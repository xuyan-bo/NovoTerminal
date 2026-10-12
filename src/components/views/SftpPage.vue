<template>
  <div
    ref="root"
    class="sftp-root"
    @click="closeCtx"
  >
    <div ref="panels" class="sftp-panels" :style="{ height: topPct + '%' }">
      <sftp-file-panel
        side="local"
        :style="{ width: leftPct + '%' }"
        :items="localItems"
        :path-input="localPathInput"
        :selected="localSel"
        :sort="localSort"
        :loading="localLoading"
        :drop-hi="dropHi"
        @path-input="localPathInput = $event"
        @select="onRowSelect"
        @marquee="onMarquee"
        @blank-click="onBlankClick"
        @sort-change="onSortChange"
        @navigate="goLocal"
        @up="localUp"
        @home="goLocal(localHome)"
        @refresh="goLocal(localPath)"
        @item-dbl="onLocalDbl"
        @blank-context="onBlankCtx"
        @item-context="onItemCtx"
        @drag-start="onDragStart"
        @drag-end="onDragEnd"
        @drag-over="onZoneDragOver"
        @row-over="onRowOver"
        @drag-leave="dropHi = ''"
        @zone-drop="onZoneDrop"
      />

      <div class="splitter splitter-v" @mousedown.prevent="startSplit('v', $event)"></div>

      <div class="sftp-right" :style="{ width: (100 - leftPct) + '%' }">
        <div class="sftp-tabbar-row">
          <button
            v-show="tabOverflow"
            type="button"
            class="tab-arrow"
            :disabled="!tabScrollLeft"
            :aria-label="$t('tab.scrollLeft')"
            :title="$t('tab.scrollLeft')"
            @click="scrollTabs(-1)"
          ><i class="el-icon-arrow-left"></i></button>
          <div ref="tabbar" class="sftp-tabbar tabbar-wrap" @scroll.passive="updateTabArrows">
            <div class="tabbar">
              <div
                v-for="s in sessions"
                :key="s.id"
                class="tab sftp-tab"
                :class="{
                  active: s.id === activeId,
                  dragging: tabDragId === s.id,
                  'drop-before': !!tabDragId && tabDropHint === s.id,
                  'drop-after': !!tabDragId && tabDropHint === 'END' && isLastTab(s),
                }"
                :data-tab-id="s.id"
                :title="s.host + ':' + s.port"
                draggable="true"
                @dragstart.stop="onSessionDragStart($event, s)"
                @dragend.stop="endSessionDrag($event)"
                @click="onTabClick(s)"
                @contextmenu.prevent="onTabContextmenu($event, s)"
              >
                <i class="tab-glyph el-icon-files" aria-hidden="true"></i>
                <span class="c-name">{{ s.label }}</span>
                <span class="conn-dot" :class="s.status"></span>
                <i
                  class="x el-icon-close"
                  @mousedown.stop.prevent
                  @dragstart.stop.prevent
                  @click.stop="closeTab(s)"
                ></i>
              </div>
            </div>
          </div>
          <button
            v-show="tabOverflow"
            type="button"
            class="tab-arrow"
            :disabled="!tabScrollRight"
            :aria-label="$t('tab.scrollRight')"
            :title="$t('tab.scrollRight')"
            @click="scrollTabs(1)"
          ><i class="el-icon-arrow-right"></i></button>
        </div>

        <div class="sftp-remote-area">
          <div
            v-for="s in sessions"
            :key="s.id"
            v-show="s.id === activeId"
            class="sftp-remote-slot"
          >
            <sftp-file-panel
              side="remote"
              :items="s.remoteItems"
              :path-input="s.remotePathInput"
              :selected="s.remoteSel"
              :sort="s.remoteSort"
              :loading="s.remoteLoading"
              :drop-hi="dropHi"
              :refresh-disabled="!s.connId"
              @path-input="s.remotePathInput = $event"
              @select="onRowSelect"
              @marquee="onMarquee"
              @blank-click="onBlankClick"
              @sort-change="onSortChange"
              @navigate="goRemote(s, $event)"
              @up="remoteUp(s)"
              @home="goRemote(s, s.remoteHome || '/')"
              @refresh="goRemote(s, s.remotePath)"
              @item-dbl="onRemoteDbl(s, $event)"
              @blank-context="onBlankCtx"
              @item-context="onItemCtx"
              @drag-start="onDragStart"
              @drag-end="onDragEnd"
              @drag-over="onZoneDragOver"
              @row-over="onRowOver"
              @drag-leave="dropHi = ''"
              @zone-drop="onZoneDrop"
            >
              <span slot="connection" class="conn-meta">
                <span class="conn-tag" :class="s.status">{{ statusText(s) }}</span>
                <span class="conn-host">{{ s.host }}:{{ s.port }}</span>
              </span>
            </sftp-file-panel>
            <div v-if="s.status === 'error'" class="sftp-session-error">
              <span class="err-text">{{ s.error || $t('conn.error') }}</span>
              <el-button size="mini" @click="bootSession(s)">{{ $t('sftp.retry') }}</el-button>
            </div>
          </div>
          <div v-if="!sessions.length" class="sftp-empty">{{ $t('sftp.tabs.empty') }}</div>
        </div>
      </div>
    </div>

    <div class="splitter splitter-h" @mousedown.prevent="startSplit('h', $event)"></div>

    <!-- 队列是整个面板公用的：所有会话的任务合并成一张表，行上用所属会话列区分 -->
    <sftp-transfer-queue
      :style="{ height: (100 - topPct) + '%' }"
      :tasks="queueTasks"
      :expanded-keys="expandedKeys"
      @expand-change="onExpandChange"
      @load-children="loadTreeChildren"
      @toggle-pause="togglePause"
      @remove-task="removeTask"
    />

    <ctx-menu ref="tabCtxMenu" @select="onTabCtxSelect" />

    <div v-if="ctx.visible" class="sftp-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @click.stop>
      <div
        v-for="it in ctx.items"
        :key="it.act"
        class="sftp-ctx-item"
        :class="{ danger: it.danger, disabled: it.disabled }"
        @click="!it.disabled && runCtx(it)"
      >{{ it.label }}</div>
    </div>

    <sftp-name-dialog ref="nameDialog" />
  </div>
