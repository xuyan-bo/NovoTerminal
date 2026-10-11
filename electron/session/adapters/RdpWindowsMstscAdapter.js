const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { BaseAdapter } = require('./BaseAdapter');
const { tcpProbe } = require('../testers');

// 资产里存的是裸 IPv6，mstsc 的 /v 要加方括号才能和端口区分开
function bracketedHost(host) {
  const h = String(host || '');
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

function mstscTarget(host, port) {
  return `${bracketedHost(host)}:${port || 3389}`;
}

// mstsc 认领的是 TERMSRV/<主机>（斜杠、不带端口）；与我们写的条目同名但类型不同（generic），
// 回收时只清掉自己这一条。
function credentialTarget(host) {
  return `TERMSRV/${bracketedHost(host)}`;
}

class RdpWindowsMstscAdapter extends BaseAdapter {
  constructor(onEvent, log) {
    super();
    this.id = 'rdp-windows-mstsc';
    this.candidates = [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'mstsc.exe'),
      'mstsc.exe',
    ];
    this.sessions = new Map();
    this.onEvent = onEvent || (() => {});
    this.log = log || null;
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

  async connect(payload, sessionId) {
    if (process.platform !== 'win32') {
      throw Object.assign(new Error('mstsc RDP requires Windows'), { code: 'PLATFORM' });
    }
    const adv = (payload.advanced && payload.advanced.clientPath) ||
      ((payload.method && payload.method.advanced) || {}).clientPath || '';
    let mstsc = this.candidates[0];
    if (adv) {
      try { if (fs.existsSync(adv) && this.matchesBinary(adv)) mstsc = adv; } catch (_) {}
    }
    const args = this.buildMstscArgs(payload);
    const password = payload._password;
    const credTarget =
      password && payload.auth && payload.auth.mode === 'cmdkey'
        ? credentialTarget(payload.asset.host)
        : '';
    if (credTarget) {
      const cmdArgs = ['/generic:' + credTarget];
      if (payload.asset.user) cmdArgs.push(`/user:${payload.asset.user}`);
      cmdArgs.push('/pass:' + password);
      await new Promise((resolveStep) => {
        execFile('cmdkey.exe', cmdArgs, (error) => {
          if (error && this.log) {
            this.log.warn('rdp', 'cmdkey credential write failed', {
              host: payload.asset.host,
              port: payload.method.port,
              message: error.message,
            });
          }
          resolveStep();
        });
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
        this.sessions.set(sessionId, { sessionId, pid: child.pid, args, child, credTarget });
        this.onEvent({ type: 'connected', sessionId, pid: child.pid, embeddable: false });
        resolve({ pid: child.pid, args, note: 'mstsc launched via CLI' });
      });

      child.once('exit', (code) => {
        // disconnect() 已经收尾过的会话不再重复报 ended
        if (!this.cleanupSession(sessionId)) return;
        this.onEvent({ type: 'ended', sessionId, code, client: this.id });
      });
    });
  }

  cleanupSession(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.sessions.delete(sessionId);
    if (entry.credTarget) {
      // 只回收我们自己写的那条 generic 凭据，用户在 mstsc 里勾「记住我的凭据」留下的条目不动
      execFile('cmdkey.exe', ['/delete:' + entry.credTarget], (error) => {
        if (error && this.log) {
          this.log.warn('rdp', 'cmdkey credential cleanup failed', {
            target: entry.credTarget,
            message: error.message,
          });
        }
      });
    }
    return true;
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
    if (this.cleanupSession(sessionId)) {
      this.onEvent({ type: 'ended', sessionId, code: 0, client: this.id });
    }
    return { ok: true };
  }

  async probe() {
    if (process.platform !== 'win32') {
      return { ok: false, code: 'PLATFORM', message: 'mstsc only on Windows' };
    }
    for (const p of this.candidates) {
      if (!p.includes('/') && !p.includes('\\')) continue;
      try {
        if (fs.existsSync(p)) return { ok: true, path: p };
      } catch (_) {}
    }
    return { ok: false, code: 'MSTSC_NOT_FOUND', message: 'mstsc.exe not found' };
  }
}

module.exports = { RdpWindowsMstscAdapter, tcpProbe };
