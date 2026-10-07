const MARKS = ['@A', '@B', '@C', '@D', '@E', '@F', '@G'];

function sections(text) {
  const out = {};
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (MARKS.includes(trimmed)) {
      key = trimmed.slice(1);
      out[key] = [];
      continue;
    }
    if (key) out[key].push(line);
  }
  return out;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function gb(kb) {
  return Math.round((kb / 1024 / 1024) * 100) / 100;
}

function parseStat(text) {
  let aggregate = [];
  const cores = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('cpu')) continue;
    const parts = line.trim().split(/\s+/);
    const ticks = parts.slice(1).map((v) => num(v));
    if (ticks.length < 4) continue;
    if (parts[0] === 'cpu') aggregate = ticks;
    else cores.push(ticks);
  }
  return { aggregate, cores };
}

function tickPercent(prev, curr) {
  if (!prev || !curr || prev.length !== curr.length) return null;
  const totalNow = curr.reduce((a, b) => a + b, 0);
  const totalPrev = prev.reduce((a, b) => a + b, 0);
  const idleNow = curr[3] + (curr[4] || 0);
  const idlePrev = prev[3] + (prev[4] || 0);
  const dTotal = totalNow - totalPrev;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, ((dTotal - (idleNow - idlePrev)) / dTotal) * 100));
}

function parseMeminfo(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) values[m[1]] = num(m[2]);
  }
  const total = values.MemTotal || 0;
  const available = values.MemAvailable != null ? values.MemAvailable : Math.max(0, total - (values.MemFree || 0) - (values.Buffers || 0) - (values.Cached || 0) - (values.SReclaimable || 0));
  const cache = (values.Cached || 0) + (values.SReclaimable || 0);
  const used = Math.max(0, total - available);
  return { totalGB: gb(total), usedGB: gb(used), cacheGB: gb(cache) };
}

function parseNetDev(text) {
  const byDev = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const dev = line.slice(0, idx).trim();
    if (!dev || dev === 'lo' || !/^[a-zA-Z0-9._:-]+$/.test(dev)) continue;
    const bars = line.indexOf('|');
    const rx = bars > 0 ? line.slice(idx + 1, bars).trim().split(/\s+/) : line.slice(idx + 1).trim().split(/\s+/);
    const tx = bars > 0 ? line.slice(bars + 1).trim().split(/\s+/) : rx.slice(8);
    if (rx.length < 1 || tx.length < 1) continue;
    const rxb = num(rx[0], -1);
    const txb = num(tx[0], -1);
    if (rxb < 0 || txb < 0) continue;
    byDev[dev] = { rx: rxb, tx: txb };
  }
  return byDev;
}

const DISK_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'jfs', 'reiserfs', 'zfs', 'ntfs', 'ntfs3', 'exfat', 'vfat', 'msdos', 'fat32']);

/** /proc/diskstats: sectors are always 512 bytes regardless of physical sector size. */
function parseDiskstats(text) {
  const byDev = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const dev = f[2];
    if (!dev) continue;
    byDev[dev] = { read: num(f[5]) * 512, write: num(f[9]) * 512 };
  }
  return byDev;
}

function parseDf(text) {
  const disks = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 7) continue;
    const dev = f[0];
    const type = f[1];
    const total = num(f[2]);
    const used = num(f[3]);
    const mount = f.slice(6).join(' ');
    if (!DISK_FS.has(type)) continue;
    if (!dev.startsWith('/dev/') && type !== 'zfs') continue;
    const key = dev + '|' + mount;
    if (seen.has(key)) continue;
    seen.add(key);
    disks.push({ dev, fs: type, mount, totalGB: gb(total), usedGB: gb(used) });
  }
  return disks;
}

