const fs = require('fs');
const path = require('path');

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_TOTAL_DEFAULT_BYTES = 20 * 1024 * 1024;
const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'passwd',
  'secret',
  'token',
  'apikey',
  'secretkey',
  'privatekey',
  'privatekeypath',
  'privatekeypassphrase',
  'passphrase',
  'answers',
  'responses',
  'cookie',
  '_password',
  '_pass',
  'credential',
]);

/** Log entries are technical facts (host/port/code/duration) — never credentials. */
function sanitizeMeta(meta) {
  if (meta == null) return undefined;
  const t = typeof meta;
  if (t === 'string' || t === 'number' || t === 'boolean') return meta;
  if (Array.isArray(meta)) return meta.map(sanitizeMeta);
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(meta)) {
      out[k] = SENSITIVE_KEYS.has(String(k).toLowerCase()) ? '[redacted]' : sanitizeMeta(meta[k]);
    }
    return out;
  }
  return undefined;
}

/** 过滤判定按原始字节区间就地解析，语义与旧的内存过滤一致 */
function makeTester(filter, needle) {
  const level = filter.level && LEVEL_ORDER[filter.level] !== undefined ? filter.level : '';
  const source = filter.source ? String(filter.source) : '';
  return (buf, start, end) => {
    let e;
    try {
      e = JSON.parse(buf.toString('utf8', start, end));
    } catch (_) {
      return false;
    }
    if (!e || typeof e.time !== 'number') return false;
    if (level && e.level !== level) return false;
    if (source && e.source !== source) return false;
    if (
      needle &&
      !(
        String(e.message).toLowerCase().includes(needle) ||
        JSON.stringify(e.meta || {}).toLowerCase().includes(needle)
      )
    ) {
      return false;
    }
    return true;
  };
}

/**
 * Persistent log sink: append-only app.log with size-based rotation. Single
 * instance created in main; managers receive a bound `log` callback so connection
 * lifecycles can record key events.
 * Disk use is capped by totalBytes (current file + rotated copies), single file by maxBytes.
 * Queries read the files instead of a memory ring, so the viewer can page through the
 * whole retained history: unfiltered pages only count newlines and parse the shown lines,
 * filtered queries cache matched byte ranges per file while its size/mtime are unchanged.
 */
class LogStore {
  constructor({ dir, maxBytes = LOG_MAX_BYTES, totalBytes = LOG_TOTAL_DEFAULT_BYTES, onNew } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.totalBytes = totalBytes;
    this.keepBackups = this._backupCount(totalBytes);
    this.onNew = onNew || (() => {});
    this._lines = new Map(); // file -> { sig, count }
    this._matches = new Map(); // file -> { sig, key, ranges }
    this.logFile = path.join(dir, 'app.log');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }

  _backupCount(totalBytes) {
    return Math.max(1, Math.floor(totalBytes / this.maxBytes) - 1);
  }

  /** 日志总量改变后立即按新上限淘汰多余的历史文件 */
  setTotalBytes(totalBytes) {
    const n = Number(totalBytes);
    if (!Number.isFinite(n) || n <= 0) return this.totalBytes;
    this.totalBytes = n;
    this.keepBackups = this._backupCount(n);
    for (let i = this.keepBackups + 1; ; i++) {
      const extra = this.logFile + '.' + i;
      if (!fs.existsSync(extra)) break;
      try {
        fs.rmSync(extra, { force: true });
      } catch (_) {
        break;
      }
    }
    this._forget();
    return this.totalBytes;
  }

  /** 日志目录跟随「存储位置」：后续写入与查询都指向新目录 */
  setDir(dir) {
    if (!dir || dir === this.dir) return this.dir;
    this.dir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    this.logFile = path.join(dir, 'app.log');
    this._forget();
    return this.dir;
  }

  _forget() {
    this._lines.clear();
    this._matches.clear();
  }

  /** 从新到旧：app.log 最新，后缀越大越旧 */
  _files() {
    const out = [];
    if (fs.existsSync(this.logFile)) out.push(this.logFile);
    for (let i = 1; i <= this.keepBackups; i++) {
      const f = this.logFile + '.' + i;
      if (fs.existsSync(f)) out.push(f);
    }
    return out;
  }

  /** 日志只追加，签名不变则内容不变，缓存才可用 */
  _sig(file) {
    try {
      const s = fs.statSync(file);
      return s.size + ':' + Math.round(s.mtimeMs);
    } catch (_) {
      return '';
    }
  }

  /** 逐字节数非空行，不碰 JSON：未过滤视图的 total 因此很便宜 */
  _count(file) {
    const sig = this._sig(file);
    if (!sig) return 0;
    const hit = this._lines.get(file);
    if (hit && hit.sig === sig) return hit.count;
    let count = 0;
    try {
      const buf = fs.readFileSync(file);
      let start = 0;
      for (let i = 0; i <= buf.length; i++) {
        if (i === buf.length || buf[i] === 0x0a) {
          if (i > start) count++;
          start = i + 1;
        }
      }
    } catch (_) {
      return 0;
    }
    this._lines.set(file, { sig, count });
    return count;
  }

