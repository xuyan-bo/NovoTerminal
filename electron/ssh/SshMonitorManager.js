const collectors = require('./monitor/collectors');
const { exec: remoteExec, platformOf } = require('./exec');

const PROBE_TIMEOUT_MS = 6000;
const META_TIMEOUT_MS = 12000;
const POLL_TIMEOUT_MS = 8000;
const WINDOWS_POLL_TIMEOUT_MS = 20000;
const MAX_POLL_FAILURES = 3;

function monitorError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 沿用监控自己的超时错误码，避免调用方看到通用的 SSH_EXEC_TIMEOUT。 */
function exec(client, command, charset, timeoutMs) {
  return remoteExec(client, command, charset, timeoutMs, 'SSH_MONITOR_TIMEOUT');
}

class SshMonitorManager {
  /**
   * @param {{ ssh: SshSessionManager, send: Function, log?: object }} deps
   */
  constructor({ ssh, send, log }) {
    this.ssh = ssh;
    this.send = send || (() => {});
    this.log = log;
    this.runners = new Map();
  }

  async start(sessionId, intervalSec) {
    if (typeof sessionId !== 'string') throw monitorError('SSH_MONITOR', 'Invalid session id');
    const requestedMs = Number.isInteger(intervalSec) && intervalSec >= 1 && intervalSec <= 60 ? intervalSec * 1000 : null;
    const target = this.ssh.execTarget(sessionId);
    if (!target) {
      this.log && this.log.warn('ssh', 'ssh monitor start skipped: session not ready', { sessionId });
      return { ok: true, supported: false, reason: 'not-ready' };
    }
    const existing = this.runners.get(sessionId);
    if (existing) {
      if (existing.platform) {
        if (requestedMs && requestedMs !== existing.intervalMs) {
          existing.intervalMs = requestedMs;
          this.resetTimer(sessionId, existing);
        }
        return { ok: true, supported: existing.supported !== false, platform: existing.platform, meta: existing.meta, snapshot: existing.lastSnapshot, intervalSec: Math.round(existing.intervalMs / 1000) };
      }
      // A probe is still running; join it instead of launching a second one.
      return existing.pending;
    }
    const runner = { platform: null, meta: null, supported: false, lastSnapshot: null, timer: null, state: null, failures: 0, collector: null, stopRequested: false, intervalMs: null };
    if (requestedMs) runner.intervalMs = requestedMs;
    this.runners.set(sessionId, runner);
    runner.pending = this.runStart(sessionId, runner).catch((e) => {
      this.runners.delete(sessionId);
      throw e;
    });
    return runner.pending;
  }

  resetTimer(sessionId, runner) {
    if (runner.timer) clearInterval(runner.timer);
    runner.timer = setInterval(() => { this.pollOnce(sessionId, runner).catch(() => {}); }, runner.intervalMs);
  }

  async runStart(sessionId, runner) {
    const target = this.ssh.execTarget(sessionId);
    if (!target) {
      this.log && this.log.warn('ssh', 'ssh monitor target lost before probe', { sessionId });
      this.runners.delete(sessionId);
      return { ok: true, supported: false, reason: 'not-ready' };
    }
    const { client, charset, host, port } = target;
    const platform = await this.probe(target, { sessionId, host, port });
    if (!platform) {
      runner.supported = false;
      runner.pending = null;
      this.runners.delete(sessionId);
      return { ok: true, supported: false, reason: 'probe-failed' };
    }
    const collector = collectors[platform];
    runner.platform = platform;
    runner.collector = collector;
    runner.supported = true;
    if (!runner.intervalMs) runner.intervalMs = collector.pollMs;
    let meta = null;
    try {
      const metaOut = await exec(client, collector.metaCommand, charset, META_TIMEOUT_MS);
      meta = collector.parseMeta(metaOut.stdout);
    } catch (e) {
      this.log && this.log.warn('ssh', 'ssh monitor meta failed', { sessionId, host, message: e.message });
    }
    meta = meta || {};
    meta.ip = target.host;
    runner.meta = meta;
    let snapshot = null;
    try {
      snapshot = await this.pollOnce(sessionId, runner);
    } catch (e) {
      this.log && this.log.error('ssh', 'ssh monitor first poll failed', { sessionId, host, message: e.message, code: e.code });
      this.stop(sessionId);
      throw e;
    }
    // The session died or the runner was stopped mid-start: pollOnce returned null without throwing.
    // Registering a timer here would leave the renderer stuck behind a loading mask forever.
    if (!snapshot && this.runners.get(sessionId) !== runner) {
      this.log && this.log.warn('ssh', 'ssh monitor start aborted: runner gone', { sessionId, host });
      return { ok: true, supported: false, reason: 'not-ready' };
    }
    this.resetTimer(sessionId, runner);
    this.log && this.log.info('ssh', 'ssh monitor started', { sessionId, host, port, platform, intervalMs: runner.intervalMs });
    runner.pending = null;
    return { ok: true, supported: true, platform, meta, snapshot, intervalSec: runner.intervalMs / 1000 };
  }