const linux = {
  id: 'linux',
  pollMs: 3000,
  metaCommand: '{ echo @A; uname -snr; echo @B; grep -m1 PRETTY_NAME /etc/os-release 2>/dev/null; echo @C; grep -m1 "model name" /proc/cpuinfo 2>/dev/null; echo @D; nproc; echo @E; ls /sys/devices/system/cpu/cpu*/topology/physical_package_id 2>/dev/null | wc -l; echo @F; date +"%Z %z"; } 2>/dev/null',
  pollCommand: '{ echo @A; cat /proc/stat; echo @B; grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable):" /proc/meminfo; echo @C; cat /proc/uptime; echo @D; cat /proc/net/dev; echo @E; df -kPT; echo @F; cat /proc/diskstats; } 2>/dev/null',
  parseMeta(text) {
    const s = sections(text);
    const uname = (s.A || []).join(' ').trim().split(/\s+/);
    const pretty = (s.B || []).join('').match(/="?([^"\n]+)"?/);
    const model = (s.C || []).join('').split('=').slice(1).join('=').trim();
    return {
      hostname: uname[0] || '',
      distro: pretty ? pretty[1].trim() : '',
      kernel: uname.slice(1).join(' '),
      cpuModel: model,
      cores: num((s.D || [])[0], 0),
      sockets: Math.max(1, num((s.E || [])[0], 1)),
      tz: (s.F || []).join('').trim(),
    };
  },
  parsePoll(text, prev) {
    const s = sections(text);
    const stat = parseStat((s.A || []).join('\n'));
    const uptimeSec = num((s.C || []).join('').trim().split(/\s+/)[0], 0);
    // 只认基准可用的上一帧：畸形输出把 0 写进 state 会让速率永久失真，远端 uptime 必须比上一帧更大
    if (prev && (!prev.aggregate || !prev.aggregate.length || !(uptimeSec > prev.uptimeSec))) return null;
    const overall = tickPercent(prev && prev.aggregate, stat.aggregate);
    const uptime = Math.floor(uptimeSec);
    const net = parseNetDev((s.D || []).join('\n'));
    let rx = 0;
    let tx = 0;
    let rxTotal = 0;
    let txTotal = 0;
    let bestDev = '';
    let bestDelta = -1;
    for (const [dev, counters] of Object.entries(net)) {
      rxTotal += counters.rx;
      txTotal += counters.tx;
      if (prev && prev.net && prev.net[dev]) {
        const d = counters.rx - prev.net[dev].rx;
        if (d > bestDelta) { bestDelta = d; bestDev = dev; }
        rx += Math.max(0, counters.rx - prev.net[dev].rx);
        tx += Math.max(0, counters.tx - prev.net[dev].tx);
      }
    }
    // 分母用远端 /proc/uptime 差分：本地解析时刻把 exec 与网络往返也算进去，df 一慢就会污染速率
    const intervalMs = prev ? Math.max(500, (uptimeSec - prev.uptimeSec) * 1000) : 2000;
    const diskStats = parseDiskstats((s.F || []).join('\n'));
    const disks = parseDf((s.E || []).join('\n')).map((d) => {
      const name = d.dev.replace(/^\/dev\//, '');
      const curr = diskStats[name] || diskStats[name.replace(/\d+$/, '')];
      const prevD = prev && prev.disk && (prev.disk[name] || prev.disk[name.replace(/\d+$/, '')]);
      if (!curr || !prevD) return Object.assign(d, { readKBs: null, writeKBs: null });
      const rd = Math.max(0, curr.read - prevD.read) / 1024 * (1000 / intervalMs);
      const wr = Math.max(0, curr.write - prevD.write) / 1024 * (1000 / intervalMs);
      return Object.assign(d, { readKBs: Math.round(rd * 10) / 10, writeKBs: Math.round(wr * 10) / 10 });
    });
    return {
      prev: { aggregate: stat.aggregate, net, disk: diskStats, uptimeSec },
      snapshot: {
        cpu: {
          cores: stat.cores.length,
          overall: overall == null ? null : Math.round(overall * 10) / 10,
        },
        mem: parseMeminfo((s.B || []).join('\n')),
        net: {
          dev: bestDev,
          rxKBs: Math.round((rx / 1024) * (1000 / intervalMs) * 10) / 10,
          txKBs: Math.round((tx / 1024) * (1000 / intervalMs) * 10) / 10,
          rxGB: Math.round((rxTotal / 1024 ** 3) * 100) / 100,
          txGB: Math.round((txTotal / 1024 ** 3) * 100) / 100,
        },
        disks,
        uptimeSec: uptime,
      },
    };
  },
};