  /** 取文件内 [from,to) 行（文件顺序，最旧在前），只把这些行转成字符串并解析 */
  _slice(file, from, to) {
    const out = [];
    if (to <= from) return out;
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (_) {
      return out;
    }
    let idx = 0;
    let start = 0;
    for (let i = 0; i <= buf.length && idx < to; i++) {
      if (i === buf.length || buf[i] === 0x0a) {
        if (i > start) {
          if (idx >= from) {
            try {
              const e = JSON.parse(buf.toString('utf8', start, i));
              if (e && typeof e.time === 'number') out.push(e);
            } catch (_) {}
          }
          idx++;
        }
        start = i + 1;
      }
    }
    return out;
  }

  /** 过滤查询：记住匹配的字节区间，翻页时只解析当前页 */
  _ranges(file, key, test) {
    const sig = this._sig(file);
    if (!sig) return [];
    const hit = this._matches.get(file);
    if (hit && hit.sig === sig && hit.key === key) return hit.ranges;
    const ranges = [];
    try {
      const buf = fs.readFileSync(file);
      let start = 0;
      for (let i = 0; i <= buf.length; i++) {
        if (i === buf.length || buf[i] === 0x0a) {
          if (i > start && test(buf, start, i)) ranges.push(start, i);
          start = i + 1;
        }
      }
    } catch (_) {
      return [];
    }
    this._matches.set(file, { sig, key, ranges });
    return ranges;
  }

  /** 取匹配区间中的第 [from,to) 条（文件顺序，最旧在前） */
  _readRanges(file, ranges, from, to) {
    const out = [];
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (_) {
      return out;
    }
    for (let i = from; i < to; i++) {
      try {
        const e = JSON.parse(buf.toString('utf8', ranges[i * 2], ranges[i * 2 + 1]));
        if (e && typeof e.time === 'number') out.push(e);
      } catch (_) {}
    }
    return out;
  }

  log(level, source, message, meta) {
    const entry = {
      time: Date.now(),
      level: LEVEL_ORDER[level] !== undefined ? level : 'info',
      source: source || 'sys',
      message: message == null ? '' : String(message),
      meta: sanitizeMeta(meta),
    };
    this.append(entry);
    try {
      this.onNew(entry);
    } catch (_) {}
    return entry;
  }

  info(source, message, meta) {
    return this.log('info', source, message, meta);
  }

  warn(source, message, meta) {
    return this.log('warn', source, message, meta);
  }

  error(source, message, meta) {
    return this.log('error', source, message, meta);
  }

  /** 从磁盘按分页取样：默认跨文件从新到旧、文件内从尾到头，order:'asc' 整体反向，只解析当前页需要的行 */
  list(filter = {}) {
    const limit = Math.max(1, Number(filter.limit) || 200);
    const offset = Math.max(0, Number(filter.offset) || 0);
    const asc = filter.order === 'asc';
    const files = this._files();
    const needle = String(filter.keyword || '').trim().toLowerCase();
    const hasFilter = Boolean((filter.level && LEVEL_ORDER[filter.level] !== undefined) || filter.source || needle);
    const key = [filter.level || '', filter.source || '', needle].join('|');
    const test = hasFilter ? makeTester(filter, needle) : null;
    const matched = hasFilter ? files.map((f) => this._ranges(f, key, test)) : null;
    const count = (i) => (matched ? matched[i].length / 2 : this._count(files[i]));

    const total = files.reduce((n, f, i) => n + count(i), 0);
    const entries = [];
    let skip = offset;
    for (let k = 0; k < files.length && entries.length < limit; k++) {
      const i = asc ? files.length - 1 - k : k;
      const c = count(i);
      if (skip >= c) {
        skip -= c;
        continue;
      }
      const want = limit - entries.length;
      const from = asc ? skip : Math.max(0, c - skip - want);
      const to = asc ? Math.min(c, skip + want) : c - skip;
      const part = matched
        ? this._readRanges(files[i], matched[i], from, to)
        : this._slice(files[i], from, to);
      if (asc) {
        for (let j = 0; j < part.length; j++) entries.push(part[j]);
      } else {
        for (let j = part.length - 1; j >= 0; j--) entries.push(part[j]);
      }
      skip = 0;
    }
    return { entries, total, offset, limit };
  }

  clear() {
    this._forget();
    try {
      fs.rmSync(this.logFile, { force: true });
    } catch (_) {}
    for (let i = 1; i <= this.keepBackups; i++) {
      try {
        fs.rmSync(this.logFile + '.' + i, { force: true });
      } catch (_) {}
    }
    return { ok: true };
  }

  append(entry) {
    let line;
    try {
      line = JSON.stringify(entry);
    } catch (_) {
      return;
    }
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > this.maxBytes) {
        this.rotate();
      }
    } catch (_) {}
    try {
      fs.appendFileSync(this.logFile, line + '\n', 'utf8');
    } catch (e) {
      console.error('[log] write failed', e.message);
    }
  }

  rotate() {
    try {
      const last = this.logFile + '.' + this.keepBackups;
      if (fs.existsSync(last)) fs.rmSync(last, { force: true });
      for (let i = this.keepBackups - 1; i >= 1; i--) {
        const from = this.logFile + '.' + i;
        const to = this.logFile + '.' + (i + 1);
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      if (fs.existsSync(this.logFile)) fs.renameSync(this.logFile, this.logFile + '.1');
    } catch (_) {}
  }
}

module.exports = { LogStore };