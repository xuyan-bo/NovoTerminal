import Vue from 'vue';
import { api, unwrap, connectionErrorMessage } from '../../store';
import { t } from '../../i18n';
import { formatSize, parentLocal, parentRemote, isTaskFinished, transferErrorText } from './utils';

/** Folder totals are only worth recomputing a few times per second, not per progress event. */
const RECALC_THROTTLE_MS = 400;

/** 完成提示合批窗口：多选上传、编辑器连续回传都不该逐条刷屏。 */
const DONE_TOAST_MS = 1200;

/**
 * Task rows live in their own session (`s.tasks`), because progress events keep arriving for
 * background sessions while the user reads another tab. The queue table itself is shared, so the
 * four table-facing entry points below resolve the owning session from the row's folder `rootId`
 * or from the task list it sits in — never from `connId`, which changes on a reconnect.
 */
export default {
  isTaskFinished,
  /** Rows are rendered lazily and updated in place, so they must be observable on their own. */
  makeTaskRow(s, fields) {
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
          // 公用队列里每一行要标明所属会话，并按提交时间倒序排列
          sessionName: s ? s.label : '',
          createdAt: Date.now(),
        },
        fields
      )
    );
  },
  folderState(s, rootId) {
    return (s && s.folderStates.get(rootId)) || null;
  },
  /** A folder task shows up in the queue before anything is enumerated. */
  registerFolderRoot(s, root) {
    s.folderStates.set(root.taskId, {
      root,
      rootId: root.taskId,
      done: false,
      canceled: false,
      paused: false,
      dirs: new Map(),
    });
    this.dirWait(this.folderState(s, root.taskId), root);
    s.tasks = [root, ...s.tasks];
  },
  forgetFolderTree(s, rootId) {
    const state = s.folderStates.get(rootId);
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
      s.rowByKey.delete(this.childKey(row));
      if (row.xferId) s.rowByXferId.delete(row.xferId);
      (row.children || []).forEach(drop);
    };
    drop(state.root);
    s.folderStates.delete(rootId);
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
  markDirScanned(s, rootId, row) {
    const entry = this.dirWait(this.folderState(s, rootId), row);
    if (entry && !entry.done) {
      entry.done = true;
      entry.resolve((row.children || []).slice());
    }
  },
  /** Progress events carry the main-process id, row keys stay stable. */
  bindTransfer(s, row, xferId) {
    if (!row || !xferId) return;
    row.xferId = xferId;
    s.rowByXferId.set(xferId, row);
  },
  finishFolderScan(s, root) {
    const state = this.folderState(s, root && root.taskId);
    if (!state || state.canceled) return;
    state.done = true;
    this.recalcTree(s, root);
    this.syncTasks(s);
  },
  /** Element asks for a node's children only when the user expands it. */
  loadTreeChildren(row, treeNode, resolve) {
    const kids = (row && row.children) || [];
    const s = this.sessionOf(row);
    if (!s) {
      resolve(kids.slice());
      return;
    }
    const state = this.folderState(s, (row && row.rootId) || (row && row.taskId));
    const entry = state ? this.dirWait(state, row) : null;
    if (!entry || entry.done) {
      resolve(kids.slice());
      return;
    }
    entry.promise.then(() => {
      if (!s.alive) return;
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
  addDiscoveredChildren(s, root, parentRow, entries, direction, pathOf) {
    const state = this.folderState(s, root.taskId);
    const rows = (entries || []).map((entry) => {
      const p = pathOf(entry) || {};
      const isDir = !!entry.isDir;
      const row = this.makeTaskRow(s, {
        // Stable row key: the transfer id from the main process lands in xferId instead.
        taskId: `${root.taskId}:${isDir ? 'd' : 'c'}:${p.targetPath || entry.name}`,
        rootId: root.taskId,
        parentId: parentRow.taskId,
        name: entry.name,
        isDir,
        hasChildren: isDir,
        direction,
        status: isDir ? 'done' : 'queued',
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
      s.rowByKey.set(this.childKey(row), row);
      return row;
    });
    parentRow.children = rows;
    return rows;
  },
  /** Coalesce tree recomputation; a folder scan can produce thousands of updates per second. */
  scheduleRecalc(s, root) {
    if (!root) return;
    s.recalcPending.add(root);
    if (s.recalcTimer) return;
    s.recalcTimer = setTimeout(() => {
      s.recalcTimer = null;
      if (!s.alive) return;
      const roots = Array.from(s.recalcPending);
      s.recalcPending.clear();
      roots.forEach((r) => this.recalcTree(s, r));
    }, RECALC_THROTTLE_MS);
  },
  recalcFolder(parent, scanDone, paused) {
    if (!parent || !(parent.isFolder || parent.isDir)) return parent;
    const files = this.folderFiles(parent);
    let size = 0;
    let transferred = 0;
    let speed = 0;
    let hasRun = false;
    let anyErr = false;
    let anyPause = false;
    let anyCancel = false;
    let doneCount = 0;
    files.forEach((c) => {
      size += Number(c.size) || 0;
      transferred += Number(c.transferred) || 0;
      if (c.status === 'running') {
        hasRun = true;
        speed += Number(c.speed) || 0;
      } else if (c.status === 'error') anyErr = true;
      else if (c.status === 'paused') anyPause = true;
      else if (c.status === 'canceled') anyCancel = true;
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
    // 全部取消不能伪装成完成，否则会触发「原地刷新」并显示成 100%
    if (complete) parent.status = anyErr ? 'error' : anyCancel ? 'canceled' : 'done';
    else if ((anyPause || paused) && !hasRun) parent.status = 'paused';
    else parent.status = 'running';
    return parent;
  },
  /** Recalculate every folder node of a task tree, deepest first. */
  recalcTree(s, root) {
    const state = this.folderState(s, root && root.taskId);
    if (state && state.canceled) return root;
    const scanDone = state ? state.done : true;
    const paused = !!(state && state.paused);
    const visit = (row, isRoot) => {
      (row.children || []).forEach((c) => {
        if (c && (c.isDir || c.isFolder)) visit(c, false);
      });
      if (row.isFolder || row.isDir) this.recalcFolder(row, isRoot ? scanDone : true, isRoot ? paused : false);
    };
    if (root) visit(root, true);
    // 整棵文件夹树跑完后按当前显示的目录原地刷新一次：不跳转，也不逐个文件刷新
    if (root && root.isFolder && root.status === 'done' && !root.panelRefreshed) {
      root.panelRefreshed = true;
      this.notifyTaskDone(root.name);
      this.refreshAfterDone(s, root);
    }
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
  /** 把一行从文件夹树里摘掉：没提交给主进程的子行只有这样才会真正停止上传。 */
  dropChildRow(s, row) {
    if (!s || !row) return;
    row.dropped = true;
    const state = this.folderState(s, row.rootId);
    if (!state) return;
    const remove = (r) => {
      const kids = r.children || [];
      const i = kids.indexOf(row);
      if (i >= 0) {
        kids.splice(i, 1);
        return true;
      }
      return kids.some(remove);
    };
    remove(state.root);
    s.rowByKey.delete(this.childKey(row));
    if (row.xferId) s.rowByXferId.delete(row.xferId);
    this.scheduleRecalc(s, state.root);
  },
  childKey(row) {
    return `${(row && row.sourcePath) || ''}|${(row && row.targetPath) || ''}`;
  },
  /** Progress events carry the main-process id; folder rows are keyed by their stable row id. */
  findFolderRow(s, p) {
    if (!p) return null;
    const byXfer = p.taskId ? s.rowByXferId.get(p.taskId) : null;
    if (byXfer) return byXfer;
    const key = this.childKey(p);
    return key === '|' ? null : s.rowByKey.get(key) || null;
  },
  mergeTask(s, p) {
    if (!s || !s.alive || !p || !p.taskId) return;
    // 主进程事件负载没有 xferId 字段，它的 taskId 才是传输 id；行对象自带 xferId，taskId 是渲染端 row-key
    const fromEvent = !Object.prototype.hasOwnProperty.call(p, 'xferId');
    const row = this.findFolderRow(s, p);
    if (row) {
      // In-place update keeps the row identity the table cells already depend on.
      Object.assign(row, p, {
        taskId: row.taskId,
        isFolder: false,
        isDir: row.isDir,
        xferId: fromEvent ? p.taskId : row.xferId,
      });
      if (fromEvent) s.rowByXferId.set(p.taskId, row);
      const state = this.folderState(s, row.rootId);
      this.scheduleRecalc(s, state ? state.root : row);
      return;
    }
    const i = s.tasks.findIndex((x) => x.taskId === p.taskId);
    const prev = i >= 0 ? s.tasks[i] : null;
    const merged =
      i >= 0
        ? { ...s.tasks[i], ...p }
        : { ...p, sessionName: s.label, createdAt: Date.now() };
    if (i >= 0) s.tasks.splice(i, 1, merged);
    else s.tasks.unshift(merged);
    if (merged.status === 'error' && (!prev || prev.status !== 'error')) {
      this.$message.error(`${merged.name}: ${transferErrorText(merged)}`);
    }
    if (merged.status === 'done' && (!prev || prev.status !== 'done')) {
      this.notifyTaskDone(merged.name);
      this.refreshAfterDone(s, merged);
      s.tasks = s.tasks.filter((x) => !(x.taskId === merged.taskId && x.status === 'done'));
    }
  },
  /** 完成提示合批：窗口内累计条数，只发一条，单项时仍报名字。 */
  notifyTaskDone(name) {
    this._doneNames.push(name);
    if (this._doneToastTimer) return;
    this._doneToastTimer = setTimeout(() => {
      this._doneToastTimer = null;
      const names = this._doneNames;
      this._doneNames = [];
      this.$message.success(
        names.length === 1
          ? t('sftp.taskDone', { name: names[0] })
          : t('sftp.taskDoneMulti', { count: names.length })
      );
    }, DONE_TOAST_MS);
  },
  refreshAfterDone(s, task) {
    if (!task) return;
    if (task.direction === 'upload') {
      const dir = parentRemote(task.targetPath);
      if (dir === s.remotePath) this.goRemote(s, s.remotePath);
    } else {
      const dir = parentLocal(task.targetPath);
      // The local panel is shared, so a background session must not navigate it out from under
      // the user; the row itself already shows completion.
      if (s === this.s && dir === this.localPath) this.goLocal(this.localPath);
    }
  },
  async syncTasks(s) {
    if (!s || !s.connId || !api.sftpTasks) return;
    const connId = s.connId;
    try {
      const list = unwrap(await api.sftpTasks(connId));
      if (!s.alive || s.connId !== connId) return;
      if (!Array.isArray(list)) return;
      const map = {};
      const keyMap = {};
      list.forEach((x) => {
        if (!x || !x.taskId) return;
        map[x.taskId] = x;
        keyMap[this.childKey(x)] = x;
      });
      // Folder trees are scanned incrementally: patch known rows instead of rebuilding them.
      s.folderStates.forEach((state) => {
        this.folderFiles(state.root).forEach((c) => {
          const m = (c.xferId && map[c.xferId]) || keyMap[this.childKey(c)];
          if (!m) return;
          Object.assign(c, m, { taskId: c.taskId, isDir: c.isDir, isFolder: false, xferId: m.taskId });
          if (m.taskId) s.rowByXferId.set(m.taskId, c);
        });
        this.scheduleRecalc(s, state.root);
      });
      const childIds = new Set(s.rowByXferId.keys());
      const childKeys = new Set(s.rowByKey.keys());
      const next = [];
      const dropped = [];
      s.tasks.forEach((row) => {
        if (!row) return;
        if (row.isFolder) {
          const state = this.folderState(s, row.taskId);
          const keep = row.status !== 'done' || (state && !state.done);
          if (keep) next.push(row);
          else dropped.push(row);
          return;
        }
        if (childIds.has(row.taskId) || childKeys.has(this.childKey(row))) return;
        if (row.status === 'done') return;
        next.push(row);
      });
      dropped.forEach((row) => this.forgetFolderTree(s, row.taskId));
      const unchanged =
        next.length === s.tasks.length && next.every((row, i) => row === s.tasks[i]);
      if (!unchanged) s.tasks = next;
      s.syncFailed = false;
    } catch (e) {
      // 这条每秒轮询只在刚坏和修好时各记一次，否则一次 IPC 故障会把日志刷满
      if (s && !s.syncFailed) {
        s.syncFailed = true;
        api.logWrite?.({
          level: 'warn',
          source: 'sftp',
          message: 'sftp task poll failed',
          meta: { connId, code: e.code || 'ERROR', message: e.message || String(e) },
        })?.catch(() => {});
      }
    }
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
  /**
   * 连接没了就不会再有进度事件（进度按 connId 路由）：把这条会话未完成的行就地判成已取消，
   * 否则队列会一直挂着「传输中」。
   */
  markTasksCanceled(s) {
    if (!s) return;
    const rows = s.tasks.slice();
    s.folderStates.forEach((state) => {
      // 先给扫描与重算发收口信号：否则排队中的 recalc 会把刚判成取消的行改回「传输中」
      state.canceled = true;
      state.paused = false;
      rows.push(state.root);
      this.folderFiles(state.root).forEach((c) => rows.push(c));
    });
    rows.forEach((row) => {
      if (!row || this.isTaskFinished(row)) return;
      row.status = 'canceled';
      row.speedText = '—';
    });
  },
  async togglePause(task) {
    if (this.isTaskFinished(task)) return;
    const s = this.sessionOf(task);
    if (!s) return;
    const pause = task.status !== 'paused';
    try {
      if (task.isFolder) {
        const state = this.folderState(s, task.taskId);
        if (state) state.paused = pause;
        const rows = this.folderFiles(task).filter((c) => c.xferId && !this.isTaskFinished(c));
        const ids = rows.map((c) => c.xferId);
        if (ids.length) {
          if (api.sftpPauseBatch) unwrap(await api.sftpPauseBatch(ids, pause));
          else for (const id of ids) { try { unwrap(await api.sftpPause(id, pause)); } catch (_) {} }
          rows.forEach((c) => {
            // Resumed children wait for a transfer slot; the running transition arrives as an event
            c.status = pause ? 'paused' : 'queued';
          });
        }
        task.status = pause ? 'paused' : 'running';
        this.recalcTree(s, task);
        this.syncTasks(s);
        return;
      }
      const state = task.rootId ? this.folderState(s, task.rootId) : null;
      if (!task.xferId && state) {
        // Not submitted yet: the only meaningful pause is the folder's scan gate
        state.paused = pause;
        task.status = pause ? 'paused' : 'queued';
        this.recalcTree(s, state.root);
        this.syncTasks(s);
        return;
      }
      const r = unwrap(await api.sftpPause(task.xferId || task.taskId, pause));
      if (!r || !r.ok) {
        this.syncTasks(s);
        return;
      }
      this.mergeTask(s, { ...task, status: r.status || (pause ? 'paused' : 'running') });
      this.syncTasks(s);
    } catch (e) {
      this.$message.error(connectionErrorMessage(e));
    }
  },
  async refreshListsAfterTaskRemove(s, task) {
    const dir = task && task.direction;
    const target = task && task.targetPath;
    if (dir === 'upload') {
      const pdir = target ? parentRemote(target) : s.remotePath;
      if (pdir === s.remotePath || (task && task.isFolder)) {
        if (s.connId) await this.goRemote(s, s.remotePath);
      }
    } else if (dir === 'download') {
      const pdir = target ? parentLocal(target) : this.localPath;
      if (pdir === this.localPath || (task && task.isFolder)) {
        await this.goLocal(this.localPath);
      }
    } else {
      await this.goLocal(this.localPath);
      if (s.connId) await this.goRemote(s, s.remotePath);
    }
  },
  async removeTask(task) {
    const s = this.sessionOf(task);
    if (!s) return;
    try {
      const unfinished = (row) => row && (row.status === 'running' || row.status === 'paused');
      if (task.isFolder) {
        const state = this.folderState(s, task.taskId);
        if (state) state.canceled = true;
        const ids = this.folderFiles(task)
          .filter((c) => c.xferId)
          .map((c) => c.xferId);
        if (ids.length) {
          // Cancelling a subtree must not serialize one round trip per file
          if (api.sftpCancelBatch) unwrap(await api.sftpCancelBatch(ids));
          else for (const id of ids) { try { unwrap(await api.sftpCancel(id)); } catch (_) {} }
        }
        s.tasks = s.tasks.filter((x) => x.taskId !== task.taskId);
        this.collapseFolder(task.taskId);
        this.forgetFolderTree(s, task.taskId);
        await this.refreshListsAfterTaskRemove(s, task);
        this.syncTasks(s);
        return;
      }
      const wasUnfinished = unfinished(task);
      // 半截目标文件由主进程在取消时一并删除，渲染端不再重复删一次
      if (task.xferId) unwrap(await api.sftpCancel(task.xferId));
      if (task.rootId) {
        // 子行不在 s.tasks 里：还没提交给主进程的行只能靠摘出树来阻止扫描循环继续上传
        this.dropChildRow(s, task);
        if (wasUnfinished) await this.refreshListsAfterTaskRemove(s, task);
        this.syncTasks(s);
        return;
      }
      if (!task.xferId) unwrap(await api.sftpCancel(task.taskId));
      s.tasks = s.tasks.filter((x) => x.taskId !== task.taskId);
      if (wasUnfinished) await this.refreshListsAfterTaskRemove(s, task);
      this.syncTasks(s);
    } catch (e) {
      this.$message.error(connectionErrorMessage(e));
    }
  },
};
