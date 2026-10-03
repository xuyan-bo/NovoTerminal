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
  async runTransfers(s, items, zoneSide, destDir) {
    if (!s || !s.connId) return;
    const dir = destDir || (zoneSide === 'local' ? this.localDropDir() : s.remotePath || '/');
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
      if (files.length) await this.downloadPaths(s, files, dir);
      for (const x of dirs) await this.transferFolderDownload(s, x.path, dir);
      return;
    }
    if (files.length) await this.uploadPaths(s, files, dir);
    for (const x of dirs) await this.transferFolderUpload(s, x.path, dir);
  },

  /** Paste files copied in the OS file manager into the current remote directory. */
  async pasteFromClipboard() {
    const s = this.s;
    if (!api.sftpClipboardFiles) {
      this.$message.error(t('msg.needElectron'));
      return;
    }
    if (!s || !s.connId) return;
    if (this._pasting) return;
    this._pasting = true;
    let files = [];
    try {
      files = unwrap(await api.sftpClipboardFiles(true)) || [];
    } catch (_) {
      files = [];
    } finally {
      this._pasting = false;
    }
    if (!files.length) {
      this.$message.warning(t('sftp.clipboardEmpty'));
      return;
    }
    this.pushDlog(`paste-clipboard n=${files.length} → ${s.remotePath}`);
    await this.uploadPaths(s, files, s.remotePath);
  },

  /** Folder upload: the task row shows up at once, directories are listed and sent one by one. */
  async transferFolderUpload(s, localDir, remoteDir) {
    if (!s || !s.connId) return;
    const folderName = String(localDir).split(/[\\/]/).filter(Boolean).pop() || 'folder';
    const remoteRoot = joinRemote(remoteDir, folderName);
    const root = this.makeTaskRow(s, {
      taskId: `folder-${s.id}-${Date.now().toString(36)}`,
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
    this.registerFolderRoot(s, root);
    // create remote root folder first — otherwise child uploads ENOENT
    try {
      if (api.sftpMkdirp) unwrap(await api.sftpMkdirp(s.connId, remoteRoot));
      else if (api.sftpMkdir) unwrap(await api.sftpMkdir(s.connId, remoteRoot));
    } catch (_) {}
    await this.scanFolderUpload(s, root);
    this.finishFolderScan(s, root);
    setTimeout(() => this.goRemote(s, remoteDir), 400);
  },

  /** Breadth-first: list one directory, publish it to the queue, then start its files. */
  async scanFolderUpload(s, root) {
    const state = this.folderState(s, root.taskId);
    const queue = [{ row: root, source: root.sourcePath, target: root.targetPath }];
    while (queue.length) {
      if (!state || state.canceled || !s.alive) return;
      const cur = queue.shift();
      let entries = [];
      try {
        const listing = unwrap(await api.sftpLocalList(cur.source));
        entries = (listing.items || []).filter((x) => x.name !== '.' && x.name !== '..');
      } catch (e) {
        cur.row.status = 'error';
        cur.row.error = e.message || String(e);
        this.markDirScanned(s, root.taskId, cur.row);
        this.scheduleRecalc(s, root);
        continue;
      }
      // The task may have been removed while the listing was in flight.
      if (!state || state.canceled || !s.alive) return;
      const rows = this.addDiscoveredChildren(s, root, cur.row, entries, 'upload', (x) => ({
        sourcePath: joinLocal(cur.source, x.name),
        targetPath: joinRemote(cur.target, x.name),
        size: Number(x.size) || 0,
      }));
      this.markDirScanned(s, root.taskId, cur.row);
      this.scheduleRecalc(s, root);
      for (let i = 0; i < entries.length; i++) {
        if (state.canceled) return;
        const row = rows[i];
        if (entries[i].isDir) {
          try {
            await api.sftpMkdir(s.connId, row.targetPath);
          } catch (_) {}
          queue.push({ row, source: row.sourcePath, target: row.targetPath });
          continue;
        }
        await this.waitForResume(state);
        if (state.canceled) return;
        try {
          const r = unwrap(
            await api.sftpUpload({
              connId: s.connId,
              localPath: row.sourcePath,
              remotePath: row.targetPath,
            })
          );
          if (r && r.taskId) this.bindTransfer(s, row, r.taskId);
        } catch (e) {
          row.status = 'error';
          row.error = e.message || String(e);
        }
        this.scheduleRecalc(s, root);
      }
    }
  },

  /** Folder download: same incremental scan against the remote listing. */
  async transferFolderDownload(s, remoteDir, localDir) {
    if (!s || !s.connId) return;
    const folderName = String(remoteDir).split('/').filter(Boolean).pop() || 'folder';
    const localRoot = joinLocal(localDir, folderName);
    const root = this.makeTaskRow(s, {
      taskId: `folder-${s.id}-${Date.now().toString(36)}`,
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
    this.registerFolderRoot(s, root);
    try {
      await api.sftpLocalMkdir(localDir, folderName);
    } catch (_) {}
    await this.scanFolderDownload(s, root);
    this.finishFolderScan(s, root);
    setTimeout(() => this.goLocal(localDir), 400);
  },

  async scanFolderDownload(s, root) {
    const state = this.folderState(s, root.taskId);
    const queue = [{ row: root, source: root.sourcePath, target: root.targetPath }];
    while (queue.length) {
      if (!state || state.canceled || !s.alive) return;
      const cur = queue.shift();
      let entries = [];
      try {
        const listing = unwrap(await api.sftpList(s.connId, cur.source));
        entries = (listing.items || []).filter(
          (x) => !x.isParent && x.name !== '.' && x.name !== '..'
        );
      } catch (e) {
        cur.row.status = 'error';
        cur.row.error = e.message || String(e);
        this.markDirScanned(s, root.taskId, cur.row);
        this.scheduleRecalc(s, root);
        continue;
      }
      // The task may have been removed while the listing was in flight.
      if (!state || state.canceled || !s.alive) return;
      const rows = this.addDiscoveredChildren(s, root, cur.row, entries, 'download', (x) => ({
        sourcePath: joinRemote(cur.source, x.name),
        targetPath: joinLocal(cur.target, x.name),
        size: Number(x.size) || 0,
      }));
      this.markDirScanned(s, root.taskId, cur.row);
      this.scheduleRecalc(s, root);
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
              connId: s.connId,
              remotePath: row.sourcePath,
              localPath: row.targetPath,
            })
          );
          if (r && r.taskId) this.bindTransfer(s, row, r.taskId);
        } catch (e) {
          row.status = 'error';
          row.error = e.message || String(e);
        }
        this.scheduleRecalc(s, root);
      }
    }
  },
  async downloadRemoteDir(s, remoteDir, localDir) {
    const list = unwrap(await api.sftpList(s.connId, remoteDir));
    const items = (list.items || []).filter((x) => !x.isParent && x.name !== '.' && x.name !== '..');
    for (const it of items) {
      const rp = joinRemote(remoteDir, it.name);
      const lp = joinLocal(localDir, it.name);
      if (it.isDir) {
        try {
          await api.sftpLocalMkdir(localDir, it.name);
        } catch (_) {}
        await this.downloadRemoteDir(s, rp, lp);
      } else {
        await this.startDownload(s, rp, lp);
      }
    }
  },
  async startUpload(s, localPath, remotePath) {
    // Folder path must not go through file upload (EISDIR)
    if (api.sftpLocalExists) {
      try {
        const lst = unwrap(await api.sftpLocalExists(localPath));
        if (lst && lst.exists && lst.isDir) {
          const remoteDir = parentRemote(remotePath) || s.remotePath;
          this.pushDlog(`startUpload dir→folder ${localPath} => ${remoteDir}`);
          await this.transferFolderUpload(s, localPath, remoteDir);
          return;
        }
      } catch (_) {}
    }
    const dup = s.tasks.find(
      (x) =>
        x.sourcePath === localPath &&
        x.targetPath === remotePath &&
        (x.status === 'running' || x.status === 'paused' || x.status === 'queued')
    );
    if (dup) return;
    const name = remotePath.split('/').filter(Boolean).pop() || localPath;
    if (api.sftpStat && s.connId) {
      try {
        const st = unwrap(await api.sftpStat(s.connId, remotePath));
        if (st && st.exists && !st.isDir) {
          const ok = await this.confirmOverwrite('upload', name);
          if (!ok) return;
        }
      } catch (_) {}
    }
    unwrap(await api.sftpUpload({ connId: s.connId, localPath, remotePath }));
  },
  async startDownload(s, remotePath, localPath) {
    const dup = s.tasks.find(
      (x) =>
        x.sourcePath === remotePath &&
        x.targetPath === localPath &&
        (x.status === 'running' || x.status === 'paused' || x.status === 'queued')
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
    const r = unwrap(await api.sftpDownload({ connId: s.connId, remotePath, localPath }));
    this.pushDlog('startDownload taskId=' + (r && r.taskId));
    if (r && r.taskId) {
      this.mergeTask(s, {
        taskId: r.taskId,
        connId: s.connId,
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
    this.syncTasks(s);
  },
  async uploadPaths(s, localPaths, remoteDir) {
    if (!s || !s.connId) return;
    const dir = remoteDir || s.remotePath;
    let ok = 0;
    for (const p of localPaths) {
      const name = p.split(/[\\/]/).pop();
      try {
        await this.startUpload(s, p, joinRemote(dir, name));
        ok += 1;
      } catch (e) {
        this.$message.error(`${name}: ${e.message || e}`);
      }
    }
    if (ok) {
      setTimeout(() => this.goRemote(s, dir), 400);
      this.syncTasks(s);
    }
  },
  async downloadPaths(s, remotePaths, localDir) {
    if (!s || !s.connId) return;
    const dir = localDir || this.localPath;
    let ok = 0;
    for (const p of remotePaths) {
      const name = p.split('/').filter(Boolean).pop();
      try {
        await this.startDownload(s, p, joinLocal(dir, name));
        ok += 1;
      } catch (e) {
        this.$message.error(`${name}: ${e.message || e}`);
      }
    }
    if (ok) {
      setTimeout(() => this.goLocal(dir), 400);
      this.syncTasks(s);
    }
  },
};
