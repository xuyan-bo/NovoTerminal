const fs = require('fs');
const path = require('path');

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_TOTAL_DEFAULT_BYTES = 20 * 1024 * 1024;
const LOG_QUERY_MAX_LIMIT = 500;
const HEAD_PROBE_BYTES = 64;
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

function makeTester(level, needle) {
  return (e) => {
    if (!e || typeof e.time !== 'number') return false;
    if (level && e.level !== level) return false;
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
 * whole retained history. Each file keeps an incremental byte-offset index of its lines:
 * the index only ever extends over newly appended bytes, total is the number of indexed
 * lines, and a page reads just the bytes of the lines it shows. Filtered queries keep the
 * matching line numbers per condition and only test the lines appended since the last query.
 */
class LogStore {
  constructor({ dir, maxBytes = LOG_MAX_BYTES, totalBytes = LOG_TOTAL_DEFAULT_BYTES, onNew } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.totalBytes = totalBytes;
    this.keepBackups = this._backupCount(totalBytes);
    this.onNew = onNew || (() => {});
    this._indexMap = new Map(); // file -> { size, mtime, head, starts, ends, scanPos, key, ranges, upto }
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
    this._indexMap.clear();
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

  _readRange(file, pos, len) {
    if (len <= 0) return Buffer.alloc(0);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      return buf.subarray(0, fs.readSync(fd, buf, 0, len, pos));
    } finally {
      fs.closeSync(fd);
    }
  }

  _readHead(file, n) {
    try {
      return this._readRange(file, 0, n).toString('utf8');
    } catch (_) {
      return '';
    }
  }

  /**
   * 行字节索引。追加只会让文件变长、mtime 变新、开头字节不动，三条同时成立才敢只扫
   * 尾部；轮转把旧文件改名进来、切换存储位置把历史拼接进来，都会落到整份重建分支。
   */
  _index(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch (_) {
      this._indexMap.delete(file);
      return null;
    }
    const prev = this._indexMap.get(file);
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) return prev;
    const grown =
      prev &&
      prev.scanPos > 0 &&
      st.size > prev.size &&
      st.mtimeMs >= prev.mtime &&
      this._readHead(file, prev.head.length) === prev.head;
    let e;
    if (grown) {
      e = prev;
      e.size = st.size;
      e.mtime = st.mtimeMs;
    } else {
      e = {
        size: st.size,
        mtime: st.mtimeMs,
        head: this._readHead(file, Math.min(HEAD_PROBE_BYTES, st.size)),
        starts: [],
        ends: [],
        scanPos: 0,
        key: '',
        ranges: [],
        upto: 0,
      };
      this._indexMap.set(file, e);
    }
    this._scan(e, file, e.scanPos);
    return e;
  }

  /** 只把以换行收尾的非空行记进索引：写坏了的尾巴不入账，下次查询重看，total 因此不会虚高 */
  _scan(e, file, from) {
    if (e.size <= from) return;
    let buf;
    try {
      buf = this._readRange(file, from, e.size - from);
    } catch (_) {
      return;
    }
    let pos = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break;
      if (nl > pos) {
        e.starts.push(from + pos);
        e.ends.push(from + nl);
      }
      pos = nl + 1;
    }
    e.scanPos = from + pos;
  }

  /** 过滤命中行号：条件不变时只测试上次之后新增的行 */
  _matched(e, file, key, test) {
    if (e.key !== key) {
      e.key = key;
      e.ranges = [];
      e.upto = 0;
    }
    const len = e.starts.length;
    if (e.upto >= len) return e.ranges;
    const a = e.starts[e.upto];
    let buf;
    try {
      buf = this._readRange(file, a, e.ends[len - 1] + 1 - a);
    } catch (_) {
      return e.ranges;
    }
    for (let n = e.upto; n < len; n++) {
      let entry = null;
      try {
        entry = JSON.parse(buf.toString('utf8', e.starts[n] - a, e.ends[n] - a));
      } catch (_) {}
      if (test(entry)) e.ranges.push(n);
    }
    e.upto = len;
    return e.ranges;
  }

  _seq(from, to) {
    const out = [];
    for (let n = from; n < to; n++) out.push(n);
    return out;
  }

  /** 取升序行号对应的记录：一次读出覆盖区间，不碰其余内容 */
  _pick(e, file, idx) {
    const out = [];
    if (!e || !idx.length) return out;
    const a = e.starts[idx[0]];
    let buf;
    try {
      buf = this._readRange(file, a, e.ends[idx[idx.length - 1]] + 1 - a);
    } catch (_) {
      return out;
    }
    for (const n of idx) {
      let entry = null;
      try {
        entry = JSON.parse(buf.toString('utf8', e.starts[n] - a, e.ends[n] - a));
      } catch (_) {}
      if (entry && typeof entry.time === 'number') out.push(entry);
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
    const limit = Math.min(LOG_QUERY_MAX_LIMIT, Math.max(1, Math.floor(Number(filter.limit)) || 200));
    const offset = Math.max(0, Math.floor(Number(filter.offset) || 0));
    const asc = filter.order === 'asc';
    const files = this._files();
    const level = filter.level && LEVEL_ORDER[filter.level] !== undefined ? filter.level : '';
    const needle = String(filter.keyword || '').trim().toLowerCase();
    const hasFilter = Boolean(level || needle);
    const key = level + '|' + needle;
    const test = hasFilter ? makeTester(level, needle) : null;
    const index = files.map((f) => this._index(f));
    const hits = files.map((f, i) => (hasFilter && index[i] ? this._matched(index[i], f, key, test) : null));
    const count = (i) => (hits[i] ? hits[i].length : index[i] ? index[i].starts.length : 0);

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
      const part = this._pick(index[i], files[i], hits[i] ? hits[i].slice(from, to) : this._seq(from, to));
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
