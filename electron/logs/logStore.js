const fs = require('fs');
const path = require('path');

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'passwd',
  'secret',
  'token',
  'secretkey',
  'privatekey',
  'privatekeypath',
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

/**
 * Persistent log sink: in-memory ring buffer + append-only app.log with
 * size-based rotation. Single instance created in main; managers receive a
 * bound `log` callback so connection lifecycles can record key events.
 */
class LogStore {
  constructor({ dir, maxBytes = 5 * 1024 * 1024, keepBackups = 2, inMemory = 1000, onNew } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.keepBackups = keepBackups;
    this.inMemoryLimit = inMemory;
    this.onNew = onNew || (() => {});
    this.buffer = [];
    this.logFile = path.join(dir, 'app.log');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    this._loadExisting();
  }

  /** Restore entries persisted in app.log so logs survive app restarts. */
  _loadExisting() {
    try {
      if (!fs.existsSync(this.logFile)) return;
      const lines = fs.readFileSync(this.logFile, 'utf8').split('\n');
      const entries = [];
      for (const line of lines) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e && typeof e.time === 'number') entries.push(e);
        } catch (_) {}
      }
      this.buffer = entries.length > this.inMemoryLimit
        ? entries.slice(entries.length - this.inMemoryLimit)
        : entries;
    } catch (_) {
      this.buffer = [];
    }
  }

  log(level, source, message, meta) {
    const entry = {
      time: Date.now(),
      level: LEVEL_ORDER[level] !== undefined ? level : 'info',
      source: source || 'sys',
      message: message == null ? '' : String(message),
      meta: sanitizeMeta(meta),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.inMemoryLimit) {
      this.buffer.splice(0, this.buffer.length - this.inMemoryLimit);
    }
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

  list(filter = {}) {
    let arr = this.buffer;
    if (filter.level && LEVEL_ORDER[filter.level] !== undefined) {
      arr = arr.filter((e) => e.level === filter.level);
    }
    if (filter.source) {
      arr = arr.filter((e) => e.source === filter.source);
    }
    const keyword = String(filter.keyword || '').trim().toLowerCase();
    if (keyword) {
      arr = arr.filter(
        (e) =>
          String(e.message).toLowerCase().includes(keyword) ||
          JSON.stringify(e.meta || {}).toLowerCase().includes(keyword)
      );
    }
    const total = arr.length;
    const limit = Math.max(1, Number(filter.limit) || 200);
    const offset = Math.max(0, Number(filter.offset) || 0);
    const end = total - offset;
    const start = Math.max(0, end - limit);
    const page = start < end ? arr.slice(start, end).reverse() : [];
    return { entries: page, total, offset, limit };
  }

  clear() {
    this.buffer = [];
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