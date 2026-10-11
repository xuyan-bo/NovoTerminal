const { RdpProxy } = require('../session/RdpProxy');

/**
 * RDP sessions (embedded IronRDP-WASM engine): main process runs an
 * RDCleanPath WebSocket proxy per session; the renderer's ironrdp-wasm
 * connects to ws://127.0.0.1:<port> and relays the RDP stream.
 * The embedded engine consumes its own advanced settings (resolution, NLA,
 * clipboard) in the renderer, so no defaults are mirrored here.
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
    const host = asset.host;
    const port = Number(method.port) || 3389;

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
        ownerId: req.ownerId,
      });
      return { sessionId, wsUrl, wsPort, host, port };
    } catch (e) {
      proxy.stop();
      const err = Object.assign(new Error(e.message || String(e)), { code: 'RDP_PROXY_ERROR' });
      this._emit(sessionId, 'error', { code: err.code, message: err.message, host, port });
      throw err;
    }
  }

  disconnect(sessionId, ownerId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: true, existed: false };
    if (ownerId !== undefined && s.ownerId !== ownerId) {
      if (this.log) {
        this.log.warn('rdp', 'rdp disconnect rejected, not the session owner', {
          sessionId,
          host: s.host,
          port: s.port,
        });
      }
      return { ok: true, existed: false };
    }
    this.sessions.delete(sessionId);
    try {
      s.proxy.stop();
    } catch (_) {}
    this._emit(sessionId, 'ended', { host: s.host, port: s.port });
    return { ok: true, existed: true };
  }

  /** 宿主渲染进程销毁时兜底：按 ownerId 释放该窗口名下所有代理，避免 WebSocket 尚未建立的会话残留在本地监听 */
  closeOwner(ownerId) {
    for (const [sessionId, s] of this.sessions) {
      if (s.ownerId !== ownerId) continue;
      this.sessions.delete(sessionId);
      try {
        s.proxy.stop();
      } catch (_) {}
    }
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

module.exports = { RdpSessionManager };