const darwin = {
  id: 'darwin',
  pollMs: 4000,
  metaCommand: '{ echo @A; uname -snr; echo @B; sw_vers -productVersion 2>/dev/null; echo @C; sysctl -n hw.ncpu hw.memsize machdep.cpu.brand_string hw.packages; echo @E; date +"%Z %z"; } 2>/dev/null',
  pollCommand: '{ echo @A; top -l 1 -n 0 | sed -n "/CPU usage/p"; echo @B; vm_stat; echo @C; netstat -ibn | awk \'NR>1{print $1, $7, $10}\'; echo @D; df -k; echo @E; sysctl -n kern.boottime; echo @F; sysctl -n hw.memsize; } 2>/dev/null',
  parseMeta(text) {
    const s = sections(text);
    const uname = (s.A || []).join(' ').trim().split(/\s+/);
    const sys = (s.C || []).join('\n').split(/\r?\n/).map((l) => l.trim());
    const modelIdx = sys.findIndex((l) => /intel|i3|apple|m1|m2|m3|amd|ryzen|xeon|cpu/i.test(l) && !/^\d+$/.test(l));
    const numbers = sys.filter((l) => /^\d+$/.test(l));
    return {
      hostname: uname[0] || '',
      distro: 'macOS ' + ((s.B || []).join('').trim() || ''),
      kernel: uname.slice(1).join(' '),
      cpuModel: modelIdx >= 0 ? sys[modelIdx] : '',
      cores: num(numbers[0], 0),
      sockets: Math.max(1, num(numbers[2], 1)),
      tz: (s.E || []).join('').trim(),
    };
  },
  parsePoll(text, prev) {
    const s = sections(text);
    const cpuLine = (s.A || []).join('').match(/(\d+(?:\.\d+)?)% user.*?(\d+(?:\.\d+)?)% sys/);
    const overall = cpuLine ? num(cpuLine[1]) + num(cpuLine[2]) : null;
    const statText = (s.B || []).join('\n');
    const pageSize = num((statText.match(/page size of (\d+)/) || [])[1], 4096);
    const field = (name) => num((statText.match(new RegExp(name + ':\\s+(\\d+)')) || [])[1], 0);
    const totalBytes = num((s.F || []).join('').trim(), 0);
    const active = field('active');
    const wired = field('wired');
    const compressed = field('occupied');
    const inactive = field('inactive');
    const speculative = field('speculative');
    const usedPages = active + wired + compressed;
    const net = {};
    for (const line of (s.C || []).join('\n').split(/\r?\n/)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 3) continue;
      const dev = f[0];
      if (!dev || dev === 'lo0' || /^\d+$/.test(dev)) continue;
      if (!net[dev]) net[dev] = { rx: num(f[1]), tx: num(f[2]) };
      else { net[dev].rx = Math.max(net[dev].rx, num(f[1])); net[dev].tx = Math.max(net[dev].tx, num(f[2])); }
    }
    let rx = 0;
    let tx = 0;
    let rxTotal = 0;
    let txTotal = 0;
    let bestDev = '';
    let bestDelta = -1;
    for (const [dev, counters] of Object.entries(net)) {
      rxTotal += counters.rx;
      txTotal += counters.tx;
      if (prev && prev.net && prev.net[dev]) {
        const d = counters.rx - prev.net[dev].rx;
        if (d > bestDelta) { bestDelta = d; bestDev = dev; }
        rx += Math.max(0, counters.rx - prev.net[dev].rx);
        tx += Math.max(0, counters.tx - prev.net[dev].tx);
      }
    }
    // macOS 的 BSD date 没有亚秒精度，拿不到可用的远端采样时钟，只能继续用本地解析间隔
    const intervalMs = prev ? Math.max(500, Date.now() - prev.ts) : 3000;
    const boot = num((s.E || []).join('').match(/sec\s*=\s*(\d+)/)?.[1], 0);
    const disks = [];
    const seen = new Set();
    for (const line of (s.D || []).join('\n').split(/\r?\n/).slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 6 || !f[0].startsWith('/dev/')) continue;
      const mount = f.slice(5).join(' ');
      if (seen.has(mount)) continue;
      seen.add(mount);
      disks.push({ dev: f[0], mount, totalGB: gb(num(f[1])), usedGB: gb(num(f[2])) });
    }
    const totalGB = gb(totalBytes / 1024);
    return {
      prev: { net, ts: Date.now() },
      snapshot: {
        cpu: { cores: 0, overall: overall == null ? null : Math.round(overall * 10) / 10 },
        mem: {
          totalGB,
          usedGB: Math.round((usedPages * pageSize / 1024 / 1024 / 1024) * 100) / 100,
          cacheGB: Math.round(((inactive + speculative) * pageSize / 1024 / 1024 / 1024) * 100) / 100,
        },
        net: {
          dev: bestDev,
          rxKBs: Math.round((rx / 1024) * (1000 / intervalMs) * 10) / 10,
          txKBs: Math.round((tx / 1024) * (1000 / intervalMs) * 10) / 10,
          rxGB: Math.round((rxTotal / 1024 ** 3) * 100) / 100,
          txGB: Math.round((txTotal / 1024 ** 3) * 100) / 100,
        },
        disks,
        uptimeSec: boot ? Math.max(0, Math.floor(Date.now() / 1000) - boot) : 0,
      },
    };
  },
};

