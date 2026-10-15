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

/** 任意参数都只读的命令：既不落盘，也不会常驻。 */
const BARE = new Set([
  'ls', 'll', 'cat', 'tac', 'zcat', 'bzcat', 'xzcat', 'wc', 'nl', 'head', 'cut', 'tr', 'uniq',
  'column', 'df', 'du', 'free', 'uptime', 'uname', 'id', 'whoami', 'who', 'w', 'ps', 'pgrep',
  'pidof', 'pwdx', 'pwd', 'ss', 'netstat', 'lsof', 'grep', 'egrep', 'fgrep', 'zgrep', 'tree', 'stat',
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
  awk: { check: (a) => !a.some((t) => /system\s*\(/.test(t) || /getline/.test(t) || t.startsWith('-f') || t.startsWith('--file') || t.startsWith('-i') || />/.test(t)) },
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
      // --watch 会一直挂着等事件，与 tail -f 同类
      && noFlags('-f', '--follow', '-w', '--watch', '--watch-only')(a),
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
