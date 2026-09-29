<template>
  <aside class="sidebar">
    <div class="side-toolbar">
      <el-button type="primary" @click="onNewAsset">{{ $t('sidebar.newAsset') }}</el-button>
      <el-button @click="onNewGroup">{{ $t('sidebar.newGroup') }}</el-button>
    </div>
    <div class="side-search">
      <el-input v-model="filter" size="mini" :placeholder="$t('sidebar.search')" clearable />
    </div>
    <el-scrollbar class="tree-scroll">
    <div class="tree" @contextmenu.prevent="onBlankCtx" @dragend="onDragEnd" @drop="onTreeDrop">
      <div
        v-for="g in filteredGroups"
        :key="g.id"
        class="group-block"
        :class="{
          'dragging-group': drag.type === 'group' && drag.id === g.id,
          'drop-group': dropKey === 'g:' + g.id,
        }"
        @dragover.prevent="onGroupBlockOver($event, g)"
        @drop.prevent.stop="onGroupBlockDrop($event, g)"
      >
        <div
          class="group-h"
          :draggable="canDrag"
          :class="{ 'drag-over': dropKey === 'g:' + g.id }"
          @click="toggleGroup(g)"
          @contextmenu.prevent.stop="onGroupCtx($event, g)"
          @dragstart="onGroupDragStart($event, g)"
          @dragover.prevent="onGroupHeadOver($event, g)"
          @dragleave="onDragLeave($event, 'g:' + g.id)"
          @drop.prevent.stop="onGroupHeadDrop($event, g)"
        >
          <span :style="{ transform: g.open ? '' : 'rotate(-90deg)', display: 'inline-block', fontSize: '10px' }">▾</span>
          <span :style="{ width: '8px', height: '8px', borderRadius: '2px', background: g.color, display: 'inline-block' }"></span>
          <span style="flex:1">{{ g.name }}</span>
          <span class="pill">{{ g.nodes.length }}</span>
        </div>
        <template v-if="g.open">
          <div
            v-for="n in g.nodes"
            :key="n.id"
            class="node"
            :class="{
              active: activeAssetId === n.id,
              dragging: drag.type === 'asset' && drag.id === n.id,
              'drag-over': dropKey === 'n:' + n.id,
            }"
            :draggable="canDrag"
            @click="onClickNode(n)"
            @dblclick="onDbl(n)"
            @contextmenu.prevent.stop="onNodeCtx($event, g, n)"
            @dragstart="onAssetDragStart($event, g, n)"
            @dragover.prevent.stop="onAssetOver($event, g, n)"
            @dragleave="onDragLeave($event, 'n:' + n.id)"
            @drop.prevent.stop="onAssetDrop($event, g, n)"
          >
            <span class="os-icon" :class="'os-' + n.os" v-html="osSvg(n.os)"></span>
            <div class="node-meta">
              <div class="node-name">{{ n.name }}</div>
              <div class="node-host">{{ n.host }}<template v-if="n.user"> · {{ n.user }}</template></div>
            </div>
            <span
              v-for="m in methodsOf(n)"
              :key="m.id"
              class="pill"
              :class="pillClass(m.id)"
              @click.stop="connect(n, m)"
              :title="$t('ctx.connectWith', { name: m.name })"
            >{{ shortProto(m.id) }}</span>
          </div>
        </template>
      </div>
      <div v-if="!filteredGroups.length" class="empty" style="padding:24px">{{ $t('sidebar.empty') }}</div>
    </div>
    </el-scrollbar>
    <div class="side-footer">
      <button
        type="button"
        class="gear-btn"
        :title="$t('nav.settings')"
        @click="$root.$emit('open-settings')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7.05 7.05 0 00-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84a.48.48 0 00-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.48.48 0 00.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z"/>
        </svg>
      </button>
      <button
        type="button"
        class="gear-btn"
        :title="$t('nav.logs')"
        @click="openLog"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM6 20V4h7v5h5v11H6zm3-3h6v-2H9v2zm0-4h6v-2H9v2z"/>
        </svg>
      </button>
    </div>
    <ctx-menu ref="contextMenu" @select="handleCtx" />
  </aside>
</template>

<script>
import {
  store,
  openAssetDetail,
  enabledMethods,
  findAsset,
  api,
  unwrap,
  refresh,
  connectAsset,
  connectionErrorMessage,
  reorderGroups,
  reorderAsset,
} from '../store';
import { OS_SVG, methodPillClass, isUngroupedGroup, UNGROUPED_ID } from '../constants';
import { protocolLabel } from '../protocols';
import CtxMenu from './CtxMenu.vue';
import { t } from '../i18n';