/** PowerShell console output can carry a UTF-8 BOM that JSON.parse rejects. */
function jsonSafe(text) {
  return String(text == null ? '' : text).replace(/^﻿+/, '').trim();
}

/** boot 失败分两种：输出坏了（重开通道可能就好）与这台机器的性能计数器类根本查不到（重开多少次都一样）。 */
function countersMissing(text) {
  try {
    const raw = JSON.parse(jsonSafe(text));
    return Boolean(raw) && raw.rawOk === false;
  } catch (_) {
    return false;
  }
}

/** Windows 采集走常驻 PowerShell 通道：boot 一次查完慢的基础类并把静态量留在进程全局，之后每帧只读
 *  `Win32_PerfRawData_*` 原始计数器，速率与占用由 JS 端按远端 100NS 时间戳差分（与 Linux 的 /proc 差分同语义）。
 *  实测冷查 FormattedData 聚合类要 0.55~1.8s，原始计数器只要 15~80ms，差一个数量级。
 *  经 stdin 喂给 `powershell -Command -` 的脚本必须是分号拼成的单行、且只含 ASCII：
 *  带换行的多行构造会让行解析器一直等闭合，此后所有输入都不再执行。 */
const WINDOWS_IDLE_SEC = 900;

const WINDOWS_BASE = [
  "$ErrorActionPreference='SilentlyContinue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$Global:Exp=(Get-Date).AddSeconds(' + WINDOWS_IDLE_SEC + ')',
];

/** 卷的 fs 与容量只来自 Win32_LogicalDisk（原始磁盘类没有这两项）：boot 扫一次，帧脚本每 WINDOWS_CAP_EVERY 帧重扫，
 *  这样 boot 之后新插入的 U 盘、新映射的网络盘最迟 N 个周期就会出现，而每帧的贵查询仍然只有一次都没有。 */
const WINDOWS_CAP_EVERY = 15;
const WINDOWS_CAP_SCAN = 'foreach($v in @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")){$Global:Cap[$v.DeviceID]=@{fs=$v.FileSystem;totalMB=[math]::Round($v.Size/1MB,1)}}';

/** 只在 boot 查一次的慢类与静态量：OS 描述、核数、总内存、开机时刻、CPU 型号、各卷的 fs 与容量。 */
const WINDOWS_BOOT_STATIC = [
  '$O=Get-CimInstance Win32_OperatingSystem',
  '$S=Get-CimInstance Win32_ComputerSystem',
  '$Global:Cores=[int]$S.NumberOfLogicalProcessors',
  '$Global:TotalBytes=[long]($O.TotalVisibleMemorySize*1KB)',
  '$Global:Boot=$O.LastBootUpTime',
  "$Global:Cpu=(Get-ItemProperty 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0').ProcessorNameString",
  '$Global:Cap=@{}',
  WINDOWS_CAP_SCAN,
];

const WINDOWS_META_JSON = '@{hostname=$env:COMPUTERNAME;distro=$O.Caption;kernel=$O.Version;arch=$env:PROCESSOR_ARCHITECTURE;cpuModel=$Global:Cpu;sockets=[int]$S.NumberOfProcessors;cores=$Global:Cores;tz=(Get-TimeZone).Id}|ConvertTo-Json -Compress';

/** 帧内空闲期限自退：连接被硬断时 sshd 未必及时关掉 stdin，避免常驻进程长期滞留。 */
const WINDOWS_FRAME_GUARD = '$n=Get-Date;if($Global:Exp -and $n -gt $Global:Exp){exit};$Global:Exp=$n.AddSeconds(' + WINDOWS_IDLE_SEC + ')';

