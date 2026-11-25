<template>
  <!-- split 节点：左右或上下两格，中间是可拖的比例分隔条；toggle-tree 沿递归链冒泡到根 -->
  <div v-if="isSplit" class="pane-split" :class="node.dir === 'row' ? 'is-row' : 'is-col'">
    <div class="pane-cell" :style="cellStyle(node.ratio)">
      <pane-layout :node="node.a" :tree-hidden="treeHidden" @toggle-tree="onToggleTree" />
    </div>
    <div class="pane-divider" @mousedown="startDivider"></div>
    <div class="pane-cell" style="flex: 1 1 0">
      <pane-layout :node="node.b" :tree-hidden="treeHidden" @toggle-tree="onToggleTree" />
    </div>
  </div>

  <!-- 叶子区域：自己的页签栏 + 内容区，会话页签住在区域里 -->
  <div v-else class="pane-region">
    <tab-bar :node="node" :main="isMain" :tree-hidden="treeHidden" @toggle-tree="onToggleTree" />

    <div
      class="region-body"
      @dragover="onBodyDragOver"
      @dragleave="onBodyDragLeave"
      @drop="onBodyDrop"
    >
      <div
        v-for="tid in node.tabs"
        :key="tid + ':' + refreshKey(tid)"
        class="view"
        :class="[kindClass(tid), { show: node.active === tid }]"
      >
        <component
          v-if="compOf(tid)"
          :is="compOf(tid)"
          v-show="node.active === tid"
          :session-id="tid"
          :asset-id="tabField(tid, 'assetId')"
          :method-id="tabField(tid, 'methodId')"
          :title="viewTitle(tid)"
          :active="store.activeTab === tid"
          :attach-session-id="attachId(tid)"
          @session="onViewSession(tid, $event)"
        />
      </div>
      <div class="dz-overlay" :class="{ show: dropZone !== '' }">
        <div v-for="z in ZONES" :key="z" class="dz" :class="[z, { hot: dropZone === z }]"></div>
      </div>
    </div>

    <!-- 拖出窗口的幽灵预览，只有根实例渲染；拖出判定与坐标由根实例的文档级 dragover 维护 -->
    <div
      v-if="root && drag.show"
      class="tab-ghost-window"
      :style="{ left: drag.left + 'px', top: drag.top + 'px' }"
    >
      <div class="ghost-bar"><span>{{ drag.title }}</span></div>
      <div class="ghost-body"></div>
    </div>
  </div>
</template>

<script>
import { defineAsyncComponent } from 'vue';
import TabBar from '../panels/TabBar.vue';
import {
  store,
  tabDrag,
  api,
  moveTabToWindow,
  setDockTarget,
  clearDockTarget,
  setPendingRegionDrop,
  clearPendingRegionDrop,
  layoutMoveTab,
  layoutSplitTab,
  layoutMainRegionId,
  reportRegionOrder,
  hostedInGroup,
} from '../../store';
import { t } from '../../i18n';
import { TAB_DRAG_TYPE } from '../../constants';
import { getProtocol } from '../../protocols';

const HOME_VIEW = defineAsyncComponent(() => import('../views/HomeView.vue'));

/** Preview size of the detached-window outline shown while a tab is dragged out. */
const GHOST_W = 320;
const GHOST_H = 190;
const ZONES = ['top', 'bottom', 'left', 'right', 'center'];

/**
 * 布局树渲染：split 节点递归自己，叶子区域 = TabBar 页签条 + 内容区。
 * 主窗口与独立会话窗口共用这一个组件；首页作为主栏里的一枚页签渲染。
 */
