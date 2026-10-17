const collectors = require('./monitor/collectors');
const { PowerShellChannel } = require('./monitor/PowerShellChannel');
const { exec: remoteExec, platformOf } = require('./exec');

const PROBE_TIMEOUT_MS = 6000;
const META_TIMEOUT_MS = 12000;
const POLL_TIMEOUT_MS = 8000;
const WINDOWS_BOOT_TIMEOUT_MS = 20000;
const WINDOWS_FRAME_TIMEOUT_MS = 8000;
const START_SEED_GAP_MS = 1000;
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
      // 探测期间的间隔修改也要落到同一个 runner：runStart 只有在 intervalMs 为空时才取采集器默认值。
      if (requestedMs) existing.intervalMs = requestedMs;
      return existing.pending;
    }
    const runner = { platform: null, meta: null, supported: false, lastSnapshot: null, timer: null, state: null, failures: 0, collector: null, stopRequested: false, intervalMs: null, shell: null, busy: false };
    if (requestedMs) runner.intervalMs = requestedMs;
    this.runners.set(sessionId, runner);
    runner.pending = this.runStart(sessionId, runner).catch((e) => {
      if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId);
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
      if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId);
      return { ok: true, supported: false, reason: 'probe-failed' };
    }
    const collector = collectors[platform];
    runner.platform = platform;
    runner.collector = collector;
    runner.supported = true;
    if (!runner.intervalMs) runner.intervalMs = collector.pollMs;
    let snapshot = null;
    if (collector.resident) {
      // meta 与首帧由同一次 boot 给出（boot 内含相隔 1 秒的两帧采样），所以 Windows 首帧就带速率
      try {
        snapshot = await this.openResident(sessionId, runner, target);
      } catch (e) {
        this.log && this.log.error('ssh', 'ssh monitor resident start failed', { sessionId, host, message: e.message, code: e.code });
        this.stopOwn(sessionId, runner);
        throw e;
      }
    } else {
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
      try {
        // 首帧也要有速率：先取一帧纯做差分基准，隔 1 秒后再取真正广播的首帧（与 Windows boot 的双采样同语义）
        const seed = await exec(client, collector.pollCommand, charset, POLL_TIMEOUT_MS);
        const seeded = collector.parsePoll(seed.stdout, null);
        if (seeded) runner.state = seeded.prev;
        await new Promise((resolve) => setTimeout(resolve, START_SEED_GAP_MS));
        snapshot = await this.pollOnce(sessionId, runner);
      } catch (e) {
        this.log && this.log.error('ssh', 'ssh monitor first poll failed', { sessionId, host, message: e.message, code: e.code });
        this.stopOwn(sessionId, runner);
        throw e;
      }
    }
    // 探测与首帧都是 await，期间 stop()/stopOwner 可能已经摘掉这条 runner：必须重新确认归属，
    // 否则下面 resetTimer 会建出一条不在表里的定时器，之后任何清理路径都再找不到它。
    if (this.runners.get(sessionId) !== runner) {
      this.log && this.log.warn('ssh', 'ssh monitor start aborted: runner gone', { sessionId, host });
      return { ok: true, supported: false, reason: 'not-ready' };
    }
    // 首帧没回来说明采集输出不可用（注册定时器会让渲染端永久停在加载遮罩上，种子帧残缺时速率也一直空白）
    if (!snapshot) {
      this.log && this.log.error('ssh', 'ssh monitor start failed: no usable first frame', { sessionId, host });
      this.stopOwn(sessionId, runner);
      throw monitorError('SSH_MONITOR_PARSE', 'monitor first frame unparseable');
    }
    this.resetTimer(sessionId, runner);
    this.log && this.log.info('ssh', 'ssh monitor started', { sessionId, host, port, platform, intervalMs: runner.intervalMs });
    runner.pending = null;
    return { ok: true, supported: true, platform, meta: runner.meta, snapshot, intervalSec: runner.intervalMs / 1000 };
  }

  /** 打开（或重开）常驻 PowerShell 通道并消费 boot：meta 落到 runner，尾帧直接作为一帧快照广播。 */
  async openResident(sessionId, runner, target) {
    // boot 脚本把远端 [Console]::OutputEncoding 固定成 UTF-8，通道也必须按 UTF-8 解码，
    // 否则会拿终端的 GBK 等字符集去解 UTF-8 字节，meta 里的发行版/CPU 型号/时区全是乱码
    const shell = await PowerShellChannel.open({ client: target.client, charset: 'UTF-8', log: this.log });
    if (this.runners.get(sessionId) !== runner || runner.stopRequested) {
      shell.destroy();
      return null;
    }
    runner.shell = shell;
    this.log && this.log.info('ssh', 'ssh monitor powershell channel opened', { sessionId, host: target.host });
    const block = await shell.run(runner.collector.bootCommand, WINDOWS_BOOT_TIMEOUT_MS);
    if (this.runners.get(sessionId) !== runner) {
      this.dropShell(runner);
      return null;
    }
    const boot = runner.collector.parseBoot(block);
    if (boot && boot.error === 'counters') {
      // 不是输出坏了，是这台机器的性能计数器库本身查不到；重开通道也不会好，日志要能直接给出修复线索
      this.log && this.log.error('ssh', 'ssh monitor raw perf counters unavailable', { sessionId, host: target.host });
      throw monitorError('SSH_MONITOR_COUNTERS', 'perf counters unavailable, repair with: lodctr /R');
    }
    if (!boot) throw monitorError('SSH_MONITOR_PARSE', 'monitor boot output unparseable');
    runner.meta = Object.assign({}, boot.meta, { ip: target.host });
    runner.state = boot.prev;
    return this.emitSnapshot(sessionId, runner, boot.snapshot);
  }

  dropShell(runner) {
    const shell = runner.shell;
    if (!shell) return;
    runner.shell = null;
    shell.destroy();
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
    // 上一帧还没回来就跳过这个周期：常驻通道一次只容一帧在飞
    if (runner.busy) return null;
    runner.busy = true;
    try {
      if (runner.collector.resident) return await this.pollResident(sessionId, runner, target);
      const out = await exec(target.client, runner.collector.pollCommand, target.charset, POLL_TIMEOUT_MS);
      return this.applyPoll(sessionId, runner, out.stdout);
    } catch (e) {
      if (this.runners.get(sessionId) !== runner || runner.stopRequested) return null;
      this.handleFailure(sessionId, runner, e);
      return null;
    } finally {
      runner.busy = false;
    }
  }

  async pollResident(sessionId, runner, target) {
    const shell = runner.shell;
    if (shell && shell.alive) {
      return this.applyPoll(sessionId, runner, await shell.run(runner.collector.frameCommand, WINDOWS_FRAME_TIMEOUT_MS));
    }
    // 通道断了（远端进程退出或帧超时已自毁）：重开 boot，失败照旧计入轮询失败次数
    this.dropShell(runner);
    this.log && this.log.warn('ssh', 'ssh monitor powershell channel lost, reopening', { sessionId, host: target.host });
    return this.openResident(sessionId, runner, target);
  }

  /** 解析一帧输出并广播；boot 的尾帧已经解析成快照，直接走 emitSnapshot。 */
  applyPoll(sessionId, runner, text) {
    if (this.runners.get(sessionId) !== runner || runner.stopRequested) return null;
    const parsed = runner.collector.parsePoll(text, runner.state);
    if (!parsed) {
      this.handleFailure(sessionId, runner, monitorError('SSH_MONITOR_PARSE', 'monitor output unparseable'));
      return null;
    }
    runner.state = parsed.prev;
    return this.emitSnapshot(sessionId, runner, parsed.snapshot);
  }

  emitSnapshot(sessionId, runner, snapshot) {
    if (!snapshot) return null;
    if (this.runners.get(sessionId) !== runner || runner.stopRequested) return null;
    if (snapshot.cpu && runner.meta) {
      if (!snapshot.cpu.cores && runner.meta.cores) snapshot.cpu.cores = runner.meta.cores;
      if (!snapshot.cpu.sockets) snapshot.cpu.sockets = runner.meta.sockets;
    }
    snapshot.platform = runner.platform;
    snapshot.ts = Date.now();
    runner.failures = 0;
    runner.lastSnapshot = snapshot;
    const target = this.ssh.execTarget(sessionId);
    this.send('monitor:snapshot', { sessionId, snapshot }, target && target.ownerId);
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

  /** runStart 内部的失败收尾：探测期间用户重开面板会建出新 runner，不能把它一并停掉。 */
  stopOwn(sessionId, runner) {
    if (this.runners.get(sessionId) !== runner) return;
    this.stop(sessionId);
  }

  stop(sessionId) {
    const runner = this.runners.get(sessionId);
    if (!runner) return { ok: true, existed: false };
    this.runners.delete(sessionId);
    runner.stopRequested = true;
    if (runner.timer) clearInterval(runner.timer);
    this.dropShell(runner);
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
