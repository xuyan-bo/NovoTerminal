/**
 * AI 助手的回合循环：一次用户输入可能触发多轮「模型请求 → 执行工具 → 回填结果」。
 *
 * 会话状态按 SSH sessionId 归并，所以面板收起再打开、页签拆成独立窗口都接得上；
 * 事件一律按会话当前 ownerId 定向发送（见 emit），拆分期间换宿主不会丢流。
 * 每条会话另存一份「展示记录」（提问、思考、正文、命令、审批/选择、整轮统计）：第一次提问就落盘，
 * 之后每轮结束、新建会话、载入别的会话或终端会话结束时写回同一个文件，
 * 内存里不保留 system 提示词与凭据。
 */

const crypto = require('crypto');
const { streamChat } = require('./aiClient');
const { normalize, resolveModel, PERMISSIONS } = require('./aiSettings');
const { createTools } = require('./aiTools');

const HISTORY_LIMIT = 60;
const HISTORY_CHARS = 60000;
const APPROVAL_TIMEOUT_MS = 120000;
const SCREEN_TIMEOUT_MS = 3000;
const TITLE_CHARS = 40;
/** 网关常在正文之后补一两个字符的 reasoning 尾巴，凑不出一次思考，达不到这个长度就当没发生。 */
const MIN_REASON_CHARS = 12;

function aiError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 没改名时用首条用户提问当会话名；留空由界面按「未命名会话」显示。 */
function autoTitle(record) {
  const first = (record.find((m) => m.role === 'user') || {}).text || '';
  return first.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS);
}

class AiManager {
  constructor({ ssh, store, sessions, send, log }) {
    this.ssh = ssh;
    this.store = store;
    /** AiSessionStore：会话记录的落盘位置；没有它时归档动作整体跳过。 */
    this.sessions = sessions;
    this.send = send || (() => {});
    this.log = log;
    this.conversations = new Map(); // sessionId -> conversation
    /** 会话内的偏好覆盖（审批级别、模型）；没有覆盖的项跟随设置里的默认值，随会话一起销毁。 */
    this.overrides = new Map(); // sessionId -> { permission?, modelRef? }
    this.pendingScreens = new Map(); // requestId -> { resolve, timer }
  }

  settings() {
    const raw = this.store && this.store.getSettings ? this.store.getSettings() : {};
    return normalize(raw && raw.ai);
  }

  _conversation(sessionId) {
    let conv = this.conversations.get(sessionId);
    if (!conv) {
      conv = {
        sessionId, messages: [], record: [], running: false, abort: null, approvals: new Map(), seq: 0,
        turnSeq: 0, turnId: '',
        /** 归档归属与记录身份：第一次用到时从 SSH 会话取，之后即使连接已断也还能归档。 */
        meta: null, recordId: '', title: '',
      };
      this.conversations.set(sessionId, conv);
    }
    return conv;
  }

  /** 面板要能列出历史，就得知道这条 SSH 会话属于哪个资产；断开后靠已缓存的 meta。 */
  _meta(sessionId) {
    if (typeof sessionId !== 'string' || !/^ssh-[a-zA-Z0-9-]{1,100}$/.test(sessionId)) {
      throw aiError('AI_REQUEST', 'invalid sessionId');
    }
    const cached = this.conversations.get(sessionId);
    if (cached && cached.meta) return cached;
    const target = this.ssh.execTarget(sessionId);
    if (!target) throw aiError('AI_SESSION_GONE', 'SSH 会话未连接');
    const conv = this._conversation(sessionId);
    if (!conv.meta) {
      const hit = this.store.findAsset ? this.store.findAsset(target.assetId) : null;
      conv.meta = {
        assetId: target.assetId,
        assetName: hit && hit.asset ? String(hit.asset.name || '') : '',
        protocol: 'ssh',
        host: target.host,
        port: target.port,
      };
    }
    return conv;
  }

  _record(conv, entry) {
    conv.record.push(entry);
  }

  emit(sessionId, payload) {
    const target = this.ssh.execTarget(sessionId);
    this.send('ai:event', { ...payload, sessionId }, target ? target.ownerId : undefined);
  }

  /** 节点类事件都带当前回合 id，渲染端据此把思考/命令/审批归到同一条逻辑回合。 */
  emitTurn(conv, payload) {
    this.emit(conv.sessionId, { turnId: conv.turnId || '', ...payload });
  }

