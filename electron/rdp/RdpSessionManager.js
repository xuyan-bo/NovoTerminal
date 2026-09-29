const { RdpProxy } = require('../session/RdpProxy');

const ADVANCED_RDP_DEFAULTS = {
  engine: 'ironrdp',
  client: '',
  resolution: 'auto',
  screenMode: 'window',
  monitors: 'single',
  clipboard: true,
  promptCredentials: false,
  adminSession: false,
  nla: true,
};

function resolveAdvanced(saved) {
  const base = { ...ADVANCED_RDP_DEFAULTS };
  if (!saved || typeof saved !== 'object') return base;
  Object.keys(base).forEach((k) => {
    const v = saved[k];
    if (v === undefined || v === null) return;
    if (typeof base[k] === 'string' && String(v).trim() === '') return;
    if (typeof base[k] === 'number') {
      const n = Number(v);
      if (Number.isNaN(n) || String(v).trim() === '') return;
      base[k] = n;
      return;
    }
    if (typeof base[k] === 'boolean') {
      base[k] = !!v;
      return;
    }
    if (v !== '') base[k] = v;
  });
  return base;
}

/**
 * RDP sessions (embedded IronRDP-WASM engine): main process runs an
 * RDCleanPath WebSocket proxy per session; the renderer's ironrdp-wasm
 * connects to ws://127.0.0.1:<port> and relays the RDP stream.
 */
class RdpSessionManager {
  constructor({ send, log }) {
    this.send = send || (() => {});
    this.log = log;
    this.sessions = new Map();
    this._seq = 0;
  }

  _emit(sessionId, type, payload) {
    this.send('rdp:state', { sessionId, type, ...(payload || {}) });
    if (!this.log) return;
    const rec = this.sessions.get(sessionId);
    const meta = {
      sessionId,
      host: (payload && payload.host) || (rec && rec.host),
      port: (payload && payload.port) || (rec && rec.port),
    };
    if (type === 'connected') {
      this.log.info('rdp', 'rdp connected', meta);
    } else if (type === 'error') {
      this.log.error('rdp', 'rdp error', {
        ...meta,
        code: payload && payload.code,
        message: payload && payload.message,
      });
    } else if (type === 'ended') {
      this.log.info('rdp', 'rdp closed', meta);
    }
  }

  async connect(req) {
    const sessionId = 'rdp-' + Date.now() + '-' + (++this._seq).toString(36);
    const asset = req.asset || {};
    const method = req.method || {};
    const adv = resolveAdvanced(method.advanced || req.advanced);
    this._host = asset.host;
    this._methodPort = Number(method.port) || 3389;

    const proxy = new RdpProxy({
      onState: (state, detail) => {
        this._emit(sessionId, state, detail || {});
      },
      onEnd: (origin) => {
        if (this.sessions.has(sessionId)) {
          this.sessions.delete(sessionId);
          // The local listener has to go with the client, or a renderer that died without
          // calling rdp:disconnect would leave the proxy port open until the app exits.
          try {
            proxy.stop();
          } catch (_) {}
          this._emit(sessionId, 'ended', { origin, host: this._host, port: this._methodPort });
        }
      },
    });

    try {
      const { wsUrl, port: wsPort } = await proxy.start();
      this.sessions.set(sessionId, {
        proxy,
        assetId: req.assetId,
        host: this._host,
        port: this._methodPort,
        wsPort,
        adv,
      });
      this._host = null;
      this._methodPort = null;
      return { sessionId, wsUrl, wsPort, host: asset.host, port: Number(method.port) || 3389 };
    } catch (e) {
      proxy.stop();
      this._host = null;
      this._methodPort = null;
      const err = Object.assign(new Error(e.message || String(e)), { code: 'RDP_PROXY_ERROR' });
      this._emit(sessionId, 'error', { code: err.code, message: err.message });
      throw err;
    }
  }

  disconnect(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: true };
    this.sessions.delete(sessionId);
    try {
      s.proxy.stop();
    } catch (_) {}
    this._emit(sessionId, 'ended', { host: s.host, port: s.port });
    return { ok: true };
  }

  list() {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      assetId: s.assetId,
      host: s.host,
      port: s.port,
      wsPort: s.wsPort,
    }));
  }

  destroyAll() {
    for (const s of this.sessions.values()) {
      try {
        s.proxy.stop();
      } catch (_) {}
    }
    this.sessions.clear();
  }
}

module.exports = { RdpSessionManager, resolveAdvanced, ADVANCED_RDP_DEFAULTS };