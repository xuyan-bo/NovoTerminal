const { VncProxy } = require('../session/VncProxy');

const ADVANCED_VNC_DEFAULTS = {
  password: '',
  compressLevel: 6,
  jpegQuality: 6,
  shared: true,
  viewOnly: false,
  scale: 'fit',
  clipboard: true,
  localCursor: true,
};

function resolveAdvanced(saved) {
  const base = { ...ADVANCED_VNC_DEFAULTS };
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
 * VNC sessions: main process runs a WebSocket-to-TCP proxy per session,
 * renderer connects via noVNC to ws://127.0.0.1:<port>.
 */
class VncSessionManager {
  constructor({ send, log }) {
    this.send = send || (() => {});
    this.log = log;
    this.sessions = new Map();
    this._seq = 0;
  }

  _channel(sessionId) {
    return 'vnc:state:' + sessionId;
  }

  _emit(sessionId, type, payload) {
    this.send('vnc:state', { sessionId, type, ...(payload || {}) });
    if (!this.log) return;
    const rec = this.sessions.get(sessionId);
    const meta = {
      sessionId,
      host: (payload && payload.host) || (rec && rec.host),
      port: (payload && payload.port) || (rec && rec.port),
    };
    if (type === 'ready') {
      this.log.info('vnc', 'vnc connected', meta);
    } else if (type === 'error') {
      this.log.error('vnc', 'vnc error', {
        ...meta,
        code: payload && payload.code,
        message: payload && payload.message,
      });
    } else if (type === 'ended') {
      this.log.info('vnc', 'vnc closed', meta);
    }
  }

  async connect(req) {
    const sessionId = 'vnc-' + Date.now() + '-' + (++this._seq).toString(36);
    const asset = req.asset || {};
    const method = req.method || {};
    const adv = resolveAdvanced(method.advanced || req.advanced);
    const host = asset.host;
    const port = Number(method.port) || 5900;

    const proxy = new VncProxy({
      host,
      port,
      onState: (state, detail) => {
        this._emit(sessionId, state, detail || {});
      },
      onEnd: (origin) => {
        if (this.sessions.has(sessionId)) {
          this.sessions.delete(sessionId);
          // The local listener has to go with the client, or a renderer that died without
          // calling vnc:disconnect would leave the proxy port open until the app exits.
          try {
            proxy.stop();
          } catch (_) {}
          this._emit(sessionId, 'ended', { origin, host, port });
        }
      },
    });

    try {
      const { wsUrl, port: wsPort } = await proxy.start();
      this.sessions.set(sessionId, {
        proxy,
        assetId: req.assetId,
        host,
        port,
        wsPort,
        adv,
      });

      this._emit(sessionId, 'ready', { sessionId, host, port, wsUrl });

      return {
        sessionId,
        wsUrl,
        wsPort,
        host,
        port,
        viewOnly: adv.viewOnly,
        scale: adv.scale,
        clipboard: adv.clipboard,
        localCursor: adv.localCursor,
        shared: adv.shared,
        jpegQuality: adv.jpegQuality,
        compressLevel: adv.compressLevel,
      };
    } catch (e) {
      proxy.stop();
      const err = Object.assign(new Error(e.message || String(e)), {
        code: 'VNC_PROXY_ERROR',
      });
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
    for (const [sessionId, s] of this.sessions) {
      try {
        s.proxy.stop();
      } catch (_) {}
    }
    this.sessions.clear();
  }
}

module.exports = { VncSessionManager, resolveAdvanced, ADVANCED_VNC_DEFAULTS };