export default {
  name: 'SideBar',
  components: { CtxMenu },
  data() {
    return {
      filter: '',
      drag: { type: null, id: null, fromGid: null },
      dropKey: '',
      dragging: false,
    };
  },
  computed: {
    groups() {
      return store.snapshot.groups || [];
    },
    activeAssetId() {
      return store.activeAssetId;
    },
    canDrag() {
      return !this.filter.trim();
    },
    filteredGroups() {
      const q = this.filter.trim().toLowerCase();
      if (!q) return this.groups;
      return this.groups
        .map((g) => {
          const nodes = g.nodes.filter(
            (n) =>
              n.name.toLowerCase().includes(q) ||
              (n.host || '').includes(q) ||
              g.name.toLowerCase().includes(q)
          );
          return { ...g, open: true, nodes };
        })
        .filter((g) => g.nodes.length);
    },
  },
  mounted() {
    this._openSettings = () => {
      store.settingsDialog = true;
    };
    this.$root.$on('open-settings', this._openSettings);
  },
  beforeDestroy() {
    this.$root.$off('open-settings', this._openSettings);
  },
  methods: {
    osSvg(os) {
      return OS_SVG[os] || '';
    },
    openLog() {
      store.logDialog = true;
    },
    methodsOf(n) {
      return enabledMethods(n);
    },
    pillClass(id) {
      return methodPillClass(id);
    },
    shortProto: protocolLabel,

    // ---------- drag & drop ----------
    onGroupDragStart(e, g) {
      if (!this.canDrag) {
        e.preventDefault();
        return;
      }
      this.drag = { type: 'group', id: g.id, fromGid: null };
      this.dragging = true;
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'group:' + g.id);
      } catch (_) {}
    },
    onAssetDragStart(e, g, n) {
      if (!this.canDrag) {
        e.preventDefault();
        return;
      }
      this.drag = { type: 'asset', id: n.id, fromGid: g.id };
      this.dragging = true;
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'asset:' + n.id);
      } catch (_) {}
    },
    onDragEnd() {
      this.clearDrag();
    },
    onTreeDrop() {
      this.clearDrag();
    },
    onDragLeave(e, key) {
      if (this.dropKey === key && !e.currentTarget.contains(e.relatedTarget)) {
        this.dropKey = '';
      }
    },
    clearDrag() {
      this.drag = { type: null, id: null, fromGid: null };
      this.dropKey = '';
      this.dragging = false;
    },

    onGroupHeadOver(e, g) {
      if (!this.drag.type) return;
      e.dataTransfer.dropEffect = 'move';
      this.dropKey = 'g:' + g.id;
    },
    onGroupBlockOver(e, g) {
      if (!this.drag.type) return;
      e.dataTransfer.dropEffect = 'move';
      if (!this.dropKey) this.dropKey = 'g:' + g.id;
    },
    onAssetOver(e, g, n) {
      if (!this.drag.type) return;
      e.dataTransfer.dropEffect = 'move';
      this.dropKey = 'n:' + n.id;
    },

    async onGroupHeadDrop(e, g) {
      const drag = { ...this.drag };
      this.clearDrag();
      if (!drag.type || !this.canDrag) return;
      try {
        if (drag.type === 'group') {
          if (drag.id === g.id) return;
          await reorderGroups(drag.id, g.id);
        } else if (drag.type === 'asset') {
          // drop on group header → move into that group (end)
          await reorderAsset({
            assetId: drag.id,
            fromGid: drag.fromGid,
            toGid: g.id,
            beforeAssetId: null,
          });
        }
      } catch (err) {
        this.$message.error(err.message || String(err));
      }
    },

    async onGroupBlockDrop(e, g) {
      // empty area under group header
      const drag = { ...this.drag };
      this.clearDrag();
      if (!drag.type || !this.canDrag) return;
      if (drag.type === 'group') {
        // only reorder when targeting a different group header; block body is for assets
        return;
      }
      try {
        if (drag.type === 'asset') {
          await reorderAsset({
            assetId: drag.id,
            fromGid: drag.fromGid,
            toGid: g.id,
            beforeAssetId: null,
          });
        }
      } catch (err) {
        this.$message.error(err.message || String(err));
      }
    },

    async onAssetDrop(e, targetG, targetN) {
      const drag = { ...this.drag };
      this.clearDrag();
      if (!drag.type || !this.canDrag) return;
      try {
        if (drag.type === 'asset') {
          if (drag.id === targetN.id) return;
          await reorderAsset({
            assetId: drag.id,
            fromGid: drag.fromGid,
            toGid: targetG.id,
            beforeAssetId: targetN.id,
          });
        } else if (drag.type === 'group') {
          // dropping a group onto an asset → reorder groups to that asset's group
          if (drag.id === targetG.id) return;
          await reorderGroups(drag.id, targetG.id);
        }
      } catch (err) {
        this.$message.error(err.message || String(err));
      }
    },

    toggleGroup(g) {
      g.open = !g.open;
      api.updateGroup(g.id, { open: g.open }).catch(() => {});
    },
    onClickNode(n) {
      store.activeAssetId = n.id;
      const hit = findAsset(n.id);
      store.activeGroupId = hit && hit.group ? hit.group.id : null;
    },
    onDbl(n) {
      openAssetDetail(n);
    },
    onNewAsset() {
      // group is optional; keep empty unless a non-default group is active
      const active = this.groups.find((g) => g.id === store.activeGroupId);
      const gid =
        active && !isUngroupedGroup(active)
          ? active.id
          : store.assetDialog.gid || '';
      store.assetDialog = {
        visible: true,
        editId: null,
        gid,
      };
    },
    onNewGroup() {
      store.groupDialog = { visible: true, editId: null };
    },
    onBlankCtx(e) {
      this.showMenu(e, [
        { label: t('ctx.newAsset'), act: 'new-asset' },
        { label: t('ctx.newGroup'), act: 'new-group' },
      ]);
    },
    onGroupCtx(e, g) {
      const ungrouped = isUngroupedGroup(g);
      if (ungrouped) {
        this.showMenu(e, [
          { label: `分组 · ${g.name}`, title: true },
          { label: t('ctx.inGroupNew'), act: 'new-asset-g', gid: g.id },
          { label: t('ctx.editGroup'), act: 'edit-group', gid: g.id },
        ]);
        return;
      }
      this.showMenu(e, [
        { label: `分组 · ${g.name}`, title: true },
        { label: t('ctx.inGroupNew'), act: 'new-asset-g', gid: g.id },
        { label: t('ctx.editGroup'), act: 'edit-group', gid: g.id },
        { sep: true },
        { label: t('ctx.delGroup'), act: 'del-group', gid: g.id, danger: true },
      ]);
    },
    onNodeCtx(e, g, n) {
      store.activeAssetId = n.id;
      const methods = enabledMethods(n);
      const items = [{ label: `${t('ctx.asset')} · ${n.name}`, title: true }];
      methods.forEach((m) => {
        items.push({ label: t('ctx.connectWith', { name: m.name }), act: 'connect', aid: n.id, mid: m.id });
      });
      items.push({ sep: true });
      items.push({ label: t('ctx.edit'), act: 'edit', aid: n.id });
      items.push({ label: t('ctx.clone'), act: 'clone', aid: n.id });
      items.push({ sep: true });
      items.push({ label: t('ctx.del'), act: 'del', aid: n.id, danger: true });
      this.showMenu(e, items);
    },
    showMenu(e, items) {
      this.$refs.contextMenu.open(e, items);
    },
    async handleCtx(it) {
      try {
        if (it.act === 'new-asset') {
          const active = this.groups.find((g) => g.id === store.activeGroupId);
          const gid =
            active && !isUngroupedGroup(active) ? active.id : '';
          store.assetDialog = { visible: true, editId: null, gid };
        } else if (it.act === 'new-asset-g') {
          store.assetDialog = { visible: true, editId: null, gid: it.gid };
        } else if (it.act === 'new-group') {
          store.groupDialog = { visible: true, editId: null };
        } else if (it.act === 'edit-group') {
          store.groupDialog = { visible: true, editId: it.gid };
        } else if (it.act === 'del-group') {
          await this.$confirm(t('msg.confirmDeleteGroup'), t('msg.confirm'), { type: 'warning' });
          unwrap(await api.deleteGroup(it.gid));
          await refresh();
        } else if (it.act === 'connect') {
          const hit = findAsset(it.aid);
          if (hit) await this.connect(hit.asset, enabledMethods(hit.asset).find((m) => m.id === it.mid));
        } else if (it.act === 'edit') {
          store.assetDialog = { visible: true, editId: it.aid, gid: null };
        } else if (it.act === 'clone') {
          store.assetDialog = { visible: true, editId: null, gid: null, cloneId: it.aid };
        } else if (it.act === 'del') {
          await this.$confirm(t('msg.confirmDeleteAsset'), t('msg.confirm'), { type: 'warning' });
          unwrap(await api.deleteAsset(it.aid));
          await refresh();
        }
      } catch (err) {
        if (err !== 'cancel') this.$message.error(err.message || String(err));
      }
    },
    async connect(asset, method) {
      if (!method) return;
      try {
        await connectAsset(asset, method);
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      }
    },
  },
};
</script>
