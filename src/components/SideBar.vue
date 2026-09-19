<template>
  <aside class="sidebar">
    <div class="side-toolbar">
      <el-button type="primary" @click="onNewAsset">{{ $t('sidebar.newAsset') }}</el-button>
      <el-button @click="onNewGroup">{{ $t('sidebar.newGroup') }}</el-button>
    </div>
    <div class="side-search">
      <el-input v-model="filter" size="mini" :placeholder="$t('sidebar.search')" clearable />
    </div>
    <div class="tree" @contextmenu.prevent="onBlankCtx">
      <div v-for="g in filteredGroups" :key="g.id" class="group-block">
        <div
          class="group-h"
          @click="toggleGroup(g)"
          @contextmenu.prevent.stop="onGroupCtx($event, g)"
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
            :class="{ active: activeAssetId === n.id }"
            @click="onClickNode(n)"
            @dblclick="onDbl(n)"
            @contextmenu.prevent.stop="onNodeCtx($event, g, n)"
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
    </div>
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
} from '../store';
import { OS_SVG, methodPillClass } from '../constants';
import { t } from '../i18n';

export default {
  name: 'SideBar',
  data() {
    return { filter: '' };
  },
  computed: {
    groups() {
      return store.snapshot.groups || [];
    },
    activeAssetId() {
      return store.activeAssetId;
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
    this._ctxHandler = (e) => {
      if (!e.target.closest('.ctx-menu')) {
        const menu = document.querySelector('.ctx-menu');
        if (menu) menu.classList.remove('show');
      }
    };
    document.addEventListener('click', this._ctxHandler);
  },
  beforeDestroy() {
    this.$root.$off('open-settings', this._openSettings);
    document.removeEventListener('click', this._ctxHandler);
  },
  methods: {
    osSvg(os) {
      return OS_SVG[os] || '';
    },
    methodsOf(n) {
      return enabledMethods(n);
    },
    pillClass(id) {
      return methodPillClass(id);
    },
    shortProto(id) {
      return id === 'rdp' ? 'RDP' : id === 'vnc' ? 'VNC' : 'SSH';
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
      store.assetDialog = {
        visible: true,
        editId: null,
        gid: store.activeGroupId || (this.groups[0] || {}).id,
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
      const root = document.querySelector('.ctx-menu');
      if (!root) return;
      const self = this;
      root.innerHTML = items
        .map((it, i) => {
          if (it.sep) return `<div class="ctx-sep"></div>`;
          if (it.title) return `<div class="ctx-title">${it.label}</div>`;
          return `<div class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}">${it.label}</div>`;
        })
        .join('');
      root.classList.add('show');
      root.style.left = e.clientX + 'px';
      root.style.top = e.clientY + 'px';
      root.querySelectorAll('.ctx-item').forEach((el) => {
        el.onclick = (ev) => {
          ev.stopPropagation();
          root.classList.remove('show');
          const it = items[Number(el.dataset.i)];
          self.handleCtx(it);
        };
      });
    },
    async handleCtx(it) {
      try {
        if (it.act === 'new-asset') {
          store.assetDialog = {
            visible: true,
            editId: null,
            gid: store.activeGroupId || (this.groups[0] || {}).id,
          };
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
          unwrap(await api.cloneAsset(it.aid));
          await refresh();
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
        unwrap(
          await api.sessionConnect({
            assetId: asset.id,
            methodId: method.id,
          })
        );
        if (method.id !== 'rdp') {
          this.$message.warning(t('msg.notImpl', { name: method.name }));
        }
      } catch (e) {
        const map = {
          TCP_TIMEOUT: t('msg.tcpFail'),
          MSTSC_NOT_FOUND: 'mstsc not found',
          NOT_IMPLEMENTED: e.message,
          NO_BRIDGE: e.message,
          PLATFORM: e.message,
        };
        this.$message.error(map[e.code] || e.message || t('err.connect'));
      }
    },
  },
};
</script>
