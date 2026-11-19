const crypto = require('crypto');
const iconv = require('iconv-lite');
const { createTelnetConnection, resolveAdvanced } = require('./connection');

/** 与 SSH 会话共用输出尾重放上限（页签跨窗口 attach 时回放已渲染内容） */
const TELNET_TAIL_LIMIT = 512 * 1024;

/**
 * Telnet 会话生命周期管理。
 *
 * 数据/状态事件刻意复用 SSH 的通道名（ssh:data:<sid>、ssh:state）：渲染端 TerminalView 的
 * onSshData/onSshState 与 methodId 无关，复用通道让字符终端视图零改动即可承载 Telnet。
 * sessionId 仍由渲染端以 'ssh-' 前缀生成，故 owns/attach 的校验与主进程既有逻辑完全一致。
 */
class TelnetSessionManager {
  constructor({ send, log, onEnded }) {
    this.send = send || (() => {});
    this.log = log;
    this.onEnded = onEnded || (() => {});
    this.sessions = new Map();
  }

  _pushTail(rec, text) {
    const tail = rec.tail;
    tail.chunks.push(text);
    tail.chars += text.length;
    while (tail.chars > TELNET_TAIL_LIMIT && tail.chunks.length > 1) {
      tail.chars -= tail.chunks.shift().length;
    }
  }

  _emitOutput(rec, sessionId, text) {
    if (!text) return;
    this._pushTail(rec, text);
    this.observeLogin(rec, text, sessionId);
    this.send('ssh:data:' + sessionId, text, rec.ownerId);
  }

  /** 字符流状态机：命中 login:/Password: 提示就投一次凭据，投完即停，超时交给用户手输。 */
  observeLogin(rec, text, sessionId) {
    const login = rec.login;
    if (!login || !rec.handle) return;
    login.buffer = (login.buffer + text).slice(-512);
    if (Date.now() > login.deadline) {
      rec.login = null;
      return;
    }
    if (login.stage === 'user' && /(?:login|username|user\s*name)\s*[:：]\s*$/i.test(login.buffer)) {
      rec.handle.write(iconv.encode(login.username + '\r', rec.adv.charset));
      login.stage = 'pass';
      login.buffer = '';
      this.log && this.log.info('telnet', 'telnet login username sent', { sessionId, host: rec.host });
      if (!login.password) rec.login = null;
    } else if (login.stage === 'pass' && /password\s*[:：]\s*$/i.test(login.buffer)) {
      rec.handle.write(iconv.encode(login.password + '\r', rec.adv.charset));
      login.buffer = '';
      rec.login = null;
      this.log && this.log.info('telnet', 'telnet login password sent', { sessionId, host: rec.host });
    }
  }

  _emit(sessionId, type, payload = {}) {
    const rec = this.sessions.get(sessionId);
    this.send('ssh:state', { ...payload, sessionId, type }, rec && rec.ownerId);
    const meta = { sessionId, host: payload.host || (rec && rec.host), port: payload.port || (rec && rec.port) };
    if (!this.log) return;
    if (type === 'ready') this.log.info('telnet', 'telnet ready', meta);
    if (type === 'ended') this.log.info('telnet', 'telnet closed', meta);
    if (type === 'error') this.log.error('telnet', 'telnet error', { ...meta, code: payload.code });
  }

