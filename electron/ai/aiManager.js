/**
 * AI 助手的回合循环：一次用户输入可能触发多轮「模型请求 → 执行工具 → 回填结果」。
 *
 * 会话状态按 SSH sessionId 归并，所以面板收起再打开、页签拆成独立窗口都接得上；
 * 事件一律按会话当前 ownerId 定向发送（见 emit），拆分期间换宿主不会丢流。
 * 每条会话另存两份东西：「展示记录」（提问、思考、正文、命令、审批/选择、压缩行、整轮统计）
 * 与「模型上下文」（裁剪/压缩之后真正发给序列）。两份一起落盘，
 * 加载会话时按原样恢复上下文，不再靠展示记录反推。内存里不保留 system 提示词与凭据。
 * 上下文的口径（什么进、进多少、怎么裁、怎么压）都在 aiContext，这里只管时序。
 */

const crypto = require('crypto');
const { streamChat, completeOnce } = require('./aiClient');
const { normalize, resolveModel, PERMISSIONS } = require('./aiSettings');
const { createTools } = require('./aiTools');
const {
  DIGEST_OUT_TOKENS, DIGEST_GAIN_RATIO, DIGEST_PROMPT,
  budget, estimateTokens, messagesTokens,
  trimToFit, splitForDigest, digestMessage, digestSource,
} = require('./aiContext');

const SCREEN_TIMEOUT_MS = 3000;
const TITLE_CHARS = 40;
/** 思考增量攒够这个长度才开播，避免把网关的收尾噪声显示成一次思考。 */
const MIN_REASON_CHARS = 12;
/**
 * 单次输出上限按模型窗口推：窗口的 1/8，夹在 [1024, 8192]。
 * 窗口大不代表能吐得多——输出上限在真实模型上是独立的一条线（128k 窗口的 GLM-4 只给 4k，
 * DeepSeek-V3 给 8k），所以这里取「几乎所有模型都接受」的 8192 当天花板，超出的部分靠逐档降载。
 */
const OUTPUT_RATIO = 0.125;
const OUTPUT_MIN = 1024;
const OUTPUT_MAX = 8192;
/** 降载的下限：再低就写不完整段答复，不如把网关的报错如实抛给用户。 */
const OUTPUT_FLOOR = 512;
/** 只有「这次要的输出太多」这一类拒绝才值得砍 max_tokens；模型名、鉴权错砍了也没用。 */
const OUTPUT_REJECT = /max[_ ]?tokens?|maximum context|context length|too long|exceed|output length/i;
/**
 * 但「光输入就超窗口」砍输出没有意义——prompt 是固定的，砍到底还是 400，
 * 只是白跑五趟。这种报错里没提输出/max_tokens 时直接把网关原文抛给用户。
 */
const INPUT_OVERFLOW = /\b(input|prompt)[\s\S]{0,40}(length|tokens?|too long|too large|exceed)/i;

function aiError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 工具这一步的真实结果：被拒、被停止、失败与成功必须区分开，
 * 否则一条报错的命令在折叠头上也显示「已完成」。
 */
