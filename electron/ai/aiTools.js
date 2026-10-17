/**
 * AI 能调用的工具，以及「什么算只读」的判定。
 *
 * 判定分三层：先扫一眼就要拦的构造（命令替换、反引号、重定向、破坏性命令名），
 * 再按未加引号的 `;` `&&` `||` `|` 换行断句，最后逐段查表。表里 BARE 是任意参数都只读，
 * SCOPED 必须匹配参数形状——因为 `env`、`ip`、`hostname`、`git branch`、`mount -a`
 * 这类命令裸用是读、带特定参数就是写。
 *
 * 表按 shell 分派：POSIX（Linux，以及 DefaultShell 是 Git-bash/Cygwin 的 Windows 主机）、
 * macOS（BSD 方言，`date 100512002026`、`log stream` 与 Linux 同名不同义）、
 * Windows（cmd 的 `/switch` 与 PowerShell 的 `Verb-Noun`）：同名命令在 Windows 上就是另一个
 * 程序，参数形状与 Linux 完全不同，所以命中 Windows 表即以它为准，不再回落到 POSIX 表。
 * 平台靠 `uname -s` + `cmd /c ver` 探测并缓存在 target 上；探测不到时按 POSIX 判，
 * 但形如 `/q` 这种一两个字母的斜杠参数一律要确认，避免 cmd 的写开关（`sort /O`）漏过去。
 *
 * `;` 这类控制符本身不再是写操作的证据（与 Codex/opencode/Gemini CLI 一致），
 * 但每一段都要独立通过判定；断句器遇到无法可靠解析的结构（子 shell 括号、裸 `&`、
 * `|&`、未闭合引号）直接放弃判定按写处理。判不出来宁可多弹一次确认。
 *
 * 有意不进白名单：包装执行类（`env <cmd>`、`chroot`、`nsenter`、`xargs`、`parallel`、`nice`、
 * `nohup`、`strace`、`perf`、`watch`、`time`）会把参数当命令跑；常驻或交互式（`less`、`more`、
 * `vi`、`top`、`htop`、`dstat`、`mtr`）等不到结束标记；`ldd` 实际会拿目标二进制跑
 * 一遍动态链接器；`mysql`/`psql`/`redis-cli` 的语句直接写在 argv 里，判不了。
 * `curl`/`wget`/`nc`/`nmap` 会对外发起请求，metadata 地址还能钓出临时凭证，全部保持要确认。
 * Windows 自带 curl.exe，PowerShell 里 `curl`/`wget` 还是 Invoke-WebRequest 的别名，同样不在表里。
 */

const iconv = require('iconv-lite');
const { exec, platformOf } = require('../ssh/exec');

/** 日志只记命令名与长度：整条命令行常带明文口令（mysql -p…、curl -u…），不能进持久化日志。 */
function commandBrief(text) {
  const raw = String(text || '');
  const first = raw.trim().split(/\s+/)[0] || '';
  return (first.slice(0, 40) || '(empty)') + ' len=' + raw.length;
}

/** 探测平台要在判定之前拿到，但不能把用户等确认的时间拖长。 */
const PLATFORM_PROBE_TIMEOUT_MS = 4000;

