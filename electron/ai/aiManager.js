/**
 * AI 助手的回合循环：一次用户输入可能触发多轮「模型请求 → 执行工具 → 回填结果」。
 *
 * 会话状态按 SSH sessionId 归并，所以面板收起再打开、页签拆成独立窗口都接得上；
 * 事件一律按会话当前 ownerId 定向发送（见 emit），拆分期间换宿主不会丢流。
 * 对话历史只存内存，不落盘——里面可能含用户终端上的敏感内容。
 */

const crypto = require('crypto');
const { streamChat } = require('./aiClient');
const { normalize, resolveModel } = require('./aiSettings');
const { createTools } = require('./aiTools');

const HISTORY_LIMIT = 24;
const HISTORY_CHARS = 24000;
const APPROVAL_TIMEOUT_MS = 120000;
const SCREEN_TIMEOUT_MS = 3000;

function aiError(code, message) {
  return Object.assign(new Error(message), { code });
}

class AiManager {
  constructor({ ssh, pty, store, send, log }) {
    this.ssh = ssh;
    this.pty = pty;
    this.store = store;
    this.send = send || (() => {});
    this.log = log;
    this.conversations = new Map(); // sessionId -> conversation
    this.pendingScreens = new Map(); // requestId -> { resolve, timer }
  }

  settings() {
    const raw = this.store && this.store.getSettings ? this.store.getSettings() : {};
    return normalize(raw && raw.ai);
  }

  _conversation(sessionId) {
    let conv = this.conversations.get(sessionId);
    if (!conv) {
      conv = { sessionId, messages: [], running: false, abort: null, approvals: new Map(), seq: 0 };
      this.conversations.set(sessionId, conv);
    }
    return conv;
  }

  emit(sessionId, payload) {
    const target = this.ssh.execTarget(sessionId);
    this.send('ai:event', { ...payload, sessionId }, target ? target.ownerId : undefined);
  }

  /** 用户点「停止」：中断模型请求，并打断正在等待结束的终端命令。 */
  cancel(sessionId) {
    const conv = this.conversations.get(sessionId);
    if (!conv || !conv.running) return { ok: true, running: false };
    if (conv.abort) conv.abort.abort();
    this.pty.interrupt(sessionId);
    this._rejectApprovals(conv, 'canceled');
    return { ok: true, running: true };
  }

  reset(sessionId) {
    const conv = this.conversations.get(sessionId);
    if (conv) {
      if (conv.abort) conv.abort.abort();
      this._rejectApprovals(conv, 'canceled');
    }
    this.conversations.delete(sessionId);
    return { ok: true };
  }

  history(sessionId) {
    const conv = this.conversations.get(sessionId);
    return { ok: true, running: !!(conv && conv.running), messages: conv ? conv.messages.filter((m) => m.role !== 'system' && m.role !== 'tool') : [] };
  }

