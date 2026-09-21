const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

const ADVANCED_SSH_DEFAULTS = {
  charset: 'UTF-8',
  term: 'xterm-256color',
  keepAlive: 30,
  compression: false,
  authType: 'password',
  privateKeyPath: '',
  proxyJump: '',
  hostKeyPolicy: 'ask',
};

function expandHome(p) {
  return String(p || '').replace(/^~(?=[/\\])/, os.homedir());
}

function resolveAdvanced(saved) {
  const base = { ...ADVANCED_SSH_DEFAULTS };
  if (!saved || typeof saved !== 'object') return base;
  Object.keys(base).forEach((k) => {
    const v = saved[k];
    if (v === undefined || v === null) return;
    if (typeof base[k] === 'string' && String(v).trim() === '') return;
    if (typeof base[k] === 'number') {
      const n = Number(v);
      if (Number.isNaN(n) || String(v).trim() === '') return;
      base[k] = n;
      return;
    }
    if (typeof base[k] === 'boolean') {
      base[k] = !!v;
      return;
    }
    if (v !== '') base[k] = v;
  });
  return base;
}

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

  _buildAuth(asset, method) {
    const adv = resolveAdvanced(method && method.advanced);
    const username = asset.user || '';
    const password = asset.pass;
    const opts = {
      host: asset.host,
      port: (method && method.port) || 22,
      username,
      readyTimeout: 20000,
      keepaliveInterval: Number(adv.keepAlive) > 0 ? Number(adv.keepAlive) * 1000 : 0,
      compress: !!adv.compression,
    };
    if (adv.authType === 'publickey' && adv.privateKeyPath) {
      opts.privateKey = fs.readFileSync(expandHome(adv.privateKeyPath));
    } else if (password) {
      opts.password = password;
    }
    return opts;
  }

  openSession({ assetId }) {
    const hit = this.store.findAsset(assetId);
    if (!hit) {
      return Promise.reject(Object.assign(new Error('asset not found'), { code: 'NOT_FOUND' }));
    }
    const asset = hit.asset;
    const methods = asset.methods || {};
    const sshConf =
      methods.ssh ||
      Object.keys(methods)
        .map((k) => methods[k])
        .find((c) => c && c.enabled);
    if (!sshConf || !sshConf.enabled) {
      // still try default port 22
    }
    const method = {
      id: 'ssh',
      port: (sshConf && sshConf.port) || 22,
      advanced: (sshConf && sshConf.advanced) || null,
    };

    return new Promise((resolve, reject) => {
      const client = new Client();
      const fail = (err) => {
        this.log &&
          this.log.error('sftp', 'sftp connect failed', {
            assetId,
            host: asset.host,
            port: method.port,
            code: err.code || 'SFTP_ERROR',
            message: err.message,
          });
        try {
          client.end();
        } catch (_) {}
        reject(Object.assign(new Error(err.message || String(err)), { code: err.code || 'SFTP_ERROR' }));
      };

      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) return fail(err);
          const connId = `sftp-${Date.now()}-${(++this._seq).toString(36)}`;
          this.conns.set(connId, {
            client,
            sftp,
            assetId,
            host: asset.host,
            port: method.port,
          });
          this.log &&
            this.log.info('sftp', 'sftp connected', {
              assetId,
              host: asset.host,
              port: method.port,
              connId,
            });
          // probe home
          sftp.realpath('.', (e2, abs) => {
            const home = !e2 && abs ? String(abs) : '/';
            resolve({ connId, host: asset.host, port: method.port, home });
          });
        });
      });
      client.on('error', fail);
      try {
        client.connect(this._buildAuth(asset, method));
      } catch (e) {
        fail(e);
      }
    });
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
          try {
            const st = fs.statSync(path.join(dir, d.name));
            size = st.size;
            mtime = st.mtime.toLocaleString();
          } catch (_) {}
          return {
            name: d.name,
            isDir: d.isDirectory(),
            size,
            sizeText: d.isDirectory() ? '—' : formatSize(size),
            mtime,
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

  /** Recursively list local files under dir → [{ localPath, remotePath, size, name }] */
  walkLocal(localDir, remoteDir) {
    const out = [];
    const walk = (ld, rd) => {
      let names;
      try {
        names = fs.readdirSync(ld, { withFileTypes: true });
      } catch (_) {
        return;
      }
      names.forEach((d) => {
        const lp = path.join(ld, d.name);
        const rp = (rd.endsWith('/') ? rd : rd + '/') + d.name;
        if (d.isDirectory()) {
          out.push({ type: 'dir', name: d.name, localPath: lp, remotePath: rp, size: 0 });
          walk(lp, rp);
        } else {
          let size = 0;
          try {
            size = fs.statSync(lp).size;
          } catch (_) {}
          out.push({ type: 'file', name: d.name, localPath: lp, remotePath: rp, size });
        }
      });
    };
    walk(localDir, remoteDir);
    return out;
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
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;

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
            if (task.status === 'canceled') {
              release();
              return;
            }
            if (task.paused) {
              task._resume = pump;
              return;
            }
            let n = 0;
            try {
              n = fs.readSync(localFd, buf, 0, CHUNK, pos);
            } catch (e) {
              return fail(e);
            }
            if (n <= 0) {
              try {
                fs.closeSync(localFd);
              } catch (_) {}
              sftp.close(handle, (ce) => {
                handle = null;
                if (ce) return fail(ce);
                task.transferred = size || pos;
                if (task.status !== 'canceled' && task.status !== 'error') {
                  task.status = 'done';
                  task.speed = 0;
                  this._progress(task);
                }
              });
              return;
            }
            const slice = n === CHUNK ? buf : buf.slice(0, n);
            const curPos = pos;
            sftp.write(handle, slice, 0, n, curPos, (werr) => {
              if (werr) return fail(werr);
              pos += n;
              task.transferred = pos;
              if (!task.size) task.size = pos;
              this._progress(task);
              setImmediate(pump);
            });
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

      c.sftp.stat(remotePath, (statErr, st) => {
        if (!statErr && st) {
          task.size = Number(st.size) || 0;
          this._progress(task);
        }
        resolve({ taskId: task.taskId });

        const sftp = c.sftp;
        const CHUNK = 64 * 1024;
        const buf = Buffer.alloc(CHUNK);
        let pos = 0;
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
            if (task.status === 'canceled') {
              release();
              return;
            }
            if (task.paused) {
              task._resume = pump;
              return;
            }
            const want = task.size > 0 ? Math.min(CHUNK, task.size - pos) : CHUNK;
            if (want <= 0) {
              try {
                fs.closeSync(outFd);
              } catch (_) {}
              sftp.close(handle, (ce) => {
                handle = null;
                if (ce) return fail(ce);
                task.transferred = task.size || pos;
                if (task.status !== 'canceled' && task.status !== 'error') {
                  task.status = 'done';
                  task.speed = 0;
                  this._progress(task);
                }
              });
              return;
            }
            const curPos = pos;
            sftp.read(handle, buf, 0, want, curPos, (rerr, br) => {
              if (rerr) return fail(rerr);
              if (!br) {
                try {
                  fs.closeSync(outFd);
                } catch (_) {}
                sftp.close(handle, (ce) => {
                  handle = null;
                  if (ce) return fail(ce);
                  task.transferred = pos;
                  if (!task.size) task.size = pos;
                  if (task.status !== 'canceled' && task.status !== 'error') {
                    task.status = 'done';
                    task.speed = 0;
                    this._progress(task);
                  }
                });
                return;
              }
              try {
                fs.writeSync(outFd, buf, 0, br, curPos);
              } catch (e) {
                return fail(e);
              }
              pos += br;
              task.transferred = pos;
              if (!task.size) task.size = pos;
              this._progress(task);
              setImmediate(pump);
            });
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
    try {
      c.client.end();
    } catch (_) {}
    this.log &&
      this.log.info('sftp', 'sftp closed', {
        assetId: c.assetId,
        host: c.host,
        port: c.port,
        connId,
      });
    return { ok: true };
  }
}

module.exports = { SftpManager, formatSize, formatSpeed };