function stepState(outcome, exitCode) {
  // 审批在等待中被停止或会话结束：命令没跑，但不是用户点了拒绝，状态要和审批卡片讲同一个故事
  if (outcome.canceled || (outcome.denied && outcome.denied !== 'deny')) return 'stopped';
  if (outcome.denied) return 'denied';
  if (outcome.channel === 'error' || outcome.failed || (exitCode != null && exitCode !== 0)) return 'failed';
  return 'done';
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
    this.pendingScreens = new Map(); // requestId -> { sessionId, resolve, timer }
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
        /** 估算系数：真实 usage.prompt_tokens / 上一轮估算，让没有 tokenizer 的估算越跑越准。 */
        tokenRatio: 1,
        /** 按模型记的降载结果（model id -> token 数）：网关嫌输出太大时学到一次就够用一整场会话。 */
        outputCaps: {},
        /** 最近一次的预算快照，面板圆环与落盘都读它。 */
        context: null,
        /** 一次提问里最多压缩一次，避免多轮工具调用把压缩请求刷成后台任务。 */
        compressTurn: 0,
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
    conv.context = null;
    conv.tokenRatio = 1;
    conv.compressTurn = 0;
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
        // 上下文与展示记录一起写：只存记录的话，加载时反推出来的上下文会跟当时发给模型的不一致
        context: {
          window: conv.context ? conv.context.window : 0,
          used: conv.context ? conv.context.used : 0,
          ratio: conv.tokenRatio,
          messages: conv.messages,
        },
      });
      conv.recordId = summary.id;
      conv.title = summary.title;
      return summary;
    } catch (e) {
      this.log && this.log.error('ai', 'ai session archive failed', { sessionId: conv.sessionId, code: e.code, message: e.message });
      return null;
    }
  }

  async listSessions(req) {
    const conv = this._meta(req && req.sessionId);
    const sessions = this.sessions ? await this.sessions.list(conv.meta.assetId, conv.meta.protocol) : [];
    return {
      ok: true,
      asset: conv.meta,
      current: conv.recordId || '',
      sessions,
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
      conv.context = null;
      conv.tokenRatio = 1;
      conv.compressTurn = 0;
    }
    return { ok: true, cleared };
  }

  /**
   * 载入历史记录：既给面板回放，也把模型上下文恢复成当时那一份，
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
    conv.messages = this._contextFromRecord(rec);
    conv.compressTurn = 0;
    const ratio = Number(rec.context && rec.context.ratio);
    conv.tokenRatio = ratio >= 0.4 && ratio <= 3 ? ratio : 1;
    const win = Number(rec.context && rec.context.window) || 0;
    const used = Number(rec.context && rec.context.used) || 0;
    conv.context = win ? { window: win, used, pct: Math.min(100, Math.round((used / win) * 100)), parts: null, reserve: 0 } : null;
    this.log && this.log.info('ai', 'ai session loaded', { sessionId: conv.sessionId, recordId: rec.id, messages: conv.record.length, contextMessages: conv.messages.length });
    return { ok: true, session: rec };
  }

  /**
   * 载入会话时的上下文来源：v2 记录里存着当时真正发给模型的那份序列，直接用它。
   * 只有老记录（没有 context 段）才退回按展示记录反推，那是有损的：命令参数与 tool id 只能重建。
   */
  _contextFromRecord(rec) {
    const saved = rec.context && Array.isArray(rec.context.messages) ? rec.context.messages : null;
    return saved && saved.length ? saved.slice() : this._restoreMessages(rec.messages);
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

  /** 审批级别只影响这一条会话，设置里的默认值不动；没覆盖过的会话跟随设置。 */
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

  /**
   * 面板打开、载入历史或切换模型时读一次：展示记录给回放，水位给圆环。
   * 窗口按这次请求里的模型现算，所以刚换模型、还没提问，分母就已经是新模型的。
   */
  history(req) {
    const sessionId = req && req.sessionId;
    const conv = this.conversations.get(sessionId);
    const ov = this.overrides.get(sessionId) || {};
    const ref = this._normalizeRef(req && req.modelRef) || ov.modelRef || this.settings().defaultRef;
    let window = 0;
    try {
      window = resolveModel((this.store.getSettings() || {}).ai, ref).contextTokens;
    } catch (_) { /* 还没配好服务就没有窗口可报，圆环不显示 */ }
    const ctx = conv && conv.context;
    const used = ctx ? ctx.used : 0;
    return {
      ok: true,
      running: !!(conv && conv.running),
      permissionOverride: ov.permission || '',
      modelOverride: ov.modelRef || null,
      title: conv ? conv.title : '',
      recordId: conv ? conv.recordId : '',
      record: conv ? conv.record : [],
      // 还在等人的审批/反问：结论要等用户点完才写进 record，所以必须单独交出，
      // 否则重建面板后卡片消失，而这一轮仍然 running 把输入框锁死。
      pending: conv
        ? [...conv.approvals.entries()].map(([requestId, p]) => ({ requestId, kind: p.kind, askedAt: p.askedAt, ...p.info }))
        : [],
      context: window
        ? { window, used, pct: Math.min(100, Math.round((used / window) * 100)), parts: ctx ? ctx.parts : null, reserve: ctx ? ctx.reserve : 0 }
        : null,
    };
  }

  approve(payload) {
    const conv = this.conversations.get(payload && payload.sessionId);
    const pending = conv && conv.approvals.get(payload.requestId);
    if (!pending) return { ok: false, reason: 'stale' };
    conv.approvals.delete(payload.requestId);
    const host = conv.meta ? conv.meta.host : '';
    if (pending.kind === 'choice') {
      const wanted = typeof payload.choice === 'string' ? payload.choice.trim().slice(0, 200) : '';
      // 点选仍按本次提问的选项白名单；只有卡片里「其他」那条自由文本才允许任意内容，
      // 因为它本来就是用户自己组织的回答，会话执行期间下面的输入框是锁着的。
      const choice = ((pending.info.options || []).includes(wanted) || payload.freeform === true) ? wanted : '';
      pending.resolve(choice);
      this.log && this.log.info('ai', 'ai choice answered', { sessionId: conv.sessionId, host, choice: choice || '(none)' });
      return { ok: true, choice };
    }
    const decision = payload && payload.decision === 'allow' ? 'allow' : 'deny';
    this.log && this.log.info('ai', 'ai approval answered', {
      sessionId: conv.sessionId, host, decision, command: String((pending.info && pending.info.command) || '').slice(0, 200),
    });
    pending.resolve(decision);
    return { ok: true, decision };
  }

  screenReply(payload) {
    const id = payload && payload.requestId;
    const pending = id && this.pendingScreens.get(id);
    if (!pending) return { ok: false };
    // 回包必须来自发起取屏的那条会话：ownSsh 只证明发送方拥有 payload 里的会话，
    // 单看全局 requestId 是挡不住「A 会话的面板替 B 会话作答」的。
    if (pending.sessionId !== payload.sessionId) return { ok: false };
    clearTimeout(pending.timer);
    this.pendingScreens.delete(id);
    pending.resolve(typeof payload.text === 'string' ? payload.text : '');
    return { ok: true };
  }

  /**
   * 命令审批：没有超时。用户可能走开，这一轮就一直等在卡片上，只有他点了允许/拒绝
   * （或整轮被停止、会话结束）才继续；等待期间这条会话是 running，不会重复起新一轮。
   */
  async _requestApproval(conv, info) {
    const requestId = 'ap-' + crypto.randomUUID();
    const askedAt = Date.now();
    const answer = await new Promise((resolve) => {
      // 必须先登记再广播：渲染端可能在同一帧就把答复送回来。登记的 info 供 history() 重建卡片，
      // 否则面板换了宿主（拆分/合并、重连、重开面板）就看不见还在等的审批，这一轮只能被停止。
      conv.approvals.set(requestId, { kind: 'approval', resolve, info, askedAt });
      this.emitTurn(conv, { type: 'approval', requestId, askedAt, ...info });
    });
    this._record(conv, { role: 'approval', ...info, decision: answer });
    // 把「用户点了拒绝」与「整轮被停止/会话结束」原样带回工具，命令行的状态才能和审批卡片一致
    return answer;
  }

  /**
   * 模型反问（ask_user）：与审批同样一直等，不选就什么都不发；
   * 只有整轮被停止或会话结束时才按「用户没选」收场，不能像审批那样当成拒绝。
   */
  async _requestChoice(conv, info) {
    const requestId = 'ch-' + crypto.randomUUID();
    const askedAt = Date.now();
    const picked = await new Promise((resolve) => {
      conv.approvals.set(requestId, { kind: 'choice', resolve, info, askedAt });
      this.emitTurn(conv, { type: 'ask', requestId, askedAt, ...info });
    });
    this._record(conv, { role: 'choice', ...info, choice: picked, state: picked ? 'picked' : 'skipped' });
    return picked;
  }

  _rejectApprovals(conv, reason) {
    if (!conv.approvals.size) return;
    this.log && this.log.info('ai', 'ai approval dropped', {
      sessionId: conv.sessionId, host: conv.meta ? conv.meta.host : '', reason, waiting: conv.approvals.size,
    });
    for (const [id, pending] of conv.approvals) {
      conv.approvals.delete(id);
      if (pending.kind === 'choice') {
        pending.resolve('');
        this.emitTurn(conv, { type: 'ask-resolved', requestId: id, choice: '', reason });
        continue;
      }
      // 落盘要能区分「用户点了拒绝」与「整轮被停止/会话结束」，工具侧仍只认 allow/deny
      pending.resolve(reason === 'canceled' ? 'canceled' : 'ended');
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
      this.pendingScreens.set(requestId, { sessionId, resolve, timer });
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
        ? 'You are NovoTerminal\'s assistant embedded in an SSH terminal. You run commands on this host through a private exec channel, so the user\'s screen stays untouched, but you still inherit its working directory.'
        : '你是 NovoTerminal 内嵌在 SSH 终端里的助手，通过独立命令通道在这台主机上执行，命令不会打进用户的终端屏幕，但会沿用终端当前目录。',
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

  /**
   * 这一轮真正发给模型的输出上限：优先用降载学到的档位，否则按窗口推一个。
   * 不放进设置是因为这两个值用户都猜不准——猜高了整轮提问直接 400。
   */
  _outputCap(conv, model) {
    const learned = conv.outputCaps[model.model];
    if (Number.isFinite(learned) && learned > 0) return learned;
    return Math.max(OUTPUT_MIN, Math.min(OUTPUT_MAX, Math.round(model.contextTokens * OUTPUT_RATIO)));
  }

  /** 被拒就砍一半再来一次，砍到下限还拒绝就不再试（返回 0，由调用方把原始错误抛出去）。 */
  _stepDown(conv, model, error, cap) {
    const status = Number(error && error.status);
    const message = String((error && error.message) || '');
    if ((status !== 400 && status !== 422) || !OUTPUT_REJECT.test(message)) return 0;
    // 输入本身就超窗口时砍输出救不回来，别把同一句话的 400 再问五遍
    if (INPUT_OVERFLOW.test(message) && !/max[_ ]?tokens|output/i.test(message)) return 0;
    if (cap <= OUTPUT_FLOOR) return 0;
    const next = Math.max(OUTPUT_FLOOR, Math.floor(cap / 2));
    conv.outputCaps[model.model] = next;
    return next;
  }

  /** 窗口跟着当前选中的模型；固定开销是工具定义 + 每轮重建的 system（已含屏幕快照）。 */
  _budget(conv, { model, system, tools, maxTokens }) {
    return budget({
      window: model.contextTokens,
      maxTokens,
      system,
      tools,
      messages: conv.messages,
    }, conv.tokenRatio);
  }

  emitContext(conv, state) {
    conv.context = { window: state.window, used: state.used, pct: state.pct, parts: state.parts, reserve: state.reserve };
    this.emitTurn(conv, { type: 'context', ...conv.context });
  }

  /**
   * 每轮请求前的治理：过水位先压缩，压完仍超额度就成对裁剪，然后把水位报给面板圆环。
   * 压缩失败不拦路——裁剪总能发得出去，代价只是少点记忆。
   */
  async _governContext(conv, scope) {
    const ratio = conv.tokenRatio;
    let state = this._budget(conv, scope);
    if (state.used >= state.triggerAt && conv.compressTurn !== conv.turnSeq) {
      await this._compressContext(conv, { ...scope, state });
      state = this._budget(conv, scope);
    }
    if (state.parts.messages > state.room) {
      const trimmed = trimToFit(conv.messages, state.room, ratio);
      if (trimmed.dropped) {
        conv.messages = trimmed.messages;
        state = this._budget(conv, scope);
        this.log && this.log.warn('ai', 'ai context trimmed', { sessionId: conv.sessionId, dropped: trimmed.dropped, room: state.room });
      }
    }
    this.emitContext(conv, state);
    return state;
  }

  /**
   * 用会话当前选中的模型把最早的若干条压成一段备忘。
   * 压不动（原文太少、正文为空、省不下 70%）都当作没发生，交给后续裁剪。
   */
  async _compressContext(conv, { model, state }) {
    const split = splitForDigest(conv.messages, state.targetRoom, conv.tokenRatio);
    if (!split.ok) return false;
    const moved = split.head.length;
    const from = state.parts.messages - messagesTokens(split.tail, conv.tokenRatio);
    let text = '';
    try {
      const res = await completeOnce({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.model,
        messages: [{ role: 'system', content: DIGEST_PROMPT }, { role: 'user', content: digestSource(split.head) }],
        maxTokens: DIGEST_OUT_TOKENS,
        temperature: 0,
        signal: conv.abort ? conv.abort.signal : undefined,
      });
      text = String(res.text || '').trim().slice(0, 8000);
    } catch (error) {
      this.log && this.log.warn('ai', 'ai context compress failed, will trim instead', { sessionId: conv.sessionId, code: error.code, message: error.message });
      return false;
    }
    if (!text) return false;
    const digest = digestMessage(text);
    const to = estimateTokens(digest.content);
    if (to > from * DIGEST_GAIN_RATIO) {
      this.log && this.log.info('ai', 'ai context compress skipped: no net gain', { sessionId: conv.sessionId, from, to });
      return false;
    }
    conv.messages = [digest, ...split.tail];
    conv.compressTurn = conv.turnSeq;
    this._record(conv, { role: 'compress', moved, from, to });
    this.emitTurn(conv, { type: 'compress', moved, from, to });
    this.log && this.log.info('ai', 'ai context compressed', { sessionId: conv.sessionId, host: model.serviceName, moved, from, to });
    return true;
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
      // 停止按钮要能掐断正在跑的远程命令，否则命令得自己等到 commandTimeoutSec 才放手
      signal: abort.signal,
    });

    this.emitTurn(conv, { type: 'state', running: true });
    const started = Date.now();
    let emptyRetried = false;
    let finished = false;
    /** 末轮 finish_reason 是 length 说明正文被单次输出上限砍断，不能当成模型自己说完了。 */
    let truncated = false;
    /** 最后一次真正发出去的输出上限，只用于截断日志。 */
    let lastCap = 0;
    let tokenIn = 0;
    let tokenOut = 0;
    /** 本轮最后一个生效的预算范围，收尾时用它重算一次水位给圆环。 */
    let scope = null;
    /** 整轮统计要落盘，历史回放才有耗时与用量可显示；异常收场同样记一条。 */
    const closeTurn = () => {
      const ms = Date.now() - started;
      this._record(conv, { role: 'turn', ms, promptTokens: tokenIn, completionTokens: tokenOut, truncated });
      return ms;
    };
    try {
      for (let round = 0; round < settings.maxTurns; round += 1) {
        if (abort.signal.aborted) break;
        const system = this.systemPrompt(ctx);
        // 预算只认工具定义的数组：createTools 返回的是 {definitions, invoke}，整个塞进去会让
        // aiContext 的 defs.length 读成 undefined，工具开销永远算 0，水位偏低、压缩晚触发。
        scope = { model, settings, system, tools: tools.definitions, maxTokens: this._outputCap(conv, model) };
        // 治理必须在组装之前：压缩会改 conv.messages，水位要按真正发出去的那一份算
        const state = await this._governContext(conv, scope);
        const messages = [{ role: 'system', content: system }, ...conv.messages];
        let thinkStart = 0;
        let thinkEnd = 0;
        let reasonBuf = '';
        let reasonOpen = false;
        let bodyStarted = false;
        const ask = (cap) => streamChat({
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          messages,
          tools: tools.definitions,
          maxTokens: cap,
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
        // 猜高的输出上限只会换来一次 400：被拒就降档重问，学到的高度按模型钉在这一场会话上
        let cap = scope.maxTokens;
        let result;
        for (;;) {
          try {
            result = await ask(cap);
            lastCap = cap;
            break;
          } catch (error) {
            const next = this._stepDown(conv, model, error, cap);
            if (!next) throw error;
            this.log && this.log.warn('ai', 'ai output limit rejected, retrying with lower cap', { sessionId, host: target.host, model: model.model, from: cap, to: next });
            cap = next;
          }
        }
        if (result.usage) {
          const inTok = Number(result.usage.prompt_tokens) || 0;
          tokenIn += inTok;
          tokenOut += Number(result.usage.completion_tokens) || 0;
          // 没有真 tokenizer，就用服务端报回的用量把估算系数拉准；用量太小的响应不参与校准
          if (inTok > 200 && state.used > 0) conv.tokenRatio = Math.min(3, Math.max(0.4, inTok / state.used));
        }
        if (reasonOpen) {
          const ms = Math.max(0, thinkEnd - thinkStart);
          this.emitTurn(conv, { type: 'think', state: 'end', ms });
          // 落盘用开播时攒下的文本，历史回放才会和当时屏幕上看到的一模一样；长度上限交给 sessionStore
          this._record(conv, { role: 'think', text: reasonBuf, ms });
        }
        this.log && this.log.info('ai', 'ai round completed', {
          sessionId, host: target.host, model: model.model, round,
          finish: result.finishReason, chars: result.text.length, calls: result.toolCalls.length,
        });
        if (!result.toolCalls.length) {
          if (result.text) {
            conv.messages.push({ role: 'assistant', content: result.text });
            this._record(conv, { role: 'ai', text: result.text });
            // length 表示正文被 maxTokens 砍断：这一轮其实没说完，面板必须给出「继续」的入口
            truncated = result.finishReason === 'length';
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
          const exitCode = Number.isInteger(outcome.exitCode) ? outcome.exitCode : null;
          const state = stepState(outcome, exitCode);
          if (!isAsk) {
            this.emitTurn(conv, {
              type: 'tool', callId: call.id, name: call.name, command, channel: outcome.channel,
              exitCode, state, ms,
              output,
            });
            this._record(conv, {
              role: 'step', name: call.name, command, channel: outcome.channel,
              state, exitCode,
              ms, auto: settings.permission === 'full', output,
            });
          }
          conv.messages.push({ role: 'tool', tool_call_id: call.id, content: String(outcome.text || '(no output)') });
          answered.add(call.id);
          if (outcome.denied || outcome.canceled) halted = true;
        }
      }
      // 跑满回合上限不是错误，但必须让用户知道这一轮没做完，否则表现为「话说一半就停了」
      const stopped = abort.signal.aborted;
      const hitLimit = !finished && !stopped;
      if (hitLimit) {
        this.log && this.log.warn('ai', 'ai turn reached max turns', { sessionId, host: target.host, maxTurns: settings.maxTurns });
      }
      if (truncated) {
        this.log && this.log.warn('ai', 'ai answer hit the max output tokens', { sessionId, host: target.host, model: model.model, maxTokens: lastCap || scope.maxTokens });
      }
      this.emitTurn(conv, {
        type: 'done',
        ms: closeTurn(),
        usage: tokenIn || tokenOut ? { promptTokens: tokenIn, completionTokens: tokenOut } : null,
        recordId: conv.recordId,
        truncated,
        error: hitLimit ? { code: 'AI_MAX_TURNS', message: 'reached max turns' }
          // 用户点了停止：正常收场也要打标，否则面板看起来像模型自己把话说完
          : (stopped ? { code: 'AI_CANCELED', message: 'stopped by user' } : undefined),
      });
      this.log && this.log.info('ai', stopped ? 'ai turn stopped' : 'ai turn finished', { sessionId, host: target.host, model: model.model, ms: Date.now() - started });
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
      // 收尾这轮又追加了正文与工具回包，圆环要显示的是真正留下来的量
      if (scope) this.emitContext(conv, this._budget(conv, scope));
      this._archive(conv, conv.title);
      this.emitTurn(conv, { type: 'state', running: false });
    }
  }

  /** 会话断开或宿主窗口销毁：中止在跑的请求，归档还没存过的对话，丢掉审批等待。 */
  stopSession(sessionId, reason) {
    this.overrides.delete(sessionId);
    const conv = this.conversations.get(sessionId);
    if (!conv) return;
    if (conv.abort) conv.abort.abort();
    this._rejectApprovals(conv, reason || 'session-ended');
    // 进行中的回合会在自己的 finally 里带完整内容归档；这里只收尾没在跑的会话，避免同一份记录写两遍
    if (!conv.running) this._archive(conv, conv.title);
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
