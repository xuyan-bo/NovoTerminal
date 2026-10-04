/**
 * AI 能调用的工具，以及「什么算只读」的判定。
 *
 * 判定分两层：先扫 shell 元字符（命令替换、后台、危险重定向、`;` `&&` `||`），
 * 再按管道逐段查表。表里 BARE 是任意参数都只读，SCOPED 必须匹配参数形状——
 * 因为 `env`、`ip`、`hostname`、`git branch`、`mount -a` 这类命令裸用是读、带特定参数就是写。
 *
 * 判不出来一律按写操作处理：宁可多弹一次确认。
 */

const { exec } = require('../ssh/exec');

/** 无害的重定向噪声：模型很爱写 2>/dev/null 与 2>&1，它们不改动任何东西。 */
const REDIRECT_NOISE = /(?:&|\d*>>?)\s*\/dev\/null|\d*>&\d+/g;
/** 命中任意一条就直接算写操作（在剥掉无害重定向之后再判）。 */
const UNSAFE = [
  /\$\(/, /`/, /;/, /&&/, /\|\|/, /[<>]/, /&/,
  /\b(rm|rmdir|mv|cp|dd|tee|touch|mkdir|ln|install|truncate|shred)\b/,
  /\b(chmod|chown|chgrp|setfacl)\b/,
  /\b(sudo|su|doas)\b/,
  /\b(kill|pkill|killall|skill)\b/,
  /\b(reboot|shutdown|halt|poweroff|init|mkfs|fdisk|parted|wipefs|umount)\b/,
  /\b(eval|exec|source)\b/,
];

/** 任意参数都只读的命令。 */
const BARE = new Set([
  'ls', 'll', 'cat', 'tac', 'zcat', 'bzcat', 'xzcat', 'wc', 'nl', 'head', 'cut', 'tr', 'uniq',
  'column', 'df', 'du', 'free', 'uptime', 'uname', 'id', 'whoami', 'who', 'w', 'ps', 'pgrep',
  'pidof', 'pwdx', 'ss', 'netstat', 'lsof', 'grep', 'egrep', 'fgrep', 'zgrep', 'tree', 'stat',
  'file', 'realpath', 'basename', 'dirname', 'readlink', 'which', 'whereis', 'type', 'nproc',
  'lscpu', 'lsmem', 'lsblk', 'lspci', 'lsusb', 'findmnt', 'blkid', 'getent', 'last', 'lastlog',
  'groups', 'locale', 'strings', 'od', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum', 'dig',
  'host', 'nslookup', 'printenv', 'mpstat', 'echo', 'printf',
]);

/** 只允许这些词出现在子命令位置（第一个非选项参数）。 */
const subs = (...allowed) => (args) => {
  if (!args.length) return false;
  const first = args.find((a) => !a.startsWith('-'));
  return !!first && allowed.includes(first);
};
/** 短选项簇也要查：`-qa` 里含 `a` 这种组合按命中处理。 */
const noFlags = (...bad) => (args) => !args.some((a) => bad.some((b) => (
  b.length === 2 && !a.startsWith('--')
    ? a === b || (a.startsWith('-') && a.slice(1).includes(b[1]))
    : a === b || a.startsWith(b)
)));
const noVerb = (...verbs) => (args) => !args.some((a) => verbs.includes(a));
const versionOnly = (args) => args.length > 0 && args.every((t) => ['-v', '-V', '--version', '-version', '-h', '--help'].includes(t));

const SCOPED = {
  // -f/-F 会常驻，等不到命令结束标记
  tail: { check: (a) => !a.some((t) => t === '--follow' || (/^-[0-9a-zA-Z]+$/.test(t) && /[fF]/.test(t))) },
  history: { check: noFlags('-c', '-w', '-d') },
  sort: { check: noFlags('-o', '--output', '--compress-program', '--random-source') },
  awk: { check: (a) => !a.some((t) => /system\s*\(/.test(t) || /getline/.test(t) || t === '-f' || t === '--file' || />/.test(t)) },
  sed: {
    check: (a) => {
      if (a.some((t) => t.startsWith('-i') || t === '--in-place' || t === '-f' || t === '--file')) return false;
      if (!a.some((t) => t === '-n' || t === '--quiet' || t === '--silent')) return false;
      const script = a.find((t) => !t.startsWith('-'));
      return !!script && /^[^;|&`$]*p\s*\/?$/.test(script);
    },
  },
  find: { check: noFlags('-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls') },
  env: { check: (a) => a.length === 0 },
  hostname: { check: (a) => !a.length || versionOnly(a) },
  hostnamectl: { check: subs('status', 'describe', 'hoststat') },
  timedatectl: { check: subs('status', 'show', 'list-timezones') },
  loginctl: { check: subs('status', 'show-user', 'user-status', 'list-sessions', 'list-users', 'show-session', 'session-status') },
  systemctl: {
    check: subs('status', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat', 'get-default',
      'list-units', 'list-unit-files', 'list-timers', 'list-jobs', 'list-dependencies', 'list-machines'),
  },
  journalctl: { check: noFlags('--rotate', '--vacuum', '--flush', '--sync', '--setup-keys', '-f', '--follow') },
  mount: {
    check: (a) => a.every((t) => t.startsWith('-'))
      && noFlags('-a', '--all', '-B', '--bind', '-L', '--label', '-U', '--uuid', '-M', '--move', '-o')(a),
  },
  route: { check: noVerb('add', 'del', 'delete', 'change', 'flush') },
  arp: { check: (a) => a.every((t) => ['-n', '-a', '-v', '-H'].includes(t)) },
  ifconfig: {
    check: (a) => a.filter((t) => !t.startsWith('-')).length <= 1
      && noVerb('up', 'down', 'promisc', 'multicast', 'allmulti', 'alias')(a),
  },
  ip: {
    check: (a) => subs('addr', 'address', 'a', 'route', 'r', 'link', 'l', 'neigh', 'n', 'tcp', 'rule', 'maddr', 'tunnel', 'vrf')(a)
      && noVerb('add', 'del', 'delete', 'set', 'change', 'replace', 'flush', 'append', 'prepend', 'new', 'modify', 'up', 'down')(a),
  },
  date: { check: noFlags('-s', '--set', '-f') },
  sysctl: { check: (a) => !a.some((t) => t === '-w' || t === '--write' || t === '-p' || t === '--load' || /=/.test(t)) },
  xxd: { check: noFlags('-r', '--recover') },
  sar: { check: noFlags('-o', '--output') },
  vmstat: { check: noFlags('-d') },
  iostat: { check: noFlags('-o') },
  ping: { check: (a) => a.some((t) => t === '-c' || t === '-n') && noFlags('-f')(a) },
  git: {
    check: (a) => {
      if (!subs('status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'ls-files', 'rev-list', 'cat-file', 'shortlog', 'blame', 'grep', 'remote', 'branch', 'tag', 'config')(a)) return false;
      const sub = a.find((t) => !t.startsWith('-'));
      if (sub === 'branch') return noFlags('-d', '-D', '-m', '-c', '-M', '-C', '--delete', '--move', '--copy', '--edit-description')(a);
      if (sub === 'tag') return noFlags('-d', '--delete', '-s', '--sign')(a);
      if (sub === 'config') {
        if (!noFlags('--unset', '--add', '--remove-section', '--rename-section', '--replace-all', '-f', '--file')(a)) return false;
        return a.slice(1).filter((t) => !t.startsWith('-')).length <= 1;
      }
      if (sub === 'remote') return noFlags('add', 'remove', 'rename', 'set-url', 'set-head', 'prune', 'update')(a);
      return true;
    },
  },
  docker: { check: (a) => subs('ps', 'images', 'inspect', 'logs', 'version', 'info', 'top', 'history', 'stats')(a) && noFlags('-f', '--follow', '--stream')(a) },
  kubectl: { check: (a) => subs('get', 'describe', 'logs', 'explain', 'version', 'api-resources', 'api-versions')(a) && noFlags('-f', '--follow')(a) },
  rpm: {
    check: (a) => a.some((t) => /^-q/.test(t) || t === '--query')
      && !a.some((t) => t.startsWith('-') && !/^-q/.test(t) && t !== '--query')
      && !a.some((t) => ['--install', '--upgrade', '--erase', '--import', '--rebuilddb', '--initdb'].includes(t)),
  },
  dnf: { check: subs('list', 'search', 'info', 'show', 'provides', 'whatprovides', 'repoinfo', 'repolist', 'repoquery', 'needs-restarting', 'version', 'history') },
  yum: { check: subs('list', 'search', 'info', 'show', 'provides', 'whatprovides', 'repolist', 'repoquery', 'history', 'version') },
  apt: { check: subs('list', 'show', 'search', 'depends', 'policy', 'madison') },
  'apt-get': { check: subs('changelog') },
  pip: { check: subs('list', 'show', 'freeze', 'check', 'version') },
  pip3: { check: subs('list', 'show', 'freeze', 'check', 'version') },
  npm: { check: subs('ls', 'list', 'view', 'outdated', 'why') },
  pnpm: { check: subs('ls', 'list', 'view', 'outdated', 'why') },
  yarn: { check: subs('list', 'info', 'why') },
  node: { check: versionOnly },
  python: { check: versionOnly },
  python3: { check: versionOnly },
  java: { check: versionOnly },
  go: { check: subs('version', 'env') },
  crontab: { check: (a) => a.includes('-l') && a.every((t, i) => t === '-l' || t === '-u' || a[i - 1] === '-u') },
  nvm: { check: subs('ls', 'list', 'current', 'version', 'which', 'alias') },
  // timeout 只是包一层时限，真正的判定在 readOnlySegment 里递归到内层命令
  timeout: { check: () => true },
};

/** 引号感知的切分：`grep -E 'a|b'` 里的竖线不能当管道分隔符。 */
function splitTop(text, sep) {
  const out = [];
  let cur = '';
  let quote = '';
  for (const ch of String(text)) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === sep) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 按未加引号的空白切词，并丢掉引号本身。 */
function tokenize(segment) {
  const out = [];
  let cur = '';
  let quote = '';
  let started = false;
  const flush = () => { if (started) { out.push(cur); cur = ''; started = false; } };
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    cur += ch;
    started = true;
  }
  flush();
  return out;
}

