import Vue from 'vue';
import { api, unwrap } from '../../store';
import { formatSize, parentLocal, parentRemote, isTaskFinished } from './utils';

export default {
  isTaskFinished,
  /** Rows are rendered lazily and updated in place, so they must be observable on their own. */
  makeTaskRow(fields) {
    return Vue.observable(
      Object.assign(
        {
          xferId: null,
          transferred: 0,
          percent: 0,
          speedText: '—',
          error: '',
          fileCount: 0,
          doneCount: 0,
        },
        fields
      )
    );
  },
  folderState(rootId) {
    return this._folderStates.get(rootId) || null;
  },
  /** A folder task shows up in the queue before anything is enumerated. */
  registerFolderRoot(root) {
    this._folderStates.set(root.taskId, {
      root,
      rootId: root.taskId,
      done: false,
      canceled: false,
      paused: false,
      dirs: new Map(),
    });
    this.dirWait(this.folderState(root.taskId), root);
    this.tasks = [root, ...this.tasks];
  },
  forgetFolderTree(rootId) {
    const state = this._folderStates.get(rootId);
    if (!state) return;
    state.canceled = true;
    state.dirs.forEach((entry) => {
      if (!entry.done) {
        entry.done = true;
        entry.resolve([]);
      }
    });
    state.dirs.clear();
    const drop = (row) => {
      this._rowByKey.delete(this.childKey(row));
      if (row.xferId) this._rowByXferId.delete(row.xferId);
      (row.children || []).forEach(drop);
    };
    drop(state.root);
    this._folderStates.delete(rootId);
  },
  /** Resolve point for a lazily rendered directory node. */
  dirWait(state, row) {
    if (!state || !row) return null;
    let entry = state.dirs.get(row.taskId);
    if (!entry) {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      entry = { promise, resolve, done: false };
      state.dirs.set(row.taskId, entry);
    }
    return entry;
  },
  markDirScanned(rootId, row) {
    const entry = this.dirWait(this.folderState(rootId), row);
    if (entry && !entry.done) {
      entry.done = true;
      entry.resolve((row.children || []).slice());
    }
  },
  /** Progress events carry the main-process id, row keys stay stable. */
  bindTransfer(row, xferId) {
    if (!row || !xferId) return;
    row.xferId = xferId;
    this._rowByXferId.set(xferId, row);
  },
  finishFolderScan(root) {
    const state = this.folderState(root && root.taskId);
    if (!state || state.canceled) return;
    state.done = true;
    this.recalcTree(root);
    this.syncTasks();
  },
  /** Element asks for a node's children only when the user expands it. */
  loadTreeChildren(row, treeNode, resolve) {
    const kids = (row && row.children) || [];
    const state = this.folderState((row && row.rootId) || (row && row.taskId));
    const entry = state ? this.dirWait(state, row) : null;
    if (!entry || entry.done) {
      resolve(kids.slice());
      return;
    }
    entry.promise.then(() => {
      if (this._sftpDestroyed) return;
      resolve(((row && row.children) || []).slice());
    });
  },
  /** All descendant file rows of a folder node, at any depth. */
  folderFiles(row) {
    const out = [];
    const walk = (r) => {
      (r.children || []).forEach((c) => {
        if (!c) return;
        if (c.isDir || c.isFolder) walk(c);
        else out.push(c);
      });
    };
    if (row) walk(row);
    return out;
  },
  /**
   * Attach one directory's freshly listed entries under its folder row.
   * `pathOf` maps a listing entry to { sourcePath, targetPath, size }.
   */
  addDiscoveredChildren(root, parentRow, entries, direction, pathOf) {
    const state = this.folderState(root.taskId);
    const rows = (entries || []).map((entry) => {
      const p = pathOf(entry) || {};
      const isDir = !!entry.isDir;
      const row = this.makeTaskRow({
        // Stable row key: the transfer id from the main process lands in xferId instead.
        taskId: `${root.taskId}:${isDir ? 'd' : 'c'}:${p.targetPath || entry.name}`,
        rootId: root.taskId,
        parentId: parentRow.taskId,
        name: entry.name,
        isDir,
        hasChildren: isDir,
        direction,
        status: isDir ? 'done' : 'running',
        percent: isDir ? 100 : 0,
        size: isDir ? 0 : Number(p.size) || 0,
        sizeText: isDir ? '—' : formatSize(p.size),
        sourcePath: p.sourcePath || '',
        targetPath: p.targetPath || '',
      });
      if (isDir) {
        row.children = [];
        this.dirWait(state, row);
      }
      this._rowByKey.set(this.childKey(row), row);
      return row;
    });
    parentRow.children = rows;
    return rows;
  },
  recalcFolder(parent, scanDone) {
    if (!parent || !(parent.isFolder || parent.isDir)) return parent;
    const files = this.folderFiles(parent);
    let size = 0;
    let transferred = 0;
    let speed = 0;
    let hasRun = false;
    let anyErr = false;
    let anyPause = false;
    let doneCount = 0;
    files.forEach((c) => {
      size += Number(c.size) || 0;
      transferred += Number(c.transferred) || 0;
      if (c.status === 'running') {
        hasRun = true;
        speed += Number(c.speed) || 0;
      } else if (c.status === 'error') anyErr = true;
      else if (c.status === 'paused') anyPause = true;
      if (c.status === 'done') doneCount += 1;
    });
    const settled =
      files.length > 0 &&
      files.every((c) => c.status === 'done' || c.status === 'error' || c.status === 'canceled');
    // While the scan is still running the totals are partial, so never report completion.
    const complete = parent.isFolder && scanDone === false ? false : settled || !files.length;
    parent.size = size;
    parent.transferred = transferred;
    parent.fileCount = files.length;
    parent.doneCount = doneCount;
    parent.percent = size > 0 ? Math.min(100, Math.round((transferred / size) * 100)) : complete ? 100 : 0;
    parent.sizeText = formatSize(size);
    parent.speedText = hasRun && speed > 0 ? `${formatSize(speed)}/s` : '—';
    if (complete) parent.status = anyErr ? 'error' : 'done';
    else if (anyPause && !hasRun) parent.status = 'paused';
    else parent.status = 'running';
    return parent;
  },
  /** Recalculate every folder node of a task tree, deepest first. */
  recalcTree(root) {
    const state = this.folderState(root && root.taskId);
    const scanDone = state ? state.done : true;
    const visit = (row, isRoot) => {
      (row.children || []).forEach((c) => {
        if (c && (c.isDir || c.isFolder)) visit(c, false);
      });
      if (row.isFolder || row.isDir) this.recalcFolder(row, isRoot ? scanDone : true);
    };
    if (root) visit(root, true);
    return root;
  },
  /** Remember expand state; folders stay collapsed until the user opens them */
  onExpandChange(row, expandedRows) {
    if (Array.isArray(expandedRows)) {
      this.expandedKeys = expandedRows.map((r) => (r && r.taskId) || null).filter(Boolean);
      return;
    }
    if (!row || !row.taskId) return;
    const id = row.taskId;
    if (this.expandedKeys.indexOf(id) >= 0) {
      this.expandedKeys = this.expandedKeys.filter((k) => k !== id);
    } else {
      this.expandedKeys = [...this.expandedKeys, id];
    }
  },
  collapseFolder(taskId) {
    if (!taskId) return;
    this.expandedKeys = this.expandedKeys.filter((k) => k !== taskId);
  },
  childKey(row) {
    return `${(row && row.sourcePath) || ''}|${(row && row.targetPath) || ''}`;
  },
  /** Progress events carry the main-process id; folder rows are keyed by their stable row id. */
  findFolderRow(p) {
    if (!p) return null;
    const byXfer = p.taskId ? this._rowByXferId.get(p.taskId) : null;
    if (byXfer) return byXfer;
    const key = this.childKey(p);
    return key === '|' ? null : this._rowByKey.get(key) || null;
  },
  mergeTask(p) {
    if (!p || !p.taskId) return;
    const row = this.findFolderRow(p);
    if (row) {
      // In-place update keeps the row identity the table cells already depend on.
      Object.assign(row, p, { taskId: row.taskId, isFolder: false, isDir: row.isDir, xferId: p.taskId });
      this._rowByXferId.set(p.taskId, row);
      const state = this.folderState(row.rootId);
      this.recalcTree(state ? state.root : row);
      return;
    }
    const i = this.tasks.findIndex((x) => x.taskId === p.taskId);
    const prev = i >= 0 ? this.tasks[i] : null;
    const merged = i >= 0 ? { ...this.tasks[i], ...p } : { ...p };
    if (i >= 0) this.$set(this.tasks, i, merged);
    else this.tasks.unshift(merged);
    if (merged.status === 'error' && (!prev || prev.status !== 'error')) {
      this.$message.error(`${merged.name}: ${merged.error || '传输失败'}`);
    }
    if (merged.status === 'done' && (!prev || prev.status !== 'done')) {
      this.refreshAfterDone(merged);
      this.tasks = this.tasks.filter((x) => !(x.taskId === merged.taskId && x.status === 'done'));
    }
  },
  refreshAfterDone(task) {
    if (!task) return;
    if (task.direction === 'upload') {
      const dir = parentRemote(task.targetPath);
      if (dir === this.remotePath) this.goRemote(this.remotePath);
    } else {
      const dir = parentLocal(task.targetPath);
      if (dir === this.localPath) this.goLocal(this.localPath);
    }
  },
  async syncTasks() {
    if (!api.sftpTasks) return;
    try {
      const list = unwrap(await api.sftpTasks());
      if (!Array.isArray(list)) return;
      const map = {};
      const keyMap = {};
      list.forEach((x) => {
        if (!x || !x.taskId) return;
        map[x.taskId] = x;
        keyMap[this.childKey(x)] = x;
      });
      // Folder trees are scanned incrementally: patch known rows instead of rebuilding them.
      this._folderStates.forEach((state) => {
        this.folderFiles(state.root).forEach((c) => {
          const m = (c.xferId && map[c.xferId]) || keyMap[this.childKey(c)];
          if (!m) return;
          Object.assign(c, m, { taskId: c.taskId, isDir: c.isDir, isFolder: false, xferId: m.taskId });
          if (m.taskId) this._rowByXferId.set(m.taskId, c);
        });
        this.recalcTree(state.root);
      });
      const childIds = new Set(this._rowByXferId.keys());
      const childKeys = new Set(this._rowByKey.keys());
      const next = [];
      const dropped = [];
      this.tasks.forEach((row) => {
        if (!row) return;
        if (row.isFolder) {
          const state = this.folderState(row.taskId);
          const keep = row.status !== 'done' || (state && !state.done);
          if (keep) next.push(row);
          else dropped.push(row);
          return;
        }
        if (childIds.has(row.taskId) || childKeys.has(this.childKey(row))) return;
        if (row.status === 'done') return;
        next.push(row);
      });
      dropped.forEach((row) => this.forgetFolderTree(row.taskId));
      const unchanged =
        next.length === this.tasks.length && next.every((row, i) => row === this.tasks[i]);
      if (!unchanged) this.tasks = next;
    } catch (_) {}
  },
  /** Pause the scan loop too, so queued files do not start while the folder is paused. */
  waitForResume(state) {
    return new Promise((resolve) => {
      const check = () => {
        if (!state || state.canceled || !state.paused) return resolve();
        setTimeout(check, 200);
      };
      check();
    });
  },
  async togglePause(task) {
    if (this.isTaskFinished(task)) return;
    const pause = task.status !== 'paused';
    try {
      if (task.isFolder) {
        const state = this.folderState(task.taskId);
        if (state) state.paused = pause;
        for (const c of this.folderFiles(task)) {
          if (!c.xferId) continue;
          try {
            unwrap(await api.sftpPause(c.xferId, pause));
            c.status = pause ? 'paused' : 'running';
          } catch (_) {}
        }
        task.status = pause ? 'paused' : 'running';
        this.recalcTree(task);
        this.syncTasks();
        return;
      }
      unwrap(await api.sftpPause(task.xferId || task.taskId, pause));
      this.mergeTask({ ...task, status: pause ? 'paused' : 'running' });
      this.syncTasks();
    } catch (e) {
      this.$message.error(e.message);
    }
  },
  async refreshListsAfterTaskRemove(task) {
    const dir = task && task.direction;
    const target = task && task.targetPath;
    if (dir === 'upload') {
      const pdir = target ? parentRemote(target) : this.remotePath;
      if (pdir === this.remotePath || (task && task.isFolder)) {
        if (this.connId) await this.goRemote(this.remotePath);
      }
    } else if (dir === 'download') {
      const pdir = target ? parentLocal(target) : this.localPath;
      if (pdir === this.localPath || (task && task.isFolder)) {
        await this.goLocal(this.localPath);
      }
    } else {
      await this.goLocal(this.localPath);
      if (this.connId) await this.goRemote(this.remotePath);
    }
  },
  async removeTask(task) {
    try {
      const unfinished = (row) => row && (row.status === 'running' || row.status === 'paused');
      if (task.isFolder) {
        const state = this.folderState(task.taskId);
        if (state) state.canceled = true;
        const files = this.folderFiles(task);
        for (const c of files) {
          if (!c.xferId) continue;
          try {
            unwrap(await api.sftpCancel(c.xferId));
          } catch (_) {}
        }
        for (const c of files) {
          if (!c.targetPath || !unfinished(c)) continue;
          if (c.direction === 'download' && api.sftpLocalUnlink) {
            try { await api.sftpLocalUnlink(c.targetPath, false); } catch (_) {}
          } else if (c.direction === 'upload' && this.connId && api.sftpUnlink) {
            try { await api.sftpUnlink(this.connId, c.targetPath, false); } catch (_) {}
          }
        }
        this.tasks = this.tasks.filter((x) => x.taskId !== task.taskId);
        this.collapseFolder(task.taskId);
        this.forgetFolderTree(task.taskId);
        await this.refreshListsAfterTaskRemove(task);
        this.syncTasks();
        return;
      }
      const wasUnfinished = unfinished(task);
      unwrap(await api.sftpCancel(task.xferId || task.taskId));
      if (wasUnfinished && task.targetPath) {
        if (task.direction === 'download' && api.sftpLocalUnlink) {
          try { await api.sftpLocalUnlink(task.targetPath, false); } catch (_) {}
        } else if (task.direction === 'upload' && this.connId && api.sftpUnlink) {
          try { await api.sftpUnlink(this.connId, task.targetPath, false); } catch (_) {}
        }
      }
      this.tasks = this.tasks.filter((x) => x.taskId !== task.taskId);
      if (wasUnfinished) await this.refreshListsAfterTaskRemove(task);
      this.syncTasks();
    } catch (e) {
      this.$message.error(e.message);
    }
  },
};
