/**
 * 在当前交互式会话里执行一条命令并拿回输出。
 *
 * 难点不是发命令，而是「怎么知道命令跑完了」：PTY 的输出流里没有任何结束信号。
 * 这里用「每条命令自带结束标记」的做法——把命令和一段打印标记的语句拼成一行发过去，
 * 在主进程的输出流上截到标记即视为结束，并从中取出退出码。
 *
 * 相比 VS Code 的 OSC 133 shell 集成：那套依赖远端 shell 主动发序列，官方文档明确它在
 * 嵌套 ssh 会话里不生效；而这里是逐命令一次性拼接，不改远端 rc / profile。
 *
 * 标记本身从转发流里剥掉，不写进 tail（避免拆分窗口重放时吐乱码）；
 * 但命令回显保持原样可见——用户应当看得见 AI 在他的终端里敲了什么。
 */

const { exec, platformOf } = require('../ssh/exec');

const PROBE_TIMEOUT_MS = 6000;
const MAX_OUTPUT_CHARS = 60 * 1024;
const CTRL_C = '\x03';

const OSC_HEAD = '\x1b]777;ai;';
const PLAIN_HEAD = '__AI_DONE_';
/** 可能构成标记前缀的最长尾巴，用于在流里把跨块的标记暂存起来再判断。 */
const HOLD_CANDIDATES = [OSC_HEAD, PLAIN_HEAD];
const MARKER_RE = /\x1b\]777;ai;(\d+);(-?\d+)\x07|__AI_DONE_(\d+)_(-?\d+)__/g;

function ptyError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 标记可能横跨两个数据块，所以末尾这段「也许还是前缀」的文本要先扣住。 */
function holdLength(buf) {
  let hold = 0;
  for (const head of HOLD_CANDIDATES) {
    const max = Math.min(buf.length, head.length - 1);
    for (let n = max; n > hold; n -= 1) {
      if (buf.endsWith(head.slice(0, n))) { hold = n; break; }
    }
  }
  return hold;
}

function buildLine(command, id, kind) {
  if (kind === 'cmd') return command + ' & echo ' + PLAIN_HEAD + id + '_%errorlevel%__';
  if (kind === 'powershell') {
    return command + '; Write-Host ([char]27+"]777;ai;' + id + ';" + $LASTEXITCODE + [char]7) -NoNewline';
  }
  return command + "; printf '\\033]777;ai;" + id + ";%d\\007' $?";
}

/** Windows 上 sshd 的 DefaultShell 可能是 cmd 也可能是 PowerShell，标记语法必须分支。 */
async function shellKindOf(target) {
  if (target.cache && target.cache.aiShellKind) return target.cache.aiShellKind;
  const info = await platformOf(target, PROBE_TIMEOUT_MS);
  let kind = 'posix';
  if (info.platform === 'windows') {
    kind = 'cmd';
    try {
      // cmd 会把这行原样吐回来，PowerShell 才会求值成版本号
      const out = await exec(target.client, '$PSVersionTable.PSVersion.Major', target.charset, PROBE_TIMEOUT_MS);
      if (/^\s*\d+\s*$/m.test(String(out.stdout || ''))) kind = 'powershell';
    } catch (_) { /* 保持 cmd */ }
  }
  if (target.cache) target.cache.aiShellKind = kind;
  return kind;
}

class PtyRunner {
  constructor({ ssh, log }) {
    this.ssh = ssh;
    this.runners = new Map(); // sessionId -> { queue, active }
    this.log = log;
    this._seq = 0;
  }

  _state(sessionId) {
    let st = this.runners.get(sessionId);
    if (!st) {
      st = { queue: Promise.resolve(), active: null };
      this.runners.set(sessionId, st);
    }
    return st;
  }

  /** 同一会话的 AI 命令串行执行，避免两条命令的输出流互相穿插。 */
  run(sessionId, command, opts = {}) {
    const st = this._state(sessionId);
    const task = st.queue.then(() => this._runOne(sessionId, command, opts));
    st.queue = task.catch(() => {});
    return task;
  }

