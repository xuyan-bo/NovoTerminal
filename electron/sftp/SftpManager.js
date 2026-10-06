const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSshConnection } = require('../ssh/connection');

function formatSize(n) {
  const num = Number(n) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)} MB`;
  return `${(num / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatSpeed(bps) {
  const n = Number(bps) || 0;
  if (n <= 0) return '—';
  return `${formatSize(n)}/s`;
}

/** Remote paths are POSIX-style; Windows servers still accept forward slashes under a drive root. */
function joinRemotePath(dir, name) {
  if (!dir || dir === '/') return '/' + name;
  return /[\\/]$/.test(dir) ? dir + name : dir + '/' + name;
}

/** Chunk requests one SFTP channel may have outstanding; running transfers share this budget. */
const XFER_REQUEST_BUDGET = 64;
/** Deepest pipeline a single transfer may use, however much of the budget is free. */
const XFER_MAX_FLIGHT = 16;
/** Floor per active transfer so no file starves when many run at once. */
const XFER_MIN_FLIGHT = 4;
/** File-level cap implied by the budget: the smallest share still admits this many transfers. */
const XFER_ACTIVE_LIMIT = Math.floor(XFER_REQUEST_BUDGET / XFER_MIN_FLIGHT);
/** Upload/download block size when the asset leaves it unset. */
const XFER_CHUNK_BYTES = 64 * 1024;
/** Handshake + subsystem timeout when the asset leaves it unset. */
const XFER_READY_TIMEOUT_MS = 20000;
/** Terminal tasks are dropped this long after the renderer received their final event. */
const TASK_PRUNE_MS = 5000;
/** Minimum gap between two progress broadcasts of the same running task. */
const PROGRESS_INTERVAL_MS = 200;
/** Upper bound of the per-connection "remote directory exists" cache. */
const DIR_CACHE_MAX = 20000;
/** Concurrent partial-target cleanups while cancelling a folder subtree. */
const CLEANUP_POOL = 16;

function tunedInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * SFTP sessions + transfer tasks for the external SFTP window.
 */
class SftpManager {
  constructor({ send, store, log }) {
    this.send = send || (() => {});
    this.store = store;
    this.log = log;
    this.conns = new Map(); // connId -> { client, sftp, assetId, host, port }
    this.pending = new Map();
    this.tasks = new Map(); // taskId -> state
    this._seq = 0;
  }

  L(zh, en) {
    return this.store && this.store.getSettings().lang === 'en' ? en : zh;
  }

  _progress(task, opts) {
    const now = Date.now();
    if (!task._lastT) {
      task._lastT = now;
      task._lastBytes = task.transferred;
    }
    const dt = now - task._lastT;
    if (dt >= 500 && task.status === 'running') {
      const db = task.transferred - (task._lastBytes || 0);
      task.speed = db > 0 ? (db / dt) * 1000 : 0;
      task._lastT = now;
      task._lastBytes = task.transferred;
    } else if (task.status !== 'running') {
      task.speed = 0;
    }
    const settled = this._isFinished(task);
    // Chunk callbacks run per request; without this bound a folder of tiny files
    // floods the renderer with one IPC event per chunk per task.
    if (!settled && !(opts && opts.force) && task._lastSent && now - task._lastSent < PROGRESS_INTERVAL_MS) {
      return;
    }
    task._lastSent = now;
    this.send('sftp:progress', {
      taskId: task.taskId,
      connId: task.connId,
      name: task.name,
      size: task.size,
      transferred: task.transferred,
      percent:
        task.size > 0
          ? Math.min(100, Math.round((task.transferred / task.size) * 100))
          : task.status === 'done'
            ? 100
            : 0,
      sizeText: formatSize(task.size),
      transferredText: formatSize(task.transferred),
      speed: task.speed || 0,
      speedText: task.status === 'running' ? formatSpeed(task.speed) : '—',
      direction: task.direction,
      sourcePath: task.sourcePath,
      targetPath: task.targetPath,
      status: task.status,
      error: task.error || '',
    });
    if (settled) {
      const owner = this.conns.get(task.connId);
      if (owner) this._freeSlot(owner, task);
      this._drainConn(task.connId);
      this._pruneLater(task);
    }
  }

  /** Finished tasks must not pile up: listTasks and the task Map are polled every second. */
  _pruneLater(task) {
    if (task._pruneTimer || task.status === 'canceled') return;
    task._pruneTimer = setTimeout(() => {
      task._pruneTimer = null;
      this.tasks.delete(task.taskId);
    }, TASK_PRUNE_MS);
  }

  _queueTask(c, task, begin) {
    task._begin = begin;
    c.xferQueue.push(task.taskId);
    this._drainConn(c.connId);
  }

  _drainConn(connId) {
    const c = this.conns.get(connId);
    if (!c) return;
    while (c.xferQueue.length && c.running.size < c.tune.activeLimit) {
      const id = c.xferQueue.shift();
      const task = this.tasks.get(id);
      if (!task || task.paused || this._isFinished(task) || c.running.has(id)) continue;
      this._takeSlot(c, task);
      task.status = 'running';
      this._progress(task, { force: true });
      if (task._started) {
        this._resumePump(task);
        continue;
      }
      task._started = true;
      try {
        task._begin();
      } catch (e) {
        task.status = 'error';
        task.error = (e && e.message) || String(e);
        this._progress(task, { force: true });
      }
    }
  }

  _takeSlot(c, task) {
    c.running.add(task.taskId);
    this._shareBudget(c);
  }

  _freeSlot(c, task) {
    if (!c.running.delete(task.taskId)) return;
    this._shareBudget(c);
  }

  /** Split the channel's request budget over the running transfers. */
  _shareBudget(c) {
    const share = c.running.size
      ? Math.max(XFER_MIN_FLIGHT, Math.min(XFER_MAX_FLIGHT, Math.floor(XFER_REQUEST_BUDGET / c.running.size)))
      : XFER_MAX_FLIGHT;
    c.running.forEach((id) => {
      const task = this.tasks.get(id);
      if (task) task.flight = share;
    });
  }

  _resumePump(task) {
    const resume = task._resume;
    task._resume = null;
    if (typeof resume === 'function') setImmediate(resume);
  }

  /** SSH_FX_NO_SUCH_FILE, or the generic FAILURE some servers return for a missing parent. */
  _isMissingEntry(err) {
    const code = err && err.code;
    if (code === 2 || code === 4) return true;
    return /no such file|failure/i.test(String((err && err.message) || ''));
  }

  /**
   * SFTP 的端口与传输参数取资产自己的 sftp 行；认证、跳板机与主机密钥策略沿用同一资产的
   * ssh 行，因此只有 SSH 配置的资产（从终端进入 SFTP）也能连接，此时用 SFTP 默认传输参数。
   */
  _sessionConfig(asset) {
    const methods = asset.methods || {};
    const sftp = methods.sftp && methods.sftp.enabled ? methods.sftp : null;
    const ssh = methods.ssh && methods.ssh.enabled ? methods.ssh : null;
    if (!sftp && !ssh) {
      throw Object.assign(new Error('SFTP or SSH method not enabled'), { code: 'SFTP_DISABLED' });
    }
    const advanced = { ...((ssh && ssh.advanced) || {}), ...((sftp && sftp.advanced) || {}) };
    const port = Number((sftp && sftp.port) || (ssh && ssh.port)) || 22;
    return {
      advanced,
      port,
      tune: {
        activeLimit: tunedInt(advanced.concurrentTransfers, 1, XFER_ACTIVE_LIMIT, XFER_ACTIVE_LIMIT),
        chunkBytes: tunedInt(advanced.chunkSize, 32, 1024, XFER_CHUNK_BYTES / 1024) * 1024,
        readyTimeout: tunedInt(advanced.connectTimeout, 5, 300, XFER_READY_TIMEOUT_MS / 1000) * 1000,
      },
    };
  }

  /** 控制面板页签与窗口标题用的只读视图；端口解析与 openSession 共用同一实现。 */
  sessionMeta(asset) {
    const { port } = this._sessionConfig(asset);
    return { assetId: asset.id, host: asset.host || '', port, name: asset.name || '' };
  }

  async openSession({ assetId, ownerId, verifyHostKey, promptKeyboard }) {
    const hit = this.store.findAsset(assetId);
    if (!hit) throw Object.assign(new Error('asset not found'), { code: 'NOT_FOUND' });
    const asset = hit.asset;
    let config;
    try {
      config = this._sessionConfig(asset);
    } catch (error) {
      this.log && this.log.error('sftp', 'sftp config unavailable', { assetId, code: error.code });
      throw error;
    }
    const connId = `sftp-${Date.now()}-${(++this._seq).toString(36)}`;
    const connection = createSshConnection({
      host: asset.host, port: config.port, username: asset.user || '', password: asset.pass,
      advanced: config.advanced, verifyHostKey, promptKeyboard, log: this.log,
      readyTimeout: config.tune.readyTimeout,
    });
    const rec = {
      connId,
      connection,
      ownerId,
      assetId,
      host: asset.host,
      port: config.port,
      tune: config.tune,
      closedError: null,
      dirs: new Set(), // remote directories this session already created
      xferQueue: [], // task ids waiting for a transfer slot
      running: new Set(), // task ids currently holding a transfer slot
    };
    this.pending.set(connId, rec);
    let rejectClosed;
    const closed = new Promise((_, reject) => { rejectClosed = reject; });
    closed.catch(() => {});
    const onClosed = (error) => {
      rec.closedError = rec.closedError || error || Object.assign(new Error('SFTP connection closed'), { code: 'SSH_CLOSED' });
      rejectClosed(rec.closedError);
      if (this.conns.has(connId)) this.closeSession(connId);
    };
    connection.on('closed', onClosed);
    let timer;
    try {
      const client = await Promise.race([connection.ready, closed]);
      if (rec.closedError) throw rec.closedError;
      if (!this.pending.has(connId)) throw Object.assign(new Error('SFTP canceled'), { code: 'SSH_CANCELED' });
      rec.client = client;
      const home = await Promise.race([
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('SFTP initialization timed out'), { code: 'SFTP_TIMEOUT' })), config.tune.readyTimeout);
          client.sftp((error, sftp) => {
            if (rec.closedError || !this.pending.has(connId)) {
              if (sftp) sftp.end();
              return reject(rec.closedError || Object.assign(new Error('SFTP canceled'), { code: 'SSH_CANCELED' }));
            }
            if (error) return reject(error);
            rec.sftp = sftp;
            sftp.on('error', onClosed);
            sftp.on('close', () => onClosed(Object.assign(new Error('SFTP channel closed'), { code: 'SFTP_CLOSED' })));
            sftp.realpath('.', (err, abs) => resolve(!err && abs ? String(abs) : '/'));
          });
        }),
        closed,
      ]);
      if (rec.closedError) throw rec.closedError;
      if (!this.pending.has(connId)) throw Object.assign(new Error('SFTP canceled'), { code: 'SSH_CANCELED' });
      this.pending.delete(connId);
      this.conns.set(connId, rec);
      this.log && this.log.info('sftp', 'sftp connected', { assetId, host: rec.host, port: rec.port, connId });
      return { connId, host: rec.host, port: rec.port, home };
    } catch (error) {
      this.pending.delete(connId);
      connection.close();
      this.log && this.log.error('sftp', 'sftp connect failed', { assetId, host: rec.host, port: rec.port, code: error.code || 'SFTP_ERROR' });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  _conn(connId) {
    const c = this.conns.get(connId);
    if (!c) throw Object.assign(new Error('SFTP session not found'), { code: 'NO_CONN' });
    return c;
  }

  list(connId, remotePath) {
    return new Promise((resolve, reject) => {
      let c;
      try {
        c = this._conn(connId);
      } catch (e) {
        return reject(e);
      }
      const target = remotePath || '/';
      c.sftp.readdir(target, (err, list) => {
        if (err) {
          return reject(Object.assign(new Error(err.message || 'readdir failed'), { code: err.code || 'SFTP_LIST' }));
        }
        const items = (list || [])
          .map((it) => {
            const attrs = it.attrs || {};
            const isDir = attrs.isDirectory ? attrs.isDirectory() : false;
            return {
              name: it.filename,
              isDir,
              size: Number(attrs.size) || 0,
              sizeText: isDir ? '—' : formatSize(attrs.size),
              mtime: attrs.mtime ? new Date(attrs.mtime * 1000).toLocaleString() : '',
              mtimeMs: attrs.mtime ? Number(attrs.mtime) * 1000 : 0,
              mode: attrs.mode || 0,
            };
          })
          .sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return String(a.name).localeCompare(String(b.name));
          });
        resolve({ path: target, items });
      });
    });
  }

  localList(localPath) {
    const dir = localPath || os.homedir();
    try {
      const names = fs.readdirSync(dir, { withFileTypes: true });
      const items = names
        .map((d) => {
          let size = 0;
          let mtime = '';
          let mtimeMs = 0;
          try {
            const st = fs.statSync(path.join(dir, d.name));
            size = st.size;
            mtime = st.mtime.toLocaleString();
            mtimeMs = st.mtimeMs || 0;
          } catch (_) {}
          return {
            name: d.name,
            isDir: d.isDirectory(),
            size,
            sizeText: d.isDirectory() ? '—' : formatSize(size),
            mtime,
            mtimeMs,
          };
        })
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return String(a.name).localeCompare(String(b.name));
        });
      return { path: dir, items, home: os.homedir() };
    } catch (e) {
      throw Object.assign(new Error(e.message || 'local list failed'), { code: 'LOCAL_LIST' });
    }
  }

  /** Enumerate Windows logical drives for the "This PC" view; [] on other platforms. */
  drives() {
    if (process.platform !== 'win32') return [];
    const out = [];
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      try {
        if (fs.existsSync(letter + ':\\')) {
          out.push({ name: letter + ':', path: letter + ':\\', isDir: true, sizeText: '—', mtime: '', isDrive: true });
        }
      } catch (_) {}
    }
    return out;
  }

  mkdir(connId, remotePath) {
    const c = this._conn(connId);
    return new Promise((resolve, reject) => {
      c.sftp.mkdir(remotePath, (err) => {
        if (err) reject(Object.assign(new Error(err.message), { code: 'SFTP_MKDIR' }));
        else {
          this._rememberDir(c, remotePath);
          resolve({ ok: true });
        }
      });
    });
  }

  _rememberDir(c, dir) {
    if (!dir || dir === '/' || c.dirs.size >= DIR_CACHE_MAX) return;
    c.dirs.add(dir);
  }

  /** mkdir -p on remote; existing paths are tolerated and known prefixes are never re-walked. */
  mkdirp(connId, remoteDir) {
    const c = this.conns.get(connId);
    if (!c || !c.sftp) return Promise.resolve({ ok: true });
    return this._mkdirp(c, remoteDir).then(() => ({ ok: true }));
  }

  _mkdirp(c, remoteDir) {
    if (!remoteDir || remoteDir === '/' || c.dirs.has(remoteDir)) return Promise.resolve();
    const parts = String(remoteDir).split('/').filter(Boolean);
    const chain = [];
    let cur = '';
    parts.forEach((p, i) => {
      // A Windows server reports drive roots (C:) under the POSIX '/' listing
      cur = i === 0 && /^[A-Za-z]:$/.test(p) ? p : cur + '/' + p;
      chain.push(cur);
    });
    let i = 0;
    return new Promise((resolve) => {
      const step = () => {
        if (i >= chain.length) {
          this._rememberDir(c, remoteDir);
          return resolve();
        }
        const p = chain[i++];
        if (c.dirs.has(p)) return step();
        this._rememberDir(c, p);
        try {
          c.sftp.mkdir(p, () => step());
        } catch (_) {
          step();
        }
      };
      step();
    });
  }

  rename(connId, oldPath, newPath) {
    return new Promise((resolve, reject) => {
      const c = this._conn(connId);
      c.sftp.rename(oldPath, newPath, (err) => {
        if (err) reject(Object.assign(new Error(err.message), { code: 'SFTP_RENAME' }));
        else resolve({ ok: true });
      });
    });
  }

  unlink(connId, remotePath, isDir) {
    const c = this._conn(connId);
    const op = isDir
      ? this._isRealDir(c, remotePath).then((dir) =>
          dir ? this._removeDir(c, remotePath) : this._deleteEntry(c, 'unlink', remotePath)
        )
      : this._deleteEntry(c, 'unlink', remotePath);
    return op
      .then(() => {
        this.log &&
          this.log.info('sftp', isDir ? 'remote rmdir ok' : 'remote unlink ok', {
            host: c.host,
            port: c.port,
            path: remotePath,
          });
        return { ok: true };
      })
      .catch((err) => {
        this.log &&
          this.log.error('sftp', isDir ? 'remote rmdir failed' : 'remote unlink failed', {
            host: c.host,
            port: c.port,
            path: remotePath,
            code: err.code,
            message: err.message,
          });
        throw err;
      });
  }

  _deleteEntry(c, kind, p) {
    return new Promise((resolve, reject) => {
      const fn = kind === 'rmdir' ? c.sftp.rmdir.bind(c.sftp) : c.sftp.unlink.bind(c.sftp);
      fn(p, (err) => {
        if (err) reject(Object.assign(new Error(err.message), { code: err.code || 'SFTP_UNLINK' }));
        else resolve();
      });
    });
  }

  /** readdir attributes follow symlinks, so confirm with lstat before walking into an entry. */
  _isRealDir(c, p) {
    return new Promise((resolve, reject) => {
      c.sftp.lstat(p, (err, st) => {
        if (err) reject(Object.assign(new Error(err.message || 'lstat failed'), { code: err.code || 'SFTP_UNLINK' }));
        else resolve(st && st.isDirectory ? st.isDirectory() : false);
      });
    });
  }

  /** Delete a directory and its contents depth-first; a plain rmdir on a non-empty folder always fails. */
  async _removeDir(c, dir) {
    const entries = await new Promise((resolve, reject) => {
      c.sftp.readdir(dir, (err, list) => {
        if (err) reject(Object.assign(new Error(err.message || 'readdir failed'), { code: err.code || 'SFTP_UNLINK' }));
        else resolve(list || []);
      });
    });
    for (const e of entries) {
      const child = joinRemotePath(dir, e.filename);
      const attrs = e.attrs || {};
      const looksDir = attrs.isDirectory ? attrs.isDirectory() : false;
      if (looksDir && (await this._isRealDir(c, child))) await this._removeDir(c, child);
      else await this._deleteEntry(c, 'unlink', child);
    }
    await this._deleteEntry(c, 'rmdir', dir);
  }

  localMkdir(dirPath, name) {
    const target = path.join(dirPath || os.homedir(), name);
    fs.mkdirSync(target, { recursive: true });
    return { ok: true, path: target };
  }

  localRename(oldPath, newPath) {
    fs.renameSync(oldPath, newPath);
    return { ok: true };
  }

  localUnlink(p, isDir) {
    if (isDir) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
    return { ok: true };
  }

  listSync(connId, remotePath) {
    return this.list(connId, remotePath);
  }

  _startTask(meta) {
    const taskId = `t-${Date.now()}-${(++this._seq).toString(36)}`;
    const task = {
      taskId,
      name: meta.name,
      size: meta.size || 0,
      transferred: 0,
      direction: meta.direction,
      sourcePath: meta.sourcePath,
      targetPath: meta.targetPath,
      status: 'queued',
      paused: false,
      flight: XFER_MIN_FLIGHT,
      error: '',
      rs: null,
      ws: null,
      connId: meta.connId,
    };
    this.tasks.set(taskId, task);
    this._progress(task);
    return task;
  }

  stat(connId, remotePath) {
    return new Promise((resolve) => {
      try {
        const c = this._conn(connId);
        c.sftp.stat(remotePath, (err, st) => {
          if (err || !st) return resolve({ exists: false });
          const isDir = typeof st.isDirectory === 'function' ? st.isDirectory() : false;
          resolve({ exists: true, isDir, size: Number(st.size) || 0 });
        });
      } catch (_) {
        resolve({ exists: false });
      }
    });
  }

  localExists(p) {
    try {
      const st = fs.statSync(p);
      return { exists: true, isDir: st.isDirectory(), size: st.size };
    } catch (_) {
      return { exists: false };
    }
  }

  upload({ connId, localPath, remotePath }) {
    let c;
    try {
      c = this._conn(connId);
    } catch (e) {
      return Promise.reject(e);
    }
    let size = 0;
    try {
      const st = fs.statSync(localPath);
      if (st.isDirectory()) {
        return Promise.reject(
          Object.assign(
            new Error(this.L('路径是文件夹，请使用文件夹传输', 'Path is a directory; use folder transfer')),
            { code: 'EISDIR' }
          )
        );
      }
      size = st.size;
    } catch (e) {
      return Promise.reject(
        Object.assign(
          new Error(
            this.L('无法读取本地文件（可能被系统占用）', 'Cannot read local file (possibly locked by the system)') +
              `: ${e.code || ''} ${e.message}`
          ),
          { code: e.code || 'LOCAL_READ' }
        )
      );
    }
    const task = this._startTask({
      name: path.basename(localPath),
      size,
      direction: 'upload',
      sourcePath: localPath,
      targetPath: remotePath,
      connId,
    });
    this._queueTask(c, task, () => this._runUpload(c, task));
    return Promise.resolve({ taskId: task.taskId });
  }

  _runUpload(c, task) {
    const localPath = task.sourcePath;
    const remotePath = task.targetPath;
    const size = task.size;
    const sftp = c.sftp;
    let localFd = null;
    let handle = null;
    const CHUNK = c.tune.chunkBytes;
    let queued = 0;
    let donePos = 0;
    let inFlight = 0;
    let finished = false;

    const release = () => {
      try {
        if (localFd != null) {
          fs.closeSync(localFd);
          localFd = null;
        }
      } catch (_) {}
      try {
        if (handle != null) {
          const h = handle;
          handle = null;
          sftp.close(h, () => {});
        }
      } catch (_) {}
    };
    task._release = release;

    const fail = (err) => {
      task.status = 'error';
      task.error = (err && (err.message || err.code)) || String(err);
      console.error('[sftp] transfer error', task.direction, task.sourcePath, task.error);
      this._progress(task);
      release();
    };

    if (task.status === 'canceled') return;

    // Preflight: many Windows system files (NTUSER.DAT etc.) are EBUSY/EPERM locked
    try {
      const probeFd = fs.openSync(localPath, 'r');
      try {
        fs.readSync(probeFd, Buffer.alloc(1), 0, 1, 0);
      } finally {
        fs.closeSync(probeFd);
      }
    } catch (e) {
      return fail(
        Object.assign(
          new Error(
            this.L('无法读取本地文件（可能被系统占用）', 'Cannot read local file (possibly locked by the system)') +
              `: ${e.code || ''} ${e.message}`
          ),
          { code: e.code || 'LOCAL_READ' }
        )
      );
    }
    try {
      localFd = fs.openSync(localPath, 'r');
    } catch (e) {
      return fail(e);
    }

    const pump = () => {
      if (finished) return;
      if (task.status === 'canceled') {
        release();
        return;
      }
      if (task.paused) {
        task._resume = pump;
        return;
      }
      while (inFlight < task.flight && queued < size) {
        const start = queued;
        const n = Math.min(CHUNK, size - start);
        queued += n;
        const cbuf = Buffer.allocUnsafe(n);
        try {
          fs.readSync(localFd, cbuf, 0, n, start);
        } catch (e) {
          finished = true;
          return fail(e);
        }
        inFlight++;
        sftp.write(handle, cbuf, 0, n, start, (werr) => {
          if (finished) return;
          inFlight--;
          if (werr) {
            finished = true;
            return fail(werr);
          }
          donePos = Math.max(donePos, start + n);
          task.transferred = donePos;
          if (!task.size) task.size = donePos;
          this._progress(task);
          pump();
        });
      }
      if (queued >= size && inFlight === 0) {
        finished = true;
        try {
          fs.closeSync(localFd);
          localFd = null;
        } catch (_) {}
        sftp.close(handle, (ce) => {
          handle = null;
          if (ce) return fail(ce);
          task.transferred = size || donePos;
          if (task.status !== 'canceled' && task.status !== 'error') {
            task.status = 'done';
            task.speed = 0;
            this._progress(task);
          }
        });
      }
    };

    // ensure remote parent directory exists (avoid ENOENT / "No such file")
    const remoteParent = String(remotePath).replace(/\/[^/]*$/, '');
    let retried = false;
    const openRemote = () => {
      this._mkdirp(c, remoteParent).then(() => {
        sftp.open(remotePath, 'w', (err, h) => {
          if (err) {
            // The directory cache goes stale when the remote tree changes underneath us
            if (!retried && this._isMissingEntry(err)) {
              retried = true;
              c.dirs.delete(remoteParent);
              return openRemote();
            }
            return fail(err);
          }
          handle = h;
          pump();
        });
      });
    };
    openRemote();
  }

  download({ connId, remotePath, localPath }) {
    let c;
    try {
      c = this._conn(connId);
    } catch (e) {
      return Promise.reject(e);
    }
    const task = this._startTask({
      name: path.basename(remotePath),
      size: 0,
      direction: 'download',
      sourcePath: remotePath,
      targetPath: localPath,
      connId,
    });
    this._queueTask(c, task, () => this._runDownload(c, task));
    return Promise.resolve({ taskId: task.taskId });
  }

  _runDownload(c, task) {
    const remotePath = task.sourcePath;
    const localPath = task.targetPath;
    if (task.status === 'canceled') return;

    // Distinguish an authoritative length (from stat) from a size inferred
    // from received bytes, so the loop/completion only trusts the real size.
    let knownSize = false;

    c.sftp.stat(remotePath, (statErr, st) => {
      if (!statErr && st) {
        const stSize = Number(st.size) || 0;
        task.size = stSize;
        if (stSize > 0) knownSize = true;
        this._progress(task);
      }

      const sftp = c.sftp;
      const CHUNK = c.tune.chunkBytes;
      let queued = 0;
      let donePos = 0;
      let inFlight = 0;
      let eof = false;
      let finished = false;
      let handle = null;
      let outFd = null;

      const release = () => {
        try {
          if (outFd != null) {
            fs.closeSync(outFd);
            outFd = null;
          }
        } catch (_) {}
        try {
          if (handle != null) {
            const h = handle;
            handle = null;
            sftp.close(h, () => {});
          }
        } catch (_) {}
      };
      task._release = release;

      const fail = (err) => {
        task.status = 'error';
        task.error = (err && (err.message || err.code)) || String(err);
        console.error('[sftp] transfer error', task.direction, task.sourcePath, task.error);
        this._progress(task);
        release();
      };

      if (task.status === 'canceled') return;

      try {
        outFd = fs.openSync(localPath, 'w');
      } catch (e) {
        return fail(e);
      }

      sftp.open(remotePath, 'r', (err, h) => {
        if (err) return fail(err);
        handle = h;
        const pump = () => {
          if (finished) return;
          if (task.status === 'canceled') {
            release();
            return;
          }
          if (task.paused) {
            task._resume = pump;
            return;
          }
          while (inFlight < task.flight && !eof && (queued < (knownSize ? task.size : Number.MAX_SAFE_INTEGER))) {
            const want = knownSize ? Math.min(CHUNK, task.size - queued) : CHUNK;
            const start = queued;
            queued += want;
            const cbuf = Buffer.allocUnsafe(want);
            inFlight++;
            sftp.read(handle, cbuf, 0, want, start, (rerr, br) => {
              if (finished) return;
              inFlight--;
              if (rerr) {
                finished = true;
                return fail(rerr);
              }
              if (br > 0) {
                try {
                  fs.writeSync(outFd, cbuf, 0, br, start);
                } catch (e) {
                  finished = true;
                  return fail(e);
                }
                donePos = Math.max(donePos, start + br);
                task.transferred = donePos;
                if (!task.size) task.size = donePos;
                this._progress(task);
              }
              if (!br) eof = true;
              pump();
            });
          }
          if (inFlight === 0 && (eof || (knownSize && queued >= task.size))) {
            finished = true;
            try {
              fs.closeSync(outFd);
              outFd = null;
            } catch (_) {}
            sftp.close(handle, (ce) => {
              handle = null;
              if (ce) return fail(ce);
              task.transferred = task.size || donePos;
              if (task.status !== 'canceled' && task.status !== 'error') {
                task.status = 'done';
                task.speed = 0;
                this._progress(task);
              }
            });
          }
        };
        pump();
      });
    });
  }

  pauseTask(taskId, pause) {
    const task = this.tasks.get(taskId);
    if (!task || this._isFinished(task)) return { ok: false };
    const c = this.conns.get(task.connId);
    if (pause) {
      task.paused = true;
      task.status = 'paused';
      task.speed = 0;
      if (c) {
        this._freeSlot(c, task);
        if (!task._started) {
          const i = c.xferQueue.indexOf(taskId);
          if (i >= 0) c.xferQueue.splice(i, 1);
        }
        this._drainConn(task.connId);
      }
    } else {
      task.paused = false;
      task.status = 'queued';
      if (c) {
        this._freeSlot(c, task);
        if (c.xferQueue.indexOf(taskId) < 0) c.xferQueue.push(taskId);
        this._drainConn(task.connId);
      } else {
        // Session is gone; nothing will schedule it, so hand the pump back directly
        task.status = 'running';
        this._resumePump(task);
      }
    }
    this._progress(task, { force: true });
    return { ok: true, status: task.status };
  }

  pauseTasks(ids, pause) {
    let changed = 0;
    const list = Array.isArray(ids) ? ids : [];
    list.forEach((id) => {
      if (this.pauseTask(id, pause).ok) changed += 1;
    });
    this.log &&
      this.log.info('sftp', pause ? 'sftp pause batch' : 'sftp resume batch', { changed, requested: list.length });
    return { ok: true, changed };
  }

  _isFinished(task) {
    return !task || task.status === 'done' || task.status === 'error' || task.status === 'canceled';
  }

  /** Shared cancel path for one id or a whole folder subtree. */
  _markCanceled(task) {
    const wasUnfinished = task.status === 'running' || task.status === 'paused';
    task.status = 'canceled';
    task.paused = false;
    task._resume = null;
    const c = this.conns.get(task.connId);
    if (c) {
      const i = c.xferQueue.indexOf(task.taskId);
      if (i >= 0) c.xferQueue.splice(i, 1);
    }
    // release file handles before delete (Windows cannot unlink while fd is open)
    try {
      if (typeof task._release === 'function') task._release();
    } catch (_) {}
    if (task._pruneTimer) {
      clearTimeout(task._pruneTimer);
      task._pruneTimer = null;
    }
    this._progress(task);
    return wasUnfinished;
  }

  async cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: true };
    const wasUnfinished = this._markCanceled(task);
    this.tasks.delete(taskId);
    if (wasUnfinished) {
      await this.cleanupPartialTarget(task);
    }
    return { ok: true, cleaned: wasUnfinished, targetPath: wasUnfinished ? task.targetPath : null };
  }

  /** Cancel a batch without serializing each partial-target cleanup (they sleep and hit the network). */
  async cancelTasks(ids) {
    const list = (Array.isArray(ids) ? ids : [])
      .map((id) => this.tasks.get(id))
      .filter(Boolean);
    const needClean = [];
    list.forEach((task) => {
      if (this._markCanceled(task)) needClean.push(task);
      this.tasks.delete(task.taskId);
    });
    await this._runPool(needClean.map((task) => () => this.cleanupPartialTarget(task)), CLEANUP_POOL);
    this.log && this.log.info('sftp', 'sftp cancel batch', { canceled: list.length, cleaned: needClean.length });
    return { ok: true, canceled: list.length, cleaned: needClean.length };
  }

  async _runPool(fns, limit) {
    const pending = fns.slice();
    const worker = async () => {
      while (pending.length) {
        const fn = pending.shift();
        try {
          await fn();
        } catch (_) {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, pending.length) }, worker));
  }

  /** Close fds first (Windows lock), then delete incomplete target file */
  async cleanupPartialTarget(task) {
    if (!task) return;
    try {
      if (typeof task._release === 'function') task._release();
    } catch (_) {}
    // give Windows a moment to drop the handle lock
    await new Promise((r) => setTimeout(r, 40));
    if (!task.targetPath) return;
    if (task.direction === 'download') {
      const p = task.targetPath;
      for (let i = 0; i < 6; i++) {
        try {
          if (!fs.existsSync(p)) return;
          fs.unlinkSync(p);
          console.log('[sftp] removed partial local file', p);
          return;
        } catch (e) {
          try {
            if (typeof task._release === 'function') task._release();
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 60 * (i + 1)));
        }
      }
      console.warn('[sftp] could not delete partial local file', p);
    } else if (task.direction === 'upload') {
      const c = this.conns.get(task.connId);
      if (c && c.sftp) {
        await new Promise((resolve) => {
          try {
            c.sftp.unlink(task.targetPath, (err) => {
              if (err) console.warn('[sftp] unlink remote partial failed', err.message);
              else console.log('[sftp] removed partial remote file', task.targetPath);
              resolve();
            });
          } catch (_) {
            resolve();
          }
        });
      }
    }
  }

  /** Polled every second by each SFTP session, so only live tasks of that connection are
   *  reported; a queued task's row already exists in the tree and gets its running transition
   *  through the progress event. */
  listTasks(connId) {
    const live = [...this.tasks.values()].filter((task) => task.status !== 'queued' && task.connId === connId);
    return live.map((task) => ({
      taskId: task.taskId,
      name: task.name,
      size: task.size,
      transferred: task.transferred,
      percent:
        task.size > 0
          ? Math.min(100, Math.round((task.transferred / task.size) * 100))
          : task.status === 'done'
            ? 100
            : 0,
      sizeText: formatSize(task.size),
      transferredText: formatSize(task.transferred),
      speed: task.speed || 0,
      speedText: task.status === 'running' ? formatSpeed(task.speed) : '—',
      direction: task.direction,
      sourcePath: task.sourcePath,
      targetPath: task.targetPath,
      status: task.status,
      error: task.error || '',
    }));
  }

  /** Resolve when task reaches done/error — used before native OS drag-out */
  downloadWait(req) {
    return new Promise((resolve, reject) => {
      this.download(req)
        .then(({ taskId }) => {
          const tick = () => {
            const task = this.tasks.get(taskId);
            if (!task) return reject(new Error('download task disappeared'));
            if (task.status === 'done') return resolve({ taskId, localPath: req.localPath });
            if (task.status === 'error' || task.status === 'canceled') {
              return reject(new Error(task.error || 'download failed'));
            }
            setTimeout(tick, 80);
          };
          tick();
        })
        .catch(reject);
    });
  }

  /** Recursively download remote dir to localDir; resolves when all files done */
  downloadTreeWait(connId, remoteDir, localDir) {
    return this.list(connId, remoteDir).then(async (listing) => {
      const items = (listing.items || []).filter((x) => x.name !== '.' && x.name !== '..' && !x.isParent);
      for (const it of items) {
        const rp = (remoteDir === '/' ? '' : remoteDir) + '/' + it.name;
        const lp = path.join(localDir, it.name);
        if (it.isDir) {
          fs.mkdirSync(lp, { recursive: true });
          await this.downloadTreeWait(connId, rp, lp);
        } else {
          await this.downloadWait({ connId, remotePath: rp, localPath: lp });
        }
      }
      return { ok: true, localDir };
    });
  }

  /** Prepare a local copy under temp for OS drag-out; returns absolute local path */
  async prepareDragOut({ connId, remotePath, isDir, name }) {
    const base = path.basename(remotePath) || name || 'download';
    const tmpRoot = path.join(os.tmpdir(), 'novoterminal-sftp-drag');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const stamp = Date.now().toString(36);
    const localPath = path.join(tmpRoot, `${stamp}-${base}`);
    if (isDir) {
      fs.mkdirSync(localPath, { recursive: true });
      await this.downloadTreeWait(connId, remotePath, localPath);
    } else {
      await this.downloadWait({ connId, remotePath, localPath });
    }
    return { localPath, remotePath, name: base, isDir: !!isDir };
  }

  closeSession(connId) {
    const c = this.conns.get(connId);
    if (!c) return { ok: true };
    this.conns.delete(connId);
    c.xferQueue.length = 0;
    // cancel related tasks
    [...this.tasks.entries()].forEach(([id, t]) => {
      if (t.connId !== connId) return;
      if (t._pruneTimer) {
        clearTimeout(t._pruneTimer);
        t._pruneTimer = null;
      }
      this.cancelTask(id);
    });
    c.connection.close();
    this.log &&
      this.log.info('sftp', 'sftp closed', {
        assetId: c.assetId,
        host: c.host,
        port: c.port,
        connId,
      });
    return { ok: true };
  }

  closeOwner(ownerId) {
    for (const [id, rec] of this.pending) {
      if (rec.ownerId !== ownerId) continue;
      this.pending.delete(id);
      rec.connection.close();
    }
    for (const [id, rec] of this.conns) {
      if (rec.ownerId === ownerId) this.closeSession(id);
    }
  }

  destroyAll() {
    for (const rec of this.pending.values()) rec.connection.close();
    this.pending.clear();
    for (const id of this.conns.keys()) this.closeSession(id);
  }
}

module.exports = { SftpManager, formatSize, formatSpeed };