</template>

<script>
import { api, unwrap, connectionErrorMessage } from '../../store';
import { t } from '../../i18n';
import CtxMenu from '../common/CtxMenu.vue';
import SftpNameDialog from '../dialogs/SftpNameDialog.vue';
import SftpFilePanel from '../sftp/SftpFilePanel.vue';
import SftpTransferQueue from '../sftp/SftpTransferQueue.vue';
import { PARENT_ROW, joinLocal, joinRemote, localPathOf, parentLocal, parentRemote, normalizeRemotePath, sortItems } from '../sftp/utils';
import taskMethods from '../sftp/taskMethods';
import transferMethods from '../sftp/transferMethods';
import dragDropMethods from '../sftp/dragDropMethods';
import selectionMethods from '../sftp/selectionMethods';

const TAB_DRAG_TYPE = 'application/x-novoterminal-sftp-tab';

/** One tab per SFTP session: an asset can be opened several times, like SSH. */
function createSession(meta, id, seq) {
  const name = meta.name || meta.host || '';
  return {
    id,
    assetId: meta.assetId,
    name,
    label: seq > 1 ? `${name} (${seq})` : name,
    seq,
    host: meta.host || '',
    port: Number(meta.port) || 22,
    connId: null,
    status: 'idle',
    error: '',
    alive: true,
    remotePath: '/',
    remotePathInput: '/',
    remoteHome: '/',
    // 从 SSH 终端进来时带的当前目录，连上后作为首个目录，用完即清（重试不该再跳回去）
    initialPath: meta.initialPath || '',
    remoteItems: [],
    remoteSel: [],
    remoteAnchor: '',
    remoteSort: { key: 'name', dir: 'asc' },
    remoteLoading: false,
    tasks: [],
    // Tree bookkeeping is per session so a background transfer keeps updating its own rows.
    folderStates: new Map(),
    rowByKey: new Map(),
    rowByXferId: new Map(),
    recalcPending: new Set(),
    recalcTimer: null,
  };
}

