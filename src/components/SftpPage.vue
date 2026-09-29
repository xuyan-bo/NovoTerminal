<template>
  <div
    ref="root"
    class="sftp-root"
    @click="closeCtx"
    @dragover.prevent="onRootDragOver"
    @drop.prevent="onRootDrop"
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

      <sftp-file-panel
        side="remote"
        :style="{ width: (100 - leftPct) + '%' }"
        :items="remoteItems"
        :path-input="remotePathInput"
        :selected="remoteSel"
        :sort="remoteSort"
        :loading="remoteLoading"
        :drop-hi="dropHi"
        :refresh-disabled="!connId"
        @path-input="remotePathInput = $event"
        @select="onRowSelect"
        @marquee="onMarquee"
        @blank-click="onBlankClick"
        @sort-change="onSortChange"
        @navigate="goRemote"
        @up="remoteUp"
        @home="goRemote(remoteHome || '/')"
        @refresh="goRemote(remotePath)"
        @item-dbl="onRemoteDbl"
        @blank-context="onBlankCtx"
        @item-context="onItemCtx"
        @drag-start="onDragStart"
        @drag-end="onDragEnd"
        @drag-over="onZoneDragOver"
        @row-over="onRowOver"
        @drag-leave="dropHi = ''"
        @zone-drop="onZoneDrop"
      >
        <span slot="connection" class="conn-tag" :class="status">{{ statusText }}</span>
      </sftp-file-panel>
    </div>

    <div class="splitter splitter-h" @mousedown.prevent="startSplit('h', $event)"></div>

    <sftp-transfer-queue
      :style="{ height: (100 - topPct) + '%' }"
      :tasks="tasks"
      :expanded-keys="expandedKeys"
      @expand-change="onExpandChange"
      @load-children="loadTreeChildren"
      @toggle-pause="togglePause"
      @remove-task="removeTask"
    />

    <div v-if="ctx.visible" class="sftp-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @click.stop>
      <div
        v-for="it in ctx.items"
        :key="it.act"
        class="sftp-ctx-item"
        :class="{ danger: it.danger, disabled: it.disabled }"
        @click="!it.disabled && runCtx(it)"
      >{{ it.label }}</div>
    </div>
  </div>
</template>

<script>
import { api, unwrap } from '../store';
import { t } from '../i18n';
import SftpFilePanel from './sftp/SftpFilePanel.vue';
import SftpTransferQueue from './sftp/SftpTransferQueue.vue';
import { PARENT_ROW, joinLocal, joinRemote, parentLocal, parentRemote, normalizeRemotePath, sortItems } from './sftp/utils';
import taskMethods from './sftp/taskMethods';
import transferMethods from './sftp/transferMethods';
import dragDropMethods from './sftp/dragDropMethods';
import selectionMethods from './sftp/selectionMethods';