  async _runOne(sessionId, command, opts) {
    const target = this.ssh.execTarget(sessionId);
    if (!target) throw ptyError('AI_SESSION_GONE', 'SSH session is not ready');
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 15000;
    const kind = await shellKindOf(target);
    const id = (this._seq += 1);
    const line = buildLine(command, id, kind);
    const meta = { sessionId, host: target.host, port: target.port, shell: kind };

    return new Promise((resolve, reject) => {
      let out = '';
      let buf = '';
      let exitCode = null;
      let settled = false;
      let filter = null;
      const started = Date.now();
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (filter) this.ssh.setOutputFilter(sessionId, null);
        const state = this.runners.get(sessionId);
        if (state && state.active && state.active.id === id) state.active = null;
        resolve(result);
      };
      const collect = (text) => {
        out += text;
        if (out.length > MAX_OUTPUT_CHARS) out = out.slice(0, MAX_OUTPUT_CHARS / 2) + '\n…(输出已截断)…\n' + out.slice(-MAX_OUTPUT_CHARS / 2);
      };
      filter = (text) => {
        buf += text;
        let forward = '';
        let last = 0;
        MARKER_RE.lastIndex = 0;
        let m;
        while ((m = MARKER_RE.exec(buf))) {
          forward += buf.slice(last, m.index);
          const foundId = Number(m[1] === undefined ? m[3] : m[1]);
          const code = Number(m[2] === undefined ? m[4] : m[2]);
          if (foundId === id) exitCode = Number.isFinite(code) ? code : null;
          last = MARKER_RE.lastIndex;
        }
        buf = buf.slice(last);
        const hold = exitCode === null ? holdLength(buf) : 0;
        forward += hold > 0 ? buf.slice(0, buf.length - hold) : buf;
        buf = hold > 0 ? buf.slice(-hold) : '';
        collect(forward);
        if (exitCode !== null) {
          finish({ stdout: out, exitCode, timedOut: false, ms: Date.now() - started });
          return '';
        }
        return forward;
      };
      const timer = setTimeout(() => {
        // 常驻程序（top/vim/前台服务）等不到标记：发 Ctrl-C 把终端还给用户
        this.ssh.write(sessionId, CTRL_C);
        this.log && this.log.warn('ai', 'ai terminal command timed out', { ...meta, timeoutMs, ms: Date.now() - started });
        finish({ stdout: out, exitCode: null, timedOut: true, ms: Date.now() - started });
      }, timeoutMs);

      const state = this.runners.get(sessionId);
      if (state) state.active = { id, started };
      this.ssh.setOutputFilter(sessionId, filter);
      try {
        this.ssh.write(sessionId, line + '\r');
      } catch (error) {
        this.ssh.setOutputFilter(sessionId, null);
        clearTimeout(timer);
        reject(ptyError('AI_WRITE_FAILED', error.message));
      }
    });
  }

  /** 用户点「停止」或会话销毁时，中断正在等待标记的命令。 */
  interrupt(sessionId) {
    const state = this.runners.get(sessionId);
    if (!state || !state.active) return false;
    this.ssh.write(sessionId, CTRL_C);
    this.log && this.log.info('ai', 'ai terminal command interrupted', { sessionId });
    return true;
  }

  stop(sessionId) {
    const state = this.runners.get(sessionId);
    if (!state) return;
    if (state.active) {
      try { this.ssh.write(sessionId, CTRL_C); } catch (_) {}
    }
    this.ssh.setOutputFilter(sessionId, null);
    this.runners.delete(sessionId);
  }

  stopOwner(ownerId) {
    for (const sessionId of [...this.runners.keys()]) {
      const target = this.ssh.execTarget(sessionId);
      if (!target || target.ownerId === ownerId) this.stop(sessionId);
    }
  }

  destroyAll() {
    for (const sessionId of [...this.runners.keys()]) this.stop(sessionId);
  }
}

module.exports = { PtyRunner };
