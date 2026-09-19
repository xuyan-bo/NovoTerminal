const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { BaseAdapter } = require('./BaseAdapter');

function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const t0 = Date.now();
    let done = false;
    const finish = (ok, error, latencyMs) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, error: error || undefined, latencyMs: latencyMs });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, undefined, Date.now() - t0));
    socket.once('timeout', () => finish(false, 'TCP_TIMEOUT'));
    socket.once('error', (e) => {
      const code = e.code || 'TCP_ERROR';
      finish(false, code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ? 'TCP_TIMEOUT' : 'TCP_ERROR');
    });
    socket.connect(Number(port) || 3389, host);
  });
}

function findMstsc() {
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'mstsc.exe'),
    'mstsc.exe',
  ];
  return candidates[0];
}

function parseResolution(res) {
  if (!res || res === 'auto') return null;
  const parts = String(res).split('x').map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
    return { width: parts[0], height: parts[1] };
  }
  return null;
}

class RdpWindowsMstscAdapter extends BaseAdapter {
  constructor(onEvent) {
    super();
    this.id = 'rdp-windows-mstsc';
    this.sessions = new Map();
    this.onEvent = onEvent || (() => {});
  }

  capabilities() {
    return {
      embeddable: false,
      resolution: 'partial',
      colorDepth: false,
      refreshRate: false,
      multimon: 'partial',
      clipboard: false,
      processTracked: true,
    };
  }

  /**
   * Build mstsc.exe command-line args (no .rdp file).
   * Official switches:
   *   mstsc /v:host[:port] [/w:W /h:H] [/f] [/multimon] [/admin] [/prompt]
   * Display settings are passed on every connect so they always apply.
   * Note: clipboard / audio / color-depth / visual-quality are NOT available
   * on the mstsc CLI; they are stored on the asset for future embedded adapters.
   */
  buildMstscArgs(payload) {
    const asset = payload.asset || {};
    const method = payload.method || {};
    const display = payload.display || {};
    const adv = method.advanced || {};
    const port = method.port || 3389;
    const host = asset.host || '';
    const target = port && port !== 3389 ? `${host}:${port}` : host;

    const args = [];
    args.push(`/v:${target}`);

    const wantFull =
      display.mode === 'fullscreen' || adv.screenMode === 'fullscreen';
    const multimon = !!(display.multimon || adv.monitors === 'multi');

    if (multimon) {
      // /multimon uses all local monitors; implies a fullscreen span
      args.push('/multimon');
    } else if (wantFull) {
      args.push('/f');
    } else {
      // Windowed: explicit desktop size every time
      let { width, height } = display;
      if (!width || !height) {
        const parsed = parseResolution(adv.resolution);
        if (parsed) {
          width = parsed.width;
          height = parsed.height;
        }
      }
      if (!width || !height) {
        width = 1920;
        height = 1080;
      }
      args.push(`/w:${width}`);
      args.push(`/h:${height}`);
    }

    if (display.promptCredentials || adv.promptCredentials) {
      args.push('/prompt');
    }
    if (adv.adminSession) {
      args.push('/admin');
    }

    return args;
  }

  async testConnection(payload) {
    if (process.platform !== 'win32') {
      return { ok: false, error: '仅 Windows 支持 mstsc RDP' };
    }
    const host = payload.asset.host;
    const port = (payload.method && payload.method.port) || 3389;
    return tcpProbe(host, port);
  }

  async connect(payload, sessionId) {
    if (process.platform !== 'win32') {
      const err = Object.assign(new Error('仅 Windows 支持 mstsc RDP'), { code: 'PLATFORM' });
      throw err;
    }
    const mstsc = findMstsc();
    const args = this.buildMstscArgs(payload);
    const adv = (payload.method && payload.method.advanced) || {};

    console.log('[rdp] mstsc args =', JSON.stringify(args));
    console.log('[rdp] advanced =', JSON.stringify(adv));
    console.log('[rdp] display =', JSON.stringify(payload.display));
    try {
      const logPath = path.join(os.tmpdir(), 'omnidesk-last-mstsc.txt');
      fs.writeFileSync(
        logPath,
        [
          'args: ' + args.join(' '),
          'advanced: ' + JSON.stringify(adv),
          'display: ' + JSON.stringify(payload.display),
          'exe: ' + mstsc,
        ].join('\n'),
        'utf8'
      );
    } catch (_) {}

    // Optional cmdkey for password — only if auth.mode === 'keytar' and password provided via main
    const password = payload._password;
    if (password && payload.auth && payload.auth.mode === 'cmdkey') {
      const method = payload.method || {};
      const port = method.port || 3389;
      const target = `TERMSRV:${payload.asset.host}:${port}`;
      await new Promise((resolve) => {
        execFile(
          'cmdkey.exe',
          ['/generic:' + target, '/user:' + (payload.asset.user || ''), '/pass:' + password],
          () => resolve()
        );
      });
    }

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(mstsc, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
      } catch (e) {
        e.code = e.code || 'SPAWN_FAILED';
        return reject(e);
      }

      child.on('error', (e) => {
        this.onEvent({ type: 'error', sessionId, code: 'SPAWN_FAILED', message: e.message });
        reject(Object.assign(e, { code: 'SPAWN_FAILED' }));
      });

      child.unref();

      const entry = { sessionId, pid: child.pid, args, child };
      this.sessions.set(sessionId, entry);

      child.on('exit', (code) => {
        this.cleanupSession(sessionId, code);
        this.onEvent({ type: 'ended', sessionId, code });
      });

      // mstsc often returns quickly after handing off — treat early success
      setTimeout(() => {
        if (this.sessions.has(sessionId)) {
          this.onEvent({ type: 'connected', sessionId, pid: child.pid, embeddable: false });
          resolve({ pid: child.pid, args, note: 'mstsc launched via CLI' });
        }
      }, 300);
    });
  }

  cleanupSession(sessionId, code) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    void code;
  }

  async disconnect(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: true };
    try {
      if (process.platform === 'win32' && entry.pid) {
        await new Promise((resolve) => {
          execFile('taskkill.exe', ['/PID', String(entry.pid), '/T'], () => resolve());
        });
      }
    } catch (_) {}
    this.cleanupSession(sessionId, 0);
    this.onEvent({ type: 'ended', sessionId, code: 0 });
    return { ok: true };
  }
}

module.exports = { RdpWindowsMstscAdapter, tcpProbe };