export default {
  name: 'SftpPage',
  components: { SftpFilePanel, SftpTransferQueue },
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
      localComputer: false,
      localItems: [],
      localSel: [],
      localAnchor: '',
      localSort: { key: 'name', dir: 'asc' },
      localLoading: false,
      remotePath: '/',
      remotePathInput: '/',
      remoteHome: '/',
      remoteItems: [],
      remoteSel: [],
      remoteAnchor: '',
      remoteSort: { key: 'name', dir: 'asc' },
      remoteLoading: false,
      activeSide: 'local',
      tasks: [],
      dropHi: '',
      dragPayload: null,
      clipHasFiles: false,
      ctx: { visible: false, x: 0, y: 0, items: [], side: '', item: null },
      offProgress: null,
      topPct: 58,
      leftPct: 50,
      expandedKeys: [],
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
  created() {
    // Vue 2 does not proxy data keys beginning with an underscore.
    this._dropLock = {};
    this._lastDrag = null;
    this._marqueeBase = null;
    this._split = null;
    this._pollTimer = null;
    this._sftpDestroyed = false;
    // Folder task trees: scan state plus row indexes for progress events and lazy rendering.
    this._folderStates = new Map();
    this._rowByKey = new Map();
    this._rowByXferId = new Map();
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
    document.addEventListener('keydown', this.onGlobalKey);
    window.addEventListener('focus', this.refreshClipFiles);

    this.$nextTick(() => {
      if (this._sftpDestroyed) return;
      const root = this.$refs.root;
      if (root) {
        root.addEventListener('dragenter', this._nativeDragEnter, false);
        root.addEventListener('dragover', this._nativeDragOver, false);
        root.addEventListener('drop', this._nativeDrop, false);
      }
    });
    await this.boot();
    if (this._sftpDestroyed) return;
    this._pollTimer = setInterval(() => this.syncTasks(), 1000);
    window.addEventListener('beforeunload', this.onUnload);
  },
  beforeDestroy() {
    this._sftpDestroyed = true;
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
    document.removeEventListener('keydown', this.onGlobalKey);
    window.removeEventListener('focus', this.refreshClipFiles);
    document.removeEventListener('mousemove', this.onSplitMove);
    document.removeEventListener('mouseup', this.onSplitUp);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    if (this.offProgress) this.offProgress();
    if (this._offSshState) this._offSshState();
    if (this._offDragReady) this._offDragReady();
    if (this.connId && api.sftpClose) api.sftpClose(this.connId).catch(() => {});
  },
  methods: {
    ...selectionMethods,
    ...taskMethods,
    ...transferMethods,
    ...dragDropMethods,
    pushDlog(msg) {
      // debug only — no on-screen overlay
      console.log('[sftp]', new Date().toLocaleTimeString(), this.buildTag, msg);
    },
    onUnload() {
      if (this.connId && api.sftpClose) api.sftpClose(this.connId).catch(() => {});
    },
    async boot() {
      if (this._sftpDestroyed) return;
      if (!api.sftpOpen) {
        this.status = 'error';
        return;
      }
      this.status = 'connecting';
      try {
        const local = unwrap(await api.sftpLocalList());
        if (this._sftpDestroyed) return;
        this.localHome = local.home || local.path;
        await this.goLocal(local.path || this.localHome);
        if (this._sftpDestroyed) return;
        const r = unwrap(await api.sftpOpen({ assetId: this.assetId }));
        // Destruction may precede sftpOpen's result, when connId is still unset.
        if (this._sftpDestroyed) {
          if (r.connId && api.sftpClose) api.sftpClose(r.connId).catch(() => {});
          return;
        }
        this.connId = r.connId;
        this.remoteHome = r.home || '/';
        this.status = 'ready';
        await this.goRemote(this.remoteHome);
        if (this._sftpDestroyed) return;
        await this.syncTasks();
        this.refreshClipFiles();
      } catch (e) {
        if (this._sftpDestroyed) return;
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
        this.$message.error(e.message);
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
        this.$message.error(e.message);
      } finally {
        this.localLoading = false;
      }
    },
    async goRemote(p) {
      if (!this.connId || this.remoteLoading) return;
      const target = normalizeRemotePath(p) || '/';
      this.remoteLoading = true;
      try {
        const r = unwrap(await api.sftpList(this.connId, target));
        this.remotePath = normalizeRemotePath(r.path || target);
        this.remotePathInput = this.remotePath;
        const items = (r.items || []).filter((x) => x.name !== '.' && x.name !== '..');
        this.remoteItems = sortItems([PARENT_ROW, ...items], this.remoteSort);
        this.remoteSel = [];
        this.remoteAnchor = '';
      } catch (e) {
        this.$message.error(e.message);
      } finally {
        this.remoteLoading = false;
      }
    },
    localUp() {
      if (this.localComputer) return;
      // From a drive root (C:\) up once -> show all drives (This PC).
      if (/^[A-Za-z]:[\\/]?$/.test(this.localPath)) return this.loadDrives();
      this.goLocal(parentLocal(this.localPath) || this.localHome);
    },
    remoteUp() {
      this.goRemote(parentRemote(this.remotePath));
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
      if (side === 'remote') {
        items.push({ act: 'paste', label: t('sftp.paste'), disabled: !this.clipHasFiles });
      }
      items.push({ act: 'refresh', label: t('sftp.refresh') });
      items.push({ act: 'select-all', label: t('sftp.selectAll') });
      this.ctx = { visible: true, x: e.clientX, y: e.clientY, side, item: null, items };
      if (side === 'remote') this.refreshClipFiles();
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
      if (this._sftpDestroyed) return;
      this.clipHasFiles = has;
      const item = (this.ctx.items || []).find((x) => x.act === 'paste');
      if (item && this.ctx.visible) item.disabled = !has;
    },
    onItemCtx(e, side, f) {
      if (f.isParent) return;
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
      if (!many) items.push({ act: 'rename', label: t('sftp.rename') });
      items.push({ act: 'delete', label: t('sftp.delete'), danger: true });
      this.ctx = { visible: true, x: e.clientX, y: e.clientY, side, item: f, items };
    },
    async runCtx(it) {
      const { side, item } = this.ctx;
      this.closeCtx();
      const targets = this.selItems(side);
      const list = targets.length ? targets : item ? [item] : [];
      const localOf = (x) => joinLocal(this.localPath, x.name);
      const remoteOf = (x) => joinRemote(this.remotePath, x.name);
      try {
        if (it.act === 'upload-folder' && item && item.isDir) {
          await this.transferFolderUpload(localOf(item), this.remotePath);
          return;
        }
        if (it.act === 'upload-selected' || it.act === 'upload-file') {
          for (const x of list.filter((y) => y.isDir)) {
            await this.transferFolderUpload(localOf(x), this.remotePath);
          }
          const files = list.filter((y) => !y.isDir);
          if (files.length) await this.uploadPaths(files.map(localOf), this.remotePath);
          return;
        }
        if (it.act === 'download-folder' && item && item.isDir) {
          await this.transferFolderDownload(remoteOf(item), this.localPath);
          return;
        }
        if (it.act === 'download-here' && list.length) {
          const dir = this.localPath;
          for (const x of list) {
            if (x.isDir) {
              await api.sftpLocalMkdir(dir, x.name);
              await this.downloadRemoteDir(remoteOf(x), joinLocal(dir, x.name));
            } else {
              await this.startDownload(remoteOf(x), joinLocal(dir, x.name));
            }
          }
          if (list.some((x) => x.isDir)) this.$message.success(t('sftp.downloadDone'));
          this.syncTasks();
          setTimeout(() => this.goLocal(dir), 400);
          return;
        }
        if (it.act === 'download-to' && list.length) {
          let dir = this.localPath;
          if (api.sftpPickLocalDir) {
            const picked = unwrap(await api.sftpPickLocalDir());
            if (picked) dir = picked;
          }
          for (const x of list) {
            if (x.isDir) {
              await api.sftpLocalMkdir(dir, x.name);
              await this.downloadRemoteDir(remoteOf(x), joinLocal(dir, x.name));
            } else {
              await this.startDownload(remoteOf(x), joinLocal(dir, x.name));
            }
          }
          if (list.some((x) => x.isDir)) this.$message.success(t('sftp.downloadDone'));
          this.syncTasks();
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
        if (it.act === 'refresh') {
          if (side === 'local') await this.goLocal(this.localPath);
          else await this.goRemote(this.remotePath);
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
            unwrap(await api.sftpRename(this.connId, remoteOf(item), joinRemote(this.remotePath, neu)));
            await this.goRemote(this.remotePath);
          }
          return;
        }
        if (it.act === 'delete' && list.length) {
          const msg =
            list.length === 1
              ? t('sftp.confirmDelete', { name: list[0].name })
              : t('sftp.confirmDeleteMulti', { count: list.length });
          await this.$confirm(msg, t('msg.confirm'), { type: 'warning' });
          for (const x of list) {
            if (side === 'local') unwrap(await api.sftpLocalUnlink(localOf(x), x.isDir));
            else unwrap(await api.sftpUnlink(this.connId, remoteOf(x), x.isDir));
          }
          if (side === 'local') await this.goLocal(this.localPath);
          else await this.goRemote(this.remotePath);
        }
      } catch (err) {
        if (err !== 'cancel' && err !== 'close') this.$message.error(err.message || String(err));
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
