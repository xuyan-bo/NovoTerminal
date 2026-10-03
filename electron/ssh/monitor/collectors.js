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
  pollCommand: '{ echo @A; cat /proc/stat; echo @B; grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable):" /proc/meminfo; echo @C; cat /proc/loadavg; echo @D; cat /proc/uptime; echo @E; cat /proc/net/dev; echo @F; df -kPT; echo @G; cat /proc/diskstats; } 2>/dev/null',
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
    const overall = tickPercent(prev && prev.aggregate, stat.aggregate);
    const perCore = stat.cores.map((ticks, i) => {
      const p = prev && prev.cores && prev.cores[i] ? tickPercent(prev.cores[i], ticks) : null;
      return p == null ? null : Math.round(p * 10) / 10;
    });
    const load = (s.C || []).join('').trim().split(/\s+/).map((v) => num(v, 0));
    const uptime = Math.floor(num((s.D || []).join('').trim().split(/\s+/)[0], 0));
    const net = parseNetDev((s.E || []).join('\n'));
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
    const intervalMs = prev ? Math.max(500, Date.now() - prev.ts) : 2000;
    const diskStats = parseDiskstats((s.G || []).join('\n'));
    const disks = parseDf((s.F || []).join('\n')).map((d) => {
      const name = d.dev.replace(/^\/dev\//, '');
      const curr = diskStats[name] || diskStats[name.replace(/\d+$/, '')];
      const prevD = prev && prev.disk && (prev.disk[name] || prev.disk[name.replace(/\d+$/, '')]);
      if (!curr || !prevD) return Object.assign(d, { readKBs: null, writeKBs: null });
      const rd = Math.max(0, curr.read - prevD.read) / 1024 * (1000 / intervalMs);
      const wr = Math.max(0, curr.write - prevD.write) / 1024 * (1000 / intervalMs);
      return Object.assign(d, { readKBs: Math.round(rd * 10) / 10, writeKBs: Math.round(wr * 10) / 10 });
    });
    return {
      prev: { aggregate: stat.aggregate, cores: stat.cores, net, disk: diskStats, ts: Date.now() },
      snapshot: {
        cpu: {
          cores: stat.cores.length,
          overall: overall == null ? null : Math.round(overall * 10) / 10,
          perCore: perCore.some((v) => v != null) ? perCore : null,
          load: load.length >= 3 ? load.slice(0, 3) : null,
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
        cpu: { cores: 0, overall: overall == null ? null : Math.round(overall * 10) / 10, perCore: null, load: null },
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

function powershell(script) {
  return 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
}

/** PowerShell console output can carry a UTF-8 BOM that JSON.parse rejects. */
function jsonSafe(text) {
  return String(text == null ? '' : text).replace(/^﻿+/, '').trim();
}

const WINDOWS_META_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "$S=Get-CimInstance Win32_ComputerSystem",
  "$O=Get-CimInstance Win32_OperatingSystem",
  "$C=@(Get-CimInstance Win32_Processor)",
  "@{hostname=$S.Name;distro=$O.Caption;kernel=$O.Version;arch=$env:PROCESSOR_ARCHITECTURE;cpuModel=$C[0].Name;sockets=[int]$S.NumberOfProcessors;cores=[int]$S.NumberOfLogicalProcessors;tz=(Get-TimeZone).Id}|ConvertTo-Json -Compress -Depth 3",
].join(';');

const WINDOWS_POLL_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "$O=Get-CimInstance Win32_OperatingSystem",
  "$S=Get-CimInstance Win32_ComputerSystem",
  "$P=@(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor)",
  "$T=@($P|Where-Object{$_.Name -ne '_Total'})",
  "$A=@($P|Where-Object{$_.Name -eq '_Total'})",
  "$D=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')",
  "$N=@(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface)",
  "$PD=@(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk)",
  "$rx=0.0;$tx=0.0",
  "foreach($i in $N){$rx+=[double]$i.BytesReceivedPersec;$tx+=[double]$i.BytesSentPersec}",
  "$j=@{cpu=@{cores=[int]$S.NumberOfLogicalProcessors;overall=[double]$A[0].PercentProcessorTime;perCore=@($T|ForEach-Object{[double]$_.PercentProcessorTime})};mem=@{totalGB=[math]::Round($O.TotalVisibleMemorySize/1MB,1);usedGB=[math]::Round(($O.TotalVisibleMemorySize-$O.FreePhysicalMemory)/1MB,1);cacheGB=0};net=@{rxKBs=[math]::Round($rx/1KB,1);txKBs=[math]::Round($tx/1KB,1)};disks=@($D|ForEach-Object{@{dev=$_.DeviceID;mount=$_.DeviceID;fs=$_.FileSystem;totalGB=[math]::Round($_.Size/1GB,1);usedGB=[math]::Round(($_.Size-$_.FreeSpace)/1GB,1)}});diskio=@($PD|ForEach-Object{@{n=$_.Name;r=[double]$_.ReadBytesPersec;w=[double]$_.WriteBytesPersec}});uptimeSec=[int](((Get-Date)-$O.LastBootUpTime).TotalSeconds)}",
  "$j|ConvertTo-Json -Compress -Depth 6",
].join(';');

const windows = {
  id: 'windows',
  pollMs: 5000,
  metaCommand: powershell(WINDOWS_META_SCRIPT),
  pollCommand: powershell(WINDOWS_POLL_SCRIPT),
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
  parsePoll(text) {
    let raw = null;
    try {
      raw = JSON.parse(jsonSafe(text));
    } catch (_) {
      return null;
    }
    if (!raw || !raw.cpu) return null;
    const perCore = Array.isArray(raw.cpu.perCore) && raw.cpu.perCore.length ? raw.cpu.perCore.map((v) => num(v)) : null;
    const ioList = Array.isArray(raw.diskio) ? raw.diskio : [];
    const disks = Array.isArray(raw.disks)
      ? raw.disks.map((d) => {
          const io = ioList.find((x) => x && x.n && String(x.n).includes(d.mount));
          return Object.assign({ dev: d.dev, mount: d.mount, fs: d.fs || null, totalGB: num(d.totalGB), usedGB: num(d.usedGB) },
            io
              ? { readKBs: Math.round(num(io.r, 0) / 102.4) / 10, writeKBs: Math.round(num(io.w, 0) / 102.4) / 10 }
              : { readKBs: null, writeKBs: null });
        })
      : [];
    return {
      prev: null,
      snapshot: {
        cpu: {
          cores: num(raw.cpu.cores, perCore ? perCore.length : 0),
          overall: num(raw.cpu.overall, 0),
          perCore,
          load: null,
        },
        mem: { totalGB: num(raw.mem.totalGB, 0), usedGB: num(raw.mem.usedGB, 0), cacheGB: 0 },
        net: { dev: '', rxKBs: num(raw.net.rxKBs, 0), txKBs: num(raw.net.txKBs, 0), rxGB: null, txGB: null },
        disks,
        uptimeSec: num(raw.uptimeSec, 0),
      },
    };
  },
};

module.exports = { linux, darwin, windows };