export default {
  name: 'SftpPage',
  components: { CtxMenu, SftpNameDialog, SftpFilePanel, SftpTransferQueue },
  data() {
    return {
      sessions: [],
      activeId: '',
      // 本机面板由所有会话页签共享
      localPath: '',
      localPathInput: '',
      localHome: '',
      localComputer: false,
      localItems: [],
      localSel: [],
      localAnchor: '',
      localSort: { key: 'name', dir: 'asc' },
      localLoading: false,
      activeSide: 'local',
      dropHi: '',
      dragPayload: null,
      clipHasFiles: false,
      ctx: { visible: false, x: 0, y: 0, items: [], side: '', item: null },
      leftPct: 50,
      topPct: 58,
      tabDragId: '',
      tabDropHint: '',
      tabOverflow: false,
      tabScrollLeft: false,
      tabScrollRight: false,
      expandedKeys: [],
    };
  },
  computed: {
    /** 拖放、选择与列头排序只可能作用在可见页签上，因此统一走这个当前会话。 */
    s() {
      return this.sessionById(this.activeId);
    },
    connId() {
      return this.s ? this.s.connId : null;
    },
    remotePath() {
      return this.s ? this.s.remotePath : '/';
    },
    remoteItems: {
      get() { return this.s ? this.s.remoteItems : []; },
      set(v) { if (this.s) this.s.remoteItems = v; },
    },
    remoteSel: {
      get() { return this.s ? this.s.remoteSel : []; },
      set(v) { if (this.s) this.s.remoteSel = v; },
    },
    remoteAnchor: {
      get() { return this.s ? this.s.remoteAnchor : ''; },
      set(v) { if (this.s) this.s.remoteAnchor = v; },
    },
    remoteSort: {
      get() { return this.s ? this.s.remoteSort : { key: 'name', dir: 'asc' }; },
      set(v) { if (this.s) this.s.remoteSort = v; },
    },
    /** 公用队列：各会话的任务合并后按提交时间倒序，行上的 sessionName 标明归属。 */
    queueTasks() {
      const rows = [];
      for (let i = 0; i < this.sessions.length; i += 1) {
        const list = this.sessions[i].tasks;
        for (let j = 0; j < list.length; j += 1) rows.push(list[j]);
      }
      return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
  },
  created() {
    // Vue 2 does not proxy data keys beginning with an underscore.
    this._dropLock = {};
    this._pasting = false;
    this._lastDrag = null;
    this._marqueeBase = null;
    this._split = null;
    this._pollTimer = null;
    this._doneNames = [];
    this._doneToastTimer = null;
    this._seq = 0;
    this._destroyed = false;
    this._tabDragging = false;
    this._tabClickBlockedUntil = 0;
    this._tabScrollFrame = 0;
    this._tabResizeObs = null;
    this._tabDragX = 0;
    this._tabOverBar = false;
  },
  async mounted() {
    this._offProgress =
      api.onSftpProgress &&
      api.onSftpProgress((p) => {
        if (!p || !p.taskId) return;
        // 进度事件带 connId：后台页签的传输也要继续更新自己的任务行
        const s = this.sessions.find((x) => x.connId === p.connId);
        if (s) this.mergeTask(s, p);
      });
    // 连接被服务端或网络断开：主进程只报这一条，页签状态由这里改
    this._offState =
      api.onSftpState &&
      api.onSftpState((ev) => {
        if (!ev || ev.type !== 'disconnected') return;
        const s = this.sessions.find((x) => x.connId === ev.connId);
        if (!s || !s.alive) return;
        s.connId = null;
        s.status = 'error';
        s.error = connectionErrorMessage({ code: ev.code });
        // 重连后回到断开前真正在看的那个目录
        s.initialPath = s.remotePath;
        // 连接没了就不会再有进度事件，未完成的行就地判掉，别一直挂着「传输中」
        this.markTasksCanceled(s);
        this.$message.error(`${s.label}: ${s.error}`);
      });
    // 先订阅再报到：主进程把就绪前到达的会话一次性交出来，之后都走事件
    this._offAddSession =
      api.onSftpAddSession &&
      api.onSftpAddSession((meta) => this.addSession(meta));
    // 关窗询问：主进程只负责拦截 close，有没有活动会话由面板回答。
    this._offWinConfirm =
      api.onSftpConfirmClose &&
      api.onSftpConfirmClose(() => this.confirmWindowClose());

    // document capture 一对监听同时覆盖 OS 拖入和面板外的落点，面板自己的 drop 优先
    this._docOver = (e) => {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types || []);
      if (types.indexOf('Files') >= 0 || this._lastDrag || this.dragPayload) {
        e.preventDefault();
        try {
          e.dataTransfer.dropEffect = 'copy';
        } catch (_) {}
      }
    };
    this._docDrop = (e) => {
      const el = e.target;
      const inZone =
        el && el.closest && el.closest('.sftp-panel, .file-list, .file-row');
      e.preventDefault();
      // Panels handle their own drops; document only covers leftover areas
      if (inZone) return;
      this.runDrop(e, null);
    };
    document.addEventListener('dragover', this._docOver, true);
    document.addEventListener('drop', this._docDrop, true);
    document.addEventListener('keydown', this.onGlobalKey);
    window.addEventListener('focus', this.refreshClipFiles);
    window.addEventListener('resize', this.updateTabArrows);

    this.$nextTick(() => {
      if (this._destroyed) return;
      this.observeTabBar();
      this.updateTabArrows();
    });

    await this.bootLocal();
    if (this._destroyed) return;
    if (api.sftpSessionsReady) {
      try {
        const r = unwrap(await api.sftpSessionsReady());
        (r && r.sessions ? r.sessions : []).forEach((meta) => this.addSession(meta));
      } catch (_) {}
    }
    if (this._destroyed) return;
    this._pollTimer = setInterval(() => {
      this.sessions.forEach((s) => {
        if (s.connId) this.syncTasks(s);
      });
    }, 1000);
    window.addEventListener('beforeunload', this.onUnload);
  },
  beforeDestroy() {
    this._destroyed = true;
    this.endSessionDrag();
    window.removeEventListener('beforeunload', this.onUnload);
    document.removeEventListener('dragover', this._docOver, true);
    document.removeEventListener('drop', this._docDrop, true);
    document.removeEventListener('keydown', this.onGlobalKey);
    window.removeEventListener('focus', this.refreshClipFiles);
    document.removeEventListener('mousemove', this.onSplitMove);
    document.removeEventListener('mouseup', this.onSplitUp);
    window.removeEventListener('resize', this.updateTabArrows);
    if (this._tabResizeObs) this._tabResizeObs.disconnect();
    this._tabResizeObs = null;
    cancelAnimationFrame(this._tabScrollFrame);
    this._tabScrollFrame = 0;
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    if (this._doneToastTimer) clearTimeout(this._doneToastTimer);
    this._doneToastTimer = null;
    this.sessions.forEach((s) => this.releaseSession(s));
    if (this._offProgress) this._offProgress();
    if (this._offState) this._offState();
    if (this._offAddSession) this._offAddSession();
    if (this._offWinConfirm) this._offWinConfirm();
  },
  methods: {
    ...selectionMethods,
    ...taskMethods,
    ...transferMethods,
    ...dragDropMethods,

    sessionById(id) {
      return this.sessions.find((s) => s.id === id) || null;
    },
    /**
     * 公用队列里的行要回到它所属的会话：文件夹树按 rootId 找扫描状态，单文件行按它在哪份
     * 任务列表里找。不能按 connId 找——重连或重新握手会换 connId，旧行就再也管不了了。
     */
    sessionOf(row) {
      if (!row) return null;
      const id = row.rootId || row.taskId;
      for (let i = 0; i < this.sessions.length; i += 1) {
        const s = this.sessions[i];
        if (s.folderStates.has(id) || s.tasks.indexOf(row) >= 0) return s;
      }
      return null;
    },
    statusText(s) {
      const map = {
        idle: t('conn.idle'),
        connecting: t('conn.connecting'),
        ready: t('conn.ready'),
        error: t('conn.error'),
      };
      return map[s.status] || s.status;
    },
    onUnload() {
      this.sessions.forEach((s) => {
        if (s.connId && api.sftpClose) api.sftpClose(s.connId).catch(() => {});
      });
    },

    /** 主进程（或页签右键「复制会话」）要求新增一个远端会话页签；同一资产可以开多个。 */
    addSession(meta) {
      if (!meta || !meta.assetId) return;
      // 编号只增不减：关掉 A(2) 后再开一条不能顶掉还活着的同名页签
      const same = this.sessions.filter((x) => x.assetId === meta.assetId);
      const seq = same.reduce((max, x) => Math.max(max, x.seq), 0) + 1;
      const s = createSession(meta, `ss-${++this._seq}`, seq);
      this.sessions.push(s);
      this.activateTab(s.id);
      this.bootSession(s);
    },
    /** 走主进程同一条打开入口，复制出的会话按当前资产配置连接。 */
    copySession(s) {
      if (!s || !api.sftpOpenWindow) return;
      // 主进程把异常包成 {__error} 返回，不 unwrap 就永远走不到 catch
      api
        .sftpOpenWindow({ assetId: s.assetId })
        .then((r) => unwrap(r))
        .catch((e) => this.$message.error(connectionErrorMessage(e)));
    },
    activateTab(id) {
      if (this.activeId === id) return;
      this.activeId = id;
      this.closeCtx();
      const s = this.sessionById(id);
      if (s && s.connId) this.syncTasks(s);
      this.$nextTick(() => this.scrollTabIntoView(id));
    },
    async bootLocal() {
      if (!api.sftpLocalList) return;
      try {
        const local = unwrap(await api.sftpLocalList());
        if (this._destroyed) return;
        this.localHome = local.home || local.path;
        await this.goLocal(local.path || this.localHome);
        this.refreshClipFiles();
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      }
    },
    async bootSession(s) {
      if (!s || !s.alive || !api.sftpOpen) return;
      s.status = 'connecting';
      s.error = '';
      try {
        const r = unwrap(await api.sftpOpen({ assetId: s.assetId }));
        // 连接返回前页签可能已被关闭
        if (!s.alive) {
          if (r.connId && api.sftpClose) api.sftpClose(r.connId).catch(() => {});
          return;
        }
        s.connId = r.connId;
        s.remoteHome = r.home || '/';
        s.status = 'ready';
        const start = s.initialPath || s.remoteHome;
        s.initialPath = '';
        await this.goRemote(s, start, start === s.remoteHome ? null : s.remoteHome);
        if (!s.alive) return;
        await this.syncTasks(s);
      } catch (e) {
        if (!s.alive) return;
        s.status = 'error';
        s.error = connectionErrorMessage(e);
        this.$message.error(s.error);
      }
    },
    releaseSession(s) {
      if (!s) return;
      s.alive = false;
      if (s.recalcTimer) clearTimeout(s.recalcTimer);
      s.recalcTimer = null;
      s.recalcPending.clear();
      // 正在扫描的文件夹要收到取消信号，否则暂停中的扫描循环一直等不到恢复
      Array.from(s.folderStates.keys()).forEach((id) => this.forgetFolderTree(s, id));
      s.rowByKey.clear();
      s.rowByXferId.clear();
      if (s.connId && api.sftpClose) api.sftpClose(s.connId).catch(() => {});
      s.connId = null;
    },
    closeTab(s) {
      const hasTasks = s.tasks.some((x) => x.status === 'running' || x.status === 'paused' || x.status === 'queued');
      if (!s.connId && !hasTasks) {
        this.closeSession(s);
        return;
      }
      this.$confirm(t('sftp.tabCloseMsg', { name: s.label }), t('tab.closeConfirmTitle'), {
        confirmButtonText: t('msg.confirm'),
        cancelButtonText: t('msg.cancel'),
        type: 'warning',
      }).then(() => this.closeSession(s)).catch(() => {});
    },
    /** 关窗即销毁面板内全部会话，是否放行由这里的判定决定。 */
    hasLiveSession() {
      return this.sessions.some((s) => s.alive && (s.connId || s.status === 'connecting'));
    },
    confirmWindowClose() {
      if (!this.hasLiveSession()) {
        this.answerWindowClose(true);
        return;
      }
      this.$confirm(
        t('sftp.windowCloseMsg'),
        t('tab.closeConfirmTitle'),
        { confirmButtonText: t('msg.confirm'), cancelButtonText: t('msg.cancel'), type: 'warning' }
      ).then(
        () => this.answerWindowClose(true),
        () => this.answerWindowClose(false)
      );
    },
    /** 答复必须送达主进程，链路失败也不能把窗口卡在拦截状态。 */
    answerWindowClose(confirmed) {
      if (!api.sftpCloseAnswer) return;
      api.sftpCloseAnswer({ confirmed }).catch((e) => {
        if (api.logWrite) {
          api.logWrite({
            level: 'warn', source: 'sftp', message: 'panel close answer failed',
            meta: { confirmed, message: e.message },
          }).catch(() => {});
        }
      });
    },

    /* ---- 页签栏内拖动排序（不拆分为独立窗口） ---- *
     * dragover 挂在 document 捕获阶段：面板根节点和本机/远端的拖放兜底监听会消费元素级事件。
     * 落位在 dragend 应用而不是 drop——drop 要求整条链上的 dragover 都保留 preventDefault，任何一层
     * 文件拖放逻辑抢先处理就不会到达，而 dragend 始终在源页签上触发。
     */
    isTabDrag(e) {
      const dt = e && e.dataTransfer;
      return !!(dt && Array.from(dt.types || []).indexOf(TAB_DRAG_TYPE) >= 0);
    },
    inTabBar(e) {
      const bar = this.$refs.tabbar;
      if (!bar || !bar.getBoundingClientRect) return false;
      const rect = bar.getBoundingClientRect();
      return (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      );
    },
    onSessionDragStart(e, s) {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData(TAB_DRAG_TYPE, s.id);
      } catch (_) {}
      this.tabDragId = s.id;
      this._tabDragging = true;
      this._tabDragX = e.clientX;
      this._tabOverBar = true;
      document.addEventListener('dragover', this.onTabDragOverDoc, true);
    },
    onTabDragOverDoc(e) {
      if (!this.tabDragId || !this.isTabDrag(e)) return;
      this._tabDragX = e.clientX;
      this._tabOverBar = this.inTabBar(e);
      if (!this._tabOverBar) {
        this.tabDropHint = '';
        return;
      }
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'move';
      } catch (_) {}
      this.tabDropHint = this.tabDropTargetAt(e.clientX);
      if (!this._tabScrollFrame) this._tabScrollFrame = requestAnimationFrame(this.scrollTabsForDrag);
    },
    tabEl(id) {
      const bar = this.$refs.tabbar;
      if (!bar) return null;
      return Array.from(bar.querySelectorAll('.sftp-tab')).find((el) => el.dataset.tabId === id) || null;
    },
    /** 交出落点：拖拽页签插到它前面的页签 id；光标在目标页签右半区即插到它后面，越过栏尾为 END。 */
    tabDropTargetAt(clientX) {
      const others = this.sessions.filter((x) => x.id !== this.tabDragId);
      for (let i = 0; i < others.length; i += 1) {
        const el = this.tabEl(others[i].id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (clientX > rect.right) continue;
        if (clientX < rect.left + rect.width / 2) return others[i].id;
        return others[i + 1] ? others[i + 1].id : 'END';
      }
      return 'END';
    },
    isLastTab(s) {
      return this.sessions.length > 0 && this.sessions[this.sessions.length - 1].id === s.id;
    },
    moveTabTo(id, before) {
      const dragged = this.sessionById(id);
      if (!dragged) return;
      const next = this.sessions.filter((x) => x.id !== dragged.id);
      const at = before === 'END' || !before ? next.length : next.findIndex((x) => x.id === before);
      if (at < 0) return;
      next.splice(at, 0, dragged);
      this.sessions = next;
    },
    endSessionDrag(e) {
      document.removeEventListener('dragover', this.onTabDragOverDoc, true);
      if (this.tabDragId && e && this.inTabBar(e)) {
        this.moveTabTo(this.tabDragId, this.tabDropTargetAt(e.clientX));
      }
      this.tabDragId = '';
      this.tabDropHint = '';
      this._tabDragging = false;
      this._tabOverBar = false;
      cancelAnimationFrame(this._tabScrollFrame);
      this._tabScrollFrame = 0;
      this._tabClickBlockedUntil = Date.now() + 150;
    },
    onTabClick(s) {
      if (Date.now() < this._tabClickBlockedUntil) return;
      this.activateTab(s.id);
    },

    /* ---- 页签栏溢出时的左右翻页与拖拽自动滚动 ---- */
    observeTabBar() {
      if (this._tabResizeObs) this._tabResizeObs.disconnect();
      this._tabResizeObs = null;
      const wrap = this.$refs.tabbar;
      if (!wrap || !window.ResizeObserver) return;
      this._tabResizeObs = new ResizeObserver(() => this.updateTabArrows());
      this._tabResizeObs.observe(wrap);
      if (wrap.firstElementChild) this._tabResizeObs.observe(wrap.firstElementChild);
    },
    updateTabArrows() {
      const wrap = this.$refs.tabbar;
      if (!wrap) return;
      const max = wrap.scrollWidth - wrap.clientWidth;
      this.tabOverflow = max > 1;
      this.tabScrollLeft = wrap.scrollLeft > 0;
      this.tabScrollRight = wrap.scrollLeft < max - 1;
    },
    scrollTabs(dir) {
      const wrap = this.$refs.tabbar;
      if (!wrap) return;
      const max = wrap.scrollWidth - wrap.clientWidth;
      const step = Math.max(120, Math.round(wrap.clientWidth * 0.6));
      const target = Math.max(0, Math.min(max, wrap.scrollLeft + dir * step));
      wrap.scrollTo({ left: target, behavior: 'smooth' });
    },
    scrollTabsForDrag() {
      this._tabScrollFrame = 0;
      const wrap = this.$refs.tabbar;
      if (!wrap || !this.tabDragId || !this._tabOverBar) return;
      const rect = wrap.getBoundingClientRect();
      const dir = this._tabDragX < rect.left + 40 ? -1 : this._tabDragX > rect.right - 40 ? 1 : 0;
      if (!dir) return;
      const previous = wrap.scrollLeft;
      wrap.scrollLeft += dir * 12;
      if (wrap.scrollLeft === previous) return;
      this.tabDropHint = this.tabDropTargetAt(this._tabDragX);
      this._tabScrollFrame = requestAnimationFrame(this.scrollTabsForDrag);
    },
    scrollTabIntoView(id) {
      const wrap = this.$refs.tabbar;
      const el = wrap && this.tabEl(id);
      if (!wrap || !el) return;
      const wr = wrap.getBoundingClientRect();
      const tr = el.getBoundingClientRect();
      if (tr.left < wr.left) wrap.scrollLeft -= Math.ceil(wr.left - tr.left);
      else if (tr.right > wr.right) wrap.scrollLeft += Math.ceil(tr.right - wr.right);
      this.updateTabArrows();
    },

    /* ---- 页签右键菜单：与主标签栏同一套操作 ---- */
    onTabContextmenu(e, s) {
      const items = [
        { label: t('tab.refresh'), icon: 'el-icon-refresh', act: 'refresh', id: s.id },
        { label: t('tab.copySession'), icon: 'el-icon-document-copy', act: 'copy', id: s.id },
        { sep: true },
        { label: t('tab.closeCurrent'), icon: 'el-icon-close', act: 'closeCurrent', id: s.id },
        { label: t('tab.closeOthers'), icon: 'el-icon-circle-close', act: 'closeOthers', id: s.id },
        { label: t('tab.closeLeft'), icon: 'el-icon-back', act: 'closeLeft', id: s.id },
        { label: t('tab.closeRight'), icon: 'el-icon-right', act: 'closeRight', id: s.id },
        { label: t('tab.closeAll'), icon: 'el-icon-error', act: 'closeAll', id: s.id },
      ];
      this.$refs.tabCtxMenu.open(e, items);
    },
    onTabCtxSelect(item) {
      if (!item) return;
      const index = this.sessions.findIndex((x) => x.id === item.id);
      const s = index >= 0 ? this.sessions[index] : null;
      if (!s) return;
      if (item.act === 'refresh') this.goRemote(s, s.remotePath);
      else if (item.act === 'copy') this.copySession(s);
      else if (item.act === 'closeCurrent') this.closeTab(s);
      else if (item.act === 'closeOthers') this.closeTabsBulk(this.sessions.filter((x) => x.id !== s.id));
      else if (item.act === 'closeLeft') this.closeTabsBulk(this.sessions.slice(0, index));
      else if (item.act === 'closeRight') this.closeTabsBulk(this.sessions.slice(index + 1));
      else if (item.act === 'closeAll') this.closeTabsBulk(this.sessions.slice());
    },
    closeTabsBulk(targets) {
      const list = (targets || []).filter((x) => x && x.alive);
      if (!list.length) return;
      const active = list.filter(
        (x) => x.connId || x.tasks.some((k) => k.status === 'running' || k.status === 'paused' || k.status === 'queued')
      ).length;
      const run = () => list.slice().forEach((x) => this.closeSession(x));
      if (!active) {
        run();
        return;
      }
      this.$confirm(
        t('tab.closeBulkConfirmMsg', { count: active }),
        t('tab.closeConfirmTitle'),
        { confirmButtonText: t('msg.confirm'), cancelButtonText: t('msg.cancel'), type: 'warning' }
      ).then(run).catch(() => {});
    },
    /** 不做二次确认的关闭：批量操作已经确认过整个集合。 */
    closeSession(s) {
      const index = this.sessions.findIndex((x) => x.id === s.id);
      if (index < 0) return;
      const next = this.sessions[index + 1] || this.sessions[index - 1];
      this.releaseSession(s);
      this.sessions.splice(index, 1);
      if (this.activeId === s.id) this.activateTab(next ? next.id : '');
    },

    startSplit(type) {
      this._split = type;
      document.addEventListener('mousemove', this.onSplitMove);
      document.addEventListener('mouseup', this.onSplitUp);
    },
    onSplitMove(e) {
      const root = this.$refs.root;
      if (!root || !this._split) return;
      if (this._split === 'h') {
        const rect = root.getBoundingClientRect();
        const pct = ((e.clientY - rect.top) / rect.height) * 100;
        this.topPct = Math.min(78, Math.max(28, pct));
        return;
      }
      const panels = this.$refs.panels;
      const rect = panels ? panels.getBoundingClientRect() : root.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      this.leftPct = Math.min(72, Math.max(28, pct));
    },
    onSplitUp() {
      this._split = null;
      document.removeEventListener('mousemove', this.onSplitMove);
      document.removeEventListener('mouseup', this.onSplitUp);
    },
    closeCtx() {
      this.ctx.visible = false;
    },

    async goLocal(p) {
      // On Windows, '/' in the local panel means "all drives", not a filesystem root.
      if (p === '/' && api.platform === 'win32') return this.loadDrives();
      if (this.localLoading) return;
      this.localComputer = false;
      this.localLoading = true;
      try {
        const r = unwrap(await api.sftpLocalList(p));
        this.localPath = r.path;
        this.localPathInput = r.path;
        if (r.home) this.localHome = r.home;
        const items = (r.items || []).filter((x) => x.name !== '.' && x.name !== '..');
        this.localItems = sortItems([PARENT_ROW, ...items], this.localSort);
        this.localSel = [];
        this.localAnchor = '';
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      } finally {
        this.localLoading = false;
      }
    },
    async loadDrives() {
      if (this.localLoading) return;
      this.localLoading = true;
      try {
        const drives = unwrap(await api.sftpDrives()) || [];
        this.localComputer = true;
        this.localPath = '/';
        this.localPathInput = '/';
        this.localItems = sortItems([PARENT_ROW, ...drives.map((d) => ({ ...d, name: `${t('sftp.disk')} (${String(d.name || '').slice(0, 1)}:)` }))], this.localSort);
        this.localSel = [];
        this.localAnchor = '';
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      } finally {
        this.localLoading = false;
      }
    },
    /** fallback 只用于首个目录（来自 SSH 终端的 cwd）：进不去时静默回家目录，不弹错误。 */
    async goRemote(s, p, fallback) {
      if (!s || !s.alive || !s.connId || s.remoteLoading) return;
      const target = normalizeRemotePath(p) || '/';
      s.remoteLoading = true;
      let failed = null;
      try {
        const r = unwrap(await api.sftpList(s.connId, target));
        if (!s.alive) return;
        s.remotePath = normalizeRemotePath(r.path || target);
        s.remotePathInput = s.remotePath;
        const items = (r.items || []).filter((x) => x.name !== '.' && x.name !== '..');
        s.remoteItems = sortItems([PARENT_ROW, ...items], s.remoteSort);
        s.remoteSel = [];
        s.remoteAnchor = '';
      } catch (e) {
        failed = e;
      } finally {
        if (s.alive) s.remoteLoading = false;
      }
      if (!failed || !s.alive) return;
      if (fallback) return this.goRemote(s, fallback);
      this.$message.error(connectionErrorMessage(failed));
    },
    localUp() {
      if (this.localComputer) return;
      // From a drive root (C:\) up once -> show all drives (This PC).
      if (/^[A-Za-z]:[\\/]?$/.test(this.localPath)) return this.loadDrives();
      this.goLocal(parentLocal(this.localPath) || this.localHome);
    },
    remoteUp(s) {
      this.goRemote(s, parentRemote(s.remotePath));
    },
    onSortChange(side, key) {
      const cur = side === 'local' ? this.localSort : this.remoteSort;
      const next =
        cur.key === key
          ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: key === 'name' ? 'asc' : 'desc' };
      if (side === 'local') {
        this.localSort = next;
        this.localItems = sortItems(this.localItems, next);
      } else {
        this.remoteSort = next;
        this.remoteItems = sortItems(this.remoteItems, next);
      }
    },
    onLocalDbl(f) {
      if (f.isParent) return this.localUp();
      if (f.isDrive) return this.goLocal(f.path);
      if (f.isDir) return this.goLocal(localPathOf(this.localPath, f));
      const s = this.needRemote();
      if (s) this.uploadPaths(s, [localPathOf(this.localPath, f)], s.remotePath);
    },
    onRemoteDbl(s, f) {
      if (f.isParent) return this.remoteUp(s);
      if (f.isDir) return this.goRemote(s, joinRemote(s.remotePath, f.name));
      this.downloadPaths(s, [joinRemote(s.remotePath, f.name)], this.localDropDir());
    },

    onBlankCtx(e, side) {
      // 「此电脑」视图里没有一个真实目录能承载新建/全选，只留刷新
      const computerView = side === 'local' && this.localComputer;
      const items = [];
      if (!computerView) {
        items.push({ act: 'mkdir', label: t('sftp.mkdir') });
        items.push({ act: 'mkfile', label: t('sftp.mkfile') });
      }
      if (side === 'remote') {
        items.push({ act: 'paste', label: t('sftp.paste'), disabled: !this.clipHasFiles });
      }
      items.push({ act: 'refresh', label: t('sftp.refresh') });
      if (!computerView) items.push({ act: 'select-all', label: t('sftp.selectAll') });
      this.openCtxAt(e, side, null, items);
      if (side === 'remote') this.refreshClipFiles();
    },
    /** 菜单 fixed 跟随光标，量出尺寸后收进视口，避免靠近右/下边缘时溢出点不到；两处右键入口共用。 */
    openCtxAt(e, side, item, items) {
      this.ctx = { visible: true, x: e.clientX, y: e.clientY, side, item, items };
      this.$nextTick(() => {
        const el = this.$el && this.$el.querySelector('.sftp-ctx');
        if (!el) return;
        const pad = 4;
        const maxX = window.innerWidth - el.offsetWidth - pad;
        const maxY = window.innerHeight - el.offsetHeight - pad;
        this.ctx.x = Math.max(pad, Math.min(e.clientX, maxX));
        this.ctx.y = Math.max(pad, Math.min(e.clientY, maxY));
      });
    },
    /** The OS clipboard can change at any moment, so the paste item is re-checked on open and on focus. */
    async refreshClipFiles() {
      let has = false;
      if (api.sftpClipboardFiles) {
        try {
          const files = unwrap(await api.sftpClipboardFiles());
          has = !!(files && files.length);
        } catch (_) {
          has = false;
        }
      }
      if (this._destroyed) return;
      this.clipHasFiles = has;
      const item = (this.ctx.items || []).find((x) => x.act === 'paste');
      if (item && this.ctx.visible) item.disabled = !has;
    },
    onItemCtx(e, side, f) {
      // 盘符行只能进入，不参与重命名/删除/上传
      if (f.isParent || f.isDrive) return;
      const sel = side === 'local' ? this.localSel : this.remoteSel;
      if (sel.indexOf(f.name) < 0) this.onRowSelect(side, f.name, {});
      const targets = this.selItems(side);
      const many = targets.length > 1;
      const items = [];
      if (side === 'local') {
        if (many) items.push({ act: 'upload-selected', label: t('sftp.uploadSelected') });
        else if (f.isDir) items.push({ act: 'upload-folder', label: t('sftp.uploadFolder') });
        else items.push({ act: 'upload-file', label: t('sftp.uploadFile') });
      } else if (many || !f.isDir) {
        items.push({ act: 'download-here', label: t('sftp.downloadHere') });
        items.push({ act: 'download-to', label: t('sftp.downloadTo') });
      } else {
        items.push({ act: 'download-folder', label: t('sftp.downloadFolder') });
      }
      if (!many) {
        if (!f.isDir) items.push({ act: 'edit', label: t('sftp.edit') });
        items.push({ act: 'rename', label: t('sftp.rename') });
      }
      items.push({ act: 'delete', label: t('sftp.delete'), danger: true });
      this.openCtxAt(e, side, f, items);
    },
    /** 远端侧（以及本机→远端的上传）要先有连接；本机侧操作不该依赖有没有页签。 */
    needRemote() {
      const s = this.s;
      if (s && s.connId) return s;
      this.$message.warning(t('err.SFTP_NO_CONN'));
      return null;
    },
    async runCtx(it) {
      const { side, item } = this.ctx;
      this.closeCtx();
      const needsRemote = side === 'remote' || it.act.indexOf('upload') === 0 || it.act === 'paste';
      const s = needsRemote ? this.needRemote() : this.s;
      if (needsRemote && !s) return;
      const targets = this.selItems(side);
      const list = targets.length ? targets : item ? [item] : [];
      const localOf = (x) => localPathOf(this.localPath, x);
      const remoteOf = (x) => joinRemote(s.remotePath, x.name);
      const downloadList = async (dir) => {
        for (const x of list) {
          if (x.isDir) {
            unwrap(await api.sftpLocalMkdir(dir, x.name));
            await this.downloadRemoteDir(s, remoteOf(x), joinLocal(dir, x.name));
          } else {
            await this.startDownload(s, remoteOf(x), joinLocal(dir, x.name));
          }
        }
      };
      try {
        if (it.act === 'upload-folder' && item && item.isDir) {
          await this.transferFolderUpload(s, localOf(item), s.remotePath);
          return;
        }
        if (it.act === 'upload-selected' || it.act === 'upload-file') {
          for (const x of list.filter((y) => y.isDir)) {
            await this.transferFolderUpload(s, localOf(x), s.remotePath);
          }
          const files = list.filter((y) => !y.isDir);
          if (files.length) await this.uploadPaths(s, files.map(localOf), s.remotePath);
          return;
        }
        if (it.act === 'download-folder' && item && item.isDir) {
          await this.transferFolderDownload(s, remoteOf(item), this.localDropDir());
          return;
        }
        if (it.act === 'download-here' && list.length) {
          await downloadList(this.localDropDir());
          return;
        }
        if (it.act === 'download-to' && list.length) {
          let dir = this.localDropDir();
          if (api.sftpPickLocalDir) {
            const picked = unwrap(await api.sftpPickLocalDir());
            if (picked) dir = picked;
          }
          await downloadList(dir);
          return;
        }
        if (it.act === 'edit' && item && !item.isDir) {
          if (side === 'local') unwrap(await api.sftpEditLocal(localOf(item)));
          else unwrap(await api.sftpEditOpen(s.connId, remoteOf(item)));
          return;
        }
        if (it.act === 'paste') {
          await this.pasteFromClipboard();
          return;
        }
        if (it.act === 'mkdir' || it.act === 'mkfile') {
          const isDir = it.act === 'mkdir';
          const name = await this.$refs.nameDialog.open(
            t(isDir ? 'sftp.mkdir' : 'sftp.mkfile'),
            t(isDir ? 'sftp.mkdirName' : 'sftp.fileName')
          );
          if (!name) return;
          if (side === 'local') {
            unwrap(
              isDir
                ? await api.sftpLocalMkdir(this.localPath, name)
                : await api.sftpLocalCreateFile(this.localPath, name)
            );
            await this.goLocal(this.localPath);
          } else {
            unwrap(
              isDir
                ? await api.sftpMkdir(s.connId, joinRemote(s.remotePath, name))
                : await api.sftpCreateFile(s.connId, joinRemote(s.remotePath, name))
            );
            await this.goRemote(s, s.remotePath);
          }
          this.$message.success(t(isDir ? 'sftp.mkdirDone' : 'sftp.mkfileDone', { name }));
          return;
        }
        if (it.act === 'refresh') {
          if (side === 'local') await this.goLocal(this.localPath);
          else await this.goRemote(s, s.remotePath);
          return;
        }
        if (it.act === 'select-all') {
          this.setSel(side, this.selectableNames(side));
          return;
        }
        if (it.act === 'rename' && item && list.length === 1) {
          const r = await this.$prompt(t('sftp.renameTo'), t('sftp.rename'), {
            confirmButtonText: t('msg.confirm'),
            cancelButtonText: t('msg.cancel'),
            inputValue: item.name,
          });
          const neu = r && r.value ? String(r.value).trim() : '';
          if (!neu || neu === item.name) return;
          if (side === 'local') {
            unwrap(await api.sftpLocalRename(localOf(item), joinLocal(this.localPath, neu)));
            await this.goLocal(this.localPath);
          } else {
            unwrap(await api.sftpRename(s.connId, remoteOf(item), joinRemote(s.remotePath, neu)));
            await this.goRemote(s, s.remotePath);
          }
          this.$message.success(t('sftp.renameDone', { name: neu }));
          return;
        }
        if (it.act === 'delete' && list.length) {
          const msg =
            list.length === 1
              ? t('sftp.confirmDelete', { name: list[0].name })
              : t('sftp.confirmDeleteMulti', { count: list.length });
          await this.$confirm(msg, t('msg.confirm'), { type: 'warning' });
          const failed = [];
          for (const x of list) {
            try {
              if (side === 'local') unwrap(await api.sftpLocalUnlink(localOf(x), x.isDir));
              else unwrap(await api.sftpUnlink(s.connId, remoteOf(x), x.isDir));
            } catch (e) {
              failed.push(`${x.name}: ${connectionErrorMessage(e)}`);
            }
          }
          if (failed.length) this.$message.error(failed.join('\n'));
          if (side === 'local') await this.goLocal(this.localPath);
          else await this.goRemote(s, s.remotePath);
          const removed = list.length - failed.length;
          if (removed) {
            this.$message.success(
              removed === 1 && !failed.length
                ? t('sftp.deleteDone', { name: list[0].name })
                : t('sftp.deleteDoneMulti', { count: removed })
            );
          }
        }
      } catch (err) {
        if (err !== 'cancel' && err !== 'close') this.$message.error(connectionErrorMessage(err));
      }
    },
  },
};
</script>