export default {
  name: 'PaneLayout',
  components: { TabBar },
  props: {
    node: { type: Object, required: true },
    /** 根实例负责拖出窗口的幽灵预览与文档级 dragover；递归子实例只渲染自己的区域。 */
    root: { type: Boolean, default: false },
    treeHidden: { type: Boolean, default: false },
  },
  data() {
    return {
      // 模板里 `store.activeTab` 需要实例上有 store：放进来同时保持响应式追踪。
      store,
      drag: tabDrag,
      dropZone: '',
      ZONES,
    };
  },
  computed: {
    isSplit() {
      return this.node.type === 'split';
    },
    isMain() {
      return !this.isSplit && layoutMainRegionId() === this.node.id;
    },
  },
  mounted() {
    if (api.onSessionDockClear) {
      // 源窗口取消拖放或渲染进程死掉时不会给本窗口发 dragleave，落点提示由主进程统一收回。
      this._offDockClear = api.onSessionDockClear(() => {
        this.dropZone = '';
      });
    }
    if (this.root) {
      document.addEventListener('dragover', this.onDocDragOver, true);
    }
  },
  beforeUnmount() {
    if (this._offDockClear) this._offDockClear();
    if (this.root) {
      document.removeEventListener('dragover', this.onDocDragOver, true);
    }
  },
  methods: {
    /* ---- 树与页签的只读辅助 ---- */
    findTab(id) {
      return store.tabs.find((tab) => tab.id === id) || null;
    },
    kindOf(tid) {
      const tab = this.findTab(tid);
      return tab && tab.kind ? tab.kind : '';
    },
    kindClass(tid) {
      return (this.kindOf(tid) || 'home') + '-view';
    },
    refreshKey(tid) {
      return store.tabRefreshKeys[tid] || 0;
    },
    tabField(tid, field) {
      const tab = this.findTab(tid);
      return tab ? tab[field] || '' : '';
    },
    viewTitle(tid) {
      const tab = this.findTab(tid);
      if (!tab) return '';
      return (tab.host || '') + (tab.port ? ':' + tab.port : '');
    },
    compOf(tid) {
      if (tid === 'home') return HOME_VIEW;
      const protocol = getProtocol(this.kindOf(tid));
      return protocol && protocol.component ? protocol.component : null;
    },
    /** SSH 与 Telnet 字符终端会把活连接跨区域带走，其余视图总是重新连。 */
    attachId(tid) {
      const tab = this.findTab(tid);
      if (!tab) return undefined;
      return tab.kind === 'ssh' || tab.kind === 'telnet' ? tab.liveSessionId || undefined : undefined;
    },
    onViewSession(tid, sessionId) {
      const tab = this.findTab(tid);
      if (tab) tab.liveSessionId = sessionId || null;
    },
    cellStyle(ratio) {
      return { flex: '0 0 ' + (ratio * 100) + '%' };
    },

    /* ---- 分隔条 ---- */
    startDivider(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      const wrap = this.$el;
      const rect = wrap.getBoundingClientRect();
      const dir = this.node.dir;
      const move = (ev) => {
        const r = dir === 'row'
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
        this.node.ratio = Math.max(0.15, Math.min(0.85, r));
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (this.isMain) this.$nextTick(() => window.dispatchEvent(new Event('resize')));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      document.body.style.cursor = dir === 'row' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    },

    /* ---- 内容区落点：中心＝移入该区域栏，四边＝按方向分屏并带走页签 ---- */
    onBodyDragOver(event) {
      if (!this.isDragEvent(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.dropZone = this.zoneFor(event, event.currentTarget.getBoundingClientRect());
    },
    onBodyDragLeave(event) {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      this.dropZone = '';
    },
    onBodyDrop(event) {
      if (!this.isDragEvent(event)) return;
      event.preventDefault();
      const zone = this.zoneFor(event, event.currentTarget.getBoundingClientRect());
      this.dropZone = '';
      const tabId = this.resolveDropTab(event);
      if (!tabId) return;
      if (!tabDrag.tabId) {
        this.acceptForeignTab(tabId, null, this.node.id);
        return;
      }
      tabDrag.handled = true;
      if (zone === 'center') layoutMoveTab(tabId, this.node.id, null);
      else layoutSplitTab(tabId, this.node.id, zone);
      reportRegionOrder();
    },
    isDragEvent(event) {
      return !!event.dataTransfer && Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE);
    },
    resolveDropTab(event) {
      if (tabDrag.tabId) return tabDrag.tabId;
      return event.dataTransfer.getData(TAB_DRAG_TYPE) || '';
    },
    async acceptForeignTab(tabId, beforeId, regionId) {
      if (hostedInGroup()) {
        setPendingRegionDrop(tabId, regionId, beforeId);
        try {
          await moveTabToWindow(tabId, beforeId, false);
        } catch (e) {
          clearPendingRegionDrop(tabId);
          this.$message.error(e.code === 'DOCK_TAB' ? t('tab.dockFail') : e.message || t('tab.dockFail'));
        }
        return;
      }
      const parked = store.tabs.find((t) => t.id === tabId && t.detached);
      if (!parked) return;
      setDockTarget(tabId, beforeId, regionId);
      try {
        await moveTabToWindow(tabId, null, true);
      } catch (e) {
        clearDockTarget(tabId);
        this.$message.error(e.code === 'DOCK_TAB' ? t('tab.dockFail') : e.message || t('tab.dockFail'));
      }
    },
    zoneFor(event, rect) {
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (x < 0.3 && y > 0.25 && y < 0.75) return 'left';
      if (x > 0.7 && y > 0.25 && y < 0.75) return 'right';
      if (y < 0.3 && x <= 0.7) return 'top';
      if (y > 0.7 && x >= 0.3) return 'bottom';
      return 'center';
    },

    /* ---- 拖出窗口的幽灵预览：仅根实例监听文档级 dragover ---- */
    onDocDragOver(event) {
      if (!tabDrag.tabId) {
        if (tabDrag.show) tabDrag.show = false;
        return;
      }
      const el = this.$el;
      const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const inside = rect
        && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
      tabDrag.show = !inside && tabDrag.detachable;
      if (!tabDrag.show) return;
      tabDrag.title = tabDrag.title || '';
      tabDrag.left = Math.max(8, Math.min(event.clientX - GHOST_W / 2, window.innerWidth - GHOST_W - 8));
      tabDrag.top = Math.max(8, Math.min(event.clientY - GHOST_H / 2, window.innerHeight - GHOST_H - 8));
    },

    /* ---- 折叠树按钮：任何区域的栏上都可能触发，沿递归链冒泡到根，由根转给 App ---- */
    onToggleTree() {
      this.$emit('toggle-tree');
    },
  },
};
</script>

<style scoped>
.pane-split {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.pane-split.is-row {
  flex-direction: row;
}
.pane-split.is-col {
  flex-direction: column;
}
.pane-cell {
  min-width: 0;
  min-height: 0;
  display: flex;
}
.pane-divider {
  flex: 0 0 7px;
  position: relative;
  z-index: 5;
}
.is-row > .pane-divider {
  cursor: col-resize;
  margin: 0 -3px;
}
.is-col > .pane-divider {
  cursor: row-resize;
  margin: -3px 0;
}
.pane-divider::after {
  content: '';
  position: absolute;
  background: var(--border);
  border-radius: 2px;
}
.is-row > .pane-divider::after {
  left: 3px;
  top: 6px;
  bottom: 6px;
  width: 1px;
}
.is-col > .pane-divider::after {
  top: 3px;
  left: 6px;
  right: 6px;
  height: 1px;
}
.pane-divider:hover::after {
  background: var(--text-3);
}

.pane-region {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-app);
}

.region-body {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--bg-app);
}

.dz-overlay {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 10;
  pointer-events: none;
}
.dz-overlay.show {
  display: block;
}
.dz {
  position: absolute;
  border: 1px dashed var(--accent, #409eff);
  background: var(--accent, #409eff);
  border-radius: 6px;
  opacity: 0.18;
}
.dz.hot {
  opacity: 0.45;
  border-style: solid;
}
.dz.top {
  left: 4px;
  right: 4px;
  top: 4px;
  height: 26%;
}
.dz.bottom {
  left: 4px;
  right: 4px;
  bottom: 4px;
  height: 26%;
}
.dz.left {
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: 26%;
}
.dz.right {
  top: 4px;
  bottom: 4px;
  right: 4px;
  width: 26%;
}
.dz.center {
  left: 30%;
  right: 30%;
  top: 30%;
  bottom: 30%;
}
</style>