/** 无害的重定向噪声：模型很爱写 2>/dev/null 与 2>&1，它们不改动任何东西；`&>` 要整块剥，留下裸 `&` 会被断句器判成后台执行。 */
const REDIRECT_NOISE = /(?:&>>?|\d*>>?)\s*\/dev\/null|\d*>&\d+/g;
/** Windows 的丢弃黑洞是 `nul`；POSIX 下 `nul` 是普通文件名，所以这张噪声表只在 windows 族用。 */
const REDIRECT_NOISE_WIN = /(?:&>>?|\d*>>?)\s*nul\b|\d*>&\d+/gi;
/** 命中任意一条就直接算写操作（在剥掉无害重定向之后再判）。 */
const UNSAFE = [
  /\$\(/, /\$['"]/, /`/, /[<>]/,
  /\b(rm|rmdir|mv|cp|dd|tee|touch|mkdir|ln|install|truncate|shred)\b/,
  /\b(chmod|chown|chgrp|setfacl)\b/,
  /\b(sudo|su|doas)\b/,
  /\b(kill|pkill|killall|skill)\b/,
  /\b(reboot|shutdown|halt|poweroff|init|mkfs|fdisk|parted|wipefs|umount)\b/,
  /\b(eval|exec|source)\b/,
];

/** 任意参数都只读的命令：既不落盘，也不会常驻。带输出文件选项的工具（tree/uniq/jq…）都放 SCOPED。 */
const BARE = new Set([
  'ls', 'll', 'cat', 'tac', 'zcat', 'bzcat', 'xzcat', 'wc', 'nl', 'head', 'cut', 'tr',
  'column', 'df', 'du', 'free', 'uptime', 'uname', 'id', 'whoami', 'who', 'w', 'ps', 'pgrep',
  'pidof', 'pwdx', 'pwd', 'ss', 'netstat', 'lsof', 'grep', 'egrep', 'fgrep', 'zgrep', 'stat',
  'file', 'realpath', 'basename', 'dirname', 'readlink', 'which', 'whereis', 'type', 'nproc',
  'lscpu', 'lsmem', 'lsblk', 'lspci', 'lsusb', 'findmnt', 'blkid', 'getent', 'last', 'lastlog', 'lastb',
  'groups', 'locale', 'strings', 'od', 'hexdump', 'dig', 'host', 'nslookup', 'printenv', 'echo',
  'printf', 'dpkg-query', 'apt-cache', 'ipcs', 'rpcinfo', 'nstat',
  // 比对与文本加工：只能读到标准输出，没有落盘入口
  'diff', 'cmp', 'comm', 'seq', 'paste', 'fold', 'rev', 'locate',
  // 内核模块与 SELinux/ACL/属性读取（对应的写命令 setfacl/chattr 已在 UNSAFE 或不在表里）
  'lsmod', 'modinfo', 'getenforce', 'sestatus', 'getfacl', 'lsattr',
  // 二进制与符号查看
  'readelf', 'objdump', 'nm', 'size', 'addr2line', 'c++filt',
  // JVM 快照：jmap 会 dump 堆、jinfo 能改 flag，都另立 SCOPED
  'jps', 'jstat', 'jstack',
  // 网络探测：与 ping 同一档，只发包不改主机
  'traceroute', 'tracepath',
]);

/** 只允许这些词出现在子命令位置（第一个非选项参数）。 */
const subs = (...allowed) => (args) => {
  if (!args.length) return false;
  const first = args.find((a) => !a.startsWith('-'));
  return !!first && allowed.includes(first);
};
/** 裸用本身就是「列出/看状态」的控制器：无参数、只带版本或帮助 flag，或子命令在白名单内。 */
const statusOnly = (...allowed) => (args) => !args.length || versionOnly(args) || subs(...allowed)(args);
/** 单个 token 是否命中某个 flag：长选项看前缀（`--output=x`），短选项要拆开簇并跳过反斜杠。 */
function flagHit(token, bad) {
  if (bad.length > 2) return token === bad || token.startsWith(bad);
  if (token.startsWith('--')) return false;
  if (!token.startsWith('-')) return false;
  // token 是选项簇或「选项+贴身值」（`-c5`、`-t5`）：反斜杠转义的下一个字符不参与簇匹配
  const letters = token.slice(1).replace(/\\./g, '\\');
  return /^[\w-]+$/.test(token.slice(1)) && letters.includes(bad.slice(1));
}
/** 短选项簇也要查：`-qa` 里含 `a` 这种组合按命中处理。 */
const noFlags = (...bad) => (args) => !args.some((a) => bad.some((b) => flagHit(a, b)));
/** 反过来用：动作全藏在选项里的命令（tar -t、tcpdump -c）必须命中一个读动作才算只读。 */
const hasAny = (...wanted) => (args) => args.some((a) => wanted.some((w) => flagHit(a, w)));
const positional = (args) => args.filter((t) => !t.startsWith('-'));
/** `vmstat 1`、`iostat 1`、`mpstat -P ALL 1` 给了间隔却不给次数就永远不返回，只能拦下。 */
const needsCount = (args) => positional(args).filter((t) => /^\d+(\.\d+)?$/.test(t)).length !== 1;
const noVerb = (...verbs) => (args) => !args.some((a) => verbs.includes(a));
const versionOnly = (args) => args.length > 0 && args.every((t) => ['-v', '-V', '--version', '-version', '-h', '--help'].includes(t));

const DPKG_READ = ['-l', '--list', '-s', '--status', '-L', '--listfiles', '-S', '--search', '--get-selections', '--print-architecture'];const DPKG_WRITE = ['-i', '--install', '--unpack', '-r', '--remove', '-P', '--purge', '--configure',
  '-x', '--extract', '-e', '--control', '-b', '--build', '-G', '--add-architecture',
  '--remove-architecture', '--set-selections', '--clear-selections', '--register'];

/** nginx 只在这些开关下是纯查询：-v/-V 报版本与编译参数，-h 用法，-t/-T 检查并转储配置。 */
const NGINX_READ = ['-v', '-V', '-t', '-T', '-h', '--version', '--help'];

const SCOPED = {
  // -f/-F 会常驻，等不到命令结束标记
  tail: { check: (a) => !a.some((t) => t === '--follow' || (/^-[0-9a-zA-Z]+$/.test(t) && /[fF]/.test(t))) },
  history: { check: noFlags('-c', '-w', '-d') },
  sort: { check: noFlags('-o', '--output', '--compress-program', '--random-source') },
  // tree 的 -o 会把目录树写成文件
  tree: { check: noFlags('-o', '--output') },
  // `uniq a b` 的第二位置参数是输出文件，只有至多一个输入文件才纯读
  uniq: { check: (a) => positional(a).length <= 1 },
  // awk 的脚本在引号内，断句器不会把 `print x | "cmd"` 的管道拆出来，`|` 与 `>` 都要在这里挡；
  // getline 与 -i/--in-place 会改文件，system() 直接起进程。
  awk: {
    check: (a) => !a.some((t) => /system\s*\(/.test(t) || /getline/.test(t) || t.startsWith('-f') || t.startsWith('--file') || t.startsWith('-i') || /[|<>]/.test(t)),
  },
  sed: {
    check: (a) => {
      if (a.some((t) => t.startsWith('-i') || t.startsWith('--in-place') || t.startsWith('-f') || t.startsWith('--file'))) return false;
      if (!a.some((t) => t === '-n' || t === '--quiet' || t === '--silent')) return false;
      const script = a.find((t) => !t.startsWith('-'));
      return !!script && /^[^;|&`$]*p\s*\/?$/.test(script);
    },
  },
  find: { check: noFlags('-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls') },
  env: { check: (a) => a.length === 0 },
  hostname: { check: (a) => !positional(a).length && noFlags('-F', '--file', '-b', '--bootproto')(a) },
  hostnamectl: { check: statusOnly('status', 'describe', 'hoststat') },
  timedatectl: { check: statusOnly('status', 'show', 'list-timezones') },
  loginctl: { check: statusOnly('status', 'show-user', 'user-status', 'list-sessions', 'list-users', 'show-session', 'session-status') },
  systemctl: {
    check: statusOnly('status', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat', 'get-default',
      'list-units', 'list-unit-files', 'list-timers', 'list-jobs', 'list-dependencies', 'list-machines'),
  },
  journalctl: { check: noFlags('--rotate', '--vacuum', '--flush', '--sync', '--setup-keys', '-f', '--follow') },
  // nginx 裸跑就是起服务（常驻前台/写 pid），必须带纯查询开关；-s 发信号、-c/-g/-p/-e 改运行参数都算写
  nginx: { check: (a) => a.length > 0 && a.every((t) => NGINX_READ.includes(t)) },
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
  sar: { check: (a) => noFlags('-o', '--output')(a) && needsCount(a) },
  vmstat: { check: (a) => noFlags('-d')(a) && needsCount(a) },
  iostat: { check: (a) => noFlags('-o')(a) && needsCount(a) },
  mpstat: { check: needsCount },
  pidstat: { check: needsCount },
  // 不计时就永远发下去，必须给 -c 或 -w 才能自动放行
  ping: { check: (a) => hasAny('-c', '--count', '-w', '--timeout', '--deadline')(a) && noFlags('-f', '--flood')(a) },
  git: {
    check: (a) => {
      if (!subs('status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'ls-files', 'rev-list', 'cat-file', 'shortlog', 'blame', 'grep', 'remote', 'branch', 'tag', 'config')(a)) return false;
      const sub = a.find((t) => !t.startsWith('-'));
      if (sub === 'branch') return noFlags('-d', '-D', '-m', '-c', '-M', '-C', '--delete', '--move', '--copy', '--edit-description')(a);
      // 造 tag 的参数一个都不许出现：-a/-A/-s 生成对象，-u/-F/-c/-e 签名与编辑，-d 才是删
      if (sub === 'tag') {
        if (!noFlags('-a', '-A', '-s', '-d', '-u', '-F', '-c', '-e', '--delete', '--sign', '--cleanup', '--create-reflog')(a)) return false;
        return positional(a.slice(1)).length === 0 || hasAny('-l', '--list')(a);
      }
      if (sub === 'config') {
        if (!noFlags('--unset', '--add', '--remove-section', '--rename-section', '--replace-all', '-f', '--file')(a)) return false;
        return a.slice(1).filter((t) => !t.startsWith('-')).length <= 1;
      }
      if (sub === 'remote') return noFlags('add', 'remove', 'rename', 'set-url', 'set-head', 'prune', 'update')(a);
      // diff/log/show 的 --output 会把正文写成文件，其余只读子命令不带这个选项
      if (sub === 'diff' || sub === 'log' || sub === 'show') return noFlags('--output')(a);
      return true;
    },
  },
  docker: {
    check: (a) => {
      // `docker compose` 是二级命令，第一个非选项词是 compose，得单独看它的动作
      if (a[0] === 'compose') return subs('ps', 'images', 'config', 'top', 'version')(a.slice(1)) && noFlags('-f', '--follow')(a);
      if (!subs('ps', 'images', 'inspect', 'logs', 'version', 'info', 'top', 'history', 'stats', 'diff', 'port')(a)) return false;
      // stats 不加 --no-stream 就常驻刷新
      if (a[0] === 'stats') return hasAny('--no-stream')(a);
      return noFlags('-f', '--follow', '--stream')(a);
    },
  },
  podman: {
    check: (a) => subs('ps', 'images', 'inspect', 'logs', 'version', 'info', 'top', 'history')(a)
      && noFlags('-f', '--follow')(a),
  },
  'docker-compose': {
    check: (a) => subs('ps', 'images', 'config', 'top', 'version')(a) && noFlags('-f', '--follow')(a),
  },
  kubectl: {
    check: (a) => subs('get', 'describe', 'logs', 'explain', 'version', 'api-resources', 'api-versions')(a)
      // --watch 会一直挂着等事件，与 tail -f 同类；--raw 直接打 API Server 任意路径，能取到 Secret 正文
      && noFlags('-f', '--follow', '-w', '--watch', '--watch-only', '--raw')(a),
  },
  rpm: {
    check: (a) => a.some((t) => /^-q/.test(t) || t === '--query')
      && !a.some((t) => t.startsWith('-') && !/^-q/.test(t) && t !== '--query')
      && !a.some((t) => ['--install', '--upgrade', '--erase', '--import', '--rebuilddb', '--initdb'].includes(t)),
  },
  // dpkg 的动作藏在选项里（-l 列、-i 装），所以判「必须带读动作、且不带任何写动作」。
  // -x/-e 会把包解到目录，-b 造包，--set-selections/--add-architecture 改状态文件，都算写。
  dpkg: { check: (a) => a.some((t) => DPKG_READ.includes(t)) && noFlags(...DPKG_WRITE)(a) },
  // dpkg-deb 看包内容（-c 列目录、-I 看 control）；-x/-X 解包、-e 抽 control、-b 造包都要确认
  'dpkg-deb': { check: (a) => hasAny('-c', '--contents', '-I', '--info')(a) && noFlags('-x', '-X', '-e', '-b', '--extract', '--vextract', '--control', '--build')(a) },
  // 校验和工具带 --write 会把摘要写回文件（coreutils 8.3+）
  md5sum: { check: noFlags('-w', '--write') },
  sha1sum: { check: noFlags('-w', '--write') },
  sha224sum: { check: noFlags('-w', '--write') },
  sha256sum: { check: noFlags('-w', '--write') },
  sha384sum: { check: noFlags('-w', '--write') },
  sha512sum: { check: noFlags('-w', '--write') },
  b2sum: { check: noFlags('-w', '--write') },
  dnf: { check: (a) => subs('list', 'search', 'info', 'show', 'provides', 'whatprovides', 'repoinfo', 'repolist', 'repoquery', 'needs-restarting', 'version', 'history')(a) && noVerb('undo', 'rollback', 'redo')(a) },
  yum: { check: (a) => subs('list', 'search', 'info', 'show', 'provides', 'whatprovides', 'repolist', 'repoquery', 'history', 'version')(a) && noVerb('undo', 'rollback', 'redo')(a) },
  apt: { check: subs('list', 'show', 'search', 'depends', 'policy', 'madison') },
  'apt-get': { check: subs('changelog') },
  // `pip cache` 是子命令树，list/dir/info 只读、purge/remove 会删缓存
  pip: {
    check: (a) => {
      if (!subs('list', 'show', 'freeze', 'check', 'version', 'cache')(a)) return false;
      if (positional(a)[0] !== 'cache') return noVerb('install', 'uninstall', 'purge', 'remove')(a);
      return ['list', 'dir', 'info'].includes(positional(a)[1]);
    },
  },
  pip3: {
    check: (a) => {
      if (!subs('list', 'show', 'freeze', 'check', 'version', 'cache')(a)) return false;
      if (positional(a)[0] !== 'cache') return noVerb('install', 'uninstall', 'purge', 'remove')(a);
      return ['list', 'dir', 'info'].includes(positional(a)[1]);
    },
  },
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

  // 语言与包管理的查询子命令（安装/卸载类动词一律不进表）
  'apt-config': { check: subs('dump', 'shell') },
  gem: { check: subs('list', 'search', 'info', 'specification', 'query', 'which', 'environment', 'env') },
  conda: { check: (a) => subs('list', 'info', 'search', 'env')(a) && noVerb('install', 'remove', 'update', 'create', 'clean')(a) },
  cargo: { check: subs('tree', 'metadata', 'version', 'locate-project', 'help') },

  // 归档与压缩：只有「列目录/校验」模式算读，解包与压包都会落盘
  tar: {
    check: (a) => hasAny('-t', '--list')(a) && noFlags(
      '-x', '-c', '-r', '-u', '--get', '--extract', '--create', '--append', '--update', '--delete',
      '--to-command', '--checkpoint', '--checkpoint-action', '--use-compress-program')(a),
  },
  gzip: { check: (a) => hasAny('-l', '--list', '-t', '--test')(a) && noFlags('-d', '-z', '-f', '-k', '--decompress', '--uncompress', '--compress', '--force', '--keep')(a) },
  bzip2: { check: (a) => hasAny('-l', '--list', '-t', '--test')(a) && noFlags('-d', '-z', '-f', '-k', '--decompress', '--compress', '--force', '--keep')(a) },
  xz: { check: (a) => hasAny('-l', '--list', '-t', '--test')(a) && noFlags('-d', '-z', '-f', '-k', '--decompress', '--compress', '--force', '--keep')(a) },
  zstd: { check: (a) => hasAny('-l', '--list', '-t', '--test')(a) && noFlags('-d', '-z', '-f', '-o', '--decompress', '--compress', '--force', '--output', '--rm')(a) },
  unzip: { check: (a) => hasAny('-l', '--list', '-t', '--test', '-Z', '--zipinfo')(a) && noFlags('-d', '--directory', '-DD')(a) },

  // 只往标准输出写内容的工具：出现输出文件选项就要确认
  jq: { check: noFlags('-o', '--output-file') },
  base64: { check: noFlags('-o', '--output') },
  iconv: { check: noFlags('-o', '--output') },

  // 内核与硬件
  dmesg: { check: noFlags('-C', '-c', '-n', '-w', '--clear', '--read-clear', '--console-level', '--console-off', '--console-on', '--follow') },
  dmidecode: { check: noFlags('--dump-bin', '--lock-memory') },
  lshw: { check: noFlags('-dump', '--output') },
  smartctl: { check: noFlags('-t', '-s', '-o', '-S', '--test', '--set', '--write', '--smartdisable', '--smartenable') },
  'nvidia-smi': {
    check: noFlags('-l', '-r', '-c', '-e', '-f', '-pm', '-lgc', '-rgc', '-pl', '--loop', '--loop-until',
      '--gpu-reset', '--reset', '--persistencemode', '--compute-mode', '--ecc-setting', '--drain',
      '--lock-gpu-clocks', '--reset-gpu-clocks', '--power-limit'),
  },
  lvs: { check: noFlags('--config', '--generate-config', '-f', '--force') },
  pvs: { check: noFlags('--config', '--generate-config', '-f', '--force') },
  vgs: { check: noFlags('--config', '--generate-config', '-f', '--force') },

  // 网络配置查看：写动作全在子命令或 -A/-I/-D 这类选项里
  iptables: {
    check: (a) => hasAny('-L', '-S', '--list', '--list-rules')(a)
      && noFlags('-A', '-I', '-D', '-F', '-N', '-X', '-Z', '-R', '-P', '--append', '--insert',
        '--delete', '--flush', '--new-chain', '--delete-chain', '--zero', '--policy', '--replace')(a),
  },
  'iptables-save': { check: noFlags('-f', '-o', '--output') },
  nft: { check: (a) => subs('list')(a) && noFlags('-f', '--file', '-i')(a) },
  ufw: { check: (a) => subs('status', 'show', 'version')(a) && positional(a).length <= 2 },
  'firewall-cmd': {
    check: (a) => hasAny('--list', '--get', '--state', '--info', '--query')(a)
      && noFlags('--add', '--remove', '--change', '--new', '--delete', '--set', '--reload')(a),
  },
  // nmcli 的模块名前面常跟着 `-t -f 字段`，所以模块名不要求出现在首个非选项位
  nmcli: {
    check: (a) => a.some((t) => ['device', 'dev', 'connection', 'con', 'network', 'net', 'general', 'g'].includes(t))
      && noVerb('connect', 'reconnect', 'disconnect', 'reapply', 'edit', 'delete', 'add', 'modify', 'set',
        'up', 'down', 'reload', 'apply', 'checkpoint', 'on', 'off')(a),
  },
  tcpdump: { check: (a) => hasAny('-c', '--count')(a) && noFlags('-w', '--write', '-W', '-C', '-z', '--post-command')(a) },

  // 证书与摘要：openssl x509 不带 -out 只往标准输出打印；s_client 会挂住交互，不在子命令里
  openssl: {
    check: (a) => subs('x509', 'ciphers', 'dhparam', 'dgst', 'mac', 'version', 'list')(a)
      && noFlags('-out', '-keyout', '-passout', '-CAcreateserial', '-newkey', '-certout', '-out_file')(a),
  },

  // 虚拟化、集群与运行时诊断的只读子命令
  virsh: {
    check: (a) => subs('list', 'dominfo', 'domstate', 'dumpxml', 'netlist', 'nodenames', 'capabilities', 'version')(a)
      && noVerb('destroy', 'shutdown', 'reboot', 'start', 'undefine', 'define', 'setmaxmem', 'attach', 'detach')(a),
  },
  helm: { check: subs('list', 'ls', 'status', 'version', 'history', 'show') },
  'systemd-analyze': { check: subs('blame', 'time', 'critical-chain', 'calendar', 'verify') },
  localectl: { check: statusOnly('status', 'list-x11', 'list-x11-printable', 'list-keymaps', 'list-locales') },
  faillock: { check: noFlags('--reset', '-r') },
  jmap: { check: (a) => hasAny('-histo')(a) && noFlags('-dump', '-F')(a) },
};

/**
 * macOS 专有只读命令。同名的 BSD 工具与 Linux 不同义（`date` 带位置参数是设时钟，
 * `log`/`say`/`open` 在 Linux 表里根本不存在），所以这张表先查，命中即以它为准，
 * 没命中的名字才落回 POSIX 表。
 */
const MAC_BARE = new Set([
  'sw_vers', 'mdfind', 'mdls', 'kextstat', 'otool',
]);

const MAC_SCOPED = {
  // BSD date：位置参数是「设时钟」，`-v`/`-a` 这类调整型 flag 同样落时钟（flagHit 拆不开 `-v+1d`，只能自己扫）；
  // 带 `-j` 的写法只打印换算结果，可以放行。
  date: {
    check: (a) => {
      if (hasAny('-j')(a)) return true;
      if (a.some((t) => /^-[aAcdehmvy]/.test(t))) return false;
      return !positional(a).some((t) => /^\d/.test(t)) && noFlags('-s', '--set')(a);
    },
  },
  // vm_stat 给了间隔却不带 `-c 次数` 就永远不返回（`vm_stat 5`、`vm_stat -s 5` 都会挂着）
  vm_stat: { check: (a) => hasAny('-c')(a) || (noFlags('-s')(a) && !positional(a).some((t) => /^\d/.test(t))) },
  ioreg: { check: noFlags('-w', '-W') },
  launchctl: {
    check: (a) => statusOnly('list', 'print', 'print-cache', 'procinfo', 'info', 'explain', 'version', 'help')(a)
      && noFlags('-w', '--wait')(a),
  },
  // networksetup 的读动作全在 `-get*` / `-list*` 里，`-set*`、`-copyNetworkSettings` 都会写 plist
  networksetup: { check: (a) => a.length > 0 && /^-(get|list)[a-z]/i.test(a[0]) && positional(a).length <= 2 },
  dscl: {
    check: (a) => hasAny('-read', '-list', '-search')(a)
      && noFlags('-create', '-delete', '-change', '-append', '-merge', '-passwd', '-f', '--file')(a),
  },
  pmset: {
    check: (a) => (hasAny('-g')(a) && noFlags('-a', '-b', '-i', '-o', '-u', '-F', '-x')(a))
      || (a[0] === 'log' && a.length === 1),
  },
  diskutil: {
    check: statusOnly('list', 'info', 'infoDisk', 'infoPartition', 'infoPlists', 'description',
      'verifyDisk', 'verifyVolume', 'findMedia', 'help'),
  },
  defaults: { check: (a) => subs('read', 'read-type', 'domains')(a) && positional(a).length <= 3 },
  // log stream 会一直挂着，log collect/erase 写归档或删日志
  log: { check: (a) => subs('show', 'stats')(a) },
  nvram: {
    check: (a) => !a.some((t) => t.includes('=')) && noFlags('-d', '-f', '-u', '-w', '--delete', '--file', '--write')(a)
      && positional(a).length <= 3,
  },
  softwareupdate: {
    check: (a) => hasAny('-l', '--list', '--history')(a)
      && noFlags('-i', '-I', '--install', '--reinstall', '--erase-install', '--fetch-full-installer')(a),
  },
  csrutil: { check: statusOnly('status') },
  // scutil 裸用是交互 REPL；--set 写配置，都得确认
  scutil: {
    check: (a) => hasAny('--nwi', '--get', '--show', '--list', '--version')(a)
      && noFlags('--set', '--persistent', '--comment')(a),
  },
  codesign: {
    check: (a) => hasAny('-d', '--display', '--verify', '-v', '--verbose')(a)
      && noFlags('-s', '--sign', '--remove', '-f', '--force', '--preserve-metadata', '--entitlements', '--generate-entitlement-der')(a),
  },
  brew: {
    check: (a) => {
      if (!a.length || !positional(a).length) return true; // brew / brew --version / brew --prefix
      if (positional(a)[0] === 'services') return a[1] === 'list';
      if (!subs('list', 'info', 'home', 'deps', 'missing', 'config', 'doctor', 'search', 'cat', 'leaves', 'outdated')(a)) return false;
      return noVerb('install', 'uninstall', 'reinstall', 'upgrade', 'update', 'tap', 'untap', 'cleanup',
        'link', 'unlink', 'pin', 'unpin', 'remove')(a);
    },
  },
  system_profiler: { check: noFlags('-outputFilePath', '-jsonFilePath', '-catalog') },
  pkgutil: {
    check: (a) => hasAny('--pkgs', '--files', '--check', '--volume-info', '--history')(a)
      && noFlags('--expand', '--cleanup', '--forget', '--install', '--flatten', '--rebuild', '--register')(a),
  },
  spctl: {
    check: (a) => hasAny('--assess', '--status')(a)
      && noFlags('--add', '--remove', '--enable', '--disable', '--save', '--load')(a),
  },
};

/** 同名命令在两个 shell 里含义相反（POSIX `open` 是 GNU coreutils 的找文件，macOS `open` 启动 App）。 */
const MAC_DENY = new Set(['open', 'say']);

/** Windows 侧选项匹配：cmd 用 `/x`、PowerShell 用 `-Name`，两者都大小写不敏感。 */
function winHit(token, wanted) {
  const t = String(token).toLowerCase();
  const w = String(wanted).toLowerCase();
  return t === w || t.startsWith(w);
}
const winNo = (...bad) => (args) => !args.some((a) => bad.some((b) => winHit(a, b)));
const winHas = (...wanted) => (args) => args.some((a) => wanted.some((b) => winHit(a, b)));

/** cmd 里任意参数都只读的工具。 */
const WIN_BARE = new Set([
  'ver', 'vol', 'systeminfo', 'tasklist', 'driverquery', 'quser', 'qwinsta', 'getmac',
  'dir', 'fc', 'findstr', 'tree', 'where', 'tracert', 'pathping',
]);

const WIN_SCOPED = {
  // cmd 的 date/time 裸用会反过来提示输入新值，只有 /t 是打印；PowerShell 用 Get-Date
  date: { check: (a) => winHas('/t')(a) },
  time: { check: (a) => winHas('/t')(a) },
  chcp: { check: (a) => !positional(a).length },
  set: { check: (a) => !positional(a).length },
  path: { check: (a) => !positional(a).length },
  // cmd 的 sort 用 /O 把结果写成文件，PowerShell 的 Sort-Object 用 -OutputPath
  sort: { check: winNo('/o', '-o', '-outputpath') },
  ipconfig: { check: winNo('/release', '/renew', '/flushdns', '/registerdns', '/setclassid', '/showclassid') },
  route: { check: (a) => a.length > 0 && winHit(a[0], 'print') && winNo('-f', '/f')(a) },
  arp: { check: (a) => winHas('-a', '/a', '-g', '/g')(a) && winNo('-d', '/d', '-delete', '/delete')(a) },
  nslookup: { check: (a) => positional(a).length >= 1 && positional(a).length <= 3 },
  ping: { check: (a) => winHas('-n', '/n')(a) && winNo('-t', '/t')(a) },
  // icacls/cacls 裸用是查看 ACL，写动作全藏在 /grant /p /setowner 这类开关里
  icacls: {
    check: winNo('/grant', '/g', '/d', '/deny', '/setowner', '/so', '/inheritance', '/i',
      '/remove', '/r', '/reset', '/save', '/from', '/chop', '/override', '/ov'),
  },
  cacls: { check: winNo('/p', '/r', '/e', '/d') },
  attrib: { check: (a) => !a.some((t) => /^[+-]/.test(t)) },
  net: {
    check: (a) => subs('share', 'user', 'localgroup', 'globalgroup', 'config', 'session',
      'statistics', 'stats', 'view', 'time', 'help', 'accounts', 'domain', 'sent', 'files')(a)
      && winNo('/add', '/delete', '/del')(a)
      && noVerb('start', 'stop', 'pause', 'continue', 'use', 'disconnect', 'rename')(a),
  },
  // cmd 的 sc 是服务控制，只读动作是 query 一族；PowerShell 里 sc 是 Set-Content，
  // 带这些子命令过去只会因为缺参数报错，两边都不会写东西
  sc: { check: (a) => subs('query', 'queryex', 'qc', 'qs', 'enumdepend', 'showsids', 'help')(a) },
  reg: { check: (a) => subs('query', 'compare')(a) },
  schtasks: {
    check: (a) => a.length > 0 && winHit(a[0], '/query') && winNo('/create', '/delete', '/change', '/run', '/end', '/xml', '/ru', '/rp')(a),
  },
  vssadmin: { check: (a) => /^list/i.test(a[0] || '') && winNo('/quiet', '/forcerestart', '/noprompt')(a) },
  // wmic 的 /output:/append: 会把查询结果写成文件，比 call/create 更隐蔽
  wmic: {
    check: (a) => winHas('get', 'list')(a)
      && noVerb('call', 'create', 'delete', 'set', 'associate', 'put', 'subscribe')(a)
      && winNo('/output', '/append', '/failfast', '/trace')(a),
  },
  gpresult: { check: (a) => winNo('/h', '/x', '/f', '/force', '/report')(a) && winHas('/r', '/v', '/scope')(a) },
  powercfg: {
    check: (a) => winHas('/list', '/query')(a)
      && winNo('/change', '/setactive', '/delete', '/setac', '/setdc', '/import', '/restoredefaultschemes', '/name', '/duplicatescheme')(a),
  },
};

/**
 * cmd/PowerShell 里名字本身就带破坏性、或裸用会挂住等输入的命令，判 false 后不再落回 POSIX 表
 * （POSIX 表里没有 `more`/`start`，落回去反而要确认，这里明确列出来是为了让口径写在纸面上）。
 */
const WIN_DENY = new Set([
  'open', 'say', 'start', 'control', 'msiexec', 'regsvr32', 'cscript', 'wscript', 'more', 'tracecert',
]);

/** PowerShell 里动词本身只读的 cmdlet；Out/Format/Write 有会落盘或弹交互的特例，单独列。 */
const PS_READ_VERBS = ['Get', 'Test', 'Measure', 'Compare', 'Select', 'Where', 'Group', 'Sort', 'ConvertTo', 'ConvertFrom', 'Resolve', 'Split', 'Join'];
const PS_READ_NAMES = [
  'Format-List', 'Format-Table', 'Format-Custom', 'Format-Wide',
  'Write-Host', 'Write-Output', 'Write-Verbose', 'Write-Warning', 'Write-Information', 'Write-Debug',
];
/** 明确写文件、执行代码或弹窗/常驻的 cmdlet（小写比对，PowerShell 大小写不敏感）。 */
const PS_DENY_NAMES = new Set([
  'out-file', 'out-gridview', 'out-printer', 'tee-object', 'add-content', 'set-content', 'clear-content',
  'get-credential', 'format-volume', 'format-filerecord', 'convertto-securestring',
]);
const PS_READ_ALIASES = new Set([
  'gci', 'gi', 'gp', 'gt', 'gps', 'gcm', 'gm', 'gmo', 'gl', 'sls', 'select', 'measure', 'ps',
  'ls', 'dir', 'cat', 'type', 'echo', 'write', 'compare', 'group',
  // `help`/`man` 是 Get-Help 的包装函数，会走 Out-Host -Paging 等按键，等不到命令结束
]);

/** 名字里带路径与扩展名的可执行文件取裸名，cmd/PowerShell 都大小写不敏感。 */
function winBaseName(token) {
  return String(token).replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** 把结果导向文件的选项：cmd 的 `/O` 与 PowerShell 的 `-OutputPath` 都藏在参数里。 */
const WIN_WRITE_FLAGS = ['-outputpath', '-outfile', '/o', '-o'];
function winArgsWrite(args) {
  return args.some((t) => WIN_WRITE_FLAGS.some((f) => winHit(t, f)));
}

/**
 * PowerShell 侧判定（动词表 + 少量内置别名）。返回 null 表示这个名字不是 cmdlet/别名，
 * 交给 cmd 表或 POSIX 表——`git`、`docker`、`node` 在 PowerShell 里就是同名可执行文件，参数形状一致。
 */
function psReadOnlySegment(parts) {
  const [cmd, ...args] = parts;
  const name = winBaseName(cmd);
  if (name.indexOf('-') < 0) {
    if (!PS_READ_ALIASES.has(name)) return null;
    return !winArgsWrite(args);
  }
  if (PS_DENY_NAMES.has(name)) return false;
  if (winArgsWrite(args)) return false;
  const verb = name.slice(0, name.indexOf('-'));
  if (PS_READ_VERBS.some((v) => v.toLowerCase() === verb)) return true;
  return PS_READ_NAMES.some((n) => n.toLowerCase() === name);
}

function winReadOnlySegment(rawSegment) {
  const parts = tokenize(rawSegment);
  if (!parts.length) return null;
  const ps = psReadOnlySegment(parts);
  if (ps !== null) return ps;
  const name = winBaseName(parts[0]);
  const args = parts.slice(1);
  if (WIN_DENY.has(name)) return false;
  if (name === 'powershell' || name === 'pwsh') return psCommand(args);
  if (name === 'cmd') return cmdInvoke(args);
  if (WIN_BARE.has(name)) return true;
  const scoped = Object.prototype.hasOwnProperty.call(WIN_SCOPED, name) ? WIN_SCOPED[name] : null;
  if (!scoped) return null;
  try {
    return scoped.check(args);
  } catch (_) {
    return false;
  }
}

/** `powershell -Command "…"`：只放行 -Command 后面那一串，-File/-EncodedCommand 能跑任意脚本。 */
function psCommand(args) {
  if (args.some((t) => /^-(f|fi|fil|file|e|en|enc|encodedcommand)$/i.test(t))) return false;
  const idx = args.findIndex((t) => /^-(c|co|com|comm|comman|command)$/i.test(t));
  if (idx < 0) return false;
  if (args.slice(0, idx).some((t) => !t.startsWith('-'))) return false;
  const inner = args.slice(idx + 1);
  if (!inner.length) return false;
  return winStatements(inner.join(' '));
}

/** `cmd /c dir /w`：内层再走一次 Windows 判定；内层的 `&` 断句器已经先一步否掉了。 */
function cmdInvoke(args) {
  if (!/^\/(c|k)$/i.test(args[0] || '')) return false;
  const inner = args.slice(1);
  if (!inner.length) return false;
  return winStatements(inner.join(' '));
}

function winStatements(text) {
  const segs = splitStatements(text, 'windows');
  if (!segs || !segs.length) return false;
  return segs.every((s) => readOnlySegment(s, 'windows') === true);
}

/** 探测结果 -> 用哪张表。Git-bash/Cygwin/WSL 的 uname 先判，那上面的 shell 是 POSIX。 */
function shellFamily(info) {
  const uname = String((info && info.uname) || '');
  if (/MINGW|MSYS|CYGWIN|WSL/i.test(uname)) return 'posix';
  const p = info && info.platform;
  if (p === 'darwin') return 'darwin';
  if (p === 'windows') return 'windows';
  if (p === 'linux') return 'posix';
  return 'unknown';
}

/** 绝对路径的常见 bin 前缀不改变判定：`/bin/ls`、`/usr/sbin/ip`、`/usr/local/bin/node` 与裸名字同等待遇。 */
function stripBinPrefix(cmd) {
  return cmd.replace(/^\/(?:usr\/)?(?:local\/)?s?bin\//, '');
}

function macReadOnlySegment(rawSegment) {
  const parts = tokenize(rawSegment);
  if (!parts.length) return null;
  const name = stripBinPrefix(parts[0]);
  if (MAC_DENY.has(name)) return false;
  if (MAC_BARE.has(name)) return true;
  const scoped = Object.prototype.hasOwnProperty.call(MAC_SCOPED, name) ? MAC_SCOPED[name] : null;
  if (!scoped) return null;
  try {
    return scoped.check(parts.slice(1));
  } catch (_) {
    return false;
  }
}

/**
 * 按未加引号的控制符断句：`;` `&&` `||` `|` 与换行。
 * 返回 null 表示无法可靠断句（后台 `&`、`|&`、子 shell 括号、引号未闭合、结尾悬空反斜杠），
 * 调用方一律按写操作处理。引号内的反斜杠语义照 bash：单引号内不转义，
 * 双引号内只转义 `$ ` " \ 与续行——`echo 'don\'t; rm -rf /'` 就靠这条不会误判成只读。
 * `shell === 'windows'` 时反引号按 PowerShell 语义处理：双引号内是转义符，裸用是定界字符串，
 * 里面不能插 `` `; ``（`Get-Date` 这类连字符会被误断）。
 */
function splitStatements(text, shell = 'posix') {
  const btick = shell === 'windows';
  const out = [];
  let cur = '';
  let quote = '';
  let i = 0;
  const flush = () => { if (cur.trim()) out.push(cur); cur = ''; };
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && '$`"\\\n'.includes(text[i + 1] || '')) {
        cur += ch + text[i + 1];
        i += 2;
        continue;
      }
      if (btick && quote === '"' && ch === '`' && text[i + 1] && text[i + 1] !== '\n') {
        cur += ch + text[i + 1];
        i += 2;
        continue;
      }
      cur += ch;
      i += 1;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; i += 1; continue; }
    if (ch === '`') {
      if (!btick) return null;
      quote = '`';
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= text.length) return null;
      cur += ch + text[i + 1];
      i += 2;
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (pair === '&&' || pair === '||') { flush(); i += 2; continue; }
    if (ch === ';' || ch === '\n') { flush(); i += 1; continue; }
    if (ch === '|') {
      if (text[i + 1] === '&') return null;
      flush();
      i += 1;
      continue;
    }
    if (ch === '&' || ch === '(' || ch === ')') return null;
    cur += ch;
    i += 1;
  }
  if (quote) return null;
  flush();
  return out;
}

/** 按未加引号的空白切词，并丢掉引号本身（反引号是 PowerShell 的定界符，也当引号处理）。 */
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
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    cur += ch;
    started = true;
  }
  flush();
  return out;
}

function readOnlySegment(rawSegment, family = 'posix') {
  if (family === 'darwin') {
    const mac = macReadOnlySegment(rawSegment);
    if (mac !== null) return mac;
  }
  if (family === 'windows') {
    const win = winReadOnlySegment(rawSegment);
    if (win !== null) return win;
  }
  const parts = tokenize(rawSegment);
  if (!parts.length) return false;
  const [cmd, ...args] = parts;
  const name = stripBinPrefix(cmd);
  if (name === 'timeout') {
    const inner = parts.slice(1).filter((t, i) => !t.startsWith('-') && !(i === 0 && /^\d+(\.\d+)?[smhd]?$/.test(t)));
    return inner.length > 0 && readOnlySegment(inner.join(' '), family);
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

function isReadOnly(command, family = 'posix') {
  const text = String(command || '');
  if (!text.trim()) return false;
  const stripped = text.replace(family === 'windows' ? REDIRECT_NOISE_WIN : REDIRECT_NOISE, ' ');
  if (UNSAFE.some((re) => re.test(stripped))) return false;
  // 平台没探出来时按 POSIX 判，但 cmd 的短开关（`/q`、`/O`、`/O:out.txt`）长得像路径，一律要确认
  if (family === 'unknown' && stripped.split(/\s+/).some((t) => /^\/\w{1,2}$/.test(t) || /^\/[\w-]+:/.test(t))) return false;
  const segments = splitStatements(stripped, family === 'windows' ? 'windows' : 'posix');
  if (!segments || !segments.length) return false;
  return segments.every((segment) => readOnlySegment(segment, family));
}

const TOOL_OUTPUT_LIMIT = 6000;
/** 文件工具的行窗口与整文件上限：读窗口对齐 clip() 的体量；写上限要给 base64 留出 Linux 单参数 128KB（MAX_ARG_STRLEN）的空间。 */
const FILE_LINE_CAP = 500;
const FILE_MAX_LINES = 20000;
const FILE_MAX_BYTES = 80 * 1024;
/** 审批卡片里「改前」只给命中处前后各这么多行：整文件贴上来用户看不清，改动本身才是要确认的东西。 */
const FILE_DIFF_PAD = 5;
/** 卡片改前/改后的字数上限：会话记录按 4000 字存，clip 还要留出截断标记的位置，所以取更小的预算。 */
const FILE_CARD_CHARS = 3900;
/** 探针标记：存在与非空各带一个回来，不靠退出码猜——sed/tail 读不到（没权限）和文件不存在都是非零。 */
const FILE_MARK_EXIST = '@@NOVO-E';
const FILE_MARK_SIZE = '@@NOVO-S';
/** 路径只收安全字符集：引号、反斜杠、`$` 与反引号一律排除，跳不出单引号；空格是安全的。 */
const FILE_PATH_RE = /^[\w./~+:@\- ]+$/;

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
      name: 'run_command',
      description: '在这台主机上执行一条命令并返回输出。命令走独立的 exec 通道，不会出现在用户终端屏幕上，也不继承交互 shell 的环境变量；非 Windows 主机由客户端注入当前目录，Windows 主机不会注入，请用绝对路径或自己 cd。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令行，不要包含交互式程序的常驻运行；需要后台运行请自行加 nohup ... &' },
          rationale: { type: 'string', description: '一句话说明这条命令要做什么，会展示给用户确认' },
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
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取这台主机上文本文件的指定行窗口（POSIX 主机）。比 cat 更合适：按行窗口取，不会被输出上限从中间截断。start_line 从 1 开始，返回尾部会带上总行数与下一段的起始行号。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          start_line: { type: 'integer', description: '起始行号，默认 1' },
          lines: { type: 'integer', description: '读取行数，默认 200，最多 ' + FILE_LINE_CAP },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把整份内容写入这台主机上的文本文件（POSIX 主机），覆盖已有内容；只用来新建文件或整份重写。改其中几行请用 edit_file，不要用这里。写前必须先 read_file 拿全当前内容再改，绝不能只凭记忆重写。执行前用户会在确认卡片里看到改前与改后的内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          content: { type: 'string', description: '要写入的完整文件内容' },
          rationale: { type: 'string', description: '一句话说明这次写入要达成什么，会展示给用户确认' },
          mkdir_parent: { type: 'boolean', description: '父目录不存在时是否创建，默认不创建' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '改这台主机上文本文件的局部内容（POSIX 主机），改几行就用它，不必重写整个文件。mode=append 把 content 追加到文件末尾，不需要先读全文（文件末尾缺换行会自动补一个，避免末行和新内容粘成一行）；mode=replace 用 old_string 逐字匹配文件里的一段原文并换成 new_string，old_string 必须原样来自 read_file 的输出，含缩进和空格，出现多次时会要求你扩大上下文或改用 replace_all。replace 会先把整个文件读到本地改好再写回，所以超过大小上限的文件改不了。执行前用户会在确认卡片里看到改前与改后的内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          mode: { type: 'string', enum: ['append', 'replace'], description: 'append 追加到文件末尾；replace 精确替换一段原文' },
          content: { type: 'string', description: 'append 模式要追加的文本' },
          old_string: { type: 'string', description: 'replace 模式要替换的原文，逐字来自当前文件' },
          new_string: { type: 'string', description: 'replace 模式换上的新文本，留空表示删掉这段原文' },
          replace_all: { type: 'boolean', description: 'replace 模式下 old_string 出现多次时是否全部替换，默认否' },
          rationale: { type: 'string', description: '一句话说明这次修改要达成什么，会展示给用户确认' },
          mkdir_parent: { type: 'boolean', description: 'append 到尚不存在的文件时是否创建父目录，默认不创建' },
        },
        required: ['path', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '向用户提一个带候选项的问题。只在「信息不足以决定下一步，且选错方向代价明显」时使用，例如要清理哪些目录、重启哪个服务；用户可以选择某一项，也可以在候选项下面的输入框里自由回答。不要用它的结果代替命令执行结果。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题，一句话' },
          options: { type: 'array', items: { type: 'string' }, description: '2~6 个候选项，每项一句话，按推荐顺序排列' },
        },
        required: ['question', 'options'],
      },
    },
  },
];