<style scoped>
.sftp-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-app, #0f1419);
  color: var(--text, #e6edf3);
  overflow: hidden;
  position: relative;
}
.sftp-panels {
  flex: 0 0 auto;
  min-height: 0;
  display: flex;
  padding: 8px 8px 0 8px;
  box-sizing: border-box;
}
.sftp-right {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
/* 页签栏作为远端面板的头部：同色背景、方角相接，共用一条分隔线而不是叠成两条 */
.sftp-tabbar-row {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  border-radius: 8px 8px 0 0;
}
.sftp-tabbar {
  flex: 1 1 auto;
  min-width: 0;
}
.sftp-tab .c-name {
  max-width: 180px;
}
.sftp-remote-area {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  position: relative;
  margin-top: -1px;
}
.sftp-remote-slot {
  flex: 1 1 auto;
  min-width: 0;
  position: relative;
  display: flex;
}
.sftp-remote-slot .sftp-panel {
  flex: 1 1 auto;
  min-width: 0;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.sftp-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-3);
}
.sftp-session-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
}
.sftp-session-error .err-text {
  font-size: 12px;
  color: #f56c6c;
  max-width: 70%;
  text-align: center;
}
.splitter {
  flex: 0 0 auto;
  background: transparent;
  position: relative;
  z-index: 5;
}
.splitter-v {
  width: 8px;
  cursor: col-resize;
  margin: 0 2px;
  align-self: stretch;
}
.splitter-h {
  height: 8px;
  cursor: row-resize;
  margin: 2px 0;
}
.splitter-v::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 12px;
  bottom: 12px;
  width: 2px;
  border-radius: 1px;
  background: var(--border);
}
.splitter-h::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  top: 3px;
  height: 2px;
  border-radius: 1px;
  background: var(--border);
}
.splitter:hover::after {
  background: var(--accent);
}
.conn-meta {
  margin-left: 8px;
  white-space: nowrap;
}
.conn-meta .conn-tag {
  margin-left: 0;
}
.conn-host {
  margin-left: 6px;
  font-weight: 400;
  font-size: 10px;
  color: var(--text-3);
}
.conn-tag {
  margin-left: 8px;
  font-weight: 400;
  font-size: 10px;
  color: var(--text-3);
}
.conn-tag.ready {
  color: #67c23a;
}
.conn-tag.connecting {
  color: #e6a23c;
}
.conn-tag.error {
  color: #f56c6c;
}
.sftp-ctx {
  position: fixed;
  z-index: 3000;
  min-width: 120px;
  background: var(--bg-elevated, #1c2430);
  border: 1px solid var(--border, #2a3544);
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.sftp-ctx-item {
  padding: 7px 14px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.sftp-ctx-item:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.sftp-ctx-item.danger:hover {
  color: #f56c6c;
  background: rgba(245, 108, 108, 0.12);
}
.sftp-ctx-item.disabled {
  color: var(--text-3);
  opacity: 0.55;
  cursor: not-allowed;
}
.sftp-ctx-item.disabled:hover {
  color: var(--text-3);
  background: transparent;
}
</style>
