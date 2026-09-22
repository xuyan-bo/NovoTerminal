const path = require('path');
const { spawn, execFile } = require('child_process');
const { BaseAdapter } = require('./BaseAdapter');
const { tcpProbe, testRdp } = require('../testers');

function findMstsc() {
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'mstsc.exe'),
    'mstsc.exe',
  ];
  return candidates[0];
}

function mstscTarget(host, port) {
  return /^(?:\[[^\]]+\]|[^:]+):\d+$/.test(host) ? host : `${host}:${port || 3389}`;
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

  buildMstscArgs(payload) {
    const { asset, method, display } = payload;
    const args = [`/v:${mstscTarget(asset.host, method.port)}`];

    if (display.multimon) {
      args.push('/multimon');
    } else if (display.mode === 'fullscreen') {
      args.push('/f');
    } else if (display.width && display.height) {
      args.push(`/w:${display.width}`, `/h:${display.height}`);
    }
    if (display.promptCredentials) args.push('/prompt');
    if (method.advanced.adminSession) args.push('/admin');
    return args;
  }

  async testConnection(payload) {
    if (process.platform !== 'win32') {
      return { ok: false, error: '仅 Windows 支持 mstsc RDP' };
    }
    const host = payload.asset.host;
    const port = (payload.method && payload.method.port) || 3389;
    return testRdp({ host, port });
  }

  async connect(payload, sessionId) {
    if (process.platform !== 'win32') {
      throw Object.assign(new Error('仅 Windows 支持 mstsc RDP'), { code: 'PLATFORM' });
    }
    const mstsc = findMstsc();
    const args = this.buildMstscArgs(payload);
    const password = payload._password;
    if (password && payload.auth && payload.auth.mode === 'cmdkey') {
      const target = `TERMSRV:${mstscTarget(payload.asset.host, payload.method.port)}`;
      await new Promise((resolveStep) => {
        execFile(
          'cmdkey.exe',
          ['/generic:' + target, '/user:' + (payload.asset.user || ''), '/pass:' + password],
          () => resolveStep()
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

      child.once('error', (e) => {
        this.cleanupSession(sessionId);
        this.onEvent({ type: 'error', sessionId, code: 'SPAWN_FAILED', message: e.message });
        reject(Object.assign(e, { code: 'SPAWN_FAILED' }));
      });

      child.once('spawn', () => {
        child.unref();
        this.sessions.set(sessionId, { sessionId, pid: child.pid, args, child });
        this.onEvent({ type: 'connected', sessionId, pid: child.pid, embeddable: false });
        resolve({ pid: child.pid, args, note: 'mstsc launched via CLI' });
      });

      child.once('exit', (code) => {
        this.cleanupSession(sessionId);
        this.onEvent({ type: 'ended', sessionId, code });
      });
    });
  }

  cleanupSession(sessionId) {
    this.sessions.delete(sessionId);
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
    this.cleanupSession(sessionId);
    this.onEvent({ type: 'ended', sessionId, code: 0 });
    return { ok: true };
  }
}

module.exports = { RdpWindowsMstscAdapter, tcpProbe };
