const crypto = require('crypto');
const iconv = require('iconv-lite');
const { createSshConnection, resolveAdvanced } = require('./connection');
const { createX11Forwarder } = require('./x11');

class SshSessionManager {
  constructor({ send, log }) {
    this.send = send || (() => {});
    this.log = log;
    this.sessions = new Map();
  }

  _emit(sessionId, type, payload = {}) {
    const rec = this.sessions.get(sessionId);
    this.send('ssh:state', { ...payload, sessionId, type }, rec && rec.ownerId);
    const meta = { sessionId, host: payload.host || (rec && rec.host), port: payload.port || (rec && rec.port) };
    if (!this.log) return;
    if (type === 'ready') this.log.info('ssh', 'ssh connected', meta);
    if (type === 'ended') this.log.info('ssh', 'ssh closed', meta);
    if (type === 'error') this.log.error('ssh', 'ssh error', { ...meta, code: payload.code });
  }

  async connect(req) {
    const sessionId = req.requestId || 'ssh-' + crypto.randomUUID();
    if (typeof sessionId !== 'string' || !/^ssh-[a-zA-Z0-9-]{1,100}$/.test(sessionId) || this.sessions.has(sessionId)) {
      throw Object.assign(new Error('Invalid SSH request ID'), { code: 'SSH_REQUEST' });
    }
    const asset = req.asset || {};
    const method = req.method || {};
    const adv = resolveAdvanced(method.advanced || req.advanced);
    const dimension = (value, fallback) => Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback;
    const rec = {
      ownerId: req.ownerId, assetId: req.assetId, host: asset.host, port: Number(method.port) || 22,
      cols: dimension(req.cols, 120), rows: dimension(req.rows, 32), adv,
      connection: null, stream: null, x11: null, ready: false, shellTimer: null, closedError: null,
      stdout: iconv.getDecoder(adv.charset), stderr: iconv.getDecoder(adv.charset),
    };
    this.sessions.set(sessionId, rec);
    let rejectClosed;
    const closed = new Promise((_, reject) => { rejectClosed = reject; });
    closed.catch(() => {});
    rec.rejectClosed = rejectClosed;
    const canceled = () => Object.assign(new Error('SSH connection canceled'), { code: 'SSH_CANCELED' });
    try {
      if (adv.x11Forward) {
        const x11 = await createX11Forwarder({ display: adv.x11Display, log: this.log, sessionId });
        if (this.sessions.get(sessionId) !== rec) {
          x11.close();
          throw canceled();
        }
        rec.x11 = x11;
      }
      if (this.sessions.get(sessionId) !== rec) throw canceled();
      rec.connection = createSshConnection({
        host: rec.host, port: rec.port, username: asset.user || '',
        password: req.password != null ? req.password : asset.pass,
        advanced: adv, verifyHostKey: req.verifyHostKey, promptKeyboard: req.promptKeyboard, log: this.log,
      });
      const onClosed = (error) => {
        rec.closedError = rec.closedError || error || Object.assign(new Error('SSH connection closed'), { code: 'SSH_CLOSED' });
        rejectClosed(rec.closedError);
        if (rec.ready && this.sessions.get(sessionId) === rec) {
          this._emit(sessionId, error ? 'error' : 'ended', error ? { code: error.code || 'SSH_ERROR', message: error.message } : {});
          this.cleanup(sessionId);
        }
      };
      rec.connection.on('closed', onClosed);
      const client = await Promise.race([rec.connection.ready, closed]);
      if (rec.closedError) throw rec.closedError;
      if (this.sessions.get(sessionId) !== rec) throw canceled();
      if (rec.x11) rec.x11.attach(client);
      const write = (decoder, data) => {
        if (this.sessions.get(sessionId) !== rec || rec.closedError) return;
        const text = decoder.write(Buffer.from(data));
        if (text) this.send('ssh:data:' + sessionId, text, rec.ownerId);
      };
      await Promise.race([
        new Promise((resolve, reject) => {
          rec.shellTimer = setTimeout(() => reject(Object.assign(new Error('SSH shell request timed out'), { code: 'SSH_SHELL_TIMEOUT' })), 20000);
          client.shell({ term: adv.term, cols: rec.cols, rows: rec.rows }, rec.x11 ? { x11: rec.x11.options } : {}, (err, channel) => {
            clearTimeout(rec.shellTimer);
            rec.shellTimer = null;
            if (rec.closedError || this.sessions.get(sessionId) !== rec) {
              if (channel) channel.destroy();
              return reject(rec.closedError || canceled());
            }
            if (err) return reject(err);
            rec.stream = channel;
            channel.on('error', onClosed);
            channel.on('close', () => {
              if (this.sessions.get(sessionId) !== rec) return;
              for (const decoder of [rec.stdout, rec.stderr]) {
                const text = decoder.end();
                if (text) this.send('ssh:data:' + sessionId, text, rec.ownerId);
              }
              onClosed(null);
            });
            channel.on('data', (data) => write(rec.stdout, data));
            if (channel.stderr) channel.stderr.on('data', (data) => write(rec.stderr, data));
            resolve();
          });
        }),
        closed,
      ]);
      if (rec.closedError) throw rec.closedError;
      if (this.sessions.get(sessionId) !== rec) throw canceled();
      rec.ready = true;
      this._emit(sessionId, 'ready', { term: adv.term });
      return { sessionId, host: rec.host, port: rec.port, charset: adv.charset, term: adv.term };
    } catch (error) {
      if (this.sessions.get(sessionId) === rec) {
        this._emit(sessionId, error.code === 'SSH_CANCELED' ? 'ended' : 'error', { code: error.code || 'SSH_ERROR', message: error.message });
        this.cleanup(sessionId);
      }
      throw error;
    }
  }