/**
 * @param {object} ctx { sessionId, target, cwd, settings, requestApproval, requestChoice, readScreen, signal, log }
 */
function createTools(ctx) {
  const { sessionId, target, cwd, settings, requestApproval, requestChoice, readScreen, signal, log } = ctx;
  let family = 'posix';
  let shell = 'posix';
  let probed = false;

  /** 平台探测只发一次 exec，结果由 exec.js 挂在 target.cache 上；拿不到就按最严的 unknown 判。 */
  async function resolveShell() {
    if (probed) return;
    probed = true;
    let info = null;
    try {
      info = await platformOf(target, PLATFORM_PROBE_TIMEOUT_MS);
    } catch (error) {
      log && log.warn('ai', 'ai platform probe failed', { sessionId, host: target.host, message: error.message });
    }
    family = shellFamily(info);
    shell = family === 'windows' ? 'windows' : 'posix';
  }

  async function runCommand(command, opts = {}) {
    await resolveShell();
    const readOnly = isReadOnly(command, family);
    // ask 档连只读命令也要过目（与设置文案、系统提示一致），只有 full 档彻底不问
    if (settings.permission !== 'full' && (settings.permission === 'ask' || !readOnly)) {
      const decision = await requestApproval({ name: 'run_command', command, readOnly, reason: opts.rationale || '' });
      if (decision !== 'allow') {
        return decision === 'deny'
          ? { channel: 'exec', denied: 'deny', text: '用户拒绝执行这条命令。不要重试同一条命令，改用只读方式获取信息或直接说明无法完成。' }
          : { channel: 'exec', denied: decision, text: '这一轮已经结束，这条命令没有执行。' };
      }
    }
    // 审批可能等上很久，只有过了这道门才算真正开始执行
    if (opts.onStart) opts.onStart();
    // exec 通道不继承交互 shell 的目录，所以默认落到渲染端报上来的终端 cwd。
    // 模型自带的 cwd 与终端上报的 cwd 用同一把尺子：正则排除了单引号与反斜杠，
    // 不匹配就干脆不注入，宁可让命令在 exec 通道的默认目录里跑，也不能跳出 `cd '…'` 的引号。
    // Windows 的 DefaultShell 可能是 cmd 也可能是 PowerShell，两种 `cd` 写法互不兼容，
    // 只能让模型用绝对路径或自己 cd。
    const wanted = (typeof opts.cwd === 'string' ? opts.cwd.trim() : '') || String(cwd || '').trim();
    const dir = /^[\w./~ -]+$/.test(wanted) ? wanted : '';
    const line = dir && shell === 'posix' ? "cd '" + dir + "' && " + command : command;
    const started = Date.now();
    let out;
    try {
      out = await exec(target.client, line, target.charset, settings.commandTimeoutSec * 1000, 'AI_EXEC_TIMEOUT', signal);
    } catch (error) {
      const partial = String(error.stdout || '') + (error.stderr ? '\n[stderr]\n' + error.stderr : '');
      // 用户点了停止：命令通道被销毁，把这一条当成「没跑成」如实回报，而不是失败报错
      if (error.code === 'SSH_EXEC_CANCELED') {
        log && log.info('ai', 'ai exec command canceled', { sessionId, host: target.host, ms: Date.now() - started, command: commandBrief(command) });
        return { channel: 'exec', canceled: true, text: '用户已停止这一轮，命令通道被销毁。' + (partial.trim() ? '已取得的输出：\n' + clip(partial) : '') };
      }
      log && log.warn('ai', 'ai exec command failed', { sessionId, host: target.host, message: error.message, code: error.code });
      return { channel: 'exec', failed: true, text: '命令执行失败：' + error.message + (partial.trim() ? '\n已取得的输出：\n' + clip(partial) : '') };
    }
    // 非零退出必须让模型看见：过去只回正文，`'(no output)'` 把失败伪装成成功
    const code = Number.isInteger(out.code) ? out.code : null;
    log && log.info('ai', 'ai exec command finished', { sessionId, host: target.host, ms: Date.now() - started, exitCode: code, command: commandBrief(command) });
    const body = clip(out.stdout) + (out.stderr ? '\n[stderr]\n' + clip(out.stderr, 2000) : '');
    return { channel: 'exec', exitCode: code, text: code && code !== 0 ? body + (body ? '\n' : '') + '[exit ' + code + ']' : body };
  }

  function runExec(line) {
    return exec(target.client, line, target.charset, settings.commandTimeoutSec * 1000, 'AI_EXEC_TIMEOUT', signal);
  }

  /** 文件工具的公共前置：校验路径、探测平台，非纯 POSIX shell 直接给出如实的不可用说明。 */
  async function fileGuard(path) {
    if (typeof path !== 'string' || !path.trim()) throw aiToolError('AI_ARGS', 'path required');
    if (!FILE_PATH_RE.test(path)) {
      return { channel: 'file', failed: true, text: '路径包含引号或特殊字符，文件工具不支持，请改用 run_command。' };
    }
    // exec 通道不继承终端当前目录，相对路径会落在 SSH 用户主目录下，读到的根本不是同一个文件
    if (path[0] !== '/') {
      return { channel: 'file', failed: true, text: '文件工具只接受绝对路径（以 / 开头），先确认目标文件的完整路径。' };
    }
    // /dev 下的设备与 FIFO 要么无限产出（zero、urandom）要么永久挂着（kmsg、tty），只能按普通文件排除
    if (path === '/dev' || path.startsWith('/dev/')) {
      return { channel: 'file', failed: true, text: '文件工具不支持 /dev 下的设备与特殊文件，请改用 run_command。' };
    }
    await resolveShell();
    if (shell !== 'posix' || family === 'unknown') {
      return { channel: 'file', failed: true, text: '文件工具只支持 POSIX 主机（当前目标不是），请改用 run_command。' };
    }
    return null;
  }

  async function readFile(rawPath, opts = {}) {
    const path = typeof rawPath === 'string' ? rawPath.trim() : rawPath;
    const blocked = await fileGuard(path);
    if (blocked) return blocked;
    const from = Math.max(1, Math.floor(Number(opts.startLine) || 1));
    const count = Math.min(FILE_LINE_CAP, Math.max(1, Math.floor(Number(opts.lines) || 200)));
    // ask 档连读取也要过目：文件里可能有密钥，口径与 run_command 的只读命令一致；守卫先行，不支持的主机不该先弹确认
    if (settings.permission === 'ask') {
      const decision = await requestApproval({ name: 'read_file', command: path, readOnly: true, reason: '' });
      if (decision !== 'allow') {
        return decision === 'deny'
          ? { channel: 'file', denied: 'deny', text: '用户拒绝读取这个文件。不要重试同一次读取，直接说明无法完成。' }
          : { channel: 'file', denied: decision, text: '这一轮已经结束，文件没有读取。' };
      }
    }
    const started = Date.now();
    let out;
    try {
      // awk 一次遍历同时交出窗口与总行数：sed+wc 在文件不存在时会把两条命令的失败搅在一起
      out = await runExec("awk 'NR>=" + from + " && NR<" + (from + count) + "{print} END{printf \"@@LINES:%d\\n\", NR}' " + sq(path));
    } catch (error) {
      if (error.code === 'SSH_EXEC_CANCELED') return { channel: 'file', canceled: true, text: '用户已停止这一轮，读取没有完成。' };
      log && log.warn('ai', 'ai read_file failed', { sessionId, host: target.host, path, message: error.message, code: error.code });
      return { channel: 'file', failed: true, text: '读取失败：' + error.message };
    }
    const code = Number.isInteger(out.code) ? out.code : null;
    const mark = String(out.stdout || '').lastIndexOf('@@LINES:');
    if (mark < 0) {
      log && log.warn('ai', 'ai read_file unexpected output', { sessionId, host: target.host, path, exitCode: code });
      return { channel: 'file', failed: true, text: '读取失败：文件不存在、不可读，或主机上没有 awk' + (out.stderr ? '\n[stderr]\n' + clip(out.stderr, 1000) : '') };
    }
    const body = clip(out.stdout.slice(0, mark).replace(/\n$/, ''));
    const total = Number((out.stdout.slice(mark) || '').replace(/\D/g, '')) || 0;
    log && log.info('ai', 'ai read_file finished', { sessionId, host: target.host, path, ms: Date.now() - started, exitCode: code, total });
    if (code && code !== 0) {
      return { channel: 'file', exitCode: code, text: '读取失败：' + (clip(out.stderr, 1000) || '文件不存在或没有读权限') };
    }
    const readTo = from + count - 1;
    const more = total > readTo ? '；还有内容没读完，用 start_line=' + (readTo + 1) + ' 继续' : '';
    return {
      channel: 'file',
      exitCode: code,
      text: body + (body ? '\n' : '') + '[共 ' + total + ' 行，本次读了第 ' + from + ' 到 ' + Math.min(readTo, total) + ' 行' + more + ']',
    };
  }

  /** exec 通道按 target.charset 解码读回的字节，写入必须用同一套编码，否则 GBK 主机上的中文读回来再写回去就成乱码。 */
  function charsetOf() {
    return target.charset || 'UTF-8';
  }
  function encodeText(text) {
    try {
      return iconv.encode(text, charsetOf());
    } catch (_) {
      return Buffer.from(text, 'utf8');
    }
  }
  function decodeBytes(buf) {
    try {
      return iconv.decode(buf, charsetOf());
    } catch (_) {
      return buf.toString('utf8');
    }
  }
  /** 路径已过 FILE_PATH_RE（不含单引号与反斜杠），包进单引号就是安全的。 */
  function sq(path) {
    return "'" + path + "'";
  }

  /** 存在性探针：先带回两个标记，再接调用方给的正文命令；标记都排在正文前面。 */
  function markProbe(path, body) {
    return 'test -e ' + sq(path) + ' && echo ' + FILE_MARK_EXIST
      + '; test -s ' + sq(path) + ' && echo ' + FILE_MARK_SIZE + '; ' + body;
  }

  /** 拆探针回包：标记之后的才是文件正文，前面的登录横幅之类一并丢掉。 */
  function probeMarks(stdout) {
    const body = String(stdout || '');
    const e = body.indexOf(FILE_MARK_EXIST);
    const s = body.indexOf(FILE_MARK_SIZE);
    const at = Math.max(e, s);
    return {
      exists: e >= 0,
      nonEmpty: s >= 0,
      rest: at < 0 ? body : body.slice(at + (at === e ? FILE_MARK_EXIST : FILE_MARK_SIZE).length).replace(/^\n/, ''),
    };
  }

  /** 写完的口径：命令返回 0 不等于主机上的文件真是这份内容，回读对得上才报具体数字。 */
  function writtenNote(buf, now) {
    return now ? buf.length + ' 字节，主机上确认为 ' + now.bytes + ' 字节 / ' + now.lines + ' 行'
      : buf.length + ' 字节（未能回读校验）';
  }

  /** 写入被中途停止时如实说明残留：mv 是原子的，就地覆写与追加都可能只落了一半。 */
  function interruptedNote(action) {
    if (action === 'create') return '目标要么还没建出来，要么已是完整的新内容。';
    if (action === 'append') return '文件末尾要么没变，要么已多出这段内容，请用 read_file 核对末尾。';
    return '就地覆写可能只写了一半，请用 read_file 核对当前内容再决定怎么修。';
  }

  async function verifyFile(path) {
    try {
      const out = await runExec('wc -l -c < ' + sq(path));
      if (Number.isInteger(out.code) && out.code !== 0) return null;
      // wc 固定按「行数 字节数」吐出，与 -l -c 的书写顺序无关；取最后两个数字，前面的杂项不算长度
      const nums = String(out.stdout || '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
      return nums.length >= 2 ? { lines: nums[nums.length - 2], bytes: nums[nums.length - 1] } : null;
    } catch (_) {
      return null;
    }
  }

  /** 整文件取回（base64 原样回传、本地按目标编码解码）：超上限或含 NUL 就不再往下走。 */
  async function pullFile(path) {
    let size = 0;
    try {
      // 存在与大小分开判：只靠 wc 的退出码，「没有读权限」会被说成「文件不存在」
      const probe = await runExec(markProbe(path, 'wc -c < ' + sq(path)));
      const marks = probeMarks(probe.stdout);
      if (!marks.exists) return { missing: true };
      // 只取第一个数字：登录横幅之类的杂项不该被并进长度
      const num = Number(String(marks.rest).trim().split(/\s+/)[0]);
      if (Number.isInteger(num) && num >= 0) size = num;
      else if (marks.nonEmpty) return { failed: '文件存在但读不到内容（多半是没有读权限），编辑工具不能凭猜测重写整份文件，请改用 run_command。' };
    } catch (error) {
      if (error.code === 'SSH_EXEC_CANCELED') return { canceled: true };
      return { failed: '读取失败：' + error.message };
    }
    if (size > FILE_MAX_BYTES) {
      return { failed: '文件有 ' + size + ' 字节，超过编辑工具 ' + FILE_MAX_BYTES + ' 字节的整文件上限：往末尾加内容改用 mode=append，就地改几行只能走 run_command。' };
    }
    if (size === 0) return { text: '', buf: Buffer.alloc(0) };
    let out;
    try {
      out = await runExec('base64 ' + sq(path));
    } catch (error) {
      if (error.code === 'SSH_EXEC_CANCELED') return { canceled: true };
      return { failed: '读取失败：' + error.message };
    }
    if (Number.isInteger(out.code) && out.code !== 0) {
      return { failed: '读取失败：' + (clip(out.stderr, 500) || '文件不可读，或主机上没有 base64') };
    }
    const buf = Buffer.from(String(out.stdout || '').replace(/\s+/g, ''), 'base64');
    if (buf.indexOf(0) >= 0) return { binary: true };
    return { buf, text: decodeBytes(buf) };
  }

  /**
   * 落盘：base64 先解到同目录的临时文件，确认解码成功才碰目标。
   * 覆盖已有文件走 `cat tmp > path` 就地覆写，保住 inode、权限与属主——`mv` 换 inode，
   * 会把 root 644 的配置变成临时文件的属主和 umask 权限；新建才用 mv，追加走 `>>`。
   * 末尾的 `|| rm -f` 只在链路失败时清临时文件，`echo OK` 成功就走不到它。
   */
  async function pushFile(path, buf, action, mkdirParent) {
    const parent = path.lastIndexOf('/') > 0 ? path.slice(0, path.lastIndexOf('/')) : '';
    const ensure = mkdirParent && parent ? 'mkdir -p ' + sq(parent) + ' && ' : '';
    const tmp = sq(path + '.novo-tmp');
    const dst = sq(path);
    const land = action === 'append' ? 'cat ' + tmp + ' >> ' + dst + ' && rm -f ' + tmp
      : action === 'create' ? 'mv ' + tmp + ' ' + dst
        : 'cat ' + tmp + ' > ' + dst + ' && rm -f ' + tmp;
    const line = ensure + "printf '" + buf.toString('base64') + "' | base64 -d > " + tmp + ' && ' + land + ' && echo OK || rm -f ' + tmp;
    const started = Date.now();
    let out;
    try {
      out = await runExec(line);
    } catch (error) {
      if (error.code === 'SSH_EXEC_CANCELED') return { canceled: true };
      log && log.error('ai', 'ai file write failed', { sessionId, host: target.host, path, action, message: error.message, code: error.code });
      return { failed: '写入失败：' + error.message };
    }
    const code = Number.isInteger(out.code) ? out.code : null;
    const ok = code === 0 && String(out.stdout || '').includes('OK');
    log && log.info('ai', 'ai file write finished', { sessionId, host: target.host, path, action, ms: Date.now() - started, exitCode: code, bytes: buf.length, ok });
    if (!ok) return { failed: '写入失败：' + (clip(out.stderr, 1000) || '主机上没有 base64，或目录与文件不可写') };
    return { ok: true };
  }

  /** 审批卡片只给命中处前后各若干行：整文件贴上来反而看不出这次改了什么。 */
  function excerpt(text, at, length) {
    const lines = text.split('\n');
    const startLine = text.slice(0, at).split('\n').length - 1;
    const endLine = startLine + text.slice(at, at + length).split('\n').length - 1;
    const from = Math.max(0, startLine - FILE_DIFF_PAD);
    const to = Math.min(lines.length, endLine + FILE_DIFF_PAD + 1);
    return (from > 0 ? '…\n' : '') + lines.slice(from, to).join('\n') + (to < lines.length ? '\n…' : '');
  }

  async function writeFile(rawPath, opts = {}) {
    const path = typeof rawPath === 'string' ? rawPath.trim() : rawPath;
    const blocked = await fileGuard(path);
    if (blocked) return blocked;
    const content = typeof opts.content === 'string' ? opts.content : '';
    if (!content.length) throw aiToolError('AI_ARGS', 'content required');
    const buf = encodeText(content);
    if (buf.length > FILE_MAX_BYTES) {
      return { channel: 'file', failed: true, text: '内容超过 ' + FILE_MAX_BYTES + ' 字节上限，文件工具写不了这么大的整文件，请改用 run_command 分段处理。' };
    }
    const started = Date.now();
    // 写之前先读当前内容进审批卡片：用户点允许/拒绝靠的就是这份改前对照。
    // 存在与否用标记判断而不是退出码：文件读不到（没权限）时 sed 也给非零码，按不存在处理会走 mv，
    // 把已有文件的 inode、权限和属主一起换掉。
    let oldCard = '';
    let oldMissing = false;
    try {
      const probe = await runExec(markProbe(path, "sed -n '1," + FILE_MAX_LINES + "p' " + sq(path) + " 2>/dev/null"));
      const marks = probeMarks(probe.stdout);
      oldMissing = !marks.exists;
      if (marks.exists) oldCard = marks.nonEmpty ? clip(marks.rest, FILE_CARD_CHARS) || '（文件当前内容读不到）' : '';
    } catch (error) {
      if (error.code === 'SSH_EXEC_CANCELED') return { channel: 'file', canceled: true, text: '用户已停止这一轮，文件没有写入。' };
      log && log.warn('ai', 'ai write_file read current content failed', { sessionId, host: target.host, path, message: error.message });
      oldCard = '(读取当前内容失败：' + error.message + ')';
    }
    if (settings.permission !== 'full') {
      const decision = await requestApproval({
        name: 'write_file',
        command: path,
        subject: 'file',
        old: oldCard,
        new: clip(content, FILE_CARD_CHARS),
        reason: opts.rationale || '',
      });
      if (decision !== 'allow') {
        return decision === 'deny'
          ? { channel: 'file', denied: 'deny', text: '用户拒绝写入这个文件。不要重试同一次写入，先说明无法完成的原因。' }
          : { channel: 'file', denied: decision, text: '这一轮已经结束，文件没有写入。' };
      }
    }
    if (opts.onStart) opts.onStart();
    const wrote = await pushFile(path, buf, oldMissing ? 'create' : 'overwrite', opts.mkdirParent);
    if (wrote.canceled) return { channel: 'file', canceled: true, text: '用户已停止这一轮，写入可能被中断；' + interruptedNote(oldMissing ? 'create' : 'overwrite') };
    if (wrote.failed) return { channel: 'file', failed: true, text: wrote.failed };
    const now = await verifyFile(path);
    log && log.info('ai', 'ai write_file checked', { sessionId, host: target.host, path, ms: Date.now() - started, bytes: buf.length, onHost: now ? now.bytes : null });
    if (now && now.bytes !== buf.length) {
      return { channel: 'file', failed: true, text: '写入结果与预期不符：本端 ' + buf.length + ' 字节，主机上是 ' + now.bytes + ' 字节，先别继续改这个文件。' };
    }
    return { channel: 'file', exitCode: 0, text: '已写入 ' + path + '（' + writtenNote(buf, now) + '，' + (oldMissing ? '新建文件' : '覆盖原文件') + '）。' };
  }

  async function editFile(rawPath, opts = {}) {
    const path = typeof rawPath === 'string' ? rawPath.trim() : rawPath;
    const blocked = await fileGuard(path);
    if (blocked) return blocked;
    const mode = opts.mode === 'replace' ? 'replace' : opts.mode === 'append' ? 'append' : '';
    if (!mode) throw aiToolError('AI_ARGS', "mode must be 'append' or 'replace'");
    const started = Date.now();

    if (mode === 'append') {
      const added = typeof opts.content === 'string' ? opts.content : '';
      if (!added.length) throw aiToolError('AI_ARGS', 'content required for append');
      const payload = encodeText(added);
      if (payload.length > FILE_MAX_BYTES) {
        return { channel: 'file', failed: true, text: '一次追加不能超过 ' + FILE_MAX_BYTES + ' 字节，请分成几次。' };
      }
      // 卡片给出落点，同时判断要不要补换行：追加不能把原末行和新内容粘成一行。
      // 读不到（没权限）与空文件都只给非零码，所以用 markProbe 的两个标记区分。
      let exists = false;
      let nonEmpty = false;
      let tail = '';
      try {
        const probe = await runExec(markProbe(path, 'tail -n 20 ' + sq(path) + ' 2>/dev/null'));
        const marks = probeMarks(probe.stdout);
        exists = marks.exists;
        nonEmpty = marks.nonEmpty;
        tail = marks.rest;
      } catch (error) {
        if (error.code === 'SSH_EXEC_CANCELED') return { channel: 'file', canceled: true, text: '用户已停止这一轮，文件没有写入。' };
        log && log.warn('ai', 'ai edit_file read tail failed', { sessionId, host: target.host, path, message: error.message });
      }
      const sep = exists && tail.length && !tail.endsWith('\n') ? '\n' : '';
      let oldCard = '';
      if (exists) oldCard = tail ? '…（文件末尾）\n' + tail : (nonEmpty ? '（文件当前内容读不到）' : '');
      if (settings.permission !== 'full') {
        const decision = await requestApproval({
          name: 'edit_file',
          command: path,
          subject: 'file',
          old: clip(oldCard, FILE_CARD_CHARS),
          new: clip(added, FILE_CARD_CHARS),
          reason: (opts.rationale ? opts.rationale + ' · ' : '') + '追加到文件末尾',
        });
        if (decision !== 'allow') {
          return decision === 'deny'
            ? { channel: 'file', denied: 'deny', text: '用户拒绝写入这个文件。不要重试同一次写入，先说明无法完成的原因。' }
            : { channel: 'file', denied: decision, text: '这一轮已经结束，文件没有写入。' };
        }
      }
      if (opts.onStart) opts.onStart();
      const buf = sep ? Buffer.concat([Buffer.from(sep, 'utf8'), payload]) : payload;
      const wrote = await pushFile(path, buf, 'append', opts.mkdirParent);
      if (wrote.canceled) return { channel: 'file', canceled: true, text: '用户已停止这一轮，追加可能被中断；' + interruptedNote('append') };
      if (wrote.failed) return { channel: 'file', failed: true, text: wrote.failed };
      const now = await verifyFile(path);
      log && log.info('ai', 'ai edit_file append checked', { sessionId, host: target.host, path, ms: Date.now() - started, bytes: buf.length, onHost: now ? now.bytes : null });
      return { channel: 'file', exitCode: 0, text: '已追加到 ' + path + '（新增 ' + buf.length + ' 字节' + (now ? '，主机上现在 ' + now.bytes + ' 字节 / ' + now.lines + ' 行' : '') + '）。' };
    }

    const needle = typeof opts.oldString === 'string' ? opts.oldString : '';
    if (!needle) throw aiToolError('AI_ARGS', 'old_string required for replace');
    const replacement = typeof opts.newString === 'string' ? opts.newString : '';
    const pull = await pullFile(path);
    if (pull.canceled) return { channel: 'file', canceled: true, text: '用户已停止这一轮，文件没有写入。' };
    if (pull.binary) return { channel: 'file', failed: true, text: '这个文件读起来是二进制（含 NUL 字节），编辑工具不碰，请改用 run_command。' };
    if (pull.failed) return { channel: 'file', failed: true, text: pull.failed };
    if (pull.missing) return { channel: 'file', failed: true, text: '文件不存在：追加请用 mode=append（必要时配 mkdir_parent），整份新建用 write_file。' };
    const text = pull.text;
    // 整文件重写会把解码后的字符再编码回去：主机 charset 与文件真实编码不一致时，解码已经吃掉了原始字节
    // （非法序列变成 U+FFFD），再写回去就是一份坏文件。对不上就拒改，宁可让模型走 run_command。
    if (Buffer.compare(encodeText(text), pull.buf) !== 0) {
      return { channel: 'file', failed: true, text: '这个文件的字节和主机字符集 ' + charsetOf() + ' 对不上（多半不是这个编码），整份重写会损坏内容，请改用 run_command 处理。' };
    }
    const hits = text.split(needle).length - 1;
    if (!hits) {
      return { channel: 'file', failed: true, text: 'old_string 在当前文件里找不到：文件可能已被改动，或这段原文不是逐字取自 read_file。请重新 read_file 再给出要替换的那段。' };
    }
    if (hits > 1 && opts.replaceAll !== true) {
      return { channel: 'file', failed: true, text: 'old_string 在文件里出现 ' + hits + ' 处，无法确定改哪一处：请扩大上下文直到唯一，或用 replace_all=true 全部替换。' };
    }
    const at = text.indexOf(needle);
    const nextText = opts.replaceAll === true
      ? text.split(needle).join(replacement)
      : text.slice(0, at) + replacement + text.slice(at + needle.length);
    if (nextText === text) return { channel: 'file', exitCode: 0, text: '新内容与当前文件一致，没有写入。' };
    const buf = encodeText(nextText);
    if (buf.length > FILE_MAX_BYTES) {
      return { channel: 'file', failed: true, text: '改完有 ' + buf.length + ' 字节，超过 ' + FILE_MAX_BYTES + ' 字节的整文件上限，写不回去。' };
    }
    if (settings.permission !== 'full') {
      const decision = await requestApproval({
        name: 'edit_file',
        command: path,
        subject: 'file',
        old: clip(excerpt(text, at, needle.length), FILE_CARD_CHARS),
        new: clip(excerpt(nextText, at, replacement.length), FILE_CARD_CHARS),
        reason: (opts.rationale ? opts.rationale + ' · ' : '') + '替换 ' + (opts.replaceAll === true ? hits : 1) + ' 处',
      });
      if (decision !== 'allow') {
        return decision === 'deny'
          ? { channel: 'file', denied: 'deny', text: '用户拒绝写入这个文件。不要重试同一次写入，先说明无法完成的原因。' }
          : { channel: 'file', denied: decision, text: '这一轮已经结束，文件没有写入。' };
      }
    }
    if (opts.onStart) opts.onStart();
    const wrote = await pushFile(path, buf, 'overwrite', false);
    if (wrote.canceled) return { channel: 'file', canceled: true, text: '用户已停止这一轮，写入可能被中断；' + interruptedNote('overwrite') };
    if (wrote.failed) return { channel: 'file', failed: true, text: wrote.failed };
    const now = await verifyFile(path);
    log && log.info('ai', 'ai edit_file replace checked', { sessionId, host: target.host, path, ms: Date.now() - started, bytes: buf.length, onHost: now ? now.bytes : null });
    if (now && now.bytes !== buf.length) {
      return { channel: 'file', failed: true, text: '写入结果与预期不符：本端 ' + buf.length + ' 字节，主机上是 ' + now.bytes + ' 字节，先别继续改这个文件。' };
    }
    return { channel: 'file', exitCode: 0, text: '已修改 ' + path + '：替换 ' + (opts.replaceAll === true ? hits : 1) + ' 处，' + writtenNote(buf, now) + '。' };
  }

  async function invoke(call, onStart) {
    const args = call.args || {};
    if (call.name === 'run_command') {
      if (typeof args.command !== 'string' || !args.command.trim()) throw aiToolError('AI_ARGS', 'command required');
      return runCommand(args.command.trim(), {
        cwd: args.cwd,
        rationale: typeof args.rationale === 'string' ? args.rationale.slice(0, 200) : '',
        onStart,
      });
    }
    if (call.name === 'read_file') {
      return readFile(args.path, { startLine: args.start_line, lines: args.lines });
    }
    if (call.name === 'write_file') {
      if (typeof args.content !== 'string') throw aiToolError('AI_ARGS', 'content required');
      return writeFile(args.path, {
        content: args.content,
        rationale: typeof args.rationale === 'string' ? args.rationale.slice(0, 200) : '',
        mkdirParent: args.mkdir_parent === true,
        onStart,
      });
    }
    if (call.name === 'edit_file') {
      return editFile(args.path, {
        mode: typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : '',
        content: args.content,
        oldString: args.old_string,
        newString: args.new_string,
        replaceAll: args.replace_all === true,
        rationale: typeof args.rationale === 'string' ? args.rationale.slice(0, 200) : '',
        mkdirParent: args.mkdir_parent === true,
        onStart,
      });
    }
    if (call.name === 'read_terminal_screen') {
      if (onStart) onStart();
      const screen = await readScreen();
      return { channel: 'screen', text: screen ? clip(screen, 8000) : '（当前拿不到终端屏幕内容，可能面板未打开或会话已断开）' };
    }
    if (call.name === 'ask_user') {
      const question = typeof args.question === 'string' ? args.question.trim().slice(0, 400) : '';
      if (!question) throw aiToolError('AI_ARGS', 'question required');
      const options = (Array.isArray(args.options) ? args.options : [])
        .map((o) => String(o == null ? '' : o).trim().slice(0, 200))
        .filter(Boolean)
        // 面板用选项文本作行 key，主进程也按文本校验回包，重复项会同时打乱这两处
        .filter((o, i, arr) => arr.indexOf(o) === i)
        .slice(0, 6);
      if (!options.length) throw aiToolError('AI_ARGS', 'options required');
      const picked = await requestChoice({ question, options });
      if (!picked) {
        return { channel: 'ask', text: '用户没有做出选择（这一轮已被停止）。不要重复同一个问题，按已知信息给出结论，或直接说明还缺什么。' };
      }
      return { channel: 'ask', text: '用户选择：' + picked };
    }
    throw aiToolError('AI_UNKNOWN_TOOL', 'unknown tool: ' + String(call.name).slice(0, 60));
  }

  // 关了读屏就别把 read_terminal_screen 报给模型：它既占上下文，又骗模型花一整轮去调一个注定拿不到内容的工具
  const definitions = settings.readScreen
    ? DEFINITIONS
    : DEFINITIONS.filter((d) => d.function.name !== 'read_terminal_screen');
  return { definitions, invoke };
}

module.exports = { createTools, commandBrief };