const WINDOWS_RAW_QUERY = [
  "$P=Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter \"Name='_Total'\"",
  '$N=@(Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface)',
  '$V=@(Get-CimInstance Win32_PerfRawData_PerfDisk_LogicalDisk)',
  '$M=Get-CimInstance Win32_PerfRawData_PerfOS_Memory',
];

/** LogicalDisk 的实例名就是 C: 这样的盘符，只保留 $Global:Cap 里查到的卷（原始类还带着 _Total 与 HarddiskVolume*）。 */
/** 计数器类取不到时 PowerShell 只会留下 $null，`[double]$null` 又是 0（照样是「合法」数值），界面会显示内存 100%、
 *  磁盘空列表却不报错。所以把「这次到底查没查到」显式带出来，交给 JS 端判定失败。 */
const WINDOWS_RAW_JSON = '$R=@{rawOk=[bool]($P -and $M);'
  + 'cpu=@{idle=[double]$P.PercentIdleTime;priv=[double]$P.PercentPrivilegedTime;user=[double]$P.PercentUserTime;ts=[double]$P.Timestamp_Sys100NS};'
  + 'mem=@{totalBytes=$Global:TotalBytes;availBytes=[double]$M.AvailableBytes;cacheBytes=[double]$M.CacheBytes};'
  + 'net=@($N|ForEach-Object{@{n=$_.Name;rx=[double]$_.BytesReceivedPersec;tx=[double]$_.BytesSentPersec;ts=[double]$_.Timestamp_Sys100NS}});'
  + 'disks=@($V|ForEach-Object{$c=$Global:Cap[$_.Name];if($c){@{mount=$_.Name;fs=$c.fs;totalMB=$c.totalMB;freeMB=[double]$_.FreeMegabytes;rd=[double]$_.DiskReadBytesPersec;wr=[double]$_.DiskWriteBytesPersec;ts=[double]$_.Timestamp_Sys100NS}}});'
  + 'cores=$Global:Cores;uptimeSec=[int]((Get-Date)-$Global:Boot).TotalSeconds};'
  + '$R|ConvertTo-Json -Compress -Depth 5';

/** boot 交出 meta 与相隔 1 秒的两帧原始采样，因此 Windows 的首帧就带速率，而不是下一轮才有。 */
const WINDOWS_BOOT_SCRIPT = WINDOWS_BASE
  .concat(WINDOWS_BOOT_STATIC)
  .concat(["'@A'", WINDOWS_META_JSON, "'@B'"], WINDOWS_RAW_QUERY, [WINDOWS_RAW_JSON], ["'@C'", 'Start-Sleep 1'], WINDOWS_RAW_QUERY, [WINDOWS_RAW_JSON])
  .join(';');

/** 帧脚本：空闲自退守卫 → 按帧号重扫卷表 → 读原始计数器。仍然只查 Raw 类，慢的 LogicalDisk 每 N 帧才碰一次。 */
const WINDOWS_CAP_TICK = '$Global:F=([int]$Global:F)+1;if($Global:F -ge ' + WINDOWS_CAP_EVERY + '){$Global:F=0;' + WINDOWS_CAP_SCAN + '}';

const WINDOWS_FRAME_SCRIPT = [WINDOWS_FRAME_GUARD, WINDOWS_CAP_TICK].concat(WINDOWS_RAW_QUERY, [WINDOWS_RAW_JSON]).join(';');