function readOnlySegment(rawSegment) {
  const parts = tokenize(rawSegment);
  if (!parts.length) return false;
  const [cmd, ...args] = parts;
  const name = cmd.replace(/^\/usr\/(bin|s?bin)\//, '');
  if (name === 'timeout') {
    const inner = parts.slice(1).filter((t, i) => !t.startsWith('-') && !(i === 0 && /^\d+(\.\d+)?[smhd]?$/.test(t)));
    return inner.length > 0 && readOnlySegment(inner.join(' '));
  }
  if (BARE.has(name)) return true;
  const scoped = Object.prototype.hasOwnProperty.call(SCOPED, name) ? SCOPED[name] : null;
  if (!scoped) return false;
  try {
    return scoped.check(args);
  } catch (_) {
    return false;
  }
}

function isReadOnly(command) {
  const text = String(command || '');
  if (!text.trim()) return false;
  const stripped = text.replace(REDIRECT_NOISE, ' ');
  if (UNSAFE.some((re) => re.test(stripped))) return false;
  return splitTop(stripped, '|').every((segment) => readOnlySegment(segment));
}

const TOOL_OUTPUT_LIMIT = 6000;

function aiToolError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 给模型的输出做长度收敛，头尾保留比只留头部更有用（报错通常在末尾）。 */
function clip(text, limit = TOOL_OUTPUT_LIMIT) {
  const s = String(text == null ? '' : text);
  if (s.length <= limit) return s;
  return s.slice(0, limit * 0.6) + '\n…(已截断 ' + (s.length - limit) + ' 字)…\n' + s.slice(-limit * 0.4);
}

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'run_in_terminal',
      description: '在用户当前可见的 SSH 终端里执行一条命令，等待命令结束并返回其输出。会占用用户的键盘，因此同一时间只跑一条。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令行，不要包含交互式程序的常驻运行；需要后台运行请自行加 nohup ... &' },
          rationale: { type: 'string', description: '一句话说明这条命令要做什么，会展示给用户确认' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_hidden',
      description: '在同一台主机上另开一条独立命令通道执行，不影响用户屏幕。缺点是不继承终端当前目录与交互状态，输出里没有彩色提示。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: '可选：执行前先进入的目录' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_terminal_screen',
      description: '读取用户终端当前可见的内容（含回滚缓冲），用于了解用户自己刚跑了什么。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/**
 * @param {object} ctx { pty, sessionId, target, cwd, settings, requestApproval, readScreen, log }
 */
function createTools(ctx) {
  const { pty, sessionId, target, cwd, settings, requestApproval, readScreen, log } = ctx;

  async function runTerminal(command, opts = {}) {
    const readOnly = isReadOnly(command);
    if (!settings.ptyControl) return runHidden(command, opts);
    if (!readOnly && settings.permission !== 'full') {
      const decision = await requestApproval({ name: 'run_in_terminal', command, readOnly, reason: opts.rationale || '' });
      if (decision === 'deny') return { channel: 'terminal', denied: true, text: '用户拒绝执行这条命令。不要重试同一条命令，改用只读方式获取信息或直接说明无法完成。' };
      if (decision === 'hidden') return runHidden(command, opts);
    }
    const started = Date.now();
    const result = await pty.run(sessionId, command, { timeoutMs: settings.commandTimeoutSec * 1000 });
    const meta = { host: target.host, port: target.port, ms: Date.now() - started, exitCode: result.exitCode, timedOut: result.timedOut };
    log && log.info('ai', 'ai terminal command finished', { ...meta, command: command.slice(0, 200) });
    const head = '退出码：' + (result.exitCode == null ? '未知' : result.exitCode)
      + (result.timedOut ? '（超过 ' + settings.commandTimeoutSec + ' 秒未结束，已发送 Ctrl+C 中断）' : '');
    return { channel: 'terminal', exitCode: result.exitCode, timedOut: result.timedOut, text: head + '\n' + clip(result.stdout) };
  }

  async function runHidden(command, opts = {}) {
    const readOnly = isReadOnly(command);
    if (!readOnly && settings.permission !== 'full') {
      const decision = await requestApproval({ name: 'run_hidden', command, readOnly, reason: opts.rationale || '' });
      if (decision === 'deny') return { channel: 'hidden', denied: true, text: '用户拒绝执行这条命令。' };
    }
    // 独立通道不继承交互 shell 的目录，所以默认落到渲染端报上来的终端 cwd；
    // 正则已排除单引号与反斜杠，这里再用单引号包住以兼容带空格的路径。
    const dir = typeof opts.cwd === 'string' && /^[\w./~ -]+$/.test(opts.cwd.trim()) ? opts.cwd.trim() : cwd;
    const line = dir ? "cd '" + dir + "' && " + command : command;
    const started = Date.now();
    let out;
    try {
      out = await exec(target.client, line, target.charset, settings.commandTimeoutSec * 1000, 'AI_EXEC_TIMEOUT');
    } catch (error) {
      log && log.warn('ai', 'ai hidden exec failed', { host: target.host, message: error.message, code: error.code });
      return { channel: 'hidden', text: '命令执行失败：' + error.message };
    }
    log && log.info('ai', 'ai hidden exec finished', { host: target.host, ms: Date.now() - started, command: command.slice(0, 200) });
    return { channel: 'hidden', text: clip(out.stdout) + (out.stderr ? '\n[stderr]\n' + clip(out.stderr, 2000) : '') };
  }

  async function invoke(call) {
    const args = call.args || {};
    if (call.name === 'run_in_terminal') {
      if (typeof args.command !== 'string' || !args.command.trim()) throw aiToolError('AI_ARGS', 'command required');
      return runTerminal(args.command.trim(), { rationale: typeof args.rationale === 'string' ? args.rationale.slice(0, 200) : '' });
    }
    if (call.name === 'run_hidden') {
      if (typeof args.command !== 'string' || !args.command.trim()) throw aiToolError('AI_ARGS', 'command required');
      return runHidden(args.command.trim(), { cwd: args.cwd });
    }
    if (call.name === 'read_terminal_screen') {
      const screen = await readScreen();
      return { channel: 'screen', text: screen ? clip(screen, 8000) : '（当前拿不到终端屏幕内容，可能面板未打开或会话已断开）' };
    }
    throw aiToolError('AI_UNKNOWN_TOOL', 'unknown tool: ' + String(call.name).slice(0, 60));
  }

  return { definitions: DEFINITIONS, invoke };
}

module.exports = { createTools };
