const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { BaseAdapter } = require('./BaseAdapter');

// 同 mstsc：裸 IPv6 要补方括号，端口只来自访问方式配置
function targetSpec(host, port) {
  const p = Number(port) || 3389;
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${h}:${p}`;
}

// DOMAIN\user 要拆成 /u 与 /d；UPN（user@domain）按 FreeRDP 的 /u 原样处理
function splitLogon(value) {
  const raw = String(value || '');
  const sep = raw.indexOf('\\');
  if (sep <= 0) return { user: raw, domain: '' };
  return { user: raw.slice(sep + 1), domain: raw.slice(0, sep) };
}

/**
 * FreeRDP CLI 适配器基类：xfreerdp（macOS/Linux，X11）和 wfreerdp（Windows 原生 GUI）
 * 共用同一套 /v /u /d /size /f /multimon /admin /clipboard /sec /cert /bpp /network 参数语义，
 * 差异只在候选路径与平台门槛，由子类提供。
 */
class FreeRdpAdapterBase extends BaseAdapter {
  constructor({ id, candidates, notFoundCode, platformError, isPlatformSupported, onEvent }) {
    super();
    this.id = id;
    this.candidates = candidates;
    this.notFoundCode = notFoundCode;
    this.platformError = platformError;
    this.isPlatformSupported = isPlatformSupported;
    this.sessions = new Map();
    this.onEvent = onEvent || (() => {});
  }

  capabilities() {
    return {
      embeddable: false,
      resolution: 'full',
      colorDepth: false,
      refreshRate: false,
      multimon: 'partial',
      clipboard: true,
      processTracked: true,
    };
  }

  buildArgs(payload) {
    const { asset, method, display, advanced } = payload;
    const adv = advanced || (method && method.advanced) || {};
    const args = [`/v:${targetSpec(asset.host, (method && method.port) || 3389)}`];
    const logon = splitLogon(asset.user);
    if (logon.user) args.push(`/u:${logon.user}`);
    if (logon.domain) args.push(`/d:${logon.domain}`);
    const password = payload._password;
    if (password) args.push(`/p:${password}`);

    if (display && display.multimon) args.push('/multimon');
    else if (display && display.mode === 'fullscreen') args.push('/f');
    else if (display && display.width && display.height) args.push(`/size:${display.width}x${display.height}`);

    if (adv.adminSession) args.push('/admin');
    // FreeRDP 默认开启剪贴板；显式关闭时才传 -clipboard
    if (adv.clipboard === false) args.push('-clipboard');
    // /sec:rdp 会连 TLS 一起关掉，只关 NLA 要用开关形式
    if (adv.nla === false) args.push('/sec:nla:off');
    // 手册写 /bpp 默认 16 位色，/network 默认不按链路类型自适应，两者都显式请求
    args.push('/bpp:32', '/network:auto');
    // 首次连接走 TOFU（本地保存指纹），避免误报但也不无脑放行
    args.push('/cert:tofu');
    return args;
  }

  async connect(payload, sessionId) {
    if (!this.isPlatformSupported()) {
      throw Object.assign(new Error(this.platformError), { code: this.notFoundCode.replace('_NOT_FOUND', '_PLATFORM') });
    }
    const args = this.buildArgs(payload);
    const custom = String(
      (payload.advanced && payload.advanced.clientPath) ||
      ((payload.method && payload.method.advanced) || {}).clientPath ||
      ''
    ).trim();
    let customOk = false;
    if (custom) {
      try { customOk = fs.existsSync(custom) && this.matchesBinary(custom); } catch (_) {}
    }
    const candidates = customOk ? [custom, ...this.candidates] : this.candidates;

    return new Promise((resolve, reject) => {
      const trySpawn = (idx) => {
        if (idx >= candidates.length) {
          const e = new Error(`${this.id} not found in PATH`);
          e.code = this.notFoundCode;
          this.onEvent({ type: 'error', sessionId, code: e.code, message: e.message });
          return reject(e);
        }
        const bin = candidates[idx];
        let child;
        try {
          child = spawn(bin, args, { detached: true, stdio: 'ignore' });
        } catch (e) {
          e.code = e.code || 'SPAWN_FAILED';
          return reject(e);
        }
        let settled = false;
        child.once('error', (e) => {
          if (settled) return;
          // ENOENT 时尝试下一个候选路径
          if (e.code === 'ENOENT') return trySpawn(idx + 1);
          settled = true;
          this.cleanupSession(sessionId);
          this.onEvent({ type: 'error', sessionId, code: 'SPAWN_FAILED', message: e.message });
          reject(Object.assign(e, { code: 'SPAWN_FAILED' }));
        });
        child.once('spawn', () => {
          if (settled) return;
          settled = true;
          child.unref();
          this.sessions.set(sessionId, { sessionId, pid: child.pid, bin, args, child });
          this.onEvent({ type: 'connected', sessionId, pid: child.pid, embeddable: false });
          resolve({ pid: child.pid, bin, args, note: `${this.id} launched via CLI` });
        });
        child.once('exit', (code) => {
          // disconnect() 已经收尾过的会话不再重复报 ended
          if (!this.cleanupSession(sessionId)) return;
          this.onEvent({ type: 'ended', sessionId, code, client: this.id });
        });
      };
      trySpawn(0);
    });
  }

  cleanupSession(sessionId) {
    if (!this.sessions.has(sessionId)) return false;
    this.sessions.delete(sessionId);
    return true;
  }

  async disconnect(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: true };
    // POSIX: 子进程是 process group leader，杀 -pid 覆盖整组；Windows 只能杀单 PID
    try {
      if (process.platform === 'win32') process.kill(entry.pid);
      else process.kill(-entry.pid, 'SIGTERM');
    } catch (_) {
      try { process.kill(entry.pid); } catch (__) {}
    }
    if (this.cleanupSession(sessionId)) {
      this.onEvent({ type: 'ended', sessionId, code: 0, client: this.id });
    }
    return { ok: true };
  }

  async probe() {
    if (!this.isPlatformSupported()) {
      return { ok: false, code: this.notFoundCode.replace('_NOT_FOUND', '_PLATFORM'), message: this.platformError };
    }
    // 先按候选绝对路径探测，命中即返回；未命中再 which/where 兜底 PATH 查找
    for (const p of this.candidates) {
      if (p.includes('/') || p.includes('\\')) {
        try {
          if (fs.existsSync(p)) return { ok: true, path: p };
        } catch (_) {}
      }
    }
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const basenames = this.candidates
      .filter((p) => !p.includes('/') && !p.includes('\\'))
      .map((p) => p.replace(/\.(exe|bat|cmd)$/i, ''));
    for (const name of basenames) {
      const found = await new Promise((resolve) => {
        execFile(finder, [name], (err, stdout) => {
          if (err) return resolve(null);
          const out = String(stdout || '').trim().split(/\r?\n/)[0];
          resolve(out || null);
        });
      });
      if (found) return { ok: true, path: found };
    }
    return { ok: false, code: this.notFoundCode, message: `${this.id} not found` };
  }
}

module.exports = { FreeRdpAdapterBase, targetSpec };