const windows = {
  id: 'windows',
  pollMs: 3000,
  resident: true,
  bootCommand: WINDOWS_BOOT_SCRIPT,
  frameCommand: WINDOWS_FRAME_SCRIPT,
  parseBoot(text) {
    const s = sections(text);
    if (!s.A || !s.B || !s.C) return null;
    const meta = this.parseMeta(s.A.join('\n'));
    if (!meta) return null;
    const seed = this.parsePoll(s.B.join('\n'), null);
    if (!seed) return countersMissing(s.B.join('\n')) ? { error: 'counters', meta } : null;
    const frame = this.parsePoll(s.C.join('\n'), seed.prev);
    return frame ? { meta, prev: frame.prev, snapshot: frame.snapshot } : null;
  },
  parseMeta(text) {
    try {
      const raw = JSON.parse(jsonSafe(text));
      return {
        hostname: raw.hostname || '',
        distro: (raw.distro || '').trim(),
        kernel: 'NT ' + (raw.kernel || ''),
        arch: raw.arch || '',
        cpuModel: String(raw.cpuModel || '').trim(),
        tz: String(raw.tz || '').trim(),
        cores: num(raw.cores, 0),
        sockets: Math.max(1, num(raw.sockets, 1)),
      };
    } catch (_) {
      return null;
    }
  },
  parsePoll(text, prev) {
    let raw = null;
    try {
      raw = JSON.parse(jsonSafe(text));
    } catch (_) {
      return null;
    }
    if (!raw || raw.rawOk === false || !raw.cpu || !(raw.cpu.ts > 0)) return null;

    const cpuPrev = prev && prev.cpu;
    const cpuElapsedMs = cpuPrev ? (raw.cpu.ts - cpuPrev.ts) / 1e4 : 0;
    const idleMs = cpuPrev ? (raw.cpu.idle - cpuPrev.idle) / 1e4 : 0;
    const overall = cpuElapsedMs > 0 ? Math.max(0, Math.min(100, 100 * (1 - idleMs / cpuElapsedMs))) : null;

    const totalBytes = num(raw.mem && raw.mem.totalBytes, 0);
    const availBytes = num(raw.mem && raw.mem.availBytes, 0);
    const cacheBytes = num(raw.mem && raw.mem.cacheBytes, 0);

    const netPrev = (prev && prev.net) || {};
    const net = {};
    let rxKBs = 0;
    let txKBs = 0;
    let rxTotal = 0;
    let txTotal = 0;
    for (const item of Array.isArray(raw.net) ? raw.net : []) {
      if (!item || !item.n) continue;
      const rx = num(item.rx, -1);
      const tx = num(item.tx, -1);
      if (rx < 0 || tx < 0) continue;
      const ts = num(item.ts, 0);
      net[item.n] = { rx, tx, ts };
      rxTotal += rx;
      txTotal += tx;
      const last = netPrev[item.n];
      if (!last) continue;
      const elapsedMs = (ts - last.ts) / 1e4;
      if (elapsedMs <= 0) continue;
      rxKBs += (Math.max(0, rx - last.rx) / elapsedMs) * (1000 / 1024);
      txKBs += (Math.max(0, tx - last.tx) / elapsedMs) * (1000 / 1024);
    }

    const diskPrev = (prev && prev.disk) || {};
    const diskNow = {};
    const disks = [];
    for (const item of Array.isArray(raw.disks) ? raw.disks : []) {
      if (!item || !item.mount) continue;
      const rd = num(item.rd, 0);
      const wr = num(item.wr, 0);
      const ts = num(item.ts, 0);
      diskNow[item.mount] = { rd, wr, ts };
      const last = diskPrev[item.mount];
      const elapsedMs = last ? (ts - last.ts) / 1e4 : 0;
      const totalMB = num(item.totalMB, 0);
      disks.push({
        dev: item.mount,
        mount: item.mount,
        fs: item.fs || null,
        totalGB: round2(totalMB / 1024),
        usedGB: round2(Math.max(0, totalMB - num(item.freeMB, 0)) / 1024),
        readKBs: elapsedMs > 0 ? round1(((Math.max(0, rd - last.rd) / elapsedMs) * 1000) / 1024) : null,
        writeKBs: elapsedMs > 0 ? round1(((Math.max(0, wr - last.wr) / elapsedMs) * 1000) / 1024) : null,
      });
    }

    // 原始性能类的实例顺序不固定（实测 D:、E:、C:），按盘符排好再交给界面
    disks.sort((a, b) => a.mount.localeCompare(b.mount));

    return {
      prev: { cpu: { idle: num(raw.cpu.idle, 0), ts: num(raw.cpu.ts, 0) }, net, disk: diskNow },
      snapshot: {
        cpu: { cores: num(raw.cores, 0), overall: overall == null ? null : round1(overall) },
        mem: {
          totalGB: round2(totalBytes / 1024 ** 3),
          usedGB: round2(Math.max(0, totalBytes - availBytes) / 1024 ** 3),
          cacheGB: round2(cacheBytes / 1024 ** 3),
        },
        net: {
          dev: '',
          rxKBs: round1(rxKBs),
          txKBs: round1(txKBs),
          rxGB: round2(rxTotal / 1024 ** 3),
          txGB: round2(txTotal / 1024 ** 3),
        },
        disks,
        uptimeSec: num(raw.uptimeSec, 0),
      },
    };
  },
};

module.exports = { linux, darwin, windows };
