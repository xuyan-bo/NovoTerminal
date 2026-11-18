import { reactive } from 'vue';
import { api, unwrap, connectionErrorMessage } from '../../store';
import { t } from '../../i18n';
import { formatSize, parentLocal, parentRemote, isTaskFinished, transferErrorText } from './utils';

/** Folder totals are only worth recomputing a few times per second, not per progress event. */
const RECALC_THROTTLE_MS = 400;

/** 完成提示合批窗口：多选上传的小文件完成事件毫秒级连续到达，短窗口足够收拢成一条。 */
const DONE_TOAST_MS = 300;

/** 删除子树后继续拦截其晚到事件的窗口；主进程取消时已从 Map 删除任务，不会有更晚的事件。 */
const IGNORE_EVENT_MS = 5000;

/** 中间进度合批窗口：拉长窗口以合并并发行的进度写入，减少表格响应式重渲染次数；终态事件仍即时应用。 */
const PROGRESS_FLUSH_MS = 250;

/** 文件夹速率的采样窗口：足够长以抹平逐帧抖动，又短于小文件的完成时间。 */
const SPEED_WINDOW_MS = 300;

/** 完成后目录刷新的合批窗口：一批小文件完成后只列一次目录，而不是每个文件列一次。 */
const REFRESH_AFTER_DONE_MS = 600;