  owns(sessionId, ownerId) {
    const rec = this.sessions.get(sessionId);
    return !!rec && rec.ownerId === ownerId;
  }

  write(sessionId, data, binary = false) {
    const rec = this.sessions.get(sessionId);
    if (!rec || !rec.stream) return false;
    if (typeof data !== 'string' || data.length > 1024 * 1024) {
      throw Object.assign(new Error('Invalid terminal input'), { code: 'SSH_INPUT' });
    }
    if (binary && /[^\x00-\xff]/.test(data)) {
      throw Object.assign(new Error('Invalid binary terminal input'), { code: 'SSH_INPUT' });
    }
    const bytes = binary ? Buffer.from(data, 'latin1') : iconv.encode(data, rec.adv.charset);
    if (!binary && iconv.decode(bytes, rec.adv.charset, { stripBOM: false }) !== data) {
      this.log && this.log.warn('ssh', 'terminal input cannot be encoded', { sessionId, charset: rec.adv.charset });
      throw Object.assign(new Error('Input cannot be represented in ' + rec.adv.charset), { code: 'SSH_ENCODING' });
    }
    rec.stream.write(bytes);
    return true;
  }

  resize(sessionId, cols, rows) {
    const rec = this.sessions.get(sessionId);
    if (!rec || !rec.stream) return false;
    if (![cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000)) return false;
    if (cols === rec.cols && rows === rec.rows) return true;
    rec.stream.setWindow(rows, cols, 0, 0);
    rec.cols = cols;
    rec.rows = rows;
    return true;
  }

  cleanup(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    this.sessions.delete(sessionId);
    clearTimeout(rec.shellTimer);
    rec.closedError = rec.closedError || Object.assign(new Error('SSH connection canceled'), { code: 'SSH_CANCELED' });
    rec.rejectClosed(rec.closedError);
    if (rec.x11) rec.x11.close();
    if (rec.stream) rec.stream.destroy();
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

  list() {
    return [...this.sessions.entries()].map(([sessionId, rec]) => ({ sessionId, assetId: rec.assetId, host: rec.host, port: rec.port }));
  }
}

module.exports = { SshSessionManager, resolveAdvanced };
