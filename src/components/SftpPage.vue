<template>
  <div
    ref="root"
    class="sftp-root"
    @click="closeCtx"
    @dragover.prevent="onRootDragOver"
    @drop.prevent="onRootDrop"
  >
    <div ref="panels" class="sftp-panels" :style="{ height: topPct + '%' }">
      <!-- local -->
      <div
        class="sftp-panel"
        data-side="local"
        :style="{ width: leftPct + '%' }"
        @contextmenu.prevent="onBlankCtx($event, 'local')"
        @dragenter.prevent
        @dragover.prevent="onZoneDragOver($event, 'local')"
        @drop.prevent.stop="onZoneDrop($event, 'local')"
      >
        <div class="panel-head">
          <span class="panel-title">{{ $t('sftp.local') }}</span>
          <div class="path-bar">
            <button type="button" class="path-icon-btn" :title="$t('sftp.back')" @click="localUp">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            </button>
            <button type="button" class="path-icon-btn" :title="$t('sftp.home')" @click="goLocal(localHome)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
            </button>
            <el-input v-model="localPathInput" size="mini" @keyup.enter.native="goLocal(localPathInput)" />
            <button
              type="button"
              class="path-icon-btn"
              :class="{ spinning: localLoading }"
              :title="$t('sftp.refresh')"
              :disabled="localLoading"
              @click="goLocal(localPath)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0012 4a8 8 0 107.73 10h-2.08A6 6 0 1112 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
          </div>
        </div>
        <div class="file-head">
          <span class="c-name">{{ $t('sftp.colName') }}</span>
          <span class="c-size">{{ $t('sftp.colSize') }}</span>
          <span class="c-time">{{ $t('sftp.colTime') }}</span>
        </div>
        <div
          v-loading="localLoading"
          element-loading-text="加载中…"
          element-loading-spinner="el-icon-loading"
          element-loading-background="rgba(15, 20, 25, 0.55)"
          class="file-list"
          data-side="local"
          @contextmenu.prevent="onBlankCtx($event, 'local')"
          @dragenter.prevent
          @dragover.prevent="onZoneDragOver($event, 'local')"
          @drop.prevent.stop="onZoneDrop($event, 'local')"
        >
          <div
            v-for="f in localItems"
            :key="'l-' + f.name"
            class="file-row"
            :class="{ sel: localSel === f.name, 'drop-hi': dropHi === 'l:' + f.name, parent: f.isParent }"
            data-side="local"
            :data-name="f.name"
            :data-isdir="f.isDir ? '1' : '0'"
            :data-parent="f.isParent ? '1' : '0'"
            :draggable="true"
            @click="localSel = f.name"
            @dblclick="onLocalDbl(f)"
            @contextmenu.prevent.stop="!f.isParent && onItemCtx($event, 'local', f)"
            @dragstart="onDragStart($event, 'local', f)"
            @dragend="onDragEnd"
            @dragover.prevent.stop="onRowOver($event, 'local', f)"
            @dragleave="dropHi = ''"
          >
            <span class="c-name"><span class="f-ico">{{ f.isDir ? '📁' : '📄' }}</span>{{ f.name }}</span>
            <span class="c-size">{{ f.sizeText }}</span>
            <span class="c-time">{{ f.mtime }}</span>
          </div>
          <div v-if="!localItems.length && !localLoading" class="empty-box">{{ $t('sftp.empty') }}</div>
        </div>
      </div>

      <div class="splitter splitter-v" @mousedown.prevent="startSplit('v', $event)"></div>

      <!-- remote -->
      <div
        class="sftp-panel sftp-panel-remote"
        data-side="remote"
        :style="{ width: (100 - leftPct) + '%' }"
        @contextmenu.prevent="onBlankCtx($event, 'remote')"
        @dragenter.prevent
        @dragover.prevent="onZoneDragOver($event, 'remote')"
        @drop.prevent.stop="onZoneDrop($event, 'remote')"
      >
        <div class="panel-head">
          <span class="panel-title">
            {{ $t('sftp.remote') }}
            <span class="conn-tag" :class="status">{{ statusText }}</span>
          </span>
          <div class="path-bar">
            <button type="button" class="path-icon-btn" :title="$t('sftp.back')" @click="remoteUp">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            </button>
            <button type="button" class="path-icon-btn" :title="$t('sftp.home')" @click="goRemote(remoteHome || '/')">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
            </button>
            <el-input v-model="remotePathInput" size="mini" @keyup.enter.native="goRemote(remotePathInput)" />
            <button
              type="button"
              class="path-icon-btn"
              :class="{ spinning: remoteLoading }"
              :title="$t('sftp.refresh')"
              :disabled="remoteLoading || !connId"
              @click="goRemote(remotePath)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0012 4a8 8 0 107.73 10h-2.08A6 6 0 1112 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
          </div>
        </div>
        <div class="file-head">
          <span class="c-name">{{ $t('sftp.colName') }}</span>
          <span class="c-size">{{ $t('sftp.colSize') }}</span>
          <span class="c-time">{{ $t('sftp.colTime') }}</span>
        </div>
        <div
          v-loading="remoteLoading"
          element-loading-text="加载中…"
          element-loading-spinner="el-icon-loading"
          element-loading-background="rgba(15, 20, 25, 0.55)"
          class="file-list"
          data-side="remote"
          @contextmenu.prevent="onBlankCtx($event, 'remote')"
          @dragenter.prevent
          @dragover.prevent="onZoneDragOver($event, 'remote')"
          @drop.prevent.stop="onZoneDrop($event, 'remote')"
        >
          <div
            v-for="f in remoteItems"
            :key="'r-' + f.name"
            class="file-row"
            :class="{ sel: remoteSel === f.name, 'drop-hi': dropHi === 'r:' + f.name, parent: f.isParent }"
            data-side="remote"
            :data-name="f.name"
            :data-isdir="f.isDir ? '1' : '0'"
            :data-parent="f.isParent ? '1' : '0'"
            :draggable="true"
            @click="remoteSel = f.name"
            @dblclick="onRemoteDbl(f)"
            @contextmenu.prevent.stop="!f.isParent && onItemCtx($event, 'remote', f)"
            @dragstart="onDragStart($event, 'remote', f)"
            @dragend="onDragEnd"
            @dragover.prevent.stop="onRowOver($event, 'remote', f)"
            @dragleave="dropHi = ''"
          >
            <span class="c-name"><span class="f-ico">{{ f.isDir ? '📁' : '📄' }}</span>{{ f.name }}</span>
            <span class="c-size">{{ f.sizeText }}</span>
            <span class="c-time">{{ f.mtime }}</span>
          </div>
          <div v-if="!remoteItems.length && !remoteLoading" class="empty-box">{{ $t('sftp.empty') }}</div>
        </div>
      </div>
    </div>

    <div class="splitter splitter-h" @mousedown.prevent="startSplit('h', $event)"></div>

    <div class="sftp-tasks" :style="{ height: (100 - topPct) + '%' }">
      <div class="tasks-head"><span>{{ $t('sftp.tasks') }}</span></div>
      <div class="tasks-table-wrap">
        <el-table :data="tasks" size="mini" height="100%" border stripe empty-text="" class="sftp-el-table">
          <el-table-column prop="name" :label="$t('sftp.colName')" min-width="110" show-overflow-tooltip />
          <el-table-column prop="sizeText" :label="$t('sftp.colSize')" width="80" />
          <el-table-column :label="$t('sftp.colProgress')" min-width="180">
            <template slot-scope="scope">
              <div class="prog-line">
                <div class="prog-wrap">
                  <div class="prog-bar" :style="{ width: (scope.row.percent || 0) + '%' }"></div>
                </div>
                <span class="prog-num" :title="scope.row.error || ''">{{ progressText(scope.row) }}</span>
              </div>
              <div v-if="scope.row.status === 'error'" class="err-line" :title="scope.row.error">
                {{ shortErr(scope.row) }}
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="speedText" :label="$t('sftp.colSpeed')" width="90" />
          <el-table-column prop="sourcePath" :label="$t('sftp.colSource')" min-width="140" show-overflow-tooltip />
          <el-table-column prop="targetPath" :label="$t('sftp.colTarget')" min-width="140" show-overflow-tooltip />
          <el-table-column :label="$t('sftp.colAction')" width="100" align="center">
            <template slot-scope="scope">
              <el-tooltip :content="scope.row.status === 'paused' ? $t('sftp.resume') : $t('sftp.pause')" placement="top">
                <button
                  type="button"
                  class="op-icon-btn"
                  :disabled="isTaskFinished(scope.row)"
                  @click.stop="togglePause(scope.row)"
                >
                  <svg v-if="scope.row.status !== 'paused'" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
                  <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
              </el-tooltip>
              <el-tooltip :content="$t('sftp.removeTask')" placement="top">
                <button type="button" class="op-icon-btn danger" @click.stop="removeTask(scope.row)">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z"/></svg>
                </button>
              </el-tooltip>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <div v-if="ctx.visible" class="sftp-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @click.stop>
      <div
        v-for="it in ctx.items"
        :key="it.act"
        class="sftp-ctx-item"
        :class="{ danger: it.danger }"
        @click="runCtx(it)"
      >{{ it.label }}</div>
    </div>
  </div>
