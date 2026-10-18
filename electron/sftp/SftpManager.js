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
/** Ceiling for a head read, so a caller asking for megabytes still costs one small round trip. */
const HEAD_MAX_BYTES = 64 * 1024;

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

  _progress(task, opts) {
    // 任务已被删除（取消/关会话）：在途回调的晚到事件不能再发给渲染端，否则删掉的行会复活
    if (!this.tasks.has(task.taskId)) return;
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
      errorCode: task.errorCode || '',
    });
    if (settled) {
      if (task.status === 'done') {
        this.log &&
          this.log.info('sftp', 'sftp transfer done', {
            connId: task.connId,
            direction: task.direction,
            sourcePath: task.sourcePath,
            targetPath: task.targetPath,
            size: task.size,
          });
      }
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
    if (!c || c.closing) return;
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
   * SFTP 的端口与传输参数取资产自己的 sftp 行；跳板机与主机密钥策略沿用同一资产的 ssh 行，
   * 因此只有 SSH 配置的资产（从终端进入 SFTP）也能连接，此时用 SFTP 默认传输参数。
   * 认证走 sftp 行自己的凭证配置（未自定义即主凭证），由 openSession 经 store 解析。
   */
  _sessionConfig(asset) {
    const methods = asset.methods || {};
    const sftp = methods.sftp || null;
    const ssh = methods.ssh || null;
    if (!sftp && !ssh) {
      throw Object.assign(new Error('SFTP or SSH method not configured'), { code: 'SFTP_DISABLED' });
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

  async openSession({ assetId, ownerId, auth, verifyHostKey, promptKeyboard }) {
    const hit = this.store.findAsset(assetId);
    if (!hit) throw Object.assign(new Error('asset not found'), { code: 'SFTP_NO_ASSET' });
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
      host: asset.host, port: config.port, username: auth.username, password: auth.password,
      privateKey: auth.privateKey, passphrase: auth.passphrase,
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
      rec.closedError = rec.closedError || error || Object.assign(new Error('SFTP connection closed'), { code: 'SFTP_CLOSED' });
      rejectClosed(rec.closedError);
      if (!this.conns.has(connId)) return;
      // 面板此时还挂着「已连接」，只能靠这条状态把页签标记为已断开
      this.log &&
        this.log.warn('sftp', 'sftp connection lost', {
          assetId: rec.assetId,
          host: rec.host,
          port: rec.port,
          connId,
          code: rec.closedError.code || 'SFTP_CLOSED',
        });
      this.send('sftp:state', { type: 'disconnected', connId, code: rec.closedError.code || 'SFTP_CLOSED' });
      this.closeSession(connId);
    };
    connection.on('closed', onClosed);
    let timer;
    try {
      const client = await Promise.race([connection.ready, closed]);
      if (rec.closedError) throw rec.closedError;
      if (!this.pending.has(connId)) throw Object.assign(new Error('SFTP canceled'), { code: 'SFTP_CANCELED' });
      rec.client = client;
      const home = await Promise.race([
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('SFTP initialization timed out'), { code: 'SFTP_TIMEOUT' })), config.tune.readyTimeout);
          client.sftp((error, sftp) => {
            if (rec.closedError || !this.pending.has(connId)) {
              if (sftp) sftp.end();
              return reject(rec.closedError || Object.assign(new Error('SFTP canceled'), { code: 'SFTP_CANCELED' }));
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
      if (!this.pending.has(connId)) throw Object.assign(new Error('SFTP canceled'), { code: 'SFTP_CANCELED' });
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
    if (!c || c.closing) throw Object.assign(new Error('SFTP session not found'), { code: 'SFTP_NO_CONN' });
    return c;
  }

  /** ssh2 的数值状态码对界面没有意义：统一换成 SFTP_* 错误码，原始信息只进日志。 */
  _remoteError(kind, err, logMessage, meta) {
    const error = Object.assign(new Error((err && err.message) || kind), {
      code: `SFTP_${kind}`,
      detail: err && err.code !== undefined ? String(err.code) : '',
    });
    this.log &&
      this.log.error('sftp', logMessage, { ...meta, code: err && err.code, message: error.detail || error.message });
    return error;
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
          return reject(this._remoteError('LIST', err, 'sftp list failed', { connId, host: c.host, port: c.port }));
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
      this.log && this.log.error('sftp', 'local list failed', { path: dir, code: e.code, message: e.message });
      throw Object.assign(new Error('local list failed'), { code: 'LOCAL_LIST' });
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
        if (err) reject(this._remoteError('MKDIR', err, 'sftp mkdir failed', { connId, host: c.host, port: c.port, path: remotePath }));
        else {
          this._rememberDir(c, remotePath);
          resolve({ ok: true });
        }
      });
    });
  }

  /** 新建空文件：同名目标已存在时直接失败，绝不截断已有内容。 */
  createFile(connId, remotePath) {
    const c = this._conn(connId);
    return new Promise((resolve, reject) => {
      c.sftp.stat(remotePath, (err) => {
        if (!err) {
          return reject(Object.assign(new Error('target already exists'), { code: 'SFTP_EXISTS' }));
        }
        c.sftp.open(remotePath, 'w', (openErr, handle) => {
          if (openErr) {
            return reject(
              this._remoteError('CREATE', openErr, 'sftp create file failed', {
                connId,
                host: c.host,
                port: c.port,
                path: remotePath,
              })
            );
          }
          c.sftp.close(handle, () => resolve({ ok: true }));
        });
      });
    });
  }

  /** 改远端权限：mode 由 IPC 入口收敛成 0~0777 的整数，具体位的含义交给服务器。 */
  chmod(connId, remotePath, mode) {
    const c = this._conn(connId);
    return new Promise((resolve, reject) => {
      c.sftp.chmod(remotePath, mode, (err) => {
        if (err) {
          return reject(
            this._remoteError('CHMOD', err, 'sftp chmod failed', {
              connId,
              host: c.host,
              port: c.port,
              path: remotePath,
            })
          );
        }
        this.log &&
          this.log.info('sftp', 'sftp chmod applied', {
            host: c.host,
            port: c.port,
            path: remotePath,
            mode: mode.toString(8),
          });
        resolve({ ok: true, mode });
      });
    });
  }

  _rememberDir(c, dir) {
    if (!dir || dir === '/' || c.dirs.size >= DIR_CACHE_MAX) return;
    c.dirs.add(dir);
  }

  /** mkdir -p on remote; existing paths are tolerated and known prefixes are never re-walked. */
  mkdirp(connId, remoteDir) {
    // 会话没了就如实报错：静默返回 ok:true 会让文件夹上传照常起步，最后只剩一屏逐文件失败，根因看不见
    const c = this._conn(connId);
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
    const c = this._conn(connId);
    return new Promise((resolve, reject) => {
      c.sftp.rename(oldPath, newPath, (err) => {
        if (err) reject(this._remoteError('RENAME', err, 'sftp rename failed', { connId, host: c.host, port: c.port }));
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
        if (!err.code || !String(err.code).startsWith('SFTP_')) {
          this.log &&
            this.log.error('sftp', isDir ? 'remote rmdir failed' : 'remote unlink failed', {
              host: c.host,
              port: c.port,
              path: remotePath,
              code: err.code,
              message: err.message,
            });
        }
        throw err;
      });
  }

  _deleteEntry(c, kind, p) {
    return new Promise((resolve, reject) => {
      const fn = kind === 'rmdir' ? c.sftp.rmdir.bind(c.sftp) : c.sftp.unlink.bind(c.sftp);
      fn(p, (err) => {
        if (err) reject(this._remoteError('UNLINK', err, 'sftp delete entry failed', { host: c.host, port: c.port, path: p }));
        else resolve();
      });
    });
  }

  /** readdir attributes follow symlinks, so confirm with lstat before walking into an entry. */
  _isRealDir(c, p) {
    return new Promise((resolve, reject) => {
      c.sftp.lstat(p, (err, st) => {
        if (err) reject(this._remoteError('UNLINK', err, 'sftp lstat failed', { host: c.host, port: c.port, path: p }));
        else resolve(st && st.isDirectory ? st.isDirectory() : false);
      });
    });
  }

  /** Delete a directory and its contents depth-first; a plain rmdir on a non-empty folder always fails. */
  async _removeDir(c, dir) {
    const entries = await new Promise((resolve, reject) => {
      c.sftp.readdir(dir, (err, list) => {
        if (err) reject(this._remoteError('UNLINK', err, 'sftp delete readdir failed', { host: c.host, port: c.port, path: dir }));
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

  /** 新建空文件：同名目标已存在时直接失败，绝不截断已有内容。 */
  localCreateFile(dirPath, name) {
    const target = path.join(dirPath || os.homedir(), name);
    if (fs.existsSync(target)) {
      throw Object.assign(new Error('target already exists'), { code: 'LOCAL_EXISTS' });
    }
    fs.writeFileSync(target, '');
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
      errorCode: '',
      rs: null,
      ws: null,
      connId: meta.connId,
      // 本次写出的 .part 路径：传输全程只碰它，成功才改名成 targetPath
      partPath: '',
      // .part 是否已被本次传输打开：没打开过就没有残留可清，取消时不能去动 targetPath
      _touched: false,
    };
    this.tasks.set(taskId, task);
    this.log &&
      this.log.info('sftp', 'sftp transfer start', {
        connId: meta.connId,
        direction: meta.direction,
        sourcePath: meta.sourcePath,
        targetPath: meta.targetPath,
        size: task.size,
      });
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

  /** 只读文件开头若干字节，用于外部编辑前判定文本还是二进制。 */
  readHead(connId, remotePath, bytes) {
    return new Promise((resolve, reject) => {
      let c;
      try {
        c = this._conn(connId);
      } catch (e) {
        return reject(e);
      }
      const length = Math.max(0, Math.min(Number(bytes) || 0, HEAD_MAX_BYTES));
      const fail = (err) =>
        reject(this._remoteError('READ', err, 'sftp read head failed', { connId, host: c.host, port: c.port }));
      c.sftp.open(remotePath, 'r', (err, handle) => {
        if (err) return fail(err);
        const buf = Buffer.alloc(length);
        c.sftp.read(handle, buf, 0, length, 0, (readErr, readLength) => {
          c.sftp.close(handle, () => {});
          if (readErr) return fail(readErr);
          resolve(buf.slice(0, readLength || 0));
        });
      });
    });
  }

  /** 外部编辑用的整文件取回：不进传输队列，失败必须删掉半截副本。 */
  fetchToLocal({ connId, remotePath, localPath }) {
    let c;
    try {
      c = this._conn(connId);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      c.sftp.fastGet(remotePath, localPath, (err) => {
        if (err) {
          try {
            fs.rmSync(localPath, { force: true });
          } catch (_) {}
          return reject(
            this._remoteError('READ', err, 'sftp fetch to local failed', {
              connId,
              host: c.host,
              port: c.port,
              remotePath,
            })
          );
        }
        resolve({ localPath });
      });
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
            new Error('path is a directory; use folder transfer'),
            { code: 'EISDIR' }
          )
        );
      }
      size = st.size;
    } catch (e) {
      return Promise.reject(
        Object.assign(new Error('cannot read local file: ' + `${e.code || ''} ${e.message}`.trim()), {
          code: 'LOCAL_READ',
        })
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
    return Promise.resolve({ taskId: task.taskId, status: task.status });
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
      // 取消已关掉 handle，在途回调随后带错回来；这时不能把 canceled 覆盖成 error
      if (task.status === 'canceled') {
        release();
        return;
      }
      task.status = 'error';
      task.error = (err && (err.message || err.code)) || String(err);
      task.errorCode = (err && typeof err.code === 'string' && err.code) || 'SFTP_TRANSFER';
      this.log &&
        this.log.error('sftp', 'sftp transfer failed', {
          connId: task.connId,
          direction: task.direction,
          sourcePath: task.sourcePath,
          code: task.errorCode,
          message: task.error,
        });
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
        Object.assign(new Error('cannot read local file: ' + `${e.code || ''} ${e.message}`.trim()), {
          code: 'LOCAL_READ',
        })
      );
    }
    try {
      localFd = fs.openSync(localPath, 'r');
    } catch (e) {
      return fail(
        Object.assign(new Error('cannot read local file: ' + `${e.code || ''} ${e.message}`.trim()), {
          code: 'LOCAL_READ',
        })
      );
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
        let got = 0;
        try {
          got = fs.readSync(localFd, cbuf, 0, n, start);
        } catch (e) {
          finished = true;
          // EBUSY/EPERM 之类要按「读不了本地文件」定性，界面才有中文可译；原文留给行与日志
          return fail(Object.assign(new Error(`${e.code || ''} ${e.message}`.trim()), { code: 'LOCAL_READ' }));
        }
        if (got < n) {
          // 本地文件在传输中被改小：cbuf 尾部是没写过的内存，按原长度发出去就是往远端写脏数据
          finished = true;
          return fail(
            Object.assign(new Error(`local file shrank during transfer: expected ${n} bytes, read ${got}`), {
              code: 'LOCAL_READ',
            })
          );
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
          if (task.status === 'canceled' || task.status === 'error') return;
          this._placeRemotePart(c, task, () => {
            // 改名是异步的，期间用户可能已经取消：不能把已取消的行翻成完成
            if (task.status === 'canceled' || task.status === 'error') return;
            task.status = 'done';
            task.speed = 0;
            this._progress(task);
          }, fail);
        });
      }
    };

    // ensure remote parent directory exists (avoid ENOENT / "No such file")
    const remoteParent = String(remotePath).replace(/\/[^/]*$/, '');
    // 全程写 .part，整份落完才改名到位：取消或失败都不碰远端既有文件，它不会被截成半份
    task.partPath = remotePath + '.' + task.taskId.slice(-6) + '.part';
    let retried = false;
    const openRemote = () => {
      this._mkdirp(c, remoteParent).then(() => {
        // 等 mkdirp 期间任务可能已被取消：行已删除，这时再打开 .part 就没人负责清它
        if (task.status === 'canceled') return;
        sftp.open(task.partPath, 'w', (err, h) => {
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
          task._touched = true;
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
    // 排队中的下载也要如实回给渲染端，否则页面只能自己猜一个 running
    return Promise.resolve({ taskId: task.taskId, status: task.status });
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
        // 同上：取消后的在途读回调不能再把状态改回 error
        if (task.status === 'canceled') {
          release();
          return;
        }
        task.status = 'error';
        task.error = (err && (err.message || err.code)) || String(err);
        task.errorCode = (err && typeof err.code === 'string' && err.code) || 'SFTP_TRANSFER';
        this.log &&
          this.log.error('sftp', 'sftp transfer failed', {
            connId: task.connId,
            direction: task.direction,
            sourcePath: task.sourcePath,
            code: task.errorCode,
            message: task.error,
          });
        this._progress(task);
        release();
      };

      if (task.status === 'canceled') return;

      // 与上传同一条口径：先写 .part，整份齐了才改名，取消不会毁掉本机既有同名文件
      task.partPath = localPath + '.' + task.taskId.slice(-6) + '.part';
      try {
        outFd = fs.openSync(task.partPath, 'w');
      } catch (e) {
        return fail(
          Object.assign(new Error('cannot write local file: ' + `${e.code || ''} ${e.message}`.trim()), {
            code: 'LOCAL_WRITE',
          })
        );
      }
      task._touched = true;

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
                  return fail(
                    Object.assign(new Error(`${e.code || ''} ${e.message}`.trim()), { code: 'LOCAL_WRITE' })
                  );
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
              if (task.status === 'canceled' || task.status === 'error') return;
              this._placeLocalPart(task, () => {
                // 改名之前也可能被取消：行已经摘掉就不要把它报成完成
                if (task.status === 'canceled' || task.status === 'error') return;
                task.status = 'done';
                task.speed = 0;
                this._progress(task);
              }, fail);
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

  /** 渲染端删任务时要连带清理半截目标文件，所以删除动作也由主进程统一发起（归属在 IPC 入口校验）。 */
  markCanceled(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.resolve({ ok: true, cleaned: false });
    const wasUnfinished = this._markCanceled(task);
    this.tasks.delete(taskId);
    if (!wasUnfinished) return Promise.resolve({ ok: true, cleaned: false });
    return this.cleanupPartialTarget(task).then(() => ({ ok: true, cleaned: true }));
  }

  /**
   * 会话开始回收：先标 closing 挡住新操作与新传输，取消全部任务并删掉半截远端文件；
   * 通道要留到这一步做完才关，否则 unlink 无处可发。
   */
  beginSessionClose(connId) {
    const c = this.conns.get(connId);
    if (!c) return Promise.resolve(false);
    c.closing = true;
    c.xferQueue.length = 0;
    const needClean = [];
    [...this.tasks.values()].forEach((task) => {
      if (task.connId !== connId) return;
      if (task._pruneTimer) {
        clearTimeout(task._pruneTimer);
        task._pruneTimer = null;
      }
      if (this._markCanceled(task)) needClean.push(task);
      this.tasks.delete(task.taskId);
    });
    this.log &&
      this.log.info('sftp', 'sftp closed', { assetId: c.assetId, host: c.host, port: c.port, connId });
    return this._runPool(needClean.map((task) => () => this.cleanupPartialTarget(task)), CLEANUP_POOL).then(
      () => true
    );
  }

  finishSessionClose(connId) {
    const c = this.conns.get(connId);
    this.conns.delete(connId);
    if (c) c.connection.close();
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
    this.log &&
      this.log.info('sftp', 'sftp transfer canceled', {
        connId: task.connId,
        direction: task.direction,
        sourcePath: task.sourcePath,
        targetPath: task.targetPath,
      });
    return wasUnfinished;
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

  /**
   * 把写完整的 .part 改名到目标位置。覆盖既有文件要靠 posix-rename 扩展（OpenSSH 都有）；
   * 没有该扩展时才退化成标准改名 + 「确认目标存在才删除再改名」。
   * 任何一步失败都只留着 .part 报错，绝不在没弄清原因时删掉用户已有的目标文件。
   */
  _placeRemotePart(c, task, onDone, onError) {
    const sftp = c.sftp;
    const partPath = task.partPath;
    const target = task.targetPath;
    const giveUp = (why) =>
      onError(
        Object.assign(
          new Error(
            'cannot move the uploaded part into place; it stays at ' + partPath + (why ? ' (' + why + ')' : '')
          ),
          { code: 'SFTP_TRANSFER' }
        )
      );
    let usedPosixRename = true;
    try {
      sftp.ext_openssh_rename(partPath, target, (err) => {
        if (err) return giveUp(err.message);
        onDone();
      });
    } catch (_) {
      // ssh2 在服务器没有声明 posix-rename@openssh.com 时同步抛出
      usedPosixRename = false;
    }
    if (usedPosixRename) return;
    // 两个改名调用在通道已销毁时都可能同步抛出，抛出与回调两种失败都按「保留 .part」处理
    try {
      sftp.rename(partPath, target, (err) => {
        if (!err) return onDone();
        sftp.stat(target, (se, st) => {
          if (se || !st) return giveUp(err.message);
          // 目标确实存在，说明这次失败就是「不肯覆盖」；用户要的就是覆盖，才动它
          sftp.unlink(target, (ue) => {
            if (ue) return giveUp(ue.message);
            sftp.rename(partPath, target, (re) => {
              if (re) return giveUp(re.message);
              onDone();
            });
          });
        });
      });
    } catch (e) {
      giveUp((e && e.message) || String(e));
    }
  }

  /** 本机侧同理：整份齐了才改名到位。Windows 的改名不覆盖既有文件，确认目标在原地才删它再改。 */
  _placeLocalPart(task, onDone, onError) {
    const partPath = task.partPath;
    const giveUp = (why) => {
      this.log &&
        this.log.warn('sftp', 'local rename into place failed', {
          path: task.targetPath,
          part: partPath,
          message: why,
        });
      onError(
        Object.assign(
          new Error('cannot move the downloaded part into place; it stays at ' + partPath),
          { code: 'LOCAL_WRITE' }
        )
      );
    };
    try {
      fs.renameSync(partPath, task.targetPath);
      return onDone();
    } catch (e) {
      // 目标不在原地，失败原因就不是「不肯覆盖」，这时删任何东西都只是毁数据
      if (!fs.existsSync(task.targetPath)) return giveUp((e && e.message) || String(e));
      try {
        fs.rmSync(task.targetPath, { force: true });
        fs.renameSync(partPath, task.targetPath);
        return onDone();
      } catch (e2) {
        giveUp((e2 && e2.message) || String(e2));
      }
    }
  }

  /** Close fds first (Windows lock), then delete the leftover .part file — never the target */
  async cleanupPartialTarget(task) {
    if (!task) return;
    try {
      if (typeof task._release === 'function') task._release();
    } catch (_) {}
    // 没打开过 .part（还在排队、重连等握手阶段）就没有残留可清；去删 targetPath 会毁掉覆盖前已存在的文件
    if (!task._touched || !task.partPath) return;
    const p = task.partPath;
    // give Windows a moment to drop the handle lock
    await new Promise((r) => setTimeout(r, 40));
    if (task.direction === 'download') {
      for (let i = 0; i < 6; i++) {
        try {
          if (!fs.existsSync(p)) return;
          fs.unlinkSync(p);
          this.log && this.log.info('sftp', 'removed partial local file', { path: p });
          return;
        } catch (e) {
          try {
            if (typeof task._release === 'function') task._release();
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 60 * (i + 1)));
        }
      }
      this.log && this.log.warn('sftp', 'could not delete partial local file', { path: p });
    } else if (task.direction === 'upload') {
      const c = this.conns.get(task.connId);
      if (c && c.sftp) {
        await new Promise((resolve) => {
          try {
            c.sftp.unlink(p, (err) => {
              this.log &&
                (err
                  ? this.log.warn('sftp', 'unlink remote partial failed', {
                      host: c.host,
                      port: c.port,
                      path: p,
                      code: err.code,
                      message: err.message,
                    })
                  : this.log.info('sftp', 'removed partial remote file', { host: c.host, path: p }));
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
      errorCode: task.errorCode || '',
    }));
  }

  closeSession(connId) {
    return this.beginSessionClose(connId).then(() => {
      this.finishSessionClose(connId);
      return { ok: true };
    });
  }

  closeOwner(ownerId) {
    for (const [id, rec] of this.pending) {
      if (rec.ownerId !== ownerId) continue;
      this.pending.delete(id);
      rec.connection.close();
    }
    const owned = [...this.conns.entries()].filter(([, rec]) => rec.ownerId === ownerId).map(([id]) => id);
    return Promise.all(owned.map((id) => this.beginSessionClose(id))).then(() => {
      owned.forEach((id) => this.finishSessionClose(id));
    });
  }

  destroyAll() {
    for (const rec of this.pending.values()) rec.connection.close();
    this.pending.clear();
    const ids = [...this.conns.keys()];
    return Promise.all(ids.map((id) => this.beginSessionClose(id))).then(() => {
      ids.forEach((id) => this.finishSessionClose(id));
    });
  }
}

module.exports = { SftpManager };
