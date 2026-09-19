const { RdpWindowsMstscAdapter, tcpProbe } = require('./adapters/RdpWindowsMstscAdapter');
const { BaseAdapter } = require('./adapters/BaseAdapter');

class SessionManager {
  constructor({ store, send }) {
    this.store = store;
    this.send = send || (() => {});
    this.adapters = {
      rdp: new RdpWindowsMstscAdapter((ev) => {
        this.send('session:state', ev);
        if (ev.type === 'ended') {
          this.active.delete(ev.sessionId);
        }
      }),
      vnc: this._stub('vnc', { embeddable: true }),
      ssh: this._stub('ssh', { embeddable: true }),
    };
    this.active = new Map();
  }

  _stub(id, caps) {
    const self = this;
    return {
      id,
      capabilities() {
        return Object.assign(
          {
            embeddable: false,
            resolution: 'none',
            colorDepth: false,
            refreshRate: false,
            multimon: 'none',
            clipboard: false,
            processTracked: false,
          },
          caps
        );
      },
      async testConnection(payload) {
        const port = (payload.method && payload.method.port) || 5900;
        return tcpProbe(payload.asset.host, port);
      },
      async connect() {
        throw Object.assign(new Error(`${id} 会话将在后续版本实现`), { code: 'NOT_IMPLEMENTED' });
      },
      async disconnect() {
        return { ok: true };
      },
    };
  }

  getAdapter(protocol) {
    return this.adapters[String(protocol || '').toLowerCase()] || null;
  }

  capabilities(protocol) {
    const a = this.getAdapter(protocol);
    return a ? a.capabilities() : null;
  }

  async testConnection(req) {
    const a = this.getAdapter(req.method && req.method.protocol);
    if (!a) return { ok: false, error: 'unknown protocol' };
    return a.testConnection(req);
  }

  async connect(req) {
    const sessionId = 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const protocol = (req.method && req.method.protocol) || 'rdp';
    const adapter = this.getAdapter(protocol);
    if (!adapter) throw Object.assign(new Error('unknown protocol'), { code: 'UNKNOWN_PROTOCOL' });

    this.send('session:state', { type: 'connecting', sessionId, assetId: req.assetId, protocol });

    const payload = { ...req, sessionId };
    if (req.auth && req.auth.mode === 'keytar' && req.asset && req.asset.pass) {
      payload._password = req.asset.pass;
      payload.auth = { mode: 'cmdkey' };
    }

    try {
      const result = await adapter.connect(payload, sessionId);
      this.active.set(sessionId, { assetId: req.assetId, protocol, startedAt: Date.now() });

      const hit = this.store.findAsset(req.assetId);
      if (hit && adapter.id === 'rdp-windows-mstsc') {
        this.store.pushRecent(hit.asset, {
          id: (req.method && req.method.id) || 'rdp',
          proto: 'RDP',
          port: (req.method && req.method.port) || 3389,
        });
        this.send('store:changed', { reason: 'recent' });
      }

      return { sessionId, ...result, embeddable: false };
    } catch (e) {
      this.send('session:state', {
        type: 'error',
        sessionId,
        assetId: req.assetId,
        code: e.code || 'CONNECT_FAILED',
        message: e.message,
      });
      throw e;
    }
  }

  async disconnect(sessionId) {
    const info = this.active.get(sessionId);
    if (!info) return { ok: true };
    const adapter = this.getAdapter(info.protocol);
    if (adapter && adapter.disconnect) return adapter.disconnect(sessionId);
    this.active.delete(sessionId);
    return { ok: true };
  }

  listActive() {
    return [...this.active.entries()].map(([sessionId, v]) => ({ sessionId, ...v }));
  }
}

module.exports = { SessionManager };