  approve(payload) {
    const conv = this.conversations.get(payload && payload.sessionId);
    const pending = conv && conv.approvals.get(payload.requestId);
    if (!pending) return { ok: false, reason: 'stale' };
    clearTimeout(pending.timer);
    conv.approvals.delete(payload.requestId);
    const decision = ['allow', 'deny', 'hidden'].includes(payload.decision) ? payload.decision : 'deny';
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

  _requestApproval(conv, info) {
    const requestId = 'ap-' + crypto.randomUUID();
    conv.seq += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conv.approvals.delete(requestId);
        this.log && this.log.warn('ai', 'ai approval timed out', { sessionId: conv.sessionId });
        this.emit(conv.sessionId, { type: 'approval-resolved', requestId, decision: 'deny', reason: 'timeout' });
        resolve('deny');
      }, APPROVAL_TIMEOUT_MS);
      // 必须先登记再广播：渲染端可能在同一帧就把答复送回来
      conv.approvals.set(requestId, { resolve, timer });
      this.emit(conv.sessionId, { type: 'approval', requestId, ...info });
    });
  }

  _rejectApprovals(conv, reason) {
    for (const [id, pending] of conv.approvals) {
      clearTimeout(pending.timer);
      conv.approvals.delete(id);
      pending.resolve('deny');
      this.emit(conv.sessionId, { type: 'approval-resolved', requestId: id, decision: 'deny', reason });
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
        ? 'You are OmniDesk\'s assistant embedded in an SSH terminal. You can run commands on this host through the user\'s own session.'
        : '你是 OmniDesk 内嵌在 SSH 终端里的助手，可以通过用户当前的会话在这台主机上执行命令。',
      (en ? 'Host: ' : '主机：') + target.host + ':' + target.port
        + (platform ? ' · ' + (en ? 'OS' : '系统') + ' ' + platform : ''),
      (en ? 'Working directory: ' : '当前目录：') + (cwd || (en ? 'unknown' : '未知')),
      (en ? 'Approval mode: ' : '审批模式：') + permissionText,
      en
        ? 'Rules: prefer read-only inspection; never start long-running foreground programs (top, vim, servers) because you wait for them to exit - use one-shot commands or nohup ... & instead; do not print secrets; explain what a write command will do before running it.'
        : '规则：优先用只读命令排查；不要启动需要交互或常驻前台的程序（top、vim、直接起服务），那会让命令等不到结束，一次性取数或改用 nohup ... &；不要在回答里复述密钥；写操作先说明后果再执行。',
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
    const target = this.ssh.execTarget(sessionId);
    if (!target) throw aiError('AI_SESSION_GONE', 'SSH 会话未连接');
    const text = typeof req.text === 'string' ? req.text.trim().slice(0, 8000) : '';
    if (!text) throw aiError('AI_REQUEST', 'empty message');

    const conv = this._conversation(sessionId);
    if (conv.running) throw aiError('AI_BUSY', '上一轮还没结束');
    const model = resolveModel((this.store.getSettings() || {}).ai, req.modelRef || settings.defaultRef);
    const screen = settings.readScreen ? String(req.screen || '').split(/\r?\n/).slice(-120).join('\n').slice(0, 8000) : '';
    const lang = this.store.getSettings().lang;
    const abort = new AbortController();
    conv.running = true;
    conv.abort = abort;
    conv.messages.push({ role: 'user', content: text });

    const ctx = {
      settings, target, cwd: typeof req.cwd === 'string' ? req.cwd.slice(0, 400) : '', screen, platform: target.cache && target.cache.platformInfo ? target.cache.platformInfo.platform : '', lang,
    };
    const tools = createTools({
      ssh: this.ssh,
      pty: this.pty,
      sessionId,
      target,
      cwd: ctx.cwd,
      settings,
      log: this.log,
      requestApproval: (info) => this._requestApproval(conv, info),
      readScreen: () => this._requestScreen(sessionId),
    });

    this.emit(sessionId, { type: 'state', running: true, model: model.label });
    const started = Date.now();
    let emptyRetried = false;
    try {
      for (let round = 0; round < settings.maxTurns; round += 1) {
        if (abort.signal.aborted) break;
        const messages = [{ role: 'system', content: this.systemPrompt(ctx) }, ...conv.messages];
        const result = await streamChat({
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          messages,
          tools: tools.definitions,
          maxTokens: settings.maxTokens,
          temperature: settings.temperature,
          signal: abort.signal,
          onText: (piece) => this.emit(sessionId, { type: 'delta', text: piece }),
        });
        this.log && this.log.info('ai', 'ai round completed', {
          sessionId, host: target.host, model: model.model, round,
          finish: result.finishReason, chars: result.text.length, calls: result.toolCalls.length,
        });
        if (!result.toolCalls.length) {
          if (result.text) {
            conv.messages.push({ role: 'assistant', content: result.text });
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
        const answered = new Set();
        let halted = false;
        for (const call of result.toolCalls) {
          const command = call.args && typeof call.args.command === 'string' ? call.args.command : '';
          // OpenAI 要求每个 tool_call 都有对应回包，缺一条下一轮请求就会被拒
          if (halted || abort.signal.aborted) {
            halted = true;
            conv.messages.push({ role: 'tool', tool_call_id: call.id, content: '未执行：本轮已停止，或上一条命令被用户拒绝。' });
            answered.add(call.id);
            continue;
          }
          this.emit(sessionId, {
            type: 'tool', callId: call.id, name: call.name, command,
            // 只有「完全访问」才是真的没问就动手；自动审批下的只读命令不值得打标
            auto: settings.permission === 'full',
            state: 'running',
          });
          const began = Date.now();
          let outcome;
          try {
            outcome = await tools.invoke(call);
          } catch (error) {
            outcome = { channel: 'error', text: '工具执行失败：' + (error.message || String(error)) };
            this.log && this.log.error('ai', 'ai tool call failed', { sessionId, name: call.name, code: error.code, message: error.message });
          }
          this.emit(sessionId, {
            type: 'tool', callId: call.id, name: call.name, command, channel: outcome.channel,
            denied: !!outcome.denied, exitCode: outcome.exitCode == null ? null : outcome.exitCode,
            state: outcome.denied ? 'denied' : 'done', ms: Date.now() - began,
            output: String(outcome.text || '').slice(0, 4000),
          });
          conv.messages.push({ role: 'tool', tool_call_id: call.id, content: String(outcome.text || '(no output)') });
          answered.add(call.id);
          if (outcome.denied) halted = true;
        }
        this._trimHistory(conv);
      }
      this.emit(sessionId, { type: 'done', ms: Date.now() - started });
      this.log && this.log.info('ai', 'ai turn finished', { sessionId, host: target.host, model: model.model, ms: Date.now() - started });
      return { ok: true };
    } catch (error) {
      const code = error.code || 'AI_REQUEST';
      const canceled = code === 'AI_CANCELED' || abort.signal.aborted;
      this._repairHistory(conv);
      if (!canceled) this.log && this.log.error('ai', 'ai turn failed', { sessionId, host: target.host, model: model.model, code, message: error.message });
      else this.log && this.log.info('ai', 'ai turn canceled', { sessionId, host: target.host, ms: Date.now() - started });
      this.emit(sessionId, { type: 'done', error: { code, message: error.message }, ms: Date.now() - started });
      return { ok: false, code, message: error.message };
    } finally {
      conv.running = false;
      conv.abort = null;
      this._rejectApprovals(conv, 'ended');
      this.emit(sessionId, { type: 'state', running: false, model: model.label });
    }
  }

  /** 会话断开或宿主窗口销毁：中止在跑的请求，丢掉审批等待。 */
  stopSession(sessionId, reason) {
    const conv = this.conversations.get(sessionId);
    if (!conv) return;
    if (conv.abort) conv.abort.abort();
    this._rejectApprovals(conv, reason || 'session-ended');
    this.conversations.delete(sessionId);
  }

  stopOwner(ownerId) {
    for (const sessionId of [...this.conversations.keys()]) {
      const target = this.ssh.execTarget(sessionId);
      if (!target || target.ownerId === ownerId) this.stopSession(sessionId, 'owner-closed');
    }
  }

  destroyAll() {
    for (const sessionId of [...this.conversations.keys()]) this.stopSession(sessionId, 'shutdown');
    for (const pending of this.pendingScreens.values()) clearTimeout(pending.timer);
    this.pendingScreens.clear();
  }
}

module.exports = { AiManager };
