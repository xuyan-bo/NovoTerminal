import { api, unwrap, connectionErrorMessage, findAsset } from '../../store';
import { t } from '../../i18n';
import { joinLocal, joinRemote, parentRemote, transferErrorText } from './utils';

// 文件夹任务的 row-key 尾巴：同一毫秒建出两条任务时 Date.now() 会重复，el-table 的 row-key 必须唯一
let folderSeq = 0;

export default {
  /**
   * 覆盖策略来自该资产 SFTP 方式的高级参数：ask 逐个询问（默认），replace 直接覆盖，skip 直接跳过。
   * 主进程只在整份内容写完后才改名替换目标，所以跳过与询问都不会留下半份目标文件。
   */
  sftpOverwritePolicy(s) {
    const hit = s && s.assetId ? findAsset(s.assetId) : null;
    const adv = (hit && hit.asset && hit.asset.methods && hit.asset.methods.sftp && hit.asset.methods.sftp.advanced) || {};
    return adv.overwrite === 'replace' || adv.overwrite === 'skip' ? adv.overwrite : 'ask';
  },
  /**
   * 文件夹子任务的目标同名时先问再传：整棵树只问一次——确认即全部覆盖，
   * 取消即逐个跳过（把行摘出树，不提交传输）。
   */
  async allowFolderTarget(s, root, row, direction) {
    if (!row || !row.targetPath) return true;
    let exists = false;
    try {
      const st = unwrap(
        await (direction === 'upload'
          ? api.sftpStat(s.connId, row.targetPath)
          : api.sftpLocalExists(row.targetPath))
      );
      exists = !!(st && st.exists && !st.isDir);
    } catch (_) {
      // 探测失败不拦正常传输：主进程自己还会返回真实的写入错误
      return true;
    }
    if (!exists) return true;
    const state = this.folderState(s, root.taskId);
    if (!state) return true;
    if (state.overwrite === undefined) {
      const policy = this.sftpOverwritePolicy(s);
      if (policy !== 'ask') {
        state.overwrite = policy === 'replace';
      } else {
        try {
          await this.$confirm(
            t(
              direction === 'upload' ? 'sftp.overwriteFolderRemote' : 'sftp.overwriteFolderLocal',
              { name: root.name }
            ),
            t('sftp.overwriteTitle'),
            { type: 'warning', confirmButtonText: t('msg.confirm'), cancelButtonText: t('msg.cancel') }
          );
          state.overwrite = true;
        } catch (_) {
          state.overwrite = false;
        }
      }
    }
    if (state.overwrite) return true;
    this.dropChildRow(s, row);
    return false;
  },
  /** 同一路径可能已经在某棵文件夹树里传：进度事件会按 source|target 命中那一行，两条任务不能各建一份。 */
  rowByKeyHit(s, sourcePath, targetPath) {
    const row = s.rowByKey && s.rowByKey.get(`${sourcePath}|${targetPath}`);
    if (!row || row.status === 'done' || row.status === 'error') return null;
    return row;
  },
  async confirmOverwrite(s, direction, name) {
    const policy = this.sftpOverwritePolicy(s);
    if (policy !== 'ask') return policy === 'replace';
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
    await this.uploadPaths(s, files, s.remotePath);
  },

  /** Folder upload: the task row shows up at once, directories are listed and sent one by one. */
  async transferFolderUpload(s, localDir, remoteDir) {
    if (!s || !s.connId) return;
    const folderName = String(localDir).split(/[\\/]/).filter(Boolean).pop() || 'folder';
    const remoteRoot = joinRemote(remoteDir, folderName);
    const root = this.makeTaskRow(s, {
      taskId: `folder-${s.id}-${Date.now().toString(36)}-${(folderSeq += 1).toString(36)}`,
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
    // 先建远端根目录，否则子文件上传会 ENOENT；mkdirp 容忍已存在的目录
    if (!(await this.ensureFolderRoot(s, root, api.sftpMkdirp(s.connId, remoteRoot)))) return;
    await this.scanFolderUpload(s, root);
    this.finishFolderScan(s, root);
  },

  /** 建不成根目录就把这条文件夹任务判失败，别让它永远挂在「传输中」。 */
  async ensureFolderRoot(s, root, pending) {
    try {
      unwrap(await pending);
      return true;
    } catch (e) {
      root.status = 'error';
      root.error = e.message || String(e);
      root.errorCode = e.code || '';
      this.forgetFolderTree(s, root.taskId);
      this.$message.error(`${root.name}: ${transferErrorText(root)}`);
      return false;
    }
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
        cur.row.errorCode = e.code || '';
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
            unwrap(await api.sftpMkdirp(s.connId, row.targetPath));
          } catch (e) {
            row.status = 'error';
            row.error = e.message || String(e);
            row.errorCode = e.code || '';
            this.scheduleRecalc(s, root);
            continue;
          }
          queue.push({ row, source: row.sourcePath, target: row.targetPath });
          continue;
        }
        await this.waitForResume(state);
        if (state.canceled) return;
        // 扫描按提交前捕获的 rows 逐条走：行被移除或用户拒绝覆盖时要当场跳过，不能照常上传
        if (row.dropped) continue;
        if (!(await this.allowFolderTarget(s, root, row, 'upload'))) continue;
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
          row.errorCode = e.code || '';
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
      taskId: `folder-${s.id}-${Date.now().toString(36)}-${(folderSeq += 1).toString(36)}`,
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
    if (!(await this.ensureFolderRoot(s, root, api.sftpLocalMkdir(localDir, folderName)))) return;
    await this.scanFolderDownload(s, root);
    this.finishFolderScan(s, root);
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
        cur.row.errorCode = e.code || '';
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
            unwrap(await api.sftpLocalMkdir(cur.target, entries[i].name));
          } catch (e) {
            row.status = 'error';
            row.error = e.message || String(e);
            row.errorCode = e.code || '';
            this.scheduleRecalc(s, root);
            continue;
          }
          queue.push({ row, source: row.sourcePath, target: row.targetPath });
          continue;
        }
        await this.waitForResume(state);
        if (state.canceled) return;
        if (row.dropped) continue;
        if (!(await this.allowFolderTarget(s, root, row, 'download'))) continue;
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
          row.errorCode = e.code || '';
        }
        this.scheduleRecalc(s, root);
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
          await this.transferFolderUpload(s, localPath, remoteDir);
          return;
        }
      } catch (_) {}
    }
    const dup =
      s.tasks.find(
        (x) =>
          x.sourcePath === localPath &&
          x.targetPath === remotePath &&
          (x.status === 'running' || x.status === 'paused' || x.status === 'queued')
      ) || this.rowByKeyHit(s, localPath, remotePath);
    if (dup) return;
    const name = remotePath.split('/').filter(Boolean).pop() || localPath;
    if (api.sftpStat && s.connId) {
      try {
        const st = unwrap(await api.sftpStat(s.connId, remotePath));
        if (st && st.exists && !st.isDir) {
          const ok = await this.confirmOverwrite(s, 'upload', name);
          if (!ok) return;
        }
      } catch (_) {}
    }
    const r = unwrap(await api.sftpUpload({ connId: s.connId, localPath, remotePath }));
    // 上传也要立刻建一行，否则排队中的任务在队列里根本看不见，去重也扫不到它
    if (r && r.taskId) {
      this.mergeTask(s, {
        taskId: r.taskId,
        name,
        size: 0,
        transferred: 0,
        percent: 0,
        sizeText: '—',
        speedText: '—',
        direction: 'upload',
        sourcePath: localPath,
        targetPath: remotePath,
        status: r.status || 'queued',
      });
    }
  },
  async startDownload(s, remotePath, localPath) {
    const dup =
      s.tasks.find(
        (x) =>
          x.sourcePath === remotePath &&
          x.targetPath === localPath &&
          (x.status === 'running' || x.status === 'paused' || x.status === 'queued')
      ) || this.rowByKeyHit(s, remotePath, localPath);
    if (dup) return;
    const name = localPath.split(/[\\/]/).pop() || remotePath;
    if (api.sftpLocalExists) {
      try {
        const st = unwrap(await api.sftpLocalExists(localPath));
        if (st && st.exists && !st.isDir) {
          const ok = await this.confirmOverwrite(s, 'download', name);
          if (!ok) return;
        }
      } catch (_) {}
    }
    const r = unwrap(await api.sftpDownload({ connId: s.connId, remotePath, localPath }));
    if (r && r.taskId) {
      this.mergeTask(s, {
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
        status: r.status || 'queued',
      });
    }
  },
  async uploadPaths(s, localPaths, remoteDir) {
    if (!s || !s.connId) return;
    const dir = remoteDir || s.remotePath;
    for (const p of localPaths) {
      const name = p.split(/[\\/]/).pop();
      try {
        await this.startUpload(s, p, joinRemote(dir, name));
      } catch (e) {
        this.$message.error(`${name}: ${connectionErrorMessage(e)}`);
      }
    }
  },
  async downloadPaths(s, remotePaths, localDir) {
    if (!s || !s.connId) return;
    const dir = localDir || this.localPath;
    for (const p of remotePaths) {
      const name = p.split('/').filter(Boolean).pop();
      try {
        await this.startDownload(s, p, joinLocal(dir, name));
      } catch (e) {
        this.$message.error(`${name}: ${connectionErrorMessage(e)}`);
      }
    }
  },
};
