import { api, unwrap } from '../../store';
import { formatSize, parentLocal, parentRemote, isTaskFinished } from './utils';

export default {
  isTaskFinished,
  recalcFolder(parent) {
    if (!parent || !parent.isFolder) return parent;
    const files = (parent.children || []).filter((c) => !c.isDir);
    let size = 0;
    let transferred = 0;
    let speed = 0;
    let hasRun = false;
    let anyErr = false;
    let anyPause = false;
    files.forEach((c) => {
      size += Number(c.size) || 0;
      transferred += Number(c.transferred) || 0;
      if (c.status === 'running') {
        hasRun = true;
        speed += Number(c.speed) || 0;
      } else if (c.status === 'error') anyErr = true;
      else if (c.status === 'paused') anyPause = true;
    });
    const allSettled =
      files.length > 0 &&
      files.every((c) => c.status === 'done' || c.status === 'error' || c.status === 'canceled');
    parent.size = size;
    parent.transferred = transferred;
    parent.percent =
      size > 0 ? Math.min(100, Math.round((transferred / size) * 100)) : allSettled ? 100 : 0;
    parent.sizeText = formatSize(size);
    parent.speedText = hasRun && speed > 0 ? `${formatSize(speed)}/s` : '—';
    if (allSettled) parent.status = anyErr ? 'error' : 'done';
    else if (anyPause && !hasRun) parent.status = 'paused';
    else parent.status = 'running';
    return parent;
  },
  /** Remember expand state; new folders expand once, manual collapse sticks */
  onExpandChange(row, expandedRows) {
    if (Array.isArray(expandedRows)) {
      this.expandedKeys = expandedRows
        .map((r) => (r && r.taskId) || null)
        .filter(Boolean);
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
  expandFolder(taskId) {
    if (!taskId) return;
    if (this.expandedKeys.indexOf(taskId) < 0) {
      this.expandedKeys = [...this.expandedKeys, taskId];
    }
  },
  collapseFolder(taskId) {
    if (!taskId) return;
    this.expandedKeys = this.expandedKeys.filter((k) => k !== taskId);
  },
  /** Collect ids/keys of files that belong under a folder task */
  folderChildIndex() {
    const ids = new Set();
    const keys = new Set();
    this.tasks.forEach((row) => {
      if (!row || !row.isFolder || !row.children) return;
      row.children.forEach((c) => {
        if (!c) return;
        if (c.taskId) ids.add(c.taskId);
        keys.add(`${c.sourcePath || ''}|${c.targetPath || ''}`);
      });
    });
    return { ids, keys };
  },
  childKey(row) {
    return `${(row && row.sourcePath) || ''}|${(row && row.targetPath) || ''}`;
  },
  findFolderChild(taskId, sourcePath, targetPath) {
    const key = `${sourcePath || ''}|${targetPath || ''}`;
    for (let i = 0; i < this.tasks.length; i++) {
      const parent = this.tasks[i];
      if (!parent || !parent.isFolder || !parent.children) continue;
      let ci = -1;
      if (taskId) ci = parent.children.findIndex((c) => c.taskId === taskId);
      if (ci < 0 && key !== '|') {
        ci = parent.children.findIndex((c) => `${c.sourcePath || ''}|${c.targetPath || ''}` === key);
      }
      if (ci >= 0) return { parent, index: ci };
    }
    return null;
  },
  mergeTask(p) {
    if (!p || !p.taskId) return;
    const hit = this.findFolderChild(p.taskId, p.sourcePath, p.targetPath);
    if (hit) {
      const parent = hit.parent;
      const merged = { ...parent.children[hit.index], ...p, parentId: parent.taskId, isFolder: false };
      const next = parent.children.slice();
      next.splice(hit.index, 1, merged);
      this.$set(parent, 'children', next);
      this.recalcFolder(parent);
      return;
    }
    const { ids, keys } = this.folderChildIndex();
    // progress for a known folder file — never promote to top-level
    if (ids.has(p.taskId) || keys.has(this.childKey(p))) return;
    const i = this.tasks.findIndex((x) => x.taskId === p.taskId);
    const prev = i >= 0 ? this.tasks[i] : null;
    const merged = i >= 0 ? { ...this.tasks[i], ...p } : { ...p };
    if (merged.isFolder && merged.children) {
      if (i >= 0) this.$set(this.tasks, i, merged);
      else this.tasks.unshift(merged);
      this.recalcFolder(merged);
      return;
    }
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
      const childIds = new Set();
      const childKeys = new Set();
      const next = [];
      this.tasks.forEach((row) => {
        if (row && row.isFolder && row.children) {
          const kids = row.children.map((c) => {
            const m = map[c.taskId] || keyMap[this.childKey(c)] || null;
            const merged = m ? { ...c, ...m, parentId: row.taskId, isFolder: false } : { ...c, parentId: row.taskId };
            if (merged.taskId) childIds.add(merged.taskId);
            childKeys.add(this.childKey(merged));
            return merged;
          });
          const folder = { ...row, children: kids, isFolder: true };
          this.recalcFolder(folder);
          if (folder.status !== 'done') next.push(folder);
          return;
        }
      });
      // top-level: only non-child, non-done rows
      this.tasks.forEach((row) => {
        if (!row || row.isFolder) return;
        if (childIds.has(row.taskId) || childKeys.has(this.childKey(row))) return;
        if (row.status === 'done') return;
        next.push(row);
      });
      this.tasks = next.filter((row) => {
        if (row.isFolder) return row.status !== 'done';
        return row.status !== 'done' && !childIds.has(row.taskId) && !childKeys.has(this.childKey(row));
      });
    } catch (_) {}
  },
  async togglePause(task) {
    if (this.isTaskFinished(task)) return;
    const pause = task.status !== 'paused';
    try {
      if (task.isFolder && task.children && task.children.length) {
        for (const c of task.children) {
          if (c.isDir || !c.taskId) continue;
          try {
            unwrap(await api.sftpPause(c.taskId, pause));
            c.status = pause ? 'paused' : 'running';
          } catch (_) {}
        }
        this.$set(task, 'status', pause ? 'paused' : 'running');
        this.recalcFolder(task);
        this.syncTasks();
        return;
      }
      unwrap(await api.sftpPause(task.taskId, pause));
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
      if (task.isFolder && task.children && task.children.length) {
        for (const c of task.children) {
          if (c.isDir || !c.taskId) continue;
          try { unwrap(await api.sftpCancel(c.taskId)); } catch (_) {}
        }
        for (const c of task.children) {
          if (c.isDir || !c.targetPath) continue;
          if (!unfinished(c)) continue;
          if (c.direction === 'download' && api.sftpLocalUnlink) {
            try { await api.sftpLocalUnlink(c.targetPath, false); } catch (_) {}
          } else if (c.direction === 'upload' && this.connId && api.sftpUnlink) {
            try { await api.sftpUnlink(this.connId, c.targetPath, false); } catch (_) {}
          }
        }
        this.tasks = this.tasks.filter((x) => x.taskId !== task.taskId);
        this.collapseFolder(task.taskId);
        await this.refreshListsAfterTaskRemove(task);
        this.syncTasks();
        return;
      }
      const wasUnfinished = unfinished(task);
      unwrap(await api.sftpCancel(task.taskId));
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