/** 传输期间推迟刷新的最长等待：避免个别长任务让新文件迟迟不出现，到点强制刷一次。 */
const REFRESH_MAX_WAIT_MS = 5000;

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
    return reactive(
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
  /** 删除/停传后立起屏障：晚到的取消与进度事件必须丢弃，否则会被 mergeTask 当成新任务打平回列表。 */
  ignoreXfer(s, ids) {
    if (!s || !ids || !ids.length) return;
    if (!s.ignoredXferIds) s.ignoredXferIds = new Set();
    ids.forEach((id) => id && s.ignoredXferIds.add(id));
    setTimeout(() => {
      ids.forEach((id) => s.ignoredXferIds && s.ignoredXferIds.delete(id));
    }, IGNORE_EVENT_MS);
  },
  isIgnoredEvent(s, p) {
    if (!s || !p) return false;
    return !!(p.taskId && s.ignoredXferIds && s.ignoredXferIds.has(p.taskId));
  },
  /** 只写值真正变化的字段：跳过 reactive setter 调用，避免触发表格单元格的重复渲染 effect。 */
  assignRow(row, patch) {
    for (const key in patch) {
      if (row[key] !== patch[key]) row[key] = patch[key];
    }
  },
  /** 进度按 taskId 合批：一个计时窗口内只保留最新值，减少表格重渲染与整树重算次数。 */
  queueProgress(s, p) {
    if (!s || !s.alive || !p || !p.taskId) return;
    if (this.isTaskFinished(p)) {
      this.flushProgress(s);
      this.mergeTask(s, p);
      return;
    }
    s.progressBuffer.set(p.taskId, p);
    if (s.progressFlush) return;
    s.progressFlush = setTimeout(() => {
      s.progressFlush = null;
      if (!s.alive) return;
      const pending = Array.from(s.progressBuffer.values());
      s.progressBuffer.clear();
      pending.forEach((item) => this.mergeTask(s, item));
    }, PROGRESS_FLUSH_MS);
  },
  flushProgress(s) {
    if (!s || !s.alive) return;
    if (s.progressFlush) {
      clearTimeout(s.progressFlush);
      s.progressFlush = null;
    }
    if (!s.progressBuffer || !s.progressBuffer.size) return;
    const pending = Array.from(s.progressBuffer.values());
    s.progressBuffer.clear();
    pending.forEach((item) => this.mergeTask(s, item));
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
    let size = 0;
    let transferred = 0;
    let childSpeed = 0;
    let hasRun = false;
    let anyErr = false;
    let anyPause = false;
    let anyCancel = false;
    let doneCount = 0;
    let fileCount = 0;
    let settledChildren = true;
    (parent.children || []).forEach((c) => {
      if (!c) return;
      size += Number(c.size) || 0;
      transferred += Number(c.transferred) || 0;
      if (c.isDir || c.isFolder) {
        const agg = c._agg || {};
        fileCount += Number(c.fileCount) || 0;
        doneCount += Number(c.doneCount) || 0;
        childSpeed += Number(agg.speed) || 0;
        if (agg.hasRun) hasRun = true;
        if (agg.anyErr) anyErr = true;
        if (agg.anyPause) anyPause = true;
        if (agg.anyCancel) anyCancel = true;
        if (!agg.settled) settledChildren = false;
      } else {
        fileCount += 1;
        if (c.status === 'running') {
          hasRun = true;
          childSpeed += Number(c.speed) || 0;
        } else if (c.status === 'error') anyErr = true;
        else if (c.status === 'paused') anyPause = true;
        else if (c.status === 'canceled') anyCancel = true;
        if (c.status === 'done') doneCount += 1;
        if (!(c.status === 'done' || c.status === 'error' || c.status === 'canceled')) settledChildren = false;
      }
    });
    const settled = fileCount > 0 && settledChildren;
    // While the scan is still running the totals are partial, so never report completion.
    const complete = parent.isFolder && scanDone === false ? false : settled || !fileCount;
    // 文件夹速率取这段时间窗口内的总吞吐，不依赖子文件恰好落在主进程的采样点上——小文件几十毫秒
    // 就完成了，子行 speed 常为 0，只有按已完成字节增量算，父级才会稳定显示速率。
    const now = Date.now();
    const prev = parent._speedWindow;
    let speed = 0;
    if (!prev) {
      parent._speedWindow = { t: now, transferred };
    } else if (now - prev.t >= SPEED_WINDOW_MS) {
      const delta = transferred - prev.transferred;
      if (delta > 0) speed = (delta / (now - prev.t)) * 1000;
      parent._speedWindow = { t: now, transferred };
    }
    if (speed <= 0 && hasRun && childSpeed > 0) speed = childSpeed;
    parent.size = size;
    parent.transferred = transferred;
    parent.fileCount = fileCount;
    parent.doneCount = doneCount;
    parent.percent = size > 0 ? Math.min(100, Math.round((transferred / size) * 100)) : complete ? 100 : 0;
    parent.sizeText = formatSize(size);
    parent.speedText = speed > 0 ? `${formatSize(speed)}/s` : '—';
    parent._agg = { speed, hasRun, anyErr, anyPause, anyCancel, settled };
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
    if (row.xferId) this.ignoreXfer(s, [row.xferId]);
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
    // 删掉的树在取消/IPC 收尾期间仍会有晚到事件；命中屏障就丢弃，绝不能新建顶层行把它「打平」出来
    if (this.isIgnoredEvent(s, p)) return;
    // 主进程事件负载没有 xferId 字段，它的 taskId 才是传输 id；行对象自带 xferId，taskId 是渲染端 row-key
    const fromEvent = !Object.prototype.hasOwnProperty.call(p, 'xferId');
    const row = this.findFolderRow(s, p);
    if (row) {
      // In-place update keeps the row identity the table cells already depend on.
      this.assignRow(row, Object.assign({}, p, {
        taskId: row.taskId,
        isFolder: false,
        isDir: row.isDir,
        xferId: fromEvent ? p.taskId : row.xferId,
      }));
      if (fromEvent) s.rowByXferId.set(p.taskId, row);
      const state = this.folderState(s, row.rootId);
      this.scheduleRecalc(s, state ? state.root : row);
      return;
    }
    // 独立文件任务：用 id→行 映射 O(1) 命中后就地更新，不再 findIndex + splice 重建 s.tasks
    // ——那会让 queueTasks computed 失效并触发整张表格重排，几百个小文件下足以占满主线程。
    let standalone = s.standaloneById.get(p.taskId);
    if (!standalone) {
      standalone = this.makeTaskRow(s, {
        ...p,
        sessionName: s.label,
        xferId: fromEvent ? p.taskId : p.xferId,
      });
      s.standaloneById.set(p.taskId, standalone);
      // 批量合入 s.tasks：每个文件开始就 unshift 一行会让 queueTasks 重算 + el-table 全表重渲染，
      // 几百个小文件下这是 renderCell 热点的主要来源。先放缓冲，按帧一次性合入。
      s.pendingAdd.push(standalone);
      this.scheduleStandaloneAdd(s);
    } else {
      this.assignRow(standalone, Object.assign({}, p, { xferId: fromEvent ? p.taskId : standalone.xferId }));
    }
    if (standalone.status === 'error' && !standalone._errorNoted) {
      standalone._errorNoted = true;
      this.$message.error(`${standalone.name}: ${transferErrorText(standalone)}`);
    }
    if (standalone.status === 'done' && !standalone._doneNoted) {
      standalone._doneNoted = true;
      this.notifyTaskDone(standalone.name);
      this.refreshAfterDone(s, standalone);
      this.scheduleStandalonePrune(s, standalone);
    }
  },
  /** 新增的独立任务按帧批量合入 s.tasks：几百个文件只触发几次数组变更，而不是每行一次全表重排。 */
  scheduleStandaloneAdd(s) {
    if (s.addTimer) return;
    s.addTimer = setTimeout(() => {
      s.addTimer = null;
      if (!s.alive || !s.pendingAdd.length) return;
      const adding = s.pendingAdd;
      s.pendingAdd = [];
      // 已在缓冲期就完成并被 prune 的行不再入表
      const fresh = adding.filter((r) => !r._doneNoted && !this.isTaskFinished(r));
      if (fresh.length) s.tasks.unshift(...fresh);
    }, PROGRESS_FLUSH_MS);
  },
  /** 完成/取消的独立任务合批移除：避免每行一次 filter 重建整个 s.tasks 数组。 */
  scheduleStandalonePrune(s, row) {
    s.pendingDone.add(row);
    if (s.pruneTimer) return;
    s.pruneTimer = setTimeout(() => {
      s.pruneTimer = null;
      if (!s.alive || !s.pendingDone.size) return;
      const done = s.pendingDone;
      s.pendingDone = new Set();
      done.forEach((r) => s.standaloneById.delete(r.xferId || r.taskId));
      if (s.pendingAdd.length) s.pendingAdd = s.pendingAdd.filter((r) => !done.has(r));
      s.tasks = s.tasks.filter((x) => !done.has(x));
    }, DONE_TOAST_MS);
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
  /**
   * 完成后刷新所在目录：合并一批完成事件只列一次目录。原先每个文件完成都 goRemote 一次，
   * 几百个小文件就是几百次 sftpList 网络往返 + 整表重建，既占主线程又用 remoteLoading
   * 把用户主动双击的导航挡掉——这才是「传输中双击文件夹卡死」的设计层根因。
   */
  refreshAfterDone(s, task) {
    if (!task || !s) return;
    let side = null;
    let dir = null;
    if (task.direction === 'upload') {
      dir = parentRemote(task.targetPath);
      if (dir === s.remotePath) side = 'remote';
    } else {
      dir = parentLocal(task.targetPath);
      // 本机面板由所有会话共享，后台会话绝不能把用户正在看的目录导航走
      if (s === this.s && dir === this.localPath) side = 'local';
    }
    if (!side) return;
    if (!s.refreshDirs) s.refreshDirs = { remote: false, local: false };
    s.refreshDirs[side] = true;
    if (s.refreshTimer) return;
    s.refreshStartedAt = s.refreshStartedAt || Date.now();
    const tick = () => {
      s.refreshTimer = null;
      if (!s.alive || !s.refreshDirs) return;
      // 传输还在继续就推迟刷新：几百个小文件期间文件列表保持静止，双击浏览零干扰。
      // 用最长等待兜底，避免个别长任务导致新文件一直不出现。
      const busy = this.hasActiveTransfer(s);
      const waited = Date.now() - s.refreshStartedAt;
      if (busy && waited < REFRESH_MAX_WAIT_MS) {
        s.refreshTimer = setTimeout(tick, REFRESH_AFTER_DONE_MS);
        return;
      }
      s.refreshStartedAt = 0;
      const want = s.refreshDirs;
      s.refreshDirs = { remote: false, local: false };
      // 用户正在手动导航时跳过这一批后台刷新，避免和双击抢同一个 remoteLoading 闸门
      if (want.remote && !s.remoteLoading) this.goRemote(s, s.remotePath);
      if (want.local && !this.localLoading) this.goLocal(this.localPath);
    };
    s.refreshTimer = setTimeout(tick, REFRESH_AFTER_DONE_MS);
  },
  /** 是否还有未完成的传输；刚完成但还在等待合批移除的行不算。 */
  hasActiveTransfer(s) {
    const active = s.tasks.some((t) => {
      if (!t || s.pendingDone.has(t)) return false;
      if (t.isFolder) return t.status === 'running' || t.status === 'paused' || t.status === 'queued';
      return !this.isTaskFinished(t);
    });
    if (active) return true;
    let folderActive = false;
    s.folderStates.forEach((st) => {
      if (!st.done && !st.canceled) folderActive = true;
    });
    return folderActive;
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
          this.assignRow(c, Object.assign({}, m, { taskId: c.taskId, isDir: c.isDir, isFolder: false, xferId: m.taskId }));
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
    this.flushProgress(s);
    try {
      const unfinished = (row) => row && (row.status === 'running' || row.status === 'paused');
      if (task.isFolder) {
        const state = this.folderState(s, task.taskId);
        if (state) state.canceled = true;
        const ids = this.folderFiles(task)
          .filter((c) => c.xferId)
          .map((c) => c.xferId);
        // 先立屏障再取消：主进程 cancel 会同步发出每条子任务的 canceled 进度事件，
        // 这些事件若在 forgetFolderTree 清映射之后到达，就会被 mergeTask 当成新任务打平回列表。
        this.ignoreXfer(s, ids);
        s.tasks = s.tasks.filter((x) => x.taskId !== task.taskId);
        this.collapseFolder(task.taskId);
        this.forgetFolderTree(s, task.taskId);
        if (ids.length) {
          // Cancelling a subtree must not serialize one round trip per file
          if (api.sftpCancelBatch) unwrap(await api.sftpCancelBatch(ids));
          else for (const id of ids) { try { unwrap(await api.sftpCancel(id)); } catch (_) {} }
        }
        await this.refreshListsAfterTaskRemove(s, task);
        this.syncTasks(s);
        return;
      }
      const wasUnfinished = unfinished(task);
      // 半截目标文件由主进程在取消时一并删除，渲染端不再重复删一次
      if (task.xferId) this.ignoreXfer(s, [task.xferId]);
      if (task.xferId) unwrap(await api.sftpCancel(task.xferId));
      if (task.rootId) {
        // 子行不在 s.tasks 里：还没提交给主进程的行只能靠摘出树来阻止扫描循环继续上传
        this.dropChildRow(s, task);
        if (wasUnfinished) await this.refreshListsAfterTaskRemove(s, task);
        this.syncTasks(s);
        return;
      }
      if (!task.xferId) this.ignoreXfer(s, [task.taskId]);
      if (!task.xferId) unwrap(await api.sftpCancel(task.taskId));
      s.standaloneById.delete(task.xferId || task.taskId);
      s.pendingDone.delete(task);
      if (s.pendingAdd.length) s.pendingAdd = s.pendingAdd.filter((r) => r !== task);
      s.tasks = s.tasks.filter((x) => x.taskId !== task.taskId);
      if (wasUnfinished) await this.refreshListsAfterTaskRemove(s, task);
      this.syncTasks(s);
    } catch (e) {
      this.$message.error(connectionErrorMessage(e));
    }
  },
};
