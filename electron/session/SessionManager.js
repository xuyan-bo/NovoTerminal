const { RdpWindowsMstscAdapter } = require('./adapters/RdpWindowsMstscAdapter');
const { tcpProbe, testSsh, testVnc, testRdp } = require('./testers');

class SessionManager {
  constructor({ store, send, log }) {
    this.store = store;
    this.send = send || (() => {});
    this.log = log;
    this.adapters = {
      rdp: new RdpWindowsMstscAdapter((ev) => {
        this.send('session:state', ev);
        if (ev.type === 'ended') {
          this.active.delete(ev.sessionId);
          this.log &&
            this.log.info('rdp', 'session closed', {
              protocol: 'rdp',
              sessionId: ev.sessionId,
              code: ev.code,
            });
        }
      }),
    };
    this.active = new Map();
  }

  getAdapter(protocol) {
    return this.adapters[String(protocol || '').toLowerCase()] || null;
  }

  async testConnection(req, context = {}) {
    const protocol = String((req.method && req.method.protocol) || '').toLowerCase();
    const asset = req.asset || {};
    const method = req.method || {};
    const host = asset.host;
    if (!host) return { ok: false, code: 'NO_HOST', error: '缺少主机地址' };
    const port = method.port;
    const advanced = method.advanced || {};

    if (protocol === 'ssh') {
      return testSsh({
        host,
        port,
        username: asset.user,
        password: asset.pass,
        advanced,
        ...context,
        log: this.log,
      });
    }
    if (protocol === 'vnc') {
      return testVnc({ host, port, password: advanced.password || asset.pass });
    }
    if (protocol === 'rdp') {
      return testRdp({ host, port });
    }
    return tcpProbe(host, port);
  }

  async connect(req) {
    const sessionId = 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const protocol = (req.method && req.method.protocol) || 'rdp';
    const adapter = this.getAdapter(protocol);
    if (!adapter) throw Object.assign(new Error('unknown protocol'), { code: 'UNKNOWN_PROTOCOL' });

    this.send('session:state', { type: 'connecting', sessionId, assetId: req.assetId, protocol });
    const logMeta = {
      protocol,
      assetId: req.assetId,
      host: req.asset && req.asset.host,
      port: req.method && req.method.port,
    };

    const payload = { ...req, sessionId };
    if (req.auth && req.auth.mode === 'keytar' && req.asset && req.asset.pass) {
      payload._password = req.asset.pass;
      payload.auth = { mode: 'cmdkey' };
    }

    try {
      const result = await adapter.connect(payload, sessionId);
      this.active.set(sessionId, { assetId: req.assetId, protocol, startedAt: Date.now() });
      this.log && this.log.info(protocol, 'external client launched', { ...logMeta, sessionId });

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
      this.log &&
        this.log.error(protocol, 'session connect failed', {
          ...logMeta,
          code: e.code || 'CONNECT_FAILED',
          message: e.message,
        });
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
