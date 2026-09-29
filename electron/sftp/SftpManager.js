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

  _progress(task) {
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
    this.send('sftp:progress', {
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
    });
  }

  async openSession({ assetId, ownerId, verifyHostKey, promptKeyboard }) {
    const hit = this.store.findAsset(assetId);
    if (!hit) throw Object.assign(new Error('asset not found'), { code: 'NOT_FOUND' });
    const asset = hit.asset;
    const method = asset.methods && asset.methods.ssh;
    if (!method || !method.enabled) throw Object.assign(new Error('SSH method not enabled'), { code: 'SSH_DISABLED' });
    const connId = `sftp-${Date.now()}-${(++this._seq).toString(36)}`;
    const connection = createSshConnection({
      host: asset.host, port: Number(method.port) || 22, username: asset.user || '', password: asset.pass,
      advanced: method.advanced, verifyHostKey, promptKeyboard, log: this.log,
    });
    const rec = { connection, ownerId, assetId, host: asset.host, port: Number(method.port) || 22, closedError: null };
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
          timer = setTimeout(() => reject(Object.assign(new Error('SFTP initialization timed out'), { code: 'SFTP_TIMEOUT' })), 20000);
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
    return new Promise((resolve, reject) => {
      const c = this._conn(connId);
      c.sftp.mkdir(remotePath, (err) => {
        if (err) reject(Object.assign(new Error(err.message), { code: 'SFTP_MKDIR' }));
        else resolve({ ok: true });
      });
    });
  }

  /** mkdir -p on remote; ignore "already exists" */
  mkdirp(connId, remoteDir) {
    return new Promise((resolve) => {
      try {
        const c = this.conns.get(connId);
        if (!c || !c.sftp || !remoteDir || remoteDir === '/') return resolve({ ok: true });
        const parts = String(remoteDir).split('/').filter(Boolean);
        let cur = '';
        let i = 0;
        const step = () => {
          if (i >= parts.length) return resolve({ ok: true });
          cur += '/' + parts[i++];
          try {
            c.sftp.mkdir(cur, () => step());
          } catch (_) {
            step();
          }
        };
        step();
      } catch (_) {
        resolve({ ok: true });
      }
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
    return new Promise((resolve, reject) => {
      const c = this._conn(connId);
      const fn = isDir ? c.sftp.rmdir.bind(c.sftp) : c.sftp.unlink.bind(c.sftp);
      fn(remotePath, (err) => {
        if (err) reject(Object.assign(new Error(err.message), { code: 'SFTP_UNLINK' }));
        else resolve({ ok: true });
      });
    });
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
      status: 'running',
      paused: false,
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
    return new Promise((resolve, reject) => {
      let c;
      try {
        c = this._conn(connId);
      } catch (e) {
        return reject(e);
      }
      // Preflight: many Windows system files (NTUSER.DAT etc.) are EBUSY/EPERM locked
      let size = 0;
      let probeFd = null;
      try {
        const st = fs.statSync(localPath);
        if (st.isDirectory()) {
          return reject(
            Object.assign(new Error('路径是文件夹，请使用文件夹传输'), { code: 'EISDIR' })
          );
        }
        size = st.size;
        probeFd = fs.openSync(localPath, 'r');
        const probeBuf = Buffer.alloc(1);
        fs.readSync(probeFd, probeBuf, 0, 1, 0);
        fs.closeSync(probeFd);
        probeFd = null;
      } catch (e) {
        try {
          if (probeFd != null) fs.closeSync(probeFd);
        } catch (_) {}
        return reject(
          Object.assign(
            new Error(`无法读取本地文件（可能被系统占用）: ${e.code || ''} ${e.message}`),
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
      resolve({ taskId: task.taskId });

      const sftp = c.sftp;
      let localFd = null;
      let handle = null;
      const CHUNK = 64 * 1024;
      // Keep multiple writes in flight (pipelining) so throughput is not
      // bounded by one request's round-trip latency on high-RTT links.
      const MAX_FLIGHT = 16;
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

      try {
        localFd = fs.openSync(localPath, 'r');
      } catch (e) {
        return fail(e);
      }

      // ensure remote parent directory exists (avoid ENOENT / "No such file")
      const remoteParent = String(remotePath).replace(/\/[^/]*$/, '');
      const startOpen = () => {
        sftp.open(remotePath, 'w', (err, h) => {
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
            while (inFlight < MAX_FLIGHT && queued < size) {
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
          pump();
        });
      };

      if (remoteParent && remoteParent !== remotePath) {
        this.mkdirp(connId, remoteParent).then(startOpen).catch(startOpen);
      } else {
        startOpen();
      }
    });
  }

  download({ connId, remotePath, localPath }) {
    return new Promise((resolve, reject) => {
      let c;
      try {
        c = this._conn(connId);
      } catch (e) {
        return reject(e);
      }
      const task = this._startTask({
        name: path.basename(remotePath),
        size: 0,
        direction: 'download',
        sourcePath: remotePath,
        targetPath: localPath,
        connId,
      });
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
        resolve({ taskId: task.taskId });

        const sftp = c.sftp;
        const CHUNK = 64 * 1024;
        // Pipelined reads: keep several in flight so throughput is not bounded
        // by per-request round-trip latency.
        const MAX_FLIGHT = 16;
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
            while (inFlight < MAX_FLIGHT && !eof && (queued < (knownSize ? task.size : Number.MAX_SAFE_INTEGER))) {
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
    });
  }

  pauseTask(taskId, pause) {
    const task = this.tasks.get(taskId);
    if (!task || this._isFinished(task)) return { ok: false };
    task.paused = !!pause;
    if (pause) {
      task.status = 'paused';
      task.speed = 0;
    } else {
      task.status = 'running';
      const resume = task._resume;
      task._resume = null;
      if (typeof resume === 'function') setImmediate(resume);
    }
    this._progress(task);
    return { ok: true, status: task.status };
  }

  _isFinished(task) {
    return (
      !task ||
      task.status === 'done' ||
      task.status === 'error' ||
      task.status === 'canceled'
    );
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

  async cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: true };
    const wasUnfinished = task.status === 'running' || task.status === 'paused';
    task.status = 'canceled';
    task.paused = false;
    task._resume = null;
    // release file handles before delete (Windows cannot unlink while fd is open)
    try {
      if (typeof task._release === 'function') task._release();
    } catch (_) {}
    this._progress(task);
    if (wasUnfinished) {
      await this.cleanupPartialTarget(task);
    }
    this.tasks.delete(taskId);
    return { ok: true, cleaned: wasUnfinished, targetPath: wasUnfinished ? task.targetPath : null };
  }

  listTasks() {
    return [...this.tasks.values()].map((task) => ({
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
    const tmpRoot = path.join(os.tmpdir(), 'omnidesk-sftp-drag');
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
    // cancel related tasks
    [...this.tasks.entries()].forEach(([id, t]) => {
      if (t.connId === connId) this.cancelTask(id);
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
