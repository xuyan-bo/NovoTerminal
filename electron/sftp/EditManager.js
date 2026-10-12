const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** 编辑器不给退出/保存事件，只能靠轮询副本的 mtime 与大小当作保存信号。 */
const EDIT_POLL_MS = 1000;
const HEAD_BYTES = 8192;

/** UTF-16 BOM 里带 NUL，但记事本编辑这类文件没问题，不能误判成二进制。 */
function isBinaryHead(head) {
  if (head.length >= 2) {
    const bom = (head[0] << 8) | head[1];
    if (bom === 0xfffe || bom === 0xfeff) return false;
  }
  return head.includes(0);
}

/** 副本只影响传输队列里的显示名：远端文件名在本机非法时收敛成安全名。 */
function safeTempName(remotePath) {
  const base = String(remotePath || '').split(/[\\/]/).pop() || '';
  const clean = base
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+$/, '')
    .trim();
  return clean || 'file';
}

function fail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

/**
 * 外部编辑器承载：本机文件直接拉起编辑器；远端文件先取回到数据存储目录下的 temp 副本，
 * 用户每次保存都复用传输队列回传原路径。副本只在回传成功后删除，其余退出路径保留到下次编辑时清扫。
 */
class EditManager {
  constructor({ store, log, sftp }) {
    this.store = store;
    this.log = log;
    this.sftp = sftp;
    this.edits = new Map(); // `connId|remotePath` -> 编辑会话
    this._seq = 0;
    this._swept = false;
  }

  tempRoot() {
    return path.join(this.store.dataDir(), 'temp', 'sftp-edit');
  }

  /** 上次崩溃或断连留下的副本没有连接可回传，第一次编辑前整目录清掉。 */
  _sweep() {
    if (this._swept) return;
    this._swept = true;
    this.purge();
  }

  /** 整目录删除：编辑器可能还占着文件，失败只记日志，留给下次清扫（启动首帧与退出各一次）。 */
  purge() {
    try {
      fs.rmSync(this.tempRoot(), { recursive: true, force: true });
    } catch (e) {
      this.log && this.log.warn('sftp', 'sftp edit temp purge failed', { message: e && e.message });
    }
  }

