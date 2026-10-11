<template>
  <aside class="sidebar">
    <div class="side-search">
      <el-input v-model="filter" size="mini" :placeholder="$t('sidebar.search')" clearable prefix-icon="el-icon-search" />
    </div>
    <el-scrollbar class="tree-scroll" @contextmenu.native.prevent="onBlankCtx">
      <div class="tree">
        <el-tree
          ref="tree"
          :data="treeData"
          node-key="key"
          :props="treeProps"
          :draggable="canDrag"
          :allow-drag="allowDrag"
          :allow-drop="allowDrop"
          :default-expanded-keys="expandedKeys"
          highlight-current
          empty-text=" "
          @node-click="onNodeClick"
          @node-contextmenu="onNodeCtx"
          @node-expand="onNodeExpand"
          @node-collapse="onNodeCollapse"
          @node-drag-start="onNodeDragStart"
          @node-drag-end="onNodeDragEnd"
          @node-drop="onNodeDrop"
        >
          <template #default="{ data }">
            <div v-if="data.kind === 'folder'" class="tn tn-folder">
              <span class="cdot" :style="{ background: data.color }"></span>
              <span class="tn-label">{{ data.name }}</span>
              <span class="pill">{{ data.count }}</span>
            </div>
            <div v-else class="tn tn-asset" @dblclick="onDblAsset(data)">
              <span class="os-icon" :class="'os-' + data.raw.os" v-html="osSvg(data.raw.os)"></span>
              <div class="tn-meta">
                <div class="tn-name" :title="data.raw.name">{{ data.raw.name }}</div>
                <div class="tn-pills">
                  <span
                    v-for="m in methodsOf(data.raw)"
                    :key="m.id"
                    class="pill"
                    :class="pillClass(m.id)"
                    :title="$t(m.nameKey)"
                  >{{ shortProto(m.id) }}</span>
                </div>
                <div class="tn-host" :title="hostLabel(data.raw)">{{ hostLabel(data.raw) }}</div>
              </div>
            </div>
          </template>
        </el-tree>
        <div v-if="!treeData.length" class="tree-empty">
          {{ groups.length ? $t('sidebar.noMatch') : $t('sidebar.emptyTree') }}
        </div>
      </div>
    </el-scrollbar>
    <div class="side-footer">
      <button
        type="button"
        class="gear-btn"
        :title="$t('nav.settings')"
        @click="$root.$emit('open-settings')"
      >
        <svg-icon name="gear" :size="16" />
      </button>
      <button
        type="button"
        class="gear-btn"
        :title="$t('nav.logs')"
        @click="openLog"
      >
        <svg-icon name="doc-log" :size="16" />
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
  connectAsset,
  connectionErrorMessage,
  reorderGroups,
  reorderAsset,
  deleteGroup,
  deleteAsset,
} from '../../store';
import { OS_SVG, methodPillClass } from '../../constants';
import { protocolLabel } from '../../protocols';
import { buildAssetTree, filterTree, folderKeys, isDescendantOf } from '../../lib/assetTree';
import CtxMenu from '../common/CtxMenu.vue';
import { t } from '../../i18n';