</template>

<script>
import { api, unwrap } from '../store';
import { t } from '../i18n';

const PARENT_ROW = { name: '..', isDir: true, isParent: true, sizeText: '—', mtime: '' };

function joinRemote(dir, name) {
  if (!dir || dir === '/') return '/' + name;
  return String(dir).replace(/\/+$/, '') + '/' + name;
}
function parentRemote(p) {
  if (!p || p === '/') return '/';
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i) || '/';
}
function joinLocal(dir, name) {
  if (!dir) return name;
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + name;
  const sep = /^[A-Za-z]:\\/.test(dir) || (dir.includes('\\') && !dir.startsWith('/')) ? '\\' : dir.startsWith('/') ? '/' : '\\';
  return dir + sep + name;
}
function parentLocal(p) {
  if (!p) return '';
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return p;
  const normalized = String(p).replace(/[\\/]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (idx <= 0) return normalized;
  let next = normalized.slice(0, idx);
  if (/^[A-Za-z]:$/.test(next)) next += '\\';
  return next || normalized;
}

export default {
  name: 'SftpPage',
  props: {
    assetId: { type: String, required: true },
    host: { type: String, default: '' },
    port: { type: Number, default: 22 },
    assetName: { type: String, default: '' },
  },
  data() {
    return {
      buildTag: 'rd2-1647',
      connId: null,
      status: 'idle',
      localPath: '',
      localPathInput: '',
      localHome: '',
      localItems: [],
      localSel: '',
      localLoading: false,
      remotePath: '/',
      remotePathInput: '/',
      remoteHome: '/',
      remoteItems: [],
      remoteSel: '',
      remoteLoading: false,
      tasks: [],
      dropHi: '',
      dragPayload: null,
      ctx: { visible: false, x: 0, y: 0, items: [], side: '', item: null },
      offProgress: null,
      topPct: 58,
      leftPct: 50,
      _split: null,
      _pollTimer: null,
      _dropLock: {},
      _lastDrag: null,
    };
  },
  computed: {
    statusText() {
      const map = {
        idle: t('sftp.status.idle'),
        connecting: t('sftp.status.connecting'),
        ready: t('sftp.status.ready'),
        error: t('sftp.status.error'),
      };
      return map[this.status] || this.status;
    },
    winTitle() {
      return `${this.assetName || this.host || 'SFTP'} · SFTP · ${this.host}:${this.port}`;
    },
  },
  watch: {
    winTitle: {
      immediate: true,
      handler(v) {
        if (typeof document !== 'undefined') {
          document.title = `${v} · ${this.buildTag}`;
        }
      },
    },
  },
  async mounted() {
    document.title = `${this.winTitle} · ${this.buildTag}`;
    this.pushDlog(`mounted UI=${this.buildTag}`);
    this._onWinErr = (msg) => {
      this.pushDlog('window.onerror ' + msg);
    };
    window.addEventListener('error', this._onWinErr);
    this.offProgress =
      api.onSftpProgress &&
      api.onSftpProgress((p) => {
        if (!p || !p.taskId) return;
        this.mergeTask(p);
      });
    this._offSshState =
      api.onSshState &&
      api.onSshState((ev) => {
        if (!ev) return;
        if (ev.type === 'drag-preparing') {
          this.pushDlog('drag-preparing ' + (ev.message || ''));
        }
        if (ev.type === 'drag-error') {
          this.pushDlog('drag-error ' + (ev.message || ''));
          this.$message.error(ev.message || '拖出失败');
        }
      });
    this._offDragReady =
      api.onSftpDragReady &&
      api.onSftpDragReady((p) => {
        this.pushDlog('drag-ready ' + (p && (p.localPath || p.name)));
        this.$message.success(t('sftp.dragReady'));
      });
    this.pushDlog('mounted sftp page');

    this._nativeDragOver = (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    this._nativeDrop = (e) => {
      e.preventDefault();
      const el = e.target;
      const inZone = el && el.closest && el.closest('.sftp-panel, .file-list, .file-row');
      if (inZone) return; // panel @drop handles it
      this.runDrop(e, null);
    };
    this._nativeDragEnter = (e) => {
      e.preventDefault();
    };
    // document capture — must see OS Explorer drops too
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
      this.pushDlog(`doc-drop inZone=${!!inZone}`);
      e.preventDefault();
      // Panels handle their own drops; document only covers leftover areas
      if (inZone) return;
      this.runDrop(e, null);
    };
    document.addEventListener('dragover', this._docOver, true);
    document.addEventListener('drop', this._docDrop, true);

    this.$nextTick(() => {
      const root = this.$refs.root;
      if (root) {
        root.addEventListener('dragenter', this._nativeDragEnter, false);
        root.addEventListener('dragover', this._nativeDragOver, false);
        root.addEventListener('drop', this._nativeDrop, false);
      }
    });
    await this.boot();
    this._pollTimer = setInterval(() => this.syncTasks(), 1000);
    window.addEventListener('beforeunload', this.onUnload);
  },
  beforeDestroy() {
    window.removeEventListener('beforeunload', this.onUnload);
    if (this._onWinErr) window.removeEventListener('error', this._onWinErr);
    const root = this.$refs.root;
    if (root) {
      if (this._nativeDragEnter) root.removeEventListener('dragenter', this._nativeDragEnter);
      if (this._nativeDragOver) root.removeEventListener('dragover', this._nativeDragOver);
      if (this._nativeDrop) root.removeEventListener('drop', this._nativeDrop);
    }
    if (this._docOver) document.removeEventListener('dragover', this._docOver, true);
    if (this._docDrop) document.removeEventListener('drop', this._docDrop, true);
    document.removeEventListener('mousemove', this.onSplitMove);
    document.removeEventListener('mouseup', this.onSplitUp);
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this.offProgress) this.offProgress();
    if (this.connId && api.sftpClose) api.sftpClose(this.connId).catch(() => {});
  },
  methods: {
    pushDlog(msg) {
      // debug only — no on-screen overlay
      console.log('[sftp]', new Date().toLocaleTimeString(), this.buildTag, msg);
    },
    isTaskFinished(row) {
      return row.status === 'done' || row.status === 'error' || row.status === 'canceled';
    },
    progressText(row) {
      return `${row.percent || 0}%`;
    },
    shortErr(row) {
      const e = String(row.error || '传输失败');
      return e.length > 48 ? e.slice(0, 48) + '…' : e;
    },
    mergeTask(p) {
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
        list.forEach((x) => {
          map[x.taskId] = x;
        });
        const merged = this.tasks.filter((x) => map[x.taskId]).map((x) => ({ ...x, ...map[x.taskId] }));
        list.forEach((x) => {
          if (!merged.find((m) => m.taskId === x.taskId)) merged.push(x);
        });
        this.tasks = merged.filter((x) => x.status !== 'done');
      } catch (_) {}
    },
    onUnload() {
      if (this.connId && api.sftpClose) api.sftpClose(this.connId).catch(() => {});
    },
    async boot() {
      if (!api.sftpOpen) {
        this.status = 'error';
        return;
      }
      this.status = 'connecting';
      try {
        const local = unwrap(await api.sftpLocalList());
        this.localHome = local.home || local.path;
        await this.goLocal(local.path || this.localHome);
        const r = unwrap(await api.sftpOpen({ assetId: this.assetId }));
        this.connId = r.connId;
        this.remoteHome = r.home || '/';
        this.status = 'ready';
        await this.goRemote(this.remoteHome);
        await this.syncTasks();
      } catch (e) {
        this.status = 'error';
        this.$message.error(e.message || String(e));
      }
    },

    startSplit(type) {
      this._split = type;
      document.addEventListener('mousemove', this.onSplitMove);
      document.addEventListener('mouseup', this.onSplitUp);
    },
    onSplitMove(e) {
      const root = this.$refs.root;
      if (!root || !this._split) return;
      const rect = root.getBoundingClientRect();
      if (this._split === 'h') {
        const pct = ((e.clientY - rect.top) / rect.height) * 100;
        this.topPct = Math.min(78, Math.max(28, pct));
      } else {
        const panels = this.$refs.panels;
        const prect = panels ? panels.getBoundingClientRect() : rect;
        const pct = ((e.clientX - prect.left) / prect.width) * 100;
        this.leftPct = Math.min(72, Math.max(28, pct));
      }
    },
    onSplitUp() {
      this._split = null;
      document.removeEventListener('mousemove', this.onSplitMove);
      document.removeEventListener('mouseup', this.onSplitUp);
    },
    closeCtx() {
      this.ctx.visible = false;
    },

    /** keep loading visible long enough for the user to see the animation */
    async minLoading(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms || 320));
    },

    async goLocal(p) {
      if (this.localLoading) return;
      const t0 = Date.now();
      this.localLoading = true;
      try {
        const r = unwrap(await api.sftpLocalList(p));
        const cost = Date.now() - t0;
        if (cost < 320) await this.minLoading(320 - cost);
        this.localPath = r.path;
        this.localPathInput = r.path;
        if (r.home) this.localHome = r.home;
        const items = (r.items || []).filter((x) => x.name !== '.' && x.name !== '..');
        this.localItems = [PARENT_ROW, ...items];
        this.localSel = '';
      } catch (e) {
        this.$message.error(e.message);
      } finally {
        this.localLoading = false;
      }
    },
    async goRemote(p) {
      if (!this.connId || this.remoteLoading) return;
      const target = p || '/';
      const t0 = Date.now();
      this.remoteLoading = true;
      try {
        const r = unwrap(await api.sftpList(this.connId, target));
        const cost = Date.now() - t0;
        if (cost < 320) await this.minLoading(320 - cost);
        this.remotePath = r.path || target;
        this.remotePathInput = this.remotePath;
        const items = (r.items || []).filter((x) => x.name !== '.' && x.name !== '..');
        this.remoteItems = [PARENT_ROW, ...items];
        this.remoteSel = '';
      } catch (e) {
        this.$message.error(e.message);
      } finally {
        this.remoteLoading = false;
      }
    },
    localUp() {
      this.goLocal(parentLocal(this.localPath) || this.localHome);
    },
    remoteUp() {
      this.goRemote(parentRemote(this.remotePath));
    },
    onLocalDbl(f) {
      if (f.isParent) return this.localUp();
      if (f.isDir) return this.goLocal(joinLocal(this.localPath, f.name));
      this.uploadPaths([joinLocal(this.localPath, f.name)]);
    },
    onRemoteDbl(f) {
      if (f.isParent) return this.remoteUp();
      if (f.isDir) return this.goRemote(joinRemote(this.remotePath, f.name));
      this.downloadPaths([joinRemote(this.remotePath, f.name)]);
    },

    onBlankCtx(e, side) {
      const items = [{ act: 'mkdir', label: t('sftp.mkdir') }];
      if (side === 'remote') items.push({ act: 'paste', label: t('sftp.paste') });
      this.ctx = { visible: true, x: e.clientX, y: e.clientY, side, item: null, items };
    },
    onItemCtx(e, side, f) {
      if (side === 'local') this.localSel = f.name;
      else this.remoteSel = f.name;
      const items = [
        { act: 'rename', label: t('sftp.rename') },
        { act: 'delete', label: t('sftp.delete'), danger: true },
      ];
      if (side === 'remote' && !f.isParent) {
        items.unshift({ act: 'download-here', label: t('sftp.downloadHere') });
        items.unshift({ act: 'download-to', label: t('sftp.downloadTo') });
      }
      this.ctx = { visible: true, x: e.clientX, y: e.clientY, side, item: f, items };
    },
    async runCtx(it) {
      const { side, item } = this.ctx;
      this.closeCtx();
      try {
        if (it.act === 'download-here' && item) {
          const remotePath = joinRemote(this.remotePath, item.name);
          if (item.isDir) {
            const localRoot = joinLocal(this.localPath, item.name);
            await api.sftpLocalMkdir(this.localPath, item.name);
            await this.downloadRemoteDir(remotePath, localRoot);
            this.$message.success(t('sftp.downloadDone'));
            this.goLocal(this.localPath);
          } else {
            await this.startDownload(remotePath, joinLocal(this.localPath, item.name));
            this.$message.success(t('sftp.taskQueued'));
            this.syncTasks();
            setTimeout(() => this.goLocal(this.localPath), 400);
          }
          return;
        }
        if (it.act === 'download-to' && item) {
          let dir = this.localPath;
          if (api.sftpPickLocalDir) {
            const picked = unwrap(await api.sftpPickLocalDir());
            if (picked) dir = picked;
          }
          const remotePath = joinRemote(this.remotePath, item.name);
          if (item.isDir) {
            const localRoot = joinLocal(dir, item.name);
            await api.sftpLocalMkdir(dir, item.name);
            await this.downloadRemoteDir(remotePath, localRoot);
            this.$message.success(t('sftp.downloadDone'));
          } else {
            await this.startDownload(remotePath, joinLocal(dir, item.name));
            this.$message.success(t('sftp.taskQueued'));
            this.syncTasks();
          }
          return;
        }
        if (it.act === 'paste') {
          if (!api.sftpClipboardFiles) {
            this.$message.error(t('msg.needElectron'));
            return;
          }
          const files = unwrap(await api.sftpClipboardFiles());
          if (!files || !files.length) {
            this.$message.warning(t('sftp.clipboardEmpty'));
            return;
          }
          await this.uploadPaths(files, this.remotePath);
          return;
        }
        if (it.act === 'mkdir') {
          const r = await this.$prompt(t('sftp.mkdirName'), t('sftp.mkdir'), {
            confirmButtonText: t('msg.confirm'),
            cancelButtonText: t('msg.cancel'),
            inputValue: 'new-folder',
          });
          const name = r && r.value ? String(r.value).trim() : '';
          if (!name) return;
          if (side === 'local') {
            unwrap(await api.sftpLocalMkdir(this.localPath, name));
            await this.goLocal(this.localPath);
          } else {
            unwrap(await api.sftpMkdir(this.connId, joinRemote(this.remotePath, name)));
            await this.goRemote(this.remotePath);
          }
          return;
        }
        if (it.act === 'rename' && item) {
          const r = await this.$prompt(t('sftp.renameTo'), t('sftp.rename'), {
            confirmButtonText: t('msg.confirm'),
            cancelButtonText: t('msg.cancel'),
            inputValue: item.name,
          });
          const neu = r && r.value ? String(r.value).trim() : '';
          if (!neu || neu === item.name) return;
          if (side === 'local') {
            unwrap(await api.sftpLocalRename(joinLocal(this.localPath, item.name), joinLocal(this.localPath, neu)));
            await this.goLocal(this.localPath);
          } else {
            unwrap(await api.sftpRename(this.connId, joinRemote(this.remotePath, item.name), joinRemote(this.remotePath, neu)));
            await this.goRemote(this.remotePath);
          }
          return;
        }
        if (it.act === 'delete' && item) {
          await this.$confirm(t('sftp.confirmDelete', { name: item.name }), t('msg.confirm'), { type: 'warning' });
          if (side === 'local') {
            unwrap(await api.sftpLocalUnlink(joinLocal(this.localPath, item.name), item.isDir));
            await this.goLocal(this.localPath);
          } else {
            unwrap(await api.sftpUnlink(this.connId, joinRemote(this.remotePath, item.name), item.isDir));
            await this.goRemote(this.remotePath);
          }
        }
      } catch (err) {
        if (err !== 'cancel' && err !== 'close') this.$message.error(err.message || String(err));
      }
    },

    /* ========== drag & drop — restore first-working panel+list zones ========== */
    onDragStart(e, side, f) {
      if (!f || f.isParent) {
        e.preventDefault();
        return false;
      }
      const pathVal =
        side === 'local' ? joinLocal(this.localPath, f.name) : joinRemote(this.remotePath, f.name);
      const payload = {
        side,
        name: f.name,
        isDir: !!f.isDir,
        path: pathVal,
      };
      this.dragPayload = payload;
      this._lastDrag = payload;
      try {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', pathVal);
        e.dataTransfer.setData('text/omnidesk-sftp', JSON.stringify(payload));
      } catch (_) {}
      // HTML5 only — in-app drop. Do NOT auto-download to temp on dragstart.
      this.pushDlog(`dragstart ${payload.side} ${payload.path}`);
      return true;
    },
    onDragEnd() {
      this.dropHi = '';
      // keep _lastDrag until drop handled; clear payload late
      setTimeout(() => {
        this.dragPayload = null;
      }, 100);
      setTimeout(() => {
        this._lastDrag = null;
      }, 4000);
    },
    onZoneDragOver(e, zoneSide) {
      e.preventDefault();
      try {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      } catch (_) {}
      const payload = this._lastDrag || this.dragPayload;
      if (!payload || payload.side === zoneSide) {
        // still allow OS file drops into remote
        if (zoneSide === 'remote' && e.dataTransfer && e.dataTransfer.types) {
          const types = Array.from(e.dataTransfer.types || []);
          if (types.indexOf('Files') >= 0) {
            try {
              e.dataTransfer.dropEffect = 'copy';
            } catch (_) {}
          }
        }
        return;
      }
      const el = e.target && e.target.closest ? e.target.closest('.file-row') : null;
      if (el && el.getAttribute('data-isdir') === '1' && el.getAttribute('data-parent') !== '1') {
        this.dropHi = (zoneSide === 'local' ? 'l:' : 'r:') + (el.getAttribute('data-name') || '');
      } else {
        this.dropHi = '';
      }
    },
    onRowOver(e, targetSide, f) {
      this.onZoneDragOver(e, targetSide);
      if (f && f.isDir && !f.isParent && targetSide) {
        const payload = this._lastDrag || this.dragPayload;
        if (payload && payload.side !== targetSide) {
          this.dropHi = (targetSide === 'local' ? 'l:' : 'r:') + f.name;
        }
      }
    },
    onZoneDrop(e, zoneSide) {
      e.preventDefault();
      e.stopPropagation();
      const payload = this._lastDrag || this.dragPayload;
      this.pushDlog(
        `zone-drop ${zoneSide} p=${payload ? payload.side : 'null'} conn=${this.connId || 'null'} isDir=${payload ? !!payload.isDir : '-'}`
      );

      // Common case: remote file → local panel (do not go through runDrop maze)
      if (
        payload &&
        zoneSide === 'local' &&
        payload.side === 'remote' &&
        !payload.isDir &&
        this.connId
      ) {
        const destDir = this.localPath || 'D:\\';
        const fname =
          payload.name || String(payload.path || '').split('/').filter(Boolean).pop() || 'download.bin';
        const localPath = destDir.replace(/[\\/]+$/, '') + '\\' + fname;
        this.pushDlog(`zone-drop DIRECT download -> ${localPath}`);
        this._lastDrag = null;
        this.dragPayload = null;
        this.startDownload(payload.path, localPath)
          .then(() => {
            this.pushDlog('zone-drop DIRECT done');
            return this.syncTasks();
          })
          .catch((err) => {
            this.pushDlog('zone-drop DIRECT fail ' + (err && err.message));
            this.$message.error(err.message || String(err));
          });
        return;
      }

      // Common case: local file → remote panel
      if (
        payload &&
        zoneSide === 'remote' &&
        payload.side === 'local' &&
        !payload.isDir &&
        this.connId
      ) {
        const destDir = this.remotePath || '/';
        const fname =
          payload.name || String(payload.path || '').split(/[\\/]/).filter(Boolean).pop() || 'upload.bin';
        const remotePath = (destDir === '/' ? '' : destDir.replace(/\/+$/, '')) + '/' + fname;
        this.pushDlog(`zone-drop DIRECT upload -> ${remotePath}`);
        this._lastDrag = null;
        this.dragPayload = null;
        this.startUpload(payload.path, remotePath)
          .then(() => {
            this.pushDlog('zone-drop DIRECT done');
            return this.syncTasks();
          })
          .catch((err) => {
            this.pushDlog('zone-drop DIRECT fail ' + (err && err.message));
            this.$message.error(err.message || String(err));
          });
        return;
      }

      this.runDrop(e, zoneSide);
    },
    onRootDragOver() {},
    /** Single drop path used by panel zones (and rare document fallback) */
    async runDrop(e, zoneSide) {
      this.dropHi = '';
      const payload = this._lastDrag || this.dragPayload;
      this.pushDlog(`*** RUNDROP *** zone=${zoneSide || '-'} payload=${payload ? payload.side + ':' + payload.path : 'null'}`);

      const dest =
        zoneSide === 'remote' ? this.remotePath : zoneSide === 'local' ? this.localPath : null;

      // no zone hint → detect from element under cursor
      let tSide = zoneSide;
      let dropDest = dest;
      if (!tSide) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const zone =
          el && el.closest
            ? el.closest('.sftp-panel[data-side], .file-list[data-side], .file-row[data-side]')
            : null;
        tSide = zone && zone.getAttribute ? zone.getAttribute('data-side') : null;
        if (!tSide) {
          this.$message.warning('请拖到「本机文件」或「服务器文件」区域');
          return;
        }
        dropDest = tSide === 'remote' ? this.remotePath : this.localPath;
        const row = el && el.closest ? el.closest('.file-row') : null;
        if (
          row &&
          row.getAttribute('data-isdir') === '1' &&
          row.getAttribute('data-parent') !== '1'
        ) {
          const name = row.getAttribute('data-name');
          if (name) {
            dropDest =
              tSide === 'remote'
                ? joinRemote(this.remotePath, name)
                : joinLocal(this.localPath, name);
          }
        }
      } else if (!dropDest) {
        dropDest = tSide === 'remote' ? this.remotePath : this.localPath;
      }

      // dropped onto a folder row in the zone
      const rowEl = e.target && e.target.closest ? e.target.closest('.file-row') : null;
      if (
        rowEl &&
        rowEl.getAttribute('data-isdir') === '1' &&
        rowEl.getAttribute('data-parent') !== '1'
      ) {
        const name = rowEl.getAttribute('data-name');
        if (name && zoneSide) {
          dropDest =
            tSide === 'remote'
              ? joinRemote(this.remotePath, name)
              : joinLocal(this.localPath, name);
        }
      }

      this.pushDlog(`runDrop dest=${tSide}:${dropDest} conn=${this.connId || 'null'} isDir=${payload ? !!payload.isDir : '-'} side=${payload ? payload.side : '-'}`);

      if (!payload) {
        this.pushDlog('runDrop no payload');
        this.$message.warning('未识别到拖拽内容，请从列表按住文件拖入');
        return;
      }
      if (payload.side === tSide) {
        this.pushDlog('runDrop same-side skip');
        return;
      }
      if (!this.connId) {
        this.pushDlog('runDrop no connId, reopen session');
        try {
          const r = unwrap(await api.sftpOpen({ assetId: this.assetId }));
          this.connId = r.connId;
          this.status = 'ready';
          this.pushDlog('runDrop reconnected conn=' + this.connId);
        } catch (err) {
          this.pushDlog('runDrop reconnect fail ' + (err && err.message));
          this.$message.error(err.message || t('sftp.status.idle'));
          return;
        }
      }

      const lockKey = `${payload.side}:${payload.path}>${tSide}:${dropDest}`;
      if (this._dropLock[lockKey]) {
        this.pushDlog('runDrop dup skip');
        return;
      }
      this._dropLock[lockKey] = true;
      setTimeout(() => {
        delete this._dropLock[lockKey];
      }, 1500);

      try {
        if (payload.side === 'remote' && tSide === 'local' && !payload.isDir) {
          const localPath = joinLocal(dropDest, payload.name || payload.path.split('/').pop());
          this.pushDlog(`runDrop DOWNLOAD ${payload.path} -> ${localPath}`);
          await this.startDownload(payload.path, localPath);
          this.pushDlog('runDrop download API returned');
          this.syncTasks();
        } else if (payload.side === 'local' && tSide === 'remote' && !payload.isDir) {
          const remotePath = joinRemote(dropDest, payload.name || payload.path.split(/[\\/]/).pop());
          this.pushDlog(`runDrop UPLOAD ${payload.path} -> ${remotePath}`);
          await this.startUpload(payload.path, remotePath);
          this.pushDlog('runDrop upload API returned');
          this.syncTasks();
        } else {
          this.pushDlog('runDrop folder transfer');
          if (tSide === 'remote') await this.uploadLocalPayload(payload, dropDest);
          else await this.downloadRemotePayload(payload, dropDest);
          this.syncTasks();
        }
      } catch (err) {
        this.pushDlog('runDrop fail ' + (err && err.message));
        this.$message.error(err.message || String(err));
      } finally {
        this._lastDrag = null;
        this.dragPayload = null;
      }
    },
    filePathOf(file) {
      if (!file) return '';
      try {
        if (api.getPathForFile) {
          const p = api.getPathForFile(file);
          if (p) return p;
        }
      } catch (_) {}
      try {
        return file.path || '';
      } catch (_) {
        return '';
      }
    },
    collectExternalPaths(e) {
      const out = [];
      const seen = {};
      const push = (p, name) => {
        if (!p || seen[p]) return;
        seen[p] = 1;
        out.push({
          side: 'external',
          name: name || String(p).split(/[\\/]/).pop(),
          isDir: false,
          path: p,
        });
      };
      try {
        const dt = e.dataTransfer;
        if (!dt) return out;
        if (dt.files && dt.files.length) {
          for (let i = 0; i < dt.files.length; i++) {
            const file = dt.files[i];
            push(this.filePathOf(file), file && file.name);
          }
        }
        if (!out.length && dt.items && dt.items.length) {
          for (let i = 0; i < dt.items.length; i++) {
            const it = dt.items[i];
            if (it && it.kind === 'file') {
              const file = it.getAsFile && it.getAsFile();
              push(this.filePathOf(file), file && file.name);
            }
          }
        }
        // Windows often puts the absolute path into text/plain (first working version)
        if (!out.length) {
          const txt = dt.getData('text/plain') || '';
          const uri = dt.getData('text/uri-list') || '';
          const candidates = [];
          if (txt) candidates.push(txt);
          if (uri) {
            uri.split(/\r?\n/).forEach((line) => {
              if (line.indexOf('file://') === 0) {
                let p = decodeURIComponent(line.slice(7)).replace(/\//g, '\\');
                if (/^\\[A-Za-z]:/.test(p)) p = p.slice(1);
                candidates.push(p);
              }
            });
          }
          candidates.forEach((raw) => {
            const line = String(raw).trim();
            if (!line || line.charAt(0) === '{') return;
            if (/^[A-Za-z]:[\\/]/.test(line) || line.indexOf('\\\\') === 0) {
              // may contain multiple paths separated by newline
              line.split(/\r?\n/).forEach((one) => {
                const p = one.trim();
                if (/^[A-Za-z]:[\\/]/.test(p) || p.indexOf('\\\\') === 0) push(p);
              });
            }
          });
        }
      } catch (err) {
        console.warn('[sftp] collectExternalPaths', err);
      }
      return out;
    },
    readInternalPayload(e) {
      if (this._lastDrag) return this._lastDrag;
      if (this.dragPayload) return this.dragPayload;
      try {
        const dt = e && e.dataTransfer;
        if (!dt) return null;
        const custom = dt.getData('text/omnidesk-sftp');
        if (custom && custom.charAt(0) === '{') {
          try {
            return JSON.parse(custom);
          } catch (_) {}
        }
        const txt = (dt.getData('text/plain') || '').trim();
        if (txt && txt.charAt(0) === '{') {
          try {
            return JSON.parse(txt);
          } catch (_) {}
        }
        if (txt && /^[A-Za-z]:[\\/]/.test(txt) && this.localPath && txt.indexOf(this.localPath) === 0) {
          return {
            side: 'local',
            name: txt.split(/[\\/]/).pop(),
            isDir: false,
            path: txt,
          };
        }
      } catch (_) {}
      return null;
    },
    resolveZone(e, hintSide) {
      if (hintSide) {
        const dest = hintSide === 'remote' ? this.remotePath : this.localPath;
        const el = e.target && e.target.closest ? e.target.closest('.file-row') : null;
        let d = dest;
        let dropName = '';
        if (el) {
          const isDir = el.getAttribute('data-isdir') === '1';
          const isParent = el.getAttribute('data-parent') === '1';
          const name = el.getAttribute('data-name');
          dropName = name || '';
          if (isDir && !isParent && name) {
            d = hintSide === 'remote' ? joinRemote(this.remotePath, name) : joinLocal(this.localPath, name);
          }
        }
        return { tSide: hintSide, dest: d, dropName };
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const zone =
        el && el.closest
          ? el.closest('[data-side].sftp-panel, [data-side].file-list, [data-side].file-row')
          : null;
      if (!zone) return null;
      let node = zone;
      let tSide = node.getAttribute && node.getAttribute('data-side');
      while (!tSide && node.parentElement) {
        node = node.parentElement;
        tSide = node.getAttribute && node.getAttribute('data-side');
      }
      if (!tSide) return null;
      const dest = tSide === 'remote' ? this.remotePath : this.localPath;
      const row = el && el.closest ? el.closest('.file-row') : null;
      let d = dest;
      let dropName = '';
      if (row) {
        const isDir = row.getAttribute('data-isdir') === '1';
        const isParent = row.getAttribute('data-parent') === '1';
        const name = row.getAttribute('data-name');
        dropName = name || '';
        if (isDir && !isParent && name) {
          d = tSide === 'remote' ? joinRemote(this.remotePath, name) : joinLocal(this.localPath, name);
        }
      }
      return { tSide, dest: d, dropName };
    },
    async handleDropEvent(e, zoneSide) {
      // one handler per DOM drop event (zone + document may both fire)
      if (e && e._omniHandled) return;
      if (e) e._omniHandled = true;
      this.dropHi = '';
      this.pushDlog(`drop enter zone=${zoneSide || '-'}`);

      let target = null;
      let internal = null;
      let external = [];
      try {
        target = this.resolveZone(e, zoneSide);
        internal = this.readInternalPayload(e);
        external = this.collectExternalPaths(e);
      } catch (err) {
        this.pushDlog('drop err ' + (err && err.message));
        this.$message.error(err.message || String(err));
        return;
      }

      this.pushDlog(
        `drop zone=${zoneSide || '-'} side=${(target && target.tSide) || 'none'} internal=${(internal && internal.path) || '-'} ext=${external.length}`
      );

      if (!target) {
        this.$message.warning('请拖到「本机文件」或「服务器文件」列表区域');
        return;
      }

      // OS files from Explorer
      if (external.length) {
        if (target.tSide === 'local') {
          let ok = 0;
          for (const item of external) {
            try {
              if (api.sftpLocalCopy) {
                unwrap(await api.sftpLocalCopy(item.path, target.dest));
              } else {
                await this.startDownload(item.path, joinLocal(target.dest, item.name));
              }
              ok += 1;
            } catch (err) {
              this.$message.error(`${item.name}: ${err.message || err}`);
            }
          }
          if (ok) {
            this.pushDlog('copy external → local ok');
            this.$message.success(t('sftp.downloadDone'));
            setTimeout(() => this.goLocal(target.dest), 400);
          }
          this._lastDrag = null;
          return;
        }
        if (!this.connId) {
          this.$message.error(t('sftp.status.idle'));
          return;
        }
        let ok = 0;
        for (const item of external) {
          try {
            await this.startUpload(item.path, joinRemote(target.dest, item.name));
            ok += 1;
          } catch (err) {
            this.$message.error(`${item.name}: ${err.message || err}`);
          }
        }
        if (ok) {
          this.$message.success(t('sftp.taskQueued'));
          setTimeout(() => this.goRemote(target.dest), 400);
          this.syncTasks();
        }
        this._lastDrag = null;
        return;
      }

      if (!internal) {
        this.pushDlog('drop no payload');
        this.$message.warning('未识别到拖拽内容，请从列表按住文件拖入，或双击/右键下载');
        this._lastDrag = null;
        return;
      }
      if (internal.side === target.tSide) {
        this.pushDlog('drop same-side ignore');
        this._lastDrag = null;
        return;
      }

      const key = `${internal.side}:${internal.path}>${target.tSide}:${target.dest}`;
      if (this._dropLock[key]) {
        this.pushDlog('drop dup-ignore');
        return;
      }
      this._dropLock[key] = true;
      setTimeout(() => {
        delete this._dropLock[key];
      }, 1200);

      try {
        // file remote → local: download into the folder user dropped on
        if (internal.side === 'remote' && target.tSide === 'local' && !internal.isDir) {
          this.pushDlog(`download file → ${target.dest}`);
          await this.downloadPaths([internal.path], target.dest);
          this._lastDrag = null;
          return;
        }
        // file local → remote
        if (internal.side === 'local' && target.tSide === 'remote' && !internal.isDir) {
          this.pushDlog(`upload file → ${target.dest}`);
          await this.uploadPaths([internal.path], target.dest);
          this._lastDrag = null;
          return;
        }
        // folders
        await this.dispatchTransfer(internal, target.tSide, target.dest);
        this._lastDrag = null;
      } catch (err) {
        this.pushDlog('drop fail ' + (err && err.message));
        this.$message.error(err.message || String(err));
        this._lastDrag = null;
      }
    },
    async onRootDrop(e) {
      const el = e.target;
      const inZone = el && el.closest && el.closest('.sftp-panel, .file-list, .file-row');
      if (inZone) return;
      this.runDrop(e, null);
    },
    async handleDropEvent(e, zoneSide) {
      return this.runDrop(e, zoneSide);
    },
    async dispatchTransfer(payload, targetSide, dest) {
      if (!this.connId) {
        this.$message.error(t('sftp.status.idle'));
        return;
      }
      this.pushDlog(`dispatch ${payload.side}→${targetSide} ${payload.name || payload.path}`);
      try {
        if (targetSide === 'remote') await this.uploadLocalPayload(payload, dest);
        else await this.downloadRemotePayload(payload, dest);
      } catch (err) {
        this.$message.error(err.message || String(err));
      }
    },

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
      try {
        const walk = unwrap(await api.sftpWalkLocal(payload.path, joinRemote(remoteDir, payload.name)));
        for (const node of walk) {
          if (node.type === 'dir') {
            try {
              await api.sftpMkdir(this.connId, node.remotePath);
            } catch (_) {}
          } else {
            await this.startUpload(node.localPath, node.remotePath);
          }
        }
        this.$message.success(t('sftp.taskQueued'));
        setTimeout(() => this.goRemote(this.remotePath), 400);
        this.syncTasks();
      } catch (e) {
        this.$message.error(e.message);
      }
    },
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
    async togglePause(task) {
      if (this.isTaskFinished(task)) return;
      const pause = task.status !== 'paused';
      try {
        unwrap(await api.sftpPause(task.taskId, pause));
        this.mergeTask({ ...task, status: pause ? 'paused' : 'running' });
        this.syncTasks();
      } catch (e) {
        this.$message.error(e.message);
      }
    },
    async removeTask(task) {
      try {
        unwrap(await api.sftpCancel(task.taskId));
        this.tasks = this.tasks.filter((x) => x.taskId !== task.taskId);
        this.syncTasks();
      } catch (e) {
        this.$message.error(e.message);
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
.sftp-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border, #2a3544);
  border-radius: 8px;
  background: var(--bg-panel, #151b24);
  overflow: hidden;
  box-sizing: border-box;
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
  margin: 2px 8px;
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
.panel-head {
  padding: 8px;
  border-bottom: 1px solid var(--border, #2a3544);
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 0 0 auto;
}
.panel-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
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
.path-bar {
  display: flex;
  gap: 4px;
  align-items: center;
}
.path-icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}
.path-icon-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.path-icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.path-icon-btn.spinning svg {
  animation: sftp-spin 0.8s linear infinite;
}
@keyframes sftp-spin {
  to {
    transform: rotate(360deg);
  }
}
.file-head,
.file-row {
  display: grid;
  grid-template-columns: 1fr 90px 150px;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  align-items: center;
}
.file-head {
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.file-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  position: relative;
}
.file-list /deep/ .el-loading-mask {
  background-color: rgba(15, 20, 25, 0.55) !important;
  z-index: 5;
}
.file-list /deep/ .el-loading-spinner .el-loading-text {
  color: var(--text-2, #8b9bb0);
  margin: 8px 0 0;
}
.file-list /deep/ .el-loading-spinner svg path,
.file-list /deep/ .el-loading-spinner i {
  color: var(--accent, #409eff);
  font-size: 22px;
}
.file-row {
  cursor: default;
  color: var(--text-2);
  font-family: Consolas, monospace;
}
.file-row:not(.parent) {
  cursor: grab;
  -webkit-user-drag: element;
  user-select: none;
}
.file-row:hover {
  background: var(--bg-hover);
}
.file-row.sel {
  background: var(--accent-soft);
  color: var(--accent);
}
.file-row.drop-hi {
  outline: 1px dashed var(--accent);
  background: var(--accent-soft);
}
.file-row.parent {
  color: var(--text-3);
  font-style: italic;
}
.c-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f-ico {
  margin-right: 4px;
}
.sftp-tasks {
  flex: 1 1 auto;
  min-height: 100px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 8px 8px;
  box-sizing: border-box;
}
.tasks-head {
  padding: 8px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  flex: 0 0 auto;
}
.tasks-table-wrap {
  flex: 1;
  min-height: 0;
}
.sftp-el-table {
  height: 100%;
  background: transparent;
}
.sftp-el-table /deep/ .el-table__header-wrapper th,
.sftp-el-table /deep/ .el-table__body-wrapper td {
  background: transparent;
  color: var(--text-2);
  border-color: var(--border) !important;
}
.sftp-el-table /deep/ .el-table__header-wrapper th {
  color: var(--text-3);
}
.sftp-el-table /deep/ .el-table--border,
.sftp-el-table /deep/ .el-table--group {
  border-color: var(--border) !important;
}
.sftp-el-table /deep/ .el-table__body tr:hover > td {
  background: var(--bg-hover) !important;
}
.prog-line {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  min-width: 0;
}
.prog-wrap {
  flex: 1 1 auto;
  min-width: 48px;
  height: 6px;
  border-radius: 3px;
  background: var(--bg-elevated);
  overflow: hidden;
}
.prog-bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s linear;
}
.prog-num {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
  min-width: 40px;
  text-align: right;
}
.err-line {
  margin-top: 2px;
  font-size: 10px;
  color: #f56c6c;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.op-icon-btn {
  width: 26px;
  height: 26px;
  margin: 0 2px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  vertical-align: middle;
}
.op-icon-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.op-icon-btn.danger:hover:not(:disabled) {
  color: #f56c6c;
  border-color: #f56c6c;
}
.op-icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
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
</style>