  async probe(target, logMeta) {
    const info = await platformOf(target, PROBE_TIMEOUT_MS);
    if (!info.platform) {
      this.log && this.log.warn('ssh', 'ssh monitor probe inconclusive', {
        ...logMeta,
        uname: String(info.uname || '').slice(0, 80) || undefined,
        ver: String(info.ver || '').trim().slice(0, 80) || undefined,
      });
    }
    return info.platform;
  }

  async pollOnce(sessionId, runner) {
    if (this.runners.get(sessionId) !== runner || runner.stopRequested) return null;
    const target = this.ssh.execTarget(sessionId);
    if (!target) {
      this.stop(sessionId);
      return null;
    }
    const collector = runner.collector;
    const timeoutMs = runner.platform === 'windows' ? WINDOWS_POLL_TIMEOUT_MS : POLL_TIMEOUT_MS;
    let out;
    try {
      out = await exec(target.client, collector.pollCommand, target.charset, timeoutMs);
    } catch (e) {
      this.handleFailure(sessionId, runner, e);
      return null;
    }
    const parsed = collector.parsePoll(out.stdout, runner.state);
    if (!parsed) {
      this.handleFailure(sessionId, runner, monitorError('SSH_MONITOR_PARSE', 'monitor output unparseable'));
      return null;
    }
    runner.state = parsed.prev;
    const snapshot = parsed.snapshot;
    if (snapshot.cpu && runner.meta) {
      if (!snapshot.cpu.cores && runner.meta.cores) snapshot.cpu.cores = runner.meta.cores;
      if (!snapshot.cpu.sockets) snapshot.cpu.sockets = runner.meta.sockets;
    }
    snapshot.platform = runner.platform;
    snapshot.ts = Date.now();
    runner.failures = 0;
    runner.lastSnapshot = snapshot;
    this.send('monitor:snapshot', { sessionId, snapshot }, target.ownerId);
    return snapshot;
  }

  handleFailure(sessionId, runner, error) {
    runner.failures += 1;
    const target = this.ssh.execTarget(sessionId);
    const meta = { sessionId, host: target && target.host, code: error.code, message: error.message, failures: runner.failures };
    if (runner.failures >= MAX_POLL_FAILURES) {
      this.log && this.log.error('ssh', 'ssh monitor stopped after failures', meta);
      this.send('monitor:end', { sessionId, code: error.code || 'SSH_MONITOR' }, target && target.ownerId);
      this.stop(sessionId);
    } else {
      this.log && this.log.warn('ssh', 'ssh monitor poll failed', meta);
    }
  }

  stop(sessionId) {
    const runner = this.runners.get(sessionId);
    if (!runner) return { ok: true, existed: false };
    this.runners.delete(sessionId);
    runner.stopRequested = true;
    if (runner.timer) clearInterval(runner.timer);
    this.log && this.log.info('ssh', 'ssh monitor stopped', { sessionId, platform: runner.platform });
    return { ok: true, existed: true };
  }

  stopOwner(ownerId) {
    for (const [sessionId] of this.runners) {
      const target = this.ssh.execTarget(sessionId);
      if (!target || target.ownerId === ownerId) this.stop(sessionId);
    }
  }

  destroyAll() {
    for (const sessionId of [...this.runners.keys()]) this.stop(sessionId);
  }
}

module.exports = { SshMonitorManager };