  /** 用户点「停止」：中断模型请求，并丢掉还在等待的审批。 */
  cancel(sessionId) {
    const conv = this.conversations.get(sessionId);
    if (!conv || !conv.running) return { ok: true, running: false };
    if (conv.abort) conv.abort.abort();
    this._rejectApprovals(conv, 'canceled');
    return { ok: true, running: true };
  }

  /** 新建会话：当前对话早已落盘，这里只补写最后一轮，然后清空内存重新攒。 */
  archiveSession(req) {
    const conv = this._meta(req && req.sessionId);
    if (conv.running) throw aiError('AI_BUSY', '上一轮还没结束');
    const archived = this._archive(conv, req && req.title);
    conv.messages = [];
    conv.record = [];
    conv.recordId = '';
    conv.title = '';
    return { ok: true, archived };
  }

  /** 把展示记录写回同一个文件；空对话不落盘，写失败只记日志，不能打断对话。 */
  _archive(conv, title) {
    if (!this.sessions || !conv.meta || !conv.record.length) return null;
    try {
      const summary = this.sessions.write({
        id: conv.recordId || 'ais-' + crypto.randomUUID(),
        ...conv.meta,
        title: (typeof title === 'string' && title.trim().slice(0, TITLE_CHARS * 3)) || conv.title || autoTitle(conv.record),
        messages: conv.record,
      });
      conv.recordId = summary.id;
      conv.title = summary.title;
      return summary;
    } catch (e) {
      this.log && this.log.error('ai', 'ai session archive failed', { sessionId: conv.sessionId, code: e.code, message: e.message });
      return null;
    }
  }

  listSessions(req) {
    const conv = this._meta(req && req.sessionId);
    return {
      ok: true,
      asset: conv.meta,
      current: conv.recordId || '',
      sessions: this.sessions ? this.sessions.list(conv.meta.assetId, conv.meta.protocol) : [],
    };
  }

  renameSession(req) {
    const conv = this._meta(req && req.sessionId);
    const session = this.sessions.rename(conv.meta.assetId, conv.meta.protocol, req.id, req.title);
    // 改的正是当前这条记录时，内存里的名字必须跟着变，否则下一轮写文件会覆盖回旧名
    if (req.id === conv.recordId) conv.title = session.title;
    return { ok: true, session };
  }

  removeSession(req) {
    const conv = this._meta(req && req.sessionId);
    this.sessions.remove(conv.meta.assetId, conv.meta.protocol, req.id);
    const cleared = req.id === conv.recordId;
    if (cleared) {
      // 删掉的就是当前对话：内存里一并丢掉，不然下一轮会把它当成新会话再写一份
      conv.recordId = '';
      conv.title = '';
      conv.record = [];
      conv.messages = [];
    }
    return { ok: true, cleared };
  }

  /**
   * 载入历史记录：既给面板回放，也把模型上下文按原样重建，
   * 这样用户接着提问就是在延续这条会话，而不是从空白重新开始。
   * 载入前无条件把内存里的对话写回文件，避免切走时丢掉刚产生的几轮。
   */
  openSession(req) {
    const conv = this._meta(req && req.sessionId);
    if (conv.running) throw aiError('AI_BUSY', '上一轮还没结束');
    this._archive(conv, conv.title);
    const rec = this.sessions.read(conv.meta.assetId, conv.meta.protocol, req.id);
    if (!rec) throw aiError('AI_SESSION_GONE', '会话记录不存在');
    conv.record = rec.messages.slice();
    conv.recordId = rec.id;
    conv.title = rec.title;
    conv.messages = this._restoreMessages(rec.messages);
    this.log && this.log.info('ai', 'ai session loaded', { sessionId: conv.sessionId, recordId: rec.id, messages: conv.record.length });
    return { ok: true, session: rec };
  }

