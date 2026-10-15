const fs = require('fs');
const { RdpWindowsMstscAdapter } = require('./adapters/RdpWindowsMstscAdapter');
const { RdpXfreerdpAdapter } = require('./adapters/RdpXfreerdpAdapter');
const { RdpWfreerdpAdapter } = require('./adapters/RdpWfreerdpAdapter');
const { tcpProbe, testSsh, testSftp, testVnc, testRdp } = require('./testers');

/** 注册表只接受自有属性：'constructor' 这类原型链键不能当成适配器返回。 */
function own(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

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
    if (id) {
      const chosen = own(this.rdpAdapters, id);
      if (!chosen) {
        throw Object.assign(new Error(`Unknown RDP client: ${id}`), { code: 'RDP_CLIENT_UNKNOWN' });
      }
      return chosen;
    }
    if (process.platform === 'darwin' || process.platform === 'linux') return this.rdpAdapters.xfreerdp;
    return this.rdpAdapters.mstsc;
  }

  getAdapter(protocol) {
    return own(this.adapters, String(protocol || '').toLowerCase());
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
    const adapter = own(this.rdpAdapters, id);
    if (!adapter) throw Object.assign(new Error(`Unknown RDP client: ${id}`), { code: 'RDP_CLIENT_UNKNOWN' });
    if (typeof adapter.probe !== 'function') {
      return { ok: false, code: 'PROBE_UNSUPPORTED', message: `${id} probe not implemented` };
    }
    return adapter.probe();
  }

  /** 校验用户手动选择的文件确实存在且为目标客户端可执行文件，防止选错程序 */
  verifyClientPath(clientId, filePath) {
    const id = String(clientId || '').toLowerCase();
    const adapter = own(this.rdpAdapters, id);
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
    const auth = req.auth || {};
    const host = asset.host;
    if (!host) return { ok: false, code: 'NO_HOST' };
    const port = method.port;
    const advanced = method.advanced || {};
    const lang = (this.store && this.store.getSettings && this.store.getSettings().lang) || 'zh';

    if (protocol === 'ssh') {
      return testSsh({
        host,
        port,
        username: auth.username,
        password: auth.password,
        privateKey: auth.privateKey,
        passphrase: auth.passphrase,
        advanced,
        ...context,
        log: this.log,
      });
    }
    if (protocol === 'sftp') {
      // advanced 由渲染层按「SSH 跳板机 + SFTP 传输参数」合并后传入，与 SftpManager 的会话配置同源
      return testSftp({
        host,
        port,
        username: auth.username,
        password: auth.password,
        privateKey: auth.privateKey,
        passphrase: auth.passphrase,
        advanced,
        ...context,
        log: this.log,
      });
    }
    if (protocol === 'vnc') {
      return testVnc({ host, port, password: auth.password || '', lang });
    }
    if (protocol === 'rdp') {
      return testRdp({ host, port, lang });
    }
    return tcpProbe(host, port);
  }

  async connect(req) {
    const sessionId = 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    // 未登记协议不能默认当作 RDP：走错适配器等于连到错误的主机语义上
    const protocol = String((req.method && req.method.protocol) || '').toLowerCase();
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

    try {
      const result = await adapter.connect(payload, sessionId);
      this.active.set(sessionId, { assetId: req.assetId, protocol, adapterId: adapter.id, startedAt: Date.now() });
      this.log &&
        this.log.info(protocol, 'external client launched', { ...logMeta, sessionId, pid: result && result.pid });

      const hit = this.store.findAsset(req.assetId);
      if (hit && protocol === 'rdp') {
        this.store.pushRecent(hit.asset, {
          id: (req.method && req.method.id) || 'rdp',
          port: (req.method && req.method.port) || 3389,
        });
        this.send('store:changed', { reason: 'recent' });
      }

      // 适配器返回的 args 里含 /p: 口令，不能跟着 IPC 进渲染进程；界面只看连接状态事件
      return { sessionId, embeddable: false };
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

  /** 外部客户端是 detached 起的独立进程，不会跟着 Electron 结束，退出时必须逐个收尾（含 cmdkey 条目）。 */
  async destroyAll() {
    const entries = [...this.active.entries()];
    this.active.clear();
    let closed = 0;
    for (const [sessionId, info] of entries) {
      const adapter = info.adapterId ? this.findAdapterById(info.adapterId) : this.getAdapter(info.protocol);
      if (!adapter || !adapter.disconnect) continue;
      try {
        await adapter.disconnect(sessionId);
        closed += 1;
      } catch (e) {
        this.log &&
          this.log.warn('rdp', 'external client cleanup on quit failed', {
            sessionId,
            client: info.adapterId,
            message: e.message,
            code: e.code,
          });
      }
    }
    this.log && this.log.info('rdp', 'external clients closed on quit', { closed });
    return { ok: true, closed };
  }
}

module.exports = { SessionManager };
