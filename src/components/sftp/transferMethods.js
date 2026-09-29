import { api, unwrap } from '../../store';
import { t } from '../../i18n';
import { joinLocal, joinRemote, parentRemote } from './utils';

export default {
  async confirmOverwrite(direction, name) {
    try {
      if (direction === 'upload') {
        await this.$confirm(t('sftp.overwriteRemote', { name }), t('sftp.overwriteTitle'), {
          type: 'warning',
          confirmButtonText: t('msg.confirm'),
          cancelButtonText: t('msg.cancel'),
        });
      } else {
        await this.$confirm(t('sftp.overwriteLocal', { name }), t('sftp.overwriteTitle'), {
          type: 'warning',
          confirmButtonText: t('msg.confirm'),
          cancelButtonText: t('msg.cancel'),
        });
      }
      return true;
    } catch (_) {
      return false;
    }
  },

  /** Move a dragged item list across panels: files batch, folders keep their aggregated task. */
  async runTransfers(items, zoneSide, destDir) {
    if (!this.connId) return;
    const dir = destDir || (zoneSide === 'local' ? this.localDropDir() : this.remotePath || '/');
    const named = (items || []).map((it) => ({
      ...it,
      name:
        it.name ||
        String(it.path || '').split(/[\\/]/).filter(Boolean).pop() ||
        (zoneSide === 'local' ? 'download.bin' : 'upload.bin'),
    }));
    const files = named.filter((x) => !x.isDir).map((x) => x.path);
    const dirs = named.filter((x) => x.isDir);
    if (zoneSide === 'local') {
      if (files.length) await this.downloadPaths(files, dir);
      for (const x of dirs) await this.transferFolderDownload(x.path, dir);
      return;
    }
    if (files.length) await this.uploadPaths(files, dir);
    for (const x of dirs) await this.transferFolderUpload(x.path, dir);
  },

  /** Folder upload: the task row shows up at once, directories are listed and sent one by one. */
  async transferFolderUpload(localDir, remoteDir) {
    if (!this.connId) return;
    const folderName = String(localDir).split(/[\\/]/).filter(Boolean).pop() || 'folder';
    const remoteRoot = joinRemote(remoteDir, folderName);
    const root = this.makeTaskRow({
      taskId: `folder-${Date.now().toString(36)}`,
      name: folderName,
      isFolder: true,
      hasChildren: true,
      direction: 'upload',
      status: 'running',
      size: 0,
      sizeText: '—',
      sourcePath: localDir,
      targetPath: remoteRoot,
      children: [],
    });
    this.registerFolderRoot(root);
    // create remote root folder first — otherwise child uploads ENOENT
    try {
      if (api.sftpMkdirp) unwrap(await api.sftpMkdirp(this.connId, remoteRoot));
      else if (api.sftpMkdir) unwrap(await api.sftpMkdir(this.connId, remoteRoot));
    } catch (_) {}
    await this.scanFolderUpload(root);
    this.finishFolderScan(root);
    setTimeout(() => this.goRemote(remoteDir), 400);
  },

  /** Breadth-first: list one directory, publish it to the queue, then start its files. */
  async scanFolderUpload(root) {
    const state = this.folderState(root.taskId);
    const queue = [{ row: root, source: root.sourcePath, target: root.targetPath }];
    while (queue.length) {
      if (!state || state.canceled) return;
      const cur = queue.shift();
      let entries = [];
      try {
        const listing = unwrap(await api.sftpLocalList(cur.source));
        entries = (listing.items || []).filter((x) => x.name !== '.' && x.name !== '..');
      } catch (e) {
        cur.row.status = 'error';
        cur.row.error = e.message || String(e);
        this.markDirScanned(root.taskId, cur.row);
        this.recalcTree(root);
        continue;
      }
      // The task may have been removed while the listing was in flight.
      if (!state || state.canceled) return;
      const rows = this.addDiscoveredChildren(root, cur.row, entries, 'upload', (x) => ({
        sourcePath: joinLocal(cur.source, x.name),
        targetPath: joinRemote(cur.target, x.name),
        size: Number(x.size) || 0,
      }));
      this.markDirScanned(root.taskId, cur.row);
      this.recalcTree(root);
      for (let i = 0; i < entries.length; i++) {
        if (state.canceled) return;
        const row = rows[i];
        if (entries[i].isDir) {
          try {
            await api.sftpMkdir(this.connId, row.targetPath);
          } catch (_) {}
          queue.push({ row, source: row.sourcePath, target: row.targetPath });
          continue;
        }
        await this.waitForResume(state);
        if (state.canceled) return;
        try {
          const r = unwrap(
            await api.sftpUpload({
              connId: this.connId,
              localPath: row.sourcePath,
              remotePath: row.targetPath,
            })
          );
          if (r && r.taskId) this.bindTransfer(row, r.taskId);
        } catch (e) {
          row.status = 'error';
          row.error = e.message || String(e);
        }
        this.recalcTree(root);
      }
    }
  },

  /** Folder download: same incremental scan against the remote listing. */
  async transferFolderDownload(remoteDir, localDir) {
    if (!this.connId) return;
    const folderName = String(remoteDir).split('/').filter(Boolean).pop() || 'folder';
    const localRoot = joinLocal(localDir, folderName);
    const root = this.makeTaskRow({
      taskId: `folder-${Date.now().toString(36)}`,
      name: folderName,
      isFolder: true,
      hasChildren: true,
      direction: 'download',
      status: 'running',
      size: 0,
      sizeText: '—',
      sourcePath: remoteDir,
      targetPath: localRoot,
      children: [],
    });
    this.registerFolderRoot(root);
    try {
      await api.sftpLocalMkdir(localDir, folderName);
    } catch (_) {}
    await this.scanFolderDownload(root);
    this.finishFolderScan(root);
    setTimeout(() => this.goLocal(localDir), 400);
  },

  async scanFolderDownload(root) {
    const state = this.folderState(root.taskId);
    const queue = [{ row: root, source: root.sourcePath, target: root.targetPath }];
    while (queue.length) {
      if (!state || state.canceled) return;
      const cur = queue.shift();
      let entries = [];
      try {
        const listing = unwrap(await api.sftpList(this.connId, cur.source));
        entries = (listing.items || []).filter(
          (x) => !x.isParent && x.name !== '.' && x.name !== '..'
        );
      } catch (e) {
        cur.row.status = 'error';
        cur.row.error = e.message || String(e);
        this.markDirScanned(root.taskId, cur.row);
        this.recalcTree(root);
        continue;
      }
      // The task may have been removed while the listing was in flight.
      if (!state || state.canceled) return;
      const rows = this.addDiscoveredChildren(root, cur.row, entries, 'download', (x) => ({
        sourcePath: joinRemote(cur.source, x.name),
        targetPath: joinLocal(cur.target, x.name),
        size: Number(x.size) || 0,
      }));
      this.markDirScanned(root.taskId, cur.row);
      this.recalcTree(root);
      for (let i = 0; i < entries.length; i++) {
        if (state.canceled) return;
        const row = rows[i];
        if (entries[i].isDir) {
          try {
            await api.sftpLocalMkdir(cur.target, entries[i].name);
          } catch (_) {}
          queue.push({ row, source: row.sourcePath, target: row.targetPath });
          continue;
        }
        await this.waitForResume(state);
        if (state.canceled) return;
        try {
          const r = unwrap(
            await api.sftpDownload({
              connId: this.connId,
              remotePath: row.sourcePath,
              localPath: row.targetPath,
            })
          );
          if (r && r.taskId) this.bindTransfer(row, r.taskId);
        } catch (e) {
          row.status = 'error';
          row.error = e.message || String(e);
        }
        this.recalcTree(root);
      }
    }
  },
  async downloadRemoteDir(remoteDir, localDir) {
    const list = unwrap(await api.sftpList(this.connId, remoteDir));
    const items = (list.items || []).filter((x) => !x.isParent && x.name !== '.' && x.name !== '..');
    for (const it of items) {
      const rp = joinRemote(remoteDir, it.name);
      const lp = joinLocal(localDir, it.name);
      if (it.isDir) {
        try {
          await api.sftpLocalMkdir(localDir, it.name);
        } catch (_) {}
        await this.downloadRemoteDir(rp, lp);
      } else {
        await this.startDownload(rp, lp);
      }
    }
  },
  async startUpload(localPath, remotePath) {
    // Folder path must not go through file upload (EISDIR)
    if (api.sftpLocalExists) {
      try {
        const lst = unwrap(await api.sftpLocalExists(localPath));
        if (lst && lst.exists && lst.isDir) {
          const remoteDir = parentRemote(remotePath) || this.remotePath;
          this.pushDlog(`startUpload dir→folder ${localPath} => ${remoteDir}`);
          await this.transferFolderUpload(localPath, remoteDir);
          return;
        }
      } catch (_) {}
    }
    const dup = this.tasks.find(
      (x) =>
        x.sourcePath === localPath &&
        x.targetPath === remotePath &&
        (x.status === 'running' || x.status === 'paused')
    );
    if (dup) return;
    const name = remotePath.split('/').filter(Boolean).pop() || localPath;
    if (api.sftpStat && this.connId) {
      try {
        const st = unwrap(await api.sftpStat(this.connId, remotePath));
        if (st && st.exists && !st.isDir) {
          const ok = await this.confirmOverwrite('upload', name);
          if (!ok) return;
        }
      } catch (_) {}
    }
    unwrap(await api.sftpUpload({ connId: this.connId, localPath, remotePath }));
  },
  async startDownload(remotePath, localPath) {
    const dup = this.tasks.find(
      (x) =>
        x.sourcePath === remotePath &&
        x.targetPath === localPath &&
        (x.status === 'running' || x.status === 'paused')
    );
    if (dup) {
      this.pushDlog('startDownload dup skip');
      return;
    }
    const name = localPath.split(/[\\/]/).pop() || remotePath;
    this.pushDlog(`startDownload ${remotePath} -> ${localPath}`);
    if (api.sftpLocalExists) {
      try {
        const st = unwrap(await api.sftpLocalExists(localPath));
        this.pushDlog(`startDownload localExists=${st && st.exists}`);
        if (st && st.exists && !st.isDir) {
          const ok = await this.confirmOverwrite('download', name);
          this.pushDlog(`startDownload overwrite ok=${ok}`);
          if (!ok) return;
        }
      } catch (err) {
        this.pushDlog('startDownload exists check ' + (err && err.message));
      }
    }
    if (!api.sftpDownload) {
      this.pushDlog('startDownload no api.sftpDownload');
      throw new Error('sftpDownload missing');
    }
    const r = unwrap(await api.sftpDownload({ connId: this.connId, remotePath, localPath }));
    this.pushDlog('startDownload taskId=' + (r && r.taskId));
    if (r && r.taskId) {
      this.mergeTask({
        taskId: r.taskId,
        name,
        size: 0,
        transferred: 0,
        percent: 0,
        sizeText: '—',
        speedText: '—',
        direction: 'download',
        sourcePath: remotePath,
        targetPath: localPath,
        status: 'running',
      });
    }
    this.syncTasks();
  },
  async uploadPaths(localPaths, remoteDir) {
    const dir = remoteDir || this.remotePath;
    let ok = 0;
    for (const p of localPaths) {
      const name = p.split(/[\\/]/).pop();
      try {
        await this.startUpload(p, joinRemote(dir, name));
        ok += 1;
      } catch (e) {
        this.$message.error(`${name}: ${e.message || e}`);
      }
    }
    if (ok) {
      setTimeout(() => this.goRemote(dir), 400);
      this.syncTasks();
    }
  },
  async downloadPaths(remotePaths, localDir) {
    const dir = localDir || this.localPath;
    let ok = 0;
    for (const p of remotePaths) {
      const name = p.split('/').filter(Boolean).pop();
      try {
        await this.startDownload(p, joinLocal(dir, name));
        ok += 1;
      } catch (e) {
        this.$message.error(`${name}: ${e.message || e}`);
      }
    }
    if (ok) {
      setTimeout(() => this.goLocal(dir), 400);
      this.syncTasks();
    }
  },
};
