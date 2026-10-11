const fs = require('fs');
const { RdpWindowsMstscAdapter } = require('./adapters/RdpWindowsMstscAdapter');
const { RdpXfreerdpAdapter } = require('./adapters/RdpXfreerdpAdapter');
const { RdpWfreerdpAdapter } = require('./adapters/RdpWfreerdpAdapter');
const { tcpProbe, testSsh, testSftp, testVnc, testRdp } = require('./testers');

class SessionManager {
  constructor({ store, send, log }) {
    this.store = store;
    this.send = send || (() => {});
    this.log = log;
    const onRdpEvent = (ev) => {
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
    };
    this.rdpAdapters = {
      mstsc: new RdpWindowsMstscAdapter(onRdpEvent, log),
      xfreerdp: new RdpXfreerdpAdapter(onRdpEvent),
      wfreerdp: new RdpWfreerdpAdapter(onRdpEvent),
    };
    // adapters[protocol] 保留默认入口，connect 时会按 advanced.client 二次分派
    this.adapters = {
      rdp: this.rdpAdapters.mstsc,
    };
    this.active = new Map();
  }

  /**
   * 依据 method.advanced.client 选择 RDP 适配器；未指定时按当前平台兜底：
   * Windows → mstsc，macOS/Linux → xfreerdp。避免旧资产（client=''）在 mac 上错走 mstsc。
   */
  resolveRdpAdapter(advanced) {
    const id = String((advanced && advanced.client) || '').toLowerCase();
    if (id && this.rdpAdapters[id]) return this.rdpAdapters[id];
    if (id && !this.rdpAdapters[id]) {
      throw Object.assign(new Error(`Unknown RDP client: ${id}`), { code: 'RDP_CLIENT_UNKNOWN' });
    }
    if (process.platform === 'darwin' || process.platform === 'linux') return this.rdpAdapters.xfreerdp;
    return this.rdpAdapters.mstsc;
  }

  getAdapter(protocol) {
    return this.adapters[String(protocol || '').toLowerCase()] || null;
  }

  findAdapterById(id) {
    for (const key of Object.keys(this.rdpAdapters)) {
      const a = this.rdpAdapters[key];
      if (a.id === id) return a;
    }
    for (const key of Object.keys(this.adapters)) {
      const a = this.adapters[key];
      if (a && a.id === id) return a;
    }
    return null;
  }

  async probeClient(clientId) {
    const id = String(clientId || '').toLowerCase();
    const adapter = this.rdpAdapters[id];
    if (!adapter) throw Object.assign(new Error(`Unknown RDP client: ${id}`), { code: 'RDP_CLIENT_UNKNOWN' });
    if (typeof adapter.probe !== 'function') {
      return { ok: false, code: 'PROBE_UNSUPPORTED', message: `${id} probe not implemented` };
    }
    return adapter.probe();
  }

  /** 校验用户手动选择的文件确实存在且为目标客户端可执行文件，防止选错程序 */
  verifyClientPath(clientId, filePath) {
    const id = String(clientId || '').toLowerCase();
    const adapter = this.rdpAdapters[id];
    if (!adapter) throw Object.assign(new Error(`Unknown RDP client: ${id}`), { code: 'RDP_CLIENT_UNKNOWN' });
    const p = String(filePath || '');
    let exists = false;
    try { exists = fs.existsSync(p); } catch (_) {}
    if (!exists) return { ok: false, code: 'NOT_FOUND' };
    if (!adapter.matchesBinary(p)) return { ok: false, code: 'MISMATCH' };
    return { ok: true, path: p };
  }

  async testConnection(req, context = {}) {
    const protocol = String((req.method && req.method.protocol) || '').toLowerCase();
    const asset = req.asset || {};
    const method = req.method || {};
    const host = asset.host;
    if (!host) return { ok: false, code: 'NO_HOST' };
    const port = method.port;
    const advanced = method.advanced || {};
    const lang = (this.store && this.store.getSettings && this.store.getSettings().lang) || 'zh';

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
    if (protocol === 'sftp') {
      // advanced 由渲染层按「SSH 认证 + SFTP 传输参数」合并后传入，与 SftpManager 的会话配置同源
      return testSftp({
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
      return testVnc({ host, port, password: advanced.password || asset.pass, lang });
    }
    if (protocol === 'rdp') {
      return testRdp({ host, port, lang });
    }
    return tcpProbe(host, port);
  }

  async connect(req) {
    const sessionId = 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const protocol = (req.method && req.method.protocol) || 'rdp';
    const adapter = protocol === 'rdp' ? this.resolveRdpAdapter(req.method.advanced) : this.getAdapter(protocol);
    if (!adapter) throw Object.assign(new Error('unknown protocol'), { code: 'UNKNOWN_PROTOCOL' });

    this.send('session:state', { type: 'connecting', sessionId, assetId: req.assetId, protocol });
    const logMeta = {
      protocol,
      client: (req.method && req.method.advanced && req.method.advanced.client) || adapter.id,
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
      this.active.set(sessionId, { assetId: req.assetId, protocol, adapterId: adapter.id, startedAt: Date.now() });
      this.log && this.log.info(protocol, 'external client launched', { ...logMeta, sessionId });

      const hit = this.store.findAsset(req.assetId);
      if (hit && protocol === 'rdp') {
        this.store.pushRecent(hit.asset, {
          id: (req.method && req.method.id) || 'rdp',
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
    const adapter = info.adapterId ? this.findAdapterById(info.adapterId) : this.getAdapter(info.protocol);
    if (adapter && adapter.disconnect) return adapter.disconnect(sessionId);
    this.active.delete(sessionId);
    return { ok: true };
  }

  listActive() {
    return [...this.active.entries()].map(([sessionId, v]) => ({ sessionId, ...v }));
  }
}

module.exports = { SessionManager };