export default {
  name: 'SideBar',
  components: { CtxMenu },
  data() {
    return {
      filter: '',
      appliedFilter: '',
      treeProps: { children: 'children', label: 'name' },
      expandedKeys: [],
      treeRev: 0,
    };
  },
  computed: {
    groups() {
      return store.snapshot.groups || [];
    },
    activeAssetId() {
      return store.activeAssetId;
    },
    /** 选中资产所在的文件夹，其次是用右键菜单选中的文件夹；都没有时由表单强制选择 */
    activeFolderId() {
      const hit = this.activeAssetId ? findAsset(this.activeAssetId) : null;
      if (hit && hit.group) return hit.group.id;
      const active = this.groups.find((g) => g.id === store.activeGroupId);
      return active ? active.id : '';
    },
    canDrag() {
      return !this.appliedFilter.trim();
    },
    treeData() {
      // el-tree 拖放会就地改写它拿到的那份数组，失败时没有刷新，靠 treeRev 强制重建回真实数据
      const _ = this.treeRev;
      return filterTree(buildAssetTree(this.groups), this.appliedFilter);
    },
  },
  watch: {
    // snapshot 每次刷新都会替换 groups 数组，el-tree 重建节点后不会重放 defaultExpandedKeys
    groups() {
      this.syncExpansion();
    },
    filter() {
      clearTimeout(this._filterTimer);
      this._filterTimer = setTimeout(() => {
        this._filterTimer = null;
        this.appliedFilter = this.filter;
      }, 200);
    },
    appliedFilter() {
      this.syncExpansion();
    },
  },
  created() {
    // el-tree 不给拖拽源加类名，只能自己记住那一行并在 dragend 还原
    this._dragEl = null;
    this._filterTimer = null;
  },
  mounted() {
    this._openSettings = () => {
      store.settingsDialog = true;
    };
    this.$root.$on('open-settings', this._openSettings);
    this.syncExpansion();
  },
  beforeDestroy() {
    clearTimeout(this._filterTimer);
    this.$root.$off('open-settings', this._openSettings);
  },
  methods: {
    osSvg(os) {
      return OS_SVG[os] || '';
    },
    hostLabel(n) {
      return n.user ? n.host + ' · ' + n.user : n.host;
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

    /**
     * 展开状态以持久化的 folder.open 为唯一来源：搜索时命中分支强制展开，但写回仍只在用户操作时发生。
     */
    syncExpansion() {
      const open = this.groups.filter((g) => g.open !== false).map((g) => 'f:' + g.id);
      const keys = this.appliedFilter.trim() ? Array.from(new Set(open.concat(folderKeys(this.treeData)))) : open;
      this.expandedKeys = keys;
      this.$nextTick(() => {
        const tree = this.$refs.tree;
        if (!tree) return;
        const set = new Set(keys);
        folderKeys(this.treeData).forEach((key) => {
          const node = tree.getNode(key);
          if (!node) return;
          if (set.has(key)) node.expand();
          else node.collapse();
        });
        tree.setCurrentKey(this.activeAssetId ? 'a:' + this.activeAssetId : null);
      });
    },

    // ---------- drag & drop ----------
    allowDrag(node) {
      return this.canDrag;
    },
    allowDrop(dragNode, dropNode, type) {
      const d = dragNode.data;
      const t = dropNode.data;
      if (d.kind === 'asset') {
        // 文件夹只接受「放入内部」，整行都是落点；资产之间才是前/后排序；放回自己所在文件夹不算落点
        return t.kind === 'folder' ? type === 'inner' && t.gid !== d.gid : type !== 'inner';
      }
      if (t.kind !== 'folder') return false;
      if (type === 'inner') return t.gid !== d.pid && !isDescendantOf(this.groups, t.gid, d.gid);
      // 文件夹的前后位置只在同一父级内成立，改变从属请拖进文件夹内部
      return t.pid === d.pid;
    },
    /**
     * 落点锚点：before 用目标自身，after 用目标后面那个同类型兄弟，末尾则返回空表示追加。
     * el-tree 在 emit node-drop 前已经把被拖节点插进内部 children，所以要按数据引用把它排除，
     * 否则算出的锚点会是自己。
     */
    siblingAnchor(dropNode, kind, type, dragData) {
      const data = dropNode.data;
      if (data.kind !== kind) return null;
      const idOf = (n) => (kind === 'folder' ? n.gid : n.id);
      if (type === 'before') return idOf(data);
      const siblings = dropNode.parent.childNodes.filter((n) => n.data !== dragData);
      const next = siblings.slice(siblings.indexOf(dropNode) + 1).find((n) => n.data.kind === kind);
      return next ? idOf(next.data) : null;
    },
    async onNodeDrop(dragNode, dropNode, type) {
      const d = dragNode.data;
      const t = dropNode.data;
      try {
        if (d.kind === 'asset') {
          // 文件夹节点的 gid 是自身、资产节点的 gid 是所属文件夹，两者都是落点文件夹
          const toGid = t.gid;
          const beforeAssetId = t.kind === 'asset' && type !== 'inner'
            ? this.siblingAnchor(dropNode, 'asset', type, d)
            : null;
          await reorderAsset({ assetId: d.id, toGid, beforeAssetId });
        } else if (type === 'inner') {
          await reorderGroups({ fromId: d.gid, toGid: t.gid, beforeId: null });
        } else {
          await reorderGroups({
            fromId: d.gid,
            toGid: t.pid,
            beforeId: this.siblingAnchor(dropNode, 'folder', type, d),
          });
        }
      } catch (err) {
        this.treeRev++;
        this.$message.error(err.message || String(err));
      }
      this.syncExpansion();
    },

    onNodeDragStart(node, event) {
      this._dragEl = event && event.target ? event.target.closest('.el-tree-node') : null;
      if (this._dragEl) this._dragEl.classList.add('is-drag-src');
    },
    onNodeDragEnd() {
      if (this._dragEl) this._dragEl.classList.remove('is-drag-src');
      this._dragEl = null;
    },

    // ---------- 展开状态持久化 ----------
    persistOpen(gid, open) {
      const g = this.groups.find((x) => x.id === gid);
      if (g) g.open = open;
      api.updateGroup(gid, { open }).catch((e) => {
        if (api.logWrite) {
          api.logWrite({
            level: 'warn', source: 'store', message: 'update group open failed',
            meta: { gid, open, message: e.message || String(e) },
          }).catch(() => {});
        }
      });
    },
    onNodeExpand(data) {
      if (this.appliedFilter.trim()) return;
      this.persistOpen(data.gid, true);
    },
    onNodeCollapse(data) {
      if (this.appliedFilter.trim()) return;
      this.persistOpen(data.gid, false);
    },

    // ---------- 选择与打开 ----------
    onNodeClick(data) {
      if (data.kind === 'folder') return;
      store.activeAssetId = data.id;
      store.activeGroupId = data.gid;
    },
    onDblAsset(data) {
      openAssetDetail(data.raw);
    },
    onNewAsset(gid) {
      if (!this.groups.length) return;
      store.assetDialog = { visible: true, editId: null, gid: gid || '' };
    },
    onNewFolder(pid) {
      store.groupDialog = { visible: true, editId: null, pid: pid || '' };
    },
    onBlankCtx(e) {
      this.showMenu(e, [
        { label: t('ctx.newAsset'), icon: 'el-icon-plus', act: 'new-asset', disabled: !this.groups.length, hint: t('sidebar.needGroup') },
        { label: t('ctx.newGroup'), icon: 'el-icon-folder-add', act: 'new-group' },
      ]);
    },
    onNodeCtx(e, data) {
      if (data.kind === 'folder') {
        this.folderMenu(e, data);
        return;
      }
      store.activeAssetId = data.id;
      const methods = enabledMethods(data.raw);
      const items = [{ label: `${t('ctx.asset')} · ${data.name}`, title: true }];
      methods.forEach((m) => {
        items.push({ label: t('ctx.connectWith', { name: t(m.nameKey) }), icon: 'el-icon-video-play', act: 'connect', aid: data.id, mid: m.id });
      });
      items.push({ sep: true });
      items.push({ label: t('ctx.edit'), icon: 'el-icon-edit', act: 'edit', aid: data.id });
      items.push({ label: t('ctx.clone'), icon: 'el-icon-document-copy', act: 'clone', aid: data.id });
      items.push({ sep: true });
      items.push({ label: t('ctx.del'), icon: 'el-icon-delete', act: 'del', aid: data.id, danger: true });
      this.showMenu(e, items);
    },
    folderMenu(e, data) {
      const occupied = data.count + data.folderCount > 0;
      this.showMenu(e, [
        { label: t('sidebar.groupTitle', { name: data.name }), title: true },
        { label: t('ctx.inGroupNew'), icon: 'el-icon-plus', act: 'new-asset-g', gid: data.gid },
        { label: t('ctx.newSubGroup'), icon: 'el-icon-folder-add', act: 'new-group-in', gid: data.gid },
        { label: t('ctx.editGroup'), icon: 'el-icon-edit', act: 'edit-group', gid: data.gid },
        { sep: true },
        {
          label: t('ctx.delGroup'),
          icon: 'el-icon-delete',
          act: 'del-group',
          gid: data.gid,
          danger: true,
          disabled: occupied,
          hint: t('ctx.delGroupBusy'),
        },
      ]);
    },
    showMenu(e, items) {
      this.$refs.contextMenu.open(e, items);
    },
    async handleCtx(it) {
      try {
        if (it.act === 'new-asset') {
          this.onNewAsset(this.activeFolderId);
        } else if (it.act === 'new-asset-g') {
          this.onNewAsset(it.gid);
        } else if (it.act === 'new-group') {
          this.onNewFolder('');
        } else if (it.act === 'new-group-in') {
          this.onNewFolder(it.gid);
        } else if (it.act === 'edit-group') {
          store.groupDialog = { visible: true, editId: it.gid, pid: null };
        } else if (it.act === 'del-group') {
          await this.$confirm(t('msg.confirmDeleteGroup'), t('msg.confirm'), { type: 'warning' });
          await deleteGroup(it.gid);
          this.syncExpansion();
        } else if (it.act === 'connect') {
          const hit = findAsset(it.aid);
          if (hit) await this.connect(hit.asset, enabledMethods(hit.asset).find((m) => m.id === it.mid));
        } else if (it.act === 'edit') {
          store.assetDialog = { visible: true, editId: it.aid, gid: null };
        } else if (it.act === 'clone') {
          store.assetDialog = { visible: true, editId: null, gid: null, cloneId: it.aid };
        } else if (it.act === 'del') {
          await this.$confirm(t('msg.confirmDeleteAsset'), t('msg.confirm'), { type: 'warning' });
          await deleteAsset(it.aid);
          this.syncExpansion();
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

<style scoped>
/* 双击资产仍然打开详情页，单击只负责选中 */
.tn-asset {
  cursor: pointer;
}
</style>