  async connect(req) {
    const sessionId = req.requestId || 'telnet-' + crypto.randomUUID();
    if (typeof sessionId !== 'string' || !/^(ssh|telnet)-[a-zA-Z0-9-]{1,100}$/.test(sessionId) || this.sessions.has(sessionId)) {
      throw Object.assign(new Error('Invalid Telnet request ID'), { code: 'TELNET_REQUEST' });
    }
    const asset = req.asset || {};
    const method = req.method || {};
    const auth = req.auth || {};
    const adv = resolveAdvanced(method.advanced || req.advanced);
    const dimension = (value, fallback) => Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback;
    const rec = {
      ownerId: req.ownerId, assetId: req.assetId, host: asset.host, port: Number(method.port) || 23,
      cols: dimension(req.cols, 120), rows: dimension(req.rows, 32), adv,
      connection: null, handle: null, ready: false, closedError: null,
      decoder: iconv.getDecoder(adv.charset),
      tail: { chunks: [], chars: 0 },
    };
    this.sessions.set(sessionId, rec);
    let rejectClosed;
    const closed = new Promise((_, reject) => { rejectClosed = reject; });
    closed.catch(() => {});
    rec.rejectClosed = rejectClosed;
    const canceled = () => Object.assign(new Error('Telnet connection canceled'), { code: 'TELNET_CANCELED' });

    try {
      rec.connection = createTelnetConnection({
        host: rec.host, port: rec.port, advanced: adv,
        cols: rec.cols, rows: rec.rows, log: this.log,
      });
      // connection 的 finish(error) 会 emit('error')：EventEmitter 无监听者会抛未处理异常
      // （ECONNREFUSED 等连接期错误都会触发），必须立即挂上兜底监听，否则崩掉主进程。
      rec.connection.on('error', (error) => {
        this.log && this.log.warn('telnet', 'telnet connection error', {
          sessionId, host: rec.host, port: rec.port,
          code: error.code || 'TELNET_ERROR', message: error.message,
        });
      });
      const onClosed = (error) => {
        rec.closedError = rec.closedError || error || Object.assign(new Error('Telnet connection closed'), { code: 'TELNET_CLOSED' });
        rejectClosed(rec.closedError);
        if (rec.ready && this.sessions.get(sessionId) === rec) {
          this._emit(sessionId, error ? 'error' : 'ended', error ? { code: error.code || 'TELNET_ERROR', message: error.message } : {});
          this.cleanup(sessionId);
        }
      };
      rec.connection.on('closed', onClosed);
      rec.connection.on('data', (data) => {
        if (this.sessions.get(sessionId) !== rec || rec.closedError) return;
        const text = rec.decoder.write(Buffer.from(data));
        if (text) this._emitOutput(rec, sessionId, text);
      });

      // 登录凭据投递的观察器必须在 await ready 之前就位：服务端常在 TCP 建立瞬间就回显
      // 「login:」，若在 await 之后才初始化，首屏提示会被漏掉（rec.login 尚为 null）。
      // handle 的赋值在 await 的微任务续体里完成，先于任何后续数据事件（宏任务），
      // 因此提示符命中时 rec.handle 必已就绪，可安全写入。
      const username = String(auth.username || '');
      const password = String(auth.password || '');
      if (username || password) {
        rec.login = {
          stage: username ? 'user' : 'pass',
          username, password, buffer: '',
          deadline: Date.now() + 30000,
        };
      }

      const handle = await Promise.race([rec.connection.ready, closed]);
      if (rec.closedError) throw rec.closedError;
      if (this.sessions.get(sessionId) !== rec) throw canceled();
      rec.handle = handle;

      rec.ready = true;
      this._emit(sessionId, 'ready', { term: adv.term });
      return { sessionId, host: rec.host, port: rec.port, charset: adv.charset, term: adv.term };
    } catch (error) {
      if (this.sessions.get(sessionId) === rec) {
        if (!req.quiet) {
          this._emit(sessionId, error.code === 'TELNET_CANCELED' ? 'ended' : 'error', {
            code: error.code || 'TELNET_ERROR', message: error.message,
          });
        }
        this.cleanup(sessionId);
      }
      throw error;
    }
  }

  owns(sessionId, ownerId) {
    const rec = this.sessions.get(sessionId);
    return !!rec && rec.ownerId === ownerId;
  }

  transferOwner(sessionId, ownerId) {
    const rec = this.sessions.get(sessionId);
    if (!rec || !Number.isInteger(ownerId)) return false;
    rec.ownerId = ownerId;
    return true;
  }

  tail(sessionId) {
    const rec = this.sessions.get(sessionId);
    return rec ? { chunks: rec.tail.chunks.slice(), ready: !!rec.ready } : null;
  }

  write(sessionId, data, binary = false) {
    const rec = this.sessions.get(sessionId);
    if (!rec || !rec.handle) return false;
    if (typeof data !== 'string' || data.length > 1024 * 1024) {
      throw Object.assign(new Error('Invalid terminal input'), { code: 'TELNET_INPUT' });
    }
    if (binary && /[^\x00-\xff]/.test(data)) {
      throw Object.assign(new Error('Invalid binary terminal input'), { code: 'TELNET_INPUT' });
    }
    const bytes = binary ? Buffer.from(data, 'latin1') : iconv.encode(data, rec.adv.charset);
    if (!binary && iconv.decode(bytes, rec.adv.charset, { stripBOM: false }) !== data) {
      this.log && this.log.warn('telnet', 'terminal input cannot be encoded', { sessionId, charset: rec.adv.charset });
      throw Object.assign(new Error('Input cannot be represented in ' + rec.adv.charset), { code: 'TELNET_ENCODING' });
    }
    rec.handle.write(bytes);
    return true;
  }

  resize(sessionId, cols, rows) {
    const rec = this.sessions.get(sessionId);
    if (!rec || !rec.handle) return false;
    if (![cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000)) return false;
    if (cols === rec.cols && rows === rec.rows) return true;
    const ok = rec.handle.resize(cols, rows);
    if (ok) {
      rec.cols = cols;
      rec.rows = rows;
    }
    return ok;
  }

  cleanup(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    this.sessions.delete(sessionId);
    try {
      this.onEnded(sessionId);
    } catch (_) { /* 撤收失败不能反过来拖住连接清理 */ }
    rec.closedError = rec.closedError || Object.assign(new Error('Telnet connection canceled'), { code: 'TELNET_CANCELED' });
    rec.rejectClosed(rec.closedError);
    if (rec.connection) rec.connection.close();
  }

  disconnect(sessionId) {
    const existed = this.sessions.has(sessionId);
    if (existed) this._emit(sessionId, 'ended');
    this.cleanup(sessionId);
    return { ok: true, existed };
  }

  closeOwner(ownerId) {
    for (const [id, rec] of this.sessions) {
      if (rec.ownerId === ownerId) this.disconnect(id);
    }
  }

  destroyAll() {
    for (const id of this.sessions.keys()) this.disconnect(id);
  }
}

module.exports = { TelnetSessionManager, resolveAdvanced };
