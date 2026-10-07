const iconv = require('iconv-lite');

const SHELL_COMMAND = 'powershell.exe -NoProfile -NonInteractive -Command -';
const FRAME_END = '@@NTEND@@';
const OPEN_TIMEOUT_MS = 15000;
const STDERR_KEEP = 400;

function channelError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 常驻 PowerShell 采集通道：一条 exec 通道对应一个远端进程，向 stdin 逐条喂「分号拼成的单行脚本」，
 *  本类在脚本尾部追加哨兵，收到哨兵行才算一帧结束。PowerShell 严格按 stdin 顺序执行，因此一帧一应答即可对齐；
 *  帧超时或进程退出都销毁通道，由调用方重开，免得迟到的输出算到下一帧头上。 */
class PowerShellChannel {
  constructor(channel, charset, log) {
    this.channel = channel;
    this.log = log;
    this.closing = false;
    this.alive = true;
    this.tail = '';
    this.err = '';
    this.pending = null;
    try {
      this.decoder = iconv.getDecoder(charset || 'UTF-8');
    } catch (_) {
      this.decoder = iconv.getDecoder('UTF-8');
    }
    channel.on('data', (chunk) => this.onData(chunk));
    if (channel.stderr) channel.stderr.on('data', (chunk) => this.onStderr(chunk));
    channel.on('close', () => this.onEnd(null));
    channel.on('error', (e) => this.onEnd(e));
  }

  static open({ client, charset, log, timeoutMs = OPEN_TIMEOUT_MS }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(channelError('SSH_MONITOR_TIMEOUT', 'monitor powershell channel open timed out')), timeoutMs);
      try {
        client.exec(SHELL_COMMAND, (err, chan) => {
          if (err) return fail(err);
          if (settled) {
            try { chan.destroy(); } catch (_) {}
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(new PowerShellChannel(chan, charset, log));
        });
      } catch (e) {
        fail(e);
      }
    });
  }

  run(script, timeoutMs) {
    if (!this.alive) return Promise.reject(channelError('SSH_MONITOR_CHANNEL_CLOSED', 'monitor powershell channel is closed'));
    if (this.pending) return Promise.reject(channelError('SSH_MONITOR_BUSY', 'monitor powershell frame already in flight'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, lines: [], timer: null };
      waiter.timer = setTimeout(() => {
        if (this.pending !== waiter) return;
        this.pending = null;
        reject(channelError('SSH_MONITOR_TIMEOUT', 'monitor powershell frame timed out'));
        this.destroy();
      }, timeoutMs);
      this.pending = waiter;
      try {
        // 哨兵单独一行：脚本若有语法错误，整行不会被执行，分开写仍能让哨兵回来，调用方立刻拿到空帧而不是等超时
        this.channel.write(script + '\r\nWrite-Output \'' + FRAME_END + '\'\r\n');
      } catch (e) {
        clearTimeout(waiter.timer);
        if (this.pending === waiter) this.pending = null;
        reject(e);
      }
    });
  }

  destroy() {
    this.closing = true;
    this.alive = false;
    const chan = this.channel;
    this.channel = null;
    const waiter = this.pending;
    this.pending = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(channelError('SSH_MONITOR_CHANNEL_CLOSED', 'monitor powershell channel closed'));
    }
    if (!chan) return;
    try { chan.write('exit\r\n'); } catch (_) {}
    // 关掉通道就是让远端 stdin 收到 EOF，PowerShell 据此自行退出；destroy 只兜住没退干净的句柄
    try { chan.close(); } catch (_) {}
    try { chan.destroy(); } catch (_) {}
  }

  onData(chunk) {
    let text;
    try {
      text = this.decoder.write(Buffer.from(chunk));
    } catch (_) {
      return;
    }
    this.tail += text;
    const lines = this.tail.split(/\r?\n/);
    this.tail = lines.pop();
    for (const line of lines) {
      if (line.trim() !== FRAME_END) {
        if (this.pending) this.pending.lines.push(line);
        continue;
      }
      const waiter = this.pending;
      if (!waiter) continue;
      this.pending = null;
      clearTimeout(waiter.timer);
      waiter.resolve(waiter.lines.join('\n'));
    }
  }

  onStderr(chunk) {
    this.err = (this.err + String(chunk)).slice(-STDERR_KEEP);
  }

  onEnd(error) {
    this.alive = false;
    this.channel = null;
    const waiter = this.pending;
    this.pending = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(channelError('SSH_MONITOR_CHANNEL_CLOSED', 'monitor powershell channel closed'));
    }
    if (!this.closing && this.log) {
      this.log.warn('ssh', 'ssh monitor powershell channel closed unexpectedly', {
        error: error && (error.message || error.code),
        stderr: this.err || undefined,
      });
    }
    try { this.decoder.end(); } catch (_) {}
  }
}

module.exports = { PowerShellChannel };