  /** 展示记录 → OpenAI 消息序列；命令卡片还原成 assistant.tool_calls + tool 回包成对出现。 */
  _restoreMessages(record) {
    const out = [];
    let seq = 0;
    for (const item of record) {
      if (item.role === 'user') out.push({ role: 'user', content: item.text });
      else if (item.role === 'ai') out.push({ role: 'assistant', content: item.text });
      // 思考全文与整轮统计只服务于界面回放，重新塞给模型只会污染上下文
      else if (item.role === 'think' || item.role === 'turn') continue;
      else if (item.role === 'choice') {
        seq += 1;
        const callId = 'restored-' + seq;
        out.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: callId,
            type: 'function',
            function: { name: 'ask_user', arguments: JSON.stringify({ question: item.question, options: item.options }) },
          }],
        });
        out.push({ role: 'tool', tool_call_id: callId, content: item.choice ? '用户选择：' + item.choice : '用户没有做出选择。' });
      } else if (item.role === 'step') {
        seq += 1;
        const callId = 'restored-' + seq;
        const args = item.name === 'read_terminal_screen' ? {} : { command: item.command };
        out.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: callId, type: 'function', function: { name: item.name, arguments: JSON.stringify(args) } }],
        });
        out.push({ role: 'tool', tool_call_id: callId, content: item.output || '(no output)' });
      }
    }
    return out;
  }

  /** 审批级别只影响这一条会话，设置里的默认值不动。 */
  setPermission(req) {
    const sessionId = req && req.sessionId;
    const value = req && req.permission;
    if (!PERMISSIONS.includes(value)) throw aiError('AI_REQUEST', 'invalid permission');
    this._override(sessionId).permission = value;
    this.log && this.log.info('ai', 'ai permission changed', { sessionId, permission: value });
    return { ok: true };
  }

  _override(sessionId) {
    let ov = this.overrides.get(sessionId);
    if (!ov) {
      ov = {};
      this.overrides.set(sessionId, ov);
    }
    return ov;
  }

  /** 面板递来的「服务/模型」引用：只接受两个非空字符串，长度假设与 aiSettings 的 normalize 一致。 */
  _normalizeRef(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const serviceId = typeof raw.serviceId === 'string' ? raw.serviceId.trim().slice(0, 64) : '';
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim().slice(0, 120) : '';
    return serviceId && modelId ? { serviceId, modelId } : null;
  }

  history(sessionId) {
    const conv = this.conversations.get(sessionId);
    const ov = this.overrides.get(sessionId) || {};
    return {
      ok: true,
      running: !!(conv && conv.running),
      permissionOverride: ov.permission || '',
      modelOverride: ov.modelRef || null,
      title: conv ? conv.title : '',
      recordId: conv ? conv.recordId : '',
      record: conv ? conv.record : [],
    };
  }

  approve(payload) {
    const conv = this.conversations.get(payload && payload.sessionId);
    const pending = conv && conv.approvals.get(payload.requestId);
    if (!pending) return { ok: false, reason: 'stale' };
    clearTimeout(pending.timer);
    conv.approvals.delete(payload.requestId);
    if (pending.kind === 'choice') {
      // 只接受这次提问里真实存在的选项，避免渲染端送来任意文本被当成用户答复
      const wanted = typeof payload.choice === 'string' ? payload.choice : '';
      const choice = (pending.options || []).includes(wanted) ? wanted : '';
      pending.resolve(choice);
      return { ok: true, choice };
    }
    const decision = payload && payload.decision === 'allow' ? 'allow' : 'deny';
    pending.resolve(decision);
    return { ok: true, decision };
  }

  screenReply(payload) {
    const id = payload && payload.requestId;
    const pending = id && this.pendingScreens.get(id);
    if (!pending) return { ok: false };
    clearTimeout(pending.timer);
    this.pendingScreens.delete(id);
    pending.resolve(typeof payload.text === 'string' ? payload.text : '');
    return { ok: true };
  }

  async _requestApproval(conv, info) {
    const requestId = 'ap-' + crypto.randomUUID();
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        conv.approvals.delete(requestId);
        this.log && this.log.warn('ai', 'ai approval timed out', { sessionId: conv.sessionId });
        this.emitTurn(conv, { type: 'approval-resolved', requestId, decision: 'deny', reason: 'timeout' });
        resolve('timeout');
      }, APPROVAL_TIMEOUT_MS);
      // 必须先登记再广播：渲染端可能在同一帧就把答复送回来
      conv.approvals.set(requestId, { kind: 'approval', resolve, timer });
      this.emitTurn(conv, { type: 'approval', requestId, ...info });
    });
    this._record(conv, { role: 'approval', ...info, decision: answer });
    // 记录要区分「超时」与「用户点了拒绝」，但工具只认 allow/deny
    return answer === 'allow' ? 'allow' : 'deny';
  }

  /**
   * 模型反问（ask_user）：走与审批相同的「先登记再广播」链路，但超时按「用户没选」处理，
   * 不能像审批那样默认拒绝——这里没有要拦的动作，只是拿不到答案。
   */
  async _requestChoice(conv, info) {
    const requestId = 'ch-' + crypto.randomUUID();
    const picked = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        conv.approvals.delete(requestId);
        this.log && this.log.warn('ai', 'ai ask_user timed out', { sessionId: conv.sessionId });
        this.emitTurn(conv, { type: 'ask-resolved', requestId, choice: '', reason: 'timeout' });
        resolve('');
      }, APPROVAL_TIMEOUT_MS);
      conv.approvals.set(requestId, { kind: 'choice', resolve, timer, options: info.options });
      this.emitTurn(conv, { type: 'ask', requestId, ...info });
    });
    this._record(conv, { role: 'choice', ...info, choice: picked, state: picked ? 'picked' : 'skipped' });
    return picked;
  }

  _rejectApprovals(conv, reason) {
    for (const [id, pending] of conv.approvals) {
      clearTimeout(pending.timer);
      conv.approvals.delete(id);
      if (pending.kind === 'choice') {
        pending.resolve('');
        this.emitTurn(conv, { type: 'ask-resolved', requestId: id, choice: '', reason });
        continue;
      }
      pending.resolve('deny');
      this.emitTurn(conv, { type: 'approval-resolved', requestId: id, decision: 'deny', reason });
    }
  }

  _requestScreen(sessionId) {
    const requestId = 'sc-' + crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingScreens.delete(requestId);
        resolve('');
      }, SCREEN_TIMEOUT_MS);
      this.pendingScreens.set(requestId, { resolve, timer });
      this.emit(sessionId, { type: 'screen-request', requestId });
    });
  }

  systemPrompt(ctx) {
    const { settings, target, cwd, screen, platform, lang } = ctx;
    const en = lang === 'en';
    const permissionText = {
      ask: en ? 'every command needs the user approval' : '每条命令都要用户确认',
      auto: en ? 'read-only commands run silently, writes need approval' : '只读命令自动执行，写操作需确认',
      full: en ? 'commands run without asking' : '命令不再逐条询问',
    }[settings.permission];
    const lines = [
      en
        ? 'You are OmniDesk\'s assistant embedded in an SSH terminal. You run commands on this host through a private exec channel, so the user\'s screen stays untouched, but you still inherit its working directory.'
        : '你是 OmniDesk 内嵌在 SSH 终端里的助手，通过独立命令通道在这台主机上执行，命令不会打进用户的终端屏幕，但会沿用终端当前目录。',
      (en ? 'Host: ' : '主机：') + target.host + ':' + target.port
        + (platform ? ' · ' + (en ? 'OS' : '系统') + ' ' + platform : ''),
      (en ? 'Working directory: ' : '当前目录：') + (cwd || (en ? 'unknown' : '未知')),
      (en ? 'Approval mode: ' : '审批模式：') + permissionText,
      en
        ? 'Rules: prefer read-only inspection; never start long-running foreground programs (top, vim, servers) because you wait for them to exit - use one-shot commands or nohup ... & instead; do not print secrets; explain what a write command will do before running it.'
        : '规则：优先用只读命令排查；不要启动需要交互或常驻前台的程序（top、vim、直接起服务），那会让命令等不到结束，一次性取数或改用 nohup ... &；不要在回答里复述密钥；写操作先说明后果再执行。',
      en
        ? 'If a destructive step has an ambiguous scope (which directories, which service), call ask_user with concrete options instead of guessing - the user can also answer freely.'
        : '破坏性操作的范围不明确时（清哪些目录、重启哪个服务），用 ask_user 给出具体候选项征求确认，不要凭猜测扩大范围；用户也可以不选，直接自由回答。',
      en ? 'Answer in English.' : '用中文回答。',
    ];
    if (screen) {
      lines.push('');
      lines.push(en ? '--- terminal screen (most recent lines) ---\n' + screen : '——— 用户终端当前屏幕（最近若干行）———\n' + screen);
    }
    return lines.join('\n');
  }

  _trimHistory(conv) {
    while (conv.messages.length > HISTORY_LIMIT) {
      const drop = conv.messages.findIndex((m) => m.role === 'assistant' && m.tool_calls);
      if (drop < 0) { conv.messages.shift(); continue; }
      let end = drop + 1;
      while (end < conv.messages.length && conv.messages[end].role === 'tool') end += 1;
      conv.messages.splice(drop, end - drop);
    }
    let chars = conv.messages.reduce((n, m) => n + String(m.content || '').length, 0);
    while (chars > HISTORY_CHARS && conv.messages.length > 2) {
      const removed = conv.messages.shift();
      chars -= String(removed.content || '').length;
    }
  }

  /** 回合异常收场时补齐缺失的 tool 回包，否则下一轮请求会被服务端整条拒掉。 */
  _repairHistory(conv) {
    for (let i = conv.messages.length - 1; i >= 0; i -= 1) {
      const msg = conv.messages[i];
      if (msg.role !== 'assistant' || !msg.tool_calls) continue;
      for (const call of msg.tool_calls) {
        if (conv.messages.some((m) => m.role === 'tool' && m.tool_call_id === call.id)) continue;
        conv.messages.splice(i + 1, 0, { role: 'tool', tool_call_id: call.id, content: '未执行：上一轮请求被中断。' });
      }
      break;
    }
  }

  /**
   * 一次用户输入。渲染端把当前屏幕与 cwd 一起递进来，避免为这两个值再往返一次。
   */
  async turn(req) {
    const sessionId = req && req.sessionId;
    if (typeof sessionId !== 'string' || !/^ssh-[a-zA-Z0-9-]{1,100}$/.test(sessionId)) {
      throw aiError('AI_REQUEST', 'invalid sessionId');
    }
    const settings = this.settings();
    if (!settings.enabled) throw aiError('AI_DISABLED', 'AI 助手已在设置中关闭');
    const override = this.overrides.get(sessionId) || {};
    if (override.permission) settings.permission = override.permission;
    const target = this.ssh.execTarget(sessionId);
    if (!target) throw aiError('AI_SESSION_GONE', 'SSH 会话未连接');
    const text = typeof req.text === 'string' ? req.text.trim().slice(0, 8000) : '';
    if (!text) throw aiError('AI_REQUEST', 'empty message');

    const conv = this._meta(sessionId);
    if (conv.running) throw aiError('AI_BUSY', '上一轮还没结束');
    const ref = this._normalizeRef(req.modelRef);
    if (ref) {
      override.modelRef = ref;
      this.overrides.set(sessionId, override);
    }
    const model = resolveModel((this.store.getSettings() || {}).ai, override.modelRef || settings.defaultRef);
    const screen = settings.readScreen ? String(req.screen || '').split(/\r?\n/).slice(-120).join('\n').slice(0, 8000) : '';
    const lang = this.store.getSettings().lang;
    const abort = new AbortController();
    conv.running = true;
    conv.abort = abort;
    conv.turnId = 't' + (conv.turnSeq += 1);
    conv.messages.push({ role: 'user', content: text });
    this._record(conv, { role: 'user', text });
    // 面板可能已经给这条对话改过名，先接住再落盘，否则首次写文件会退回自动标题
    const named = typeof req.title === 'string' ? req.title.trim().slice(0, TITLE_CHARS * 3) : '';
    if (named) conv.title = named;
    this._archive(conv, conv.title);

    const ctx = {
      settings, target, cwd: typeof req.cwd === 'string' ? req.cwd.slice(0, 400) : '', screen, platform: target.cache && target.cache.platformInfo ? target.cache.platformInfo.platform : '', lang,
    };
    const tools = createTools({
      sessionId,
      target,
      cwd: ctx.cwd,
      settings,
      log: this.log,
      requestApproval: (info) => this._requestApproval(conv, info),
      requestChoice: (info) => this._requestChoice(conv, info),
      readScreen: () => this._requestScreen(sessionId),
    });

    this.emitTurn(conv, { type: 'state', running: true, model: model.label });
    const started = Date.now();
    let emptyRetried = false;
    let finished = false;
    let tokenIn = 0;
    let tokenOut = 0;
    /** 整轮统计要落盘，历史回放才有耗时与用量可显示；异常收场同样记一条。 */
    const closeTurn = () => {
      const ms = Date.now() - started;
      this._record(conv, { role: 'turn', ms, promptTokens: tokenIn, completionTokens: tokenOut });
      return ms;
    };
    try {
      for (let round = 0; round < settings.maxTurns; round += 1) {
        if (abort.signal.aborted) break;
        const messages = [{ role: 'system', content: this.systemPrompt(ctx) }, ...conv.messages];
        let thinkStart = 0;
        let thinkEnd = 0;
        let reasonBuf = '';
        let reasonOpen = false;
        let bodyStarted = false;
        const result = await streamChat({
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          messages,
          tools: tools.definitions,
          maxTokens: settings.maxTokens,
          temperature: settings.temperature,
          signal: abort.signal,
          log: this.log,
          onText: (piece) => {
            bodyStarted = true;
            this.emitTurn(conv, { type: 'delta', text: piece });
          },
          onReason: (piece) => {
            // 正文之后还吐 reasoning 是网关的收尾噪声（往往就一两个字符），
            // 既不上屏也不落盘，否则面板会多出一条没有内容的「已思考」。
            if (bodyStarted) return;
            const now = Date.now();
            if (!thinkStart) thinkStart = now;
            thinkEnd = now;
            reasonBuf += piece;
            // 攒够长度才开播，并把之前扣下的片段一次性补发
            if (reasonOpen) this.emitTurn(conv, { type: 'think', state: 'delta', text: piece });
            else if (reasonBuf.trim().length >= MIN_REASON_CHARS) {
              reasonOpen = true;
              this.emitTurn(conv, { type: 'think', state: 'delta', text: reasonBuf });
            }
          },
        });
        if (result.usage) {
          tokenIn += Number(result.usage.prompt_tokens) || 0;
          tokenOut += Number(result.usage.completion_tokens) || 0;
        }
        if (reasonOpen) {
          const ms = Math.max(0, thinkEnd - thinkStart);
          this.emitTurn(conv, { type: 'think', state: 'end', ms });
          // 落盘用开播时攒下的文本，历史回放才会和当时屏幕上看到的一模一样
          this._record(conv, { role: 'think', text: reasonBuf.slice(0, 8000), ms });
        }
        this.log && this.log.info('ai', 'ai round completed', {
          sessionId, host: target.host, model: model.model, round,
          finish: result.finishReason, chars: result.text.length, calls: result.toolCalls.length,
        });
        if (!result.toolCalls.length) {
          if (result.text) {
            conv.messages.push({ role: 'assistant', content: result.text });
            this._record(conv, { role: 'ai', text: result.text });
            finished = true;
            break;
          }
          // 只回了空正文（部分网关把内容放进 reasoning_content 时会这样）：再问一次，
          // 仍然空就明确报错，不能让会话无声停住。
          if (!emptyRetried && round + 1 < settings.maxTurns) {
            emptyRetried = true;
            this.log && this.log.warn('ai', 'ai round returned empty content, retrying once', { sessionId, host: target.host });
            continue;
          }
          throw aiError('AI_EMPTY', 'the model returned no content');
        }
        emptyRetried = false;
        // 正文与 tool_calls 必须在同一条 assistant 消息里：拆成两条会让部分兼容网关
        // 在下一轮直接回空正文，表现为「命令跑完了但 AI 不说话了」。
        conv.messages.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
        });
        if (result.text) this._record(conv, { role: 'ai', text: result.text });
        const answered = new Set();
        let halted = false;
        for (const call of result.toolCalls) {
          const command = call.args && typeof call.args.command === 'string' ? call.args.command : '';
          // ask_user 自己发 ask / 落 choice，不能再套一层命令卡片
          const isAsk = call.name === 'ask_user';
          // OpenAI 要求每个 tool_call 都有对应回包，缺一条下一轮请求就会被拒
          if (halted || abort.signal.aborted) {
            halted = true;
            conv.messages.push({ role: 'tool', tool_call_id: call.id, content: '未执行：本轮已停止，或上一条命令被用户拒绝。' });
            answered.add(call.id);
            continue;
          }
          // 「执行中」必须在审批通过、命令真的要跑时才报，否则面板里执行行会排在审批行前面，
          // 而且等待用户点击的时间会被算进命令耗时。
          let began = Date.now();
          let reported = false;
          const markRunning = () => {
            if (reported) return;
            reported = true;
            began = Date.now();
            this.emitTurn(conv, {
              type: 'tool', callId: call.id, name: call.name, command,
              // 只有「完全访问」才是真的没问就动手；自动审批下的只读命令不值得打标
              auto: settings.permission === 'full',
              state: 'running',
            });
          };
          let outcome;
          try {
            outcome = await tools.invoke(call, markRunning);
          } catch (error) {
            outcome = { channel: 'error', text: '工具执行失败：' + (error.message || String(error)) };
            this.log && this.log.error('ai', 'ai tool call failed', { sessionId, name: call.name, code: error.code, message: error.message });
          }
          if (!reported && !isAsk) markRunning();
          const ms = Date.now() - began;
          const output = String(outcome.text || '').slice(0, 4000);
          if (!isAsk) {
            this.emitTurn(conv, {
              type: 'tool', callId: call.id, name: call.name, command, channel: outcome.channel,
              denied: !!outcome.denied, exitCode: outcome.exitCode == null ? null : outcome.exitCode,
              state: outcome.denied ? 'denied' : 'done', ms,
              output,
            });
            this._record(conv, {
              role: 'step', name: call.name, command, channel: outcome.channel,
              state: outcome.denied ? 'denied' : 'done', exitCode: outcome.exitCode == null ? null : outcome.exitCode,
              ms, auto: settings.permission === 'full', output,
            });
          }
          conv.messages.push({ role: 'tool', tool_call_id: call.id, content: String(outcome.text || '(no output)') });
          answered.add(call.id);
          if (outcome.denied) halted = true;
        }
        this._trimHistory(conv);
      }
      // 跑满回合上限不是错误，但必须让用户知道这一轮没做完，否则表现为「话说一半就停了」
      const hitLimit = !finished && !abort.signal.aborted;
      if (hitLimit) {
        this.log && this.log.warn('ai', 'ai turn reached max turns', { sessionId, host: target.host, maxTurns: settings.maxTurns });
      }
      this.emitTurn(conv, {
        type: 'done',
        ms: closeTurn(),
        usage: tokenIn || tokenOut ? { promptTokens: tokenIn, completionTokens: tokenOut } : null,
        recordId: conv.recordId,
        error: hitLimit ? { code: 'AI_MAX_TURNS', message: 'reached max turns' } : undefined,
      });
      this.log && this.log.info('ai', 'ai turn finished', { sessionId, host: target.host, model: model.model, ms: Date.now() - started });
      return { ok: true };
    } catch (error) {
      const code = error.code || 'AI_REQUEST';
      const canceled = code === 'AI_CANCELED' || abort.signal.aborted;
      this._repairHistory(conv);
      if (!canceled) this.log && this.log.error('ai', 'ai turn failed', { sessionId, host: target.host, model: model.model, code, message: error.message });
      else this.log && this.log.info('ai', 'ai turn canceled', { sessionId, host: target.host, ms: Date.now() - started });
      this.emitTurn(conv, { type: 'done', error: { code, message: error.message }, ms: closeTurn(), recordId: conv.recordId });
      return { ok: false, code, message: error.message };
    } finally {
      conv.running = false;
      conv.abort = null;
      this._rejectApprovals(conv, 'ended');
      this._archive(conv, conv.title);
      this.emitTurn(conv, { type: 'state', running: false, model: model.label });
    }
  }

  /** 会话断开或宿主窗口销毁：中止在跑的请求，归档还没存过的对话，丢掉审批等待。 */
  stopSession(sessionId, reason) {
    this.overrides.delete(sessionId);
    const conv = this.conversations.get(sessionId);
    if (!conv) return;
    if (conv.abort) conv.abort.abort();
    this._rejectApprovals(conv, reason || 'session-ended');
    this._archive(conv, conv.title);
    this.conversations.delete(sessionId);
  }

  stopOwner(ownerId) {
    const ids = new Set([...this.conversations.keys(), ...this.overrides.keys()]);
    for (const sessionId of ids) {
      const target = this.ssh.execTarget(sessionId);
      if (!target || target.ownerId === ownerId) this.stopSession(sessionId, 'owner-closed');
    }
  }

  destroyAll() {
    for (const sessionId of [...this.conversations.keys()]) this.stopSession(sessionId, 'shutdown');
    this.overrides.clear();
    for (const pending of this.pendingScreens.values()) clearTimeout(pending.timer);
    this.pendingScreens.clear();
  }
}

module.exports = { AiManager };
