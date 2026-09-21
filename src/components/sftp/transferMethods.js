import { api, unwrap } from '../../store';
import { t } from '../../i18n';
import { formatSize, joinLocal, joinRemote, parentLocal, parentRemote } from './utils';

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

  async uploadLocalPayload(payload, remoteDir) {
    if (!this.connId) return;
    if (!payload.isDir) {
      await this.uploadPaths([payload.path], remoteDir);
      return;
    }
    await this.transferFolderUpload(payload.path, remoteDir);
  },

  /** Folder upload → one expandable parent task + child file tasks */
  async transferFolderUpload(localDir, remoteDir) {
    if (!this.connId) return;
    const folderName = String(localDir).split(/[\\/]/).filter(Boolean).pop() || 'folder';
    const remoteRoot = joinRemote(remoteDir, folderName);
    let walk = [];
    try {
      walk = unwrap(await api.sftpWalkLocal(localDir, remoteRoot)) || [];
    } catch (e) {
      this.$message.error(e.message);
      return;
    }
    const parentId = `folder-${Date.now().toString(36)}`;
    const parent = {
      taskId: parentId,
      name: folderName,
      isFolder: true,
      direction: 'upload',
      status: 'running',
      percent: 0,
      size: 0,
      transferred: 0,
      sizeText: '—',
      speedText: '—',
      sourcePath: localDir,
      targetPath: remoteRoot,
      error: '',
      children: [],
    };
    // create remote root folder first — otherwise child uploads ENOENT
    try {
      if (api.sftpMkdirp) unwrap(await api.sftpMkdirp(this.connId, remoteRoot));
      else if (api.sftpMkdir) unwrap(await api.sftpMkdir(this.connId, remoteRoot));
    } catch (_) {}
    this.tasks = [parent, ...this.tasks];
    this.expandFolder(parentId);
    this.$message.success(`${t('sftp.taskQueued')}: ${folderName}`);
    for (const node of walk) {
      if (node.type === 'dir') {
        try {
          await api.sftpMkdir(this.connId, node.remotePath);
        } catch (_) {}
        parent.children.push({
          taskId: `${parentId}:d:${node.remotePath}`,
          parentId,
          name: node.name,
          isDir: true,
          status: 'done',
          percent: 100,
          size: 0,
          transferred: 0,
          sizeText: '—',
          speedText: '—',
          sourcePath: node.localPath,
          targetPath: node.remotePath,
        });
      } else if (node.type === 'file') {
        const child = {
          taskId: `${parentId}:c:${node.remotePath}`,
          parentId,
          name: node.name,
          isDir: false,
          status: 'running',
          percent: 0,
          size: Number(node.size) || 0,
          transferred: 0,
          sizeText: formatSize(node.size),
          speedText: '—',
          sourcePath: node.localPath,
          targetPath: node.remotePath,
          error: '',
        };
        parent.children.push(child);
        try {
          const r = unwrap(
            await api.sftpUpload({
              connId: this.connId,
              localPath: node.localPath,
              remotePath: node.remotePath,
            })
          );
          if (r && r.taskId) child.taskId = r.taskId;
        } catch (e) {
          child.status = 'error';
          child.error = e.message || String(e);
        }
      } else if (!node.type && node.localPath) {
        // unknown node — only upload if it is a regular file
        try {
          const st = unwrap(await api.sftpLocalExists(node.localPath));
          if (!st || !st.exists || st.isDir) continue;
        } catch (_) {
          continue;
        }
        try {
          const r = unwrap(
            await api.sftpUpload({
              connId: this.connId,
              localPath: node.localPath,
              remotePath: node.remotePath,
            })
          );
          parent.children.push({
            taskId: (r && r.taskId) || `${parentId}:c:${node.remotePath}`,
            parentId,
            name: node.name,
            isDir: false,
            status: 'running',
            percent: 0,
            size: Number(node.size) || 0,
            transferred: 0,
            sizeText: formatSize(node.size),
            speedText: '—',
            sourcePath: node.localPath,
            targetPath: node.remotePath,
          });
        } catch (e) {
          this.pushDlog('folder child skip ' + (e && e.message));
        }
      }
      this.$set(parent, 'children', parent.children.slice());
      this.recalcFolder(parent);
    }
    this.recalcFolder(parent);
    this.syncTasks();
    setTimeout(() => this.goRemote(remoteDir), 400);
  },

  async walkRemoteNodes(connId, remoteDir, localDir) {
    const listing = unwrap(await api.sftpList(connId, remoteDir));
    const items = (listing.items || []).filter(
      (x) => !x.isParent && x.name !== '.' && x.name !== '..'
    );
    const nodes = [];
    for (const it of items) {
      const rp = joinRemote(remoteDir, it.name);
      const lp = joinLocal(localDir, it.name);
      if (it.isDir) {
        nodes.push({ type: 'dir', name: it.name, remotePath: rp, localPath: lp, size: 0 });
        const sub = await this.walkRemoteNodes(connId, rp, lp);
        nodes.push(...sub);
      } else {
        nodes.push({
          type: 'file',
          name: it.name,
          remotePath: rp,
          localPath: lp,
          size: Number(it.size) || 0,
        });
      }
    }
    return nodes;
  },

  /** Folder download → expandable parent + children */
  async transferFolderDownload(remoteDir, localDir) {
    if (!this.connId) return;
    const folderName = String(remoteDir).split('/').filter(Boolean).pop() || 'folder';
    const localRoot = joinLocal(localDir, folderName);
    let walk = [];
    try {
      walk = await this.walkRemoteNodes(this.connId, remoteDir, localRoot);
    } catch (e) {
      this.$message.error(e.message);
      return;
    }
    try {
      await api.sftpLocalMkdir(localDir, folderName);
    } catch (_) {}
    const parentId = `folder-${Date.now().toString(36)}`;
    const parent = {
      taskId: parentId,
      name: folderName,
      isFolder: true,
      direction: 'download',
      status: 'running',
      percent: 0,
      size: 0,
      transferred: 0,
      sizeText: '—',
      speedText: '—',
      sourcePath: remoteDir,
      targetPath: localRoot,
      error: '',
      children: [],
    };
    this.tasks = [parent, ...this.tasks];
    this.expandFolder(parentId);
    this.$message.success(`${t('sftp.taskQueued')}: ${folderName}`);
    for (const node of walk) {
      if (node.type === 'dir') {
        try {
          await api.sftpLocalMkdir(localDir === parent.targetPath ? localDir : parentLocal(node.localPath), node.name);
        } catch (_) {}
        // ensure nested dir path exists
        try {
          await api.sftpLocalMkdir(parentLocal(node.localPath), node.name);
        } catch (_) {}
        parent.children.push({
          taskId: `${parentId}:d:${node.remotePath}`,
          parentId,
          name: node.name,
          isDir: true,
          status: 'done',
          percent: 100,
          size: 0,
          transferred: 0,
          sizeText: '—',
          speedText: '—',
          sourcePath: node.remotePath,
          targetPath: node.localPath,
        });
      } else {
        try {
          await api.sftpLocalMkdir(parentLocal(node.localPath), '.');
        } catch (_) {}
        const child = {
          taskId: `${parentId}:c:${node.remotePath}`,
          parentId,
          name: node.name,
          isDir: false,
          status: 'running',
          percent: 0,
          size: Number(node.size) || 0,
          transferred: 0,
          sizeText: formatSize(node.size),
          speedText: '—',
          sourcePath: node.remotePath,
          targetPath: node.localPath,
          error: '',
        };
        parent.children.push(child);
        try {
          const r = unwrap(
            await api.sftpDownload({
              connId: this.connId,
              remotePath: node.remotePath,
              localPath: node.localPath,
            })
          );
          if (r && r.taskId) child.taskId = r.taskId;
        } catch (e) {
          child.status = 'error';
          child.error = e.message || String(e);
        }
      }
      this.$set(parent, 'children', parent.children.slice());
      this.recalcFolder(parent);
    }
    this.recalcFolder(parent);
    this.syncTasks();
    setTimeout(() => this.goLocal(localDir), 400);
  },
  // Recursive payload downloads require per-file overwrite confirmation.
  async downloadRemotePayload(payload, localDir) {
    if (!this.connId) return;
    if (!payload.isDir) {
      await this.downloadPaths([payload.path], localDir);
      return;
    }
    const localRoot = joinLocal(localDir, payload.name);
    try {
      await api.sftpLocalMkdir(localDir, payload.name);
      await this.downloadRemoteDir(payload.path, localRoot);
      this.$message.success(t('sftp.taskQueued'));
      setTimeout(() => this.goLocal(localDir), 400);
      this.syncTasks();
    } catch (e) {
      this.$message.error(e.message);
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
    this.$message.success(`${t('sftp.taskQueued')}: ${name}`);
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
      this.$message.success(t('sftp.taskQueued'));
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
      this.$message.success(t('sftp.taskQueued'));
      setTimeout(() => this.goLocal(dir), 400);
      this.syncTasks();
    }
  },
};
