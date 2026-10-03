const { exec, platformOf } = require('./exec');

const PLATFORM_TIMEOUT_MS = 6000;
const CWD_TIMEOUT_MS = 3000;
const MAX_PATH_LEN = 4096;

/**
 * 交互 shell 的当前目录无法通过 SSH 查询：新开 exec 通道只会落在登录 shell 的家目录。
 * 这里改从进程树反查——我们的探测命令本身是这条连接的 sshd 后代，交互 shell 是同一个
 * sshd 下另一个持有 tty 的后代，读它的 /proc/<pid>/cwd 即可。
 *
 * 脚本必须整体裹在 /bin/sh 里：exec 通道是用登录 shell 执行的，fish/csh 不认 POSIX 展开。
 * 因此脚本内不能出现单引号。逐行读 /proc 用 read 重定向而非 cat，避免上百次 fork。
 * stat 字段按 ") " 之后重排：$1=state $2=ppid $3=pgrp $4=session $5=tty_nr。
 */
const LINUX_CWD_SCRIPT = [
  'p=$$',
  'f=',
  'i=0',
  'while [ $i -lt 12 ]; do',
  'IFS= read -r c 2>/dev/null < "/proc/$p/comm" || c=',
  'case $c in sshd*|dropbear*) f=1; break ;; esac',
  'IFS= read -r s 2>/dev/null < "/proc/$p/stat" || break',
  'r=${s##*) }',
  'set -- $r',
  'pp=$2',
  '[ -n "$pp" ] || break',
  '[ "$pp" != "$p" ] || break',
  'p=$pp',
  'i=$((i+1))',
  'done',
  '[ -n "$f" ] || exit 0',
  'pid=',
  'cur=$p',
  'i=0',
  'while [ $i -lt 12 ]; do',
  'next=',
  'for e in /proc/[0-9]*; do',
  'IFS= read -r s 2>/dev/null < "$e/stat" || continue',
  'r=${s##*) }',
  'set -- $r',
  '[ "$2" = "$cur" ] || continue',
  '[ "$5" = "0" ] && continue',
  'next=${e#/proc/}',
  'break',
  'done',
  '[ -n "$next" ] || break',
  'pid=$next',
  'cur=$next',
  'i=$((i+1))',
  'done',
  '[ -n "$pid" ] || exit 0',
  'cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || exit 0',
  'case $cwd in /*) printf "%s\\n" "$cwd" ;; esac',
  'exit 0',
].join('\n');

const LINUX_CWD_COMMAND = "/bin/sh -c '" + LINUX_CWD_SCRIPT + "'";

/** 远端路径只接受绝对路径；控制字符与超长值一律丢弃，避免把探测输出当路径用。 */
function sanitizeRemotePath(value) {
  if (typeof value !== 'string') return null;
  const lines = value.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const p = lines[i].trim();
    if (!p) continue;
    if (p.charAt(0) !== '/') return null;
    if (p.length > MAX_PATH_LEN) return null;
    /* eslint-disable-next-line no-control-regex */
    if (/[\x00-\x1f\x7f]/.test(p)) return null;
    return p;
  }
  return null;
}

/**
 * 反查这条 SSH 会话里交互 shell 的当前目录，失败返回 null（调用方回退家目录）。
 * 只有 Linux 有 /proc 可用；macOS 缺 /proc，Windows OpenSSH 既无 tty 也读不到别的进程 cwd。
 * @param {{ client: object, charset: string, cache?: object }} target SshSessionManager.execTarget() 的返回值
 */
async function probeRemoteCwd(target) {
  if (!target || !target.client) return null;
  const info = await platformOf(target, PLATFORM_TIMEOUT_MS);
  if (info.platform !== 'linux') return null;
  const out = await exec(target.client, LINUX_CWD_COMMAND, target.charset, CWD_TIMEOUT_MS, 'SSH_CWD_TIMEOUT');
  return sanitizeRemotePath(out.stdout);
}

module.exports = { probeRemoteCwd, sanitizeRemotePath };