  /** 设置里的文件编辑器：没有值、路径不存在都算无可用编辑器，交给界面提示去设置。 */
  _editor() {
    const raw = (this.store.getSettings() || {}).fileEditor;
    const cmd = typeof raw === 'string' ? raw.trim() : '';
    if (!cmd) throw fail('NO_EDITOR');
    // 绝对路径当场判掉，免得白下载一份远端副本；裸命令只能等 spawn 报 ENOENT
    if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) throw fail('NO_EDITOR');
    return cmd;
  }

  _launch(file, cmd) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        // 记事本（Win11 已是 Store 应用）会继承 STARTUPINFO 的显示标志：windowsHide/detached
        // 会让窗口开成隐藏态，进程在但看不到编辑器，实测踩过，这里保持最普通的 spawn
        child = spawn(cmd, [file], { stdio: 'ignore' });
      } catch (e) {
        return reject(fail('NO_EDITOR', e && e.message));
      }
      child.once('error', (e) => reject(fail('NO_EDITOR', e && e.message)));
      child.once('spawn', () => {
        child.removeAllListeners('error');
        child.unref();
        resolve();
      });
    });
  }

  async openLocal(p) {
    const cmd = this._editor();
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      throw fail('SFTP_EDIT_MISSING', e && e.message);
    }
    if (st.isDirectory()) throw fail('SFTP_EDIT_DIR');
    if (isBinaryHead(this._readLocalHead(p))) throw fail('SFTP_EDIT_BINARY');
    await this._launch(p, cmd);
    this.log && this.log.info('sftp', 'sftp local file opened in editor', { path: p, editor: cmd, size: st.size });
    return { ok: true };
  }

  _readLocalHead(p) {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      return buf.slice(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
    } finally {
      fs.closeSync(fd);
    }
  }

  async openRemote({ ownerId, connId, remotePath }) {
    const cmd = this._editor();
    const key = `${connId}|${remotePath}`;
    const existing = this.edits.get(key);
    if (existing) {
      existing.ownerId = ownerId;
      await this._launch(existing.tempPath, cmd);
      return { ok: true, reused: true };
    }
    this._sweep();
    const st = await this.sftp.stat(connId, remotePath);
    if (!st.exists) throw fail('SFTP_EDIT_MISSING');
    if (st.isDir) throw fail('SFTP_EDIT_DIR');
    if (isBinaryHead(await this.sftp.readHead(connId, remotePath, HEAD_BYTES))) throw fail('SFTP_EDIT_BINARY');
    const dir = path.join(this.tempRoot(), `${Date.now().toString(36)}-${(++this._seq).toString(36)}`);
    const tempPath = path.join(dir, safeTempName(remotePath));
    fs.mkdirSync(dir, { recursive: true });
    try {
      await this.sftp.fetchToLocal({ connId, remotePath, localPath: tempPath });
      await this._launch(tempPath, cmd);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    const copy = fs.statSync(tempPath);
    const rec = {
      key,
      ownerId,
      connId,
      remotePath,
      tempPath,
      base: { mtimeMs: copy.mtimeMs, size: copy.size },
      uploadTaskId: null,
      timer: setInterval(() => this._tick(key), EDIT_POLL_MS),
    };
    this.edits.set(key, rec);
    this.log &&
      this.log.info('sftp', 'sftp edit opened', { connId, remotePath, editor: cmd, size: copy.size });
    return { ok: true };
  }

  _tick(key) {
    const rec = this.edits.get(key);
    if (!rec) return;
    if (rec.uploadTaskId) return this._checkUpload(rec);
    let cur;
    try {
      cur = fs.statSync(rec.tempPath);
    } catch (_) {
      return;
    }
    if (cur.mtimeMs === rec.base.mtimeMs && cur.size === rec.base.size) return;
    this._startUpload(rec, cur);
  }

  _startUpload(rec, cur) {
    rec.base = { mtimeMs: cur.mtimeMs, size: cur.size };
    this.sftp
      .upload({ connId: rec.connId, localPath: rec.tempPath, remotePath: rec.remotePath })
      .then((r) => {
        rec.uploadTaskId = (r && r.taskId) || null;
        this.log &&
          this.log.info('sftp', 'sftp edit upload queued', {
            connId: rec.connId,
            remotePath: rec.remotePath,
            size: cur.size,
          });
      })
      .catch((e) => {
        // 任务根本没建起来（连接已断或副本被外部删掉），编辑会话已经无法继续
        this._abandon(rec, e);
      });
  }

  _checkUpload(rec) {
    const task = this.sftp.tasks.get(rec.uploadTaskId);
    rec.uploadTaskId = null;
    if (!task) {
      // 任务被取消或被回收：保留副本，用户下一次保存会重新排队
      this.log && this.log.warn('sftp', 'sftp edit upload task vanished', { remotePath: rec.remotePath });
      return;
    }
    if (task.status === 'running' || task.status === 'paused') {
      rec.uploadTaskId = task.taskId;
      return;
    }
    if (task.status === 'done') {
      this.log &&
        this.log.info('sftp', 'sftp edit upload done', {
          connId: rec.connId,
          remotePath: rec.remotePath,
          size: task.size || 0,
        });
      // 回传读取副本期间编辑器又写了一次：这一次的内容还没上去，得马上补一轮
      let cur = null;
      try {
        cur = fs.statSync(rec.tempPath);
      } catch (_) {}
      if (cur && (cur.mtimeMs !== rec.base.mtimeMs || cur.size !== rec.base.size)) this._startUpload(rec, cur);
      // 上传成功不删副本、不收尾：编辑器还开着，删掉后下一次保存就写不回去了
      return;
    }
    this.log &&
      this.log.warn('sftp', 'sftp edit upload unfinished', {
        remotePath: rec.remotePath,
        status: task.status,
        errorCode: task.errorCode || '',
      });
  }

  _stop(rec) {
    clearInterval(rec.timer);
    rec.timer = null;
    this.edits.delete(rec.key);
  }

  /** 连接没了才放弃这条编辑会话：副本留在原地，等下次启动清扫，不当场丢掉用户改动。 */
  _abandon(rec, e) {
    this._stop(rec);
    this.log &&
      this.log.warn('sftp', 'sftp edit abandoned', {
        connId: rec.connId,
        remotePath: rec.remotePath,
        code: (e && e.code) || '',
        message: (e && e.message) || '',
      });
  }

  closeConn(connId) {
    [...this.edits.values()].forEach((rec) => {
      if (rec.connId === connId) this._abandon(rec);
    });
  }

  closeOwner(ownerId) {
    [...this.edits.values()].forEach((rec) => {
      if (rec.ownerId === ownerId) this._abandon(rec);
    });
  }

  destroyAll() {
    [...this.edits.values()].forEach((rec) => {
      clearInterval(rec.timer);
      rec.timer = null;
    });
    this.edits.clear();
  }
}

module.exports = { EditManager };
