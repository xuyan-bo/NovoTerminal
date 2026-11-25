<template>
  <div
    class="tabbar-row"
    @dragover="onRowDragOver"
    @dragleave="onRowDragLeave"
    @drop="onRowDrop"
  >
    <button
      v-if="showToggle"
      class="tab-arrow tab-toggle"
      :aria-label="$t('tab.toggleTree')"
      :title="$t('tab.toggleTree')"
      @click="$emit('toggle-tree')"
    ><el-icon><Expand v-if="treeHidden" /><Fold v-else /></el-icon></button>
    <button
      v-show="tabOverflow"
      class="tab-arrow"
      :disabled="!tabScrollLeft"
      :aria-label="$t('tab.scrollLeft')"
      @click="scrollTabs(-1)"
    ><el-icon><ArrowLeft /></el-icon></button>
    <div
      ref="tabbarWrap"
      class="tabbar-wrap"
      @scroll.passive="updateTabArrows"
      @dragover="onTabDragOver"
      @dragleave="onTabDragLeave"
      @drop="onTabDrop"
    >
      <div class="tabbar">
        <template v-for="(t, index) in tabs" :key="t.id">
          <div v-if="dockGhostIndex === index" class="tab tab-dock-ghost"></div>
          <div
            class="tab"
            :class="{
              active: node.active === t.id,
              dragging: drag.tabId === t.id,
              'drop-before': tabDragOver && dropBeforeTabId === t.id,
              'drop-after': tabDragOver && dropBeforeTabId === null && index === tabs.length - 1,
            }"
            :data-tab-id="t.id"
            :draggable="!!t.closable"
            @dragstart.stop="onTabDragStart($event, t)"
            @dragend.stop="endTabDrag"
            @click="onTabClick(t)"
            @contextmenu.prevent="onTabContextmenu($event, t)"
          >
            <el-icon v-if="isEpIcon(t.icon)" class="tab-glyph"><component :is="t.icon" /></el-icon>
            <svg-icon v-else class="tab-glyph" :name="t.icon" />
            <span>{{ tabTitle(t) }}</span>
            <span
              v-if="t.connState"
              class="conn-dot"
              :class="t.connState"
              :title="$t('conn.' + t.connState)"
            ></span>
            <el-icon v-if="t.closable"
              class="x"
              @mousedown.stop.prevent
              @dragstart.stop.prevent
              @click.stop="closeTabById(t.id)"><Close /></el-icon>
          </div>
          <div
            v-if="dockGhostIndex === tabs.length && index === tabs.length - 1"
            :key="'dock-ghost-last'"
            class="tab tab-dock-ghost"
          ></div>
        </template>
      </div>
    </div>
    <button
      v-show="tabOverflow"
      class="tab-arrow"
      :disabled="!tabScrollRight"
      :aria-label="$t('tab.scrollRight')"
      @click="scrollTabs(1)"
    ><el-icon><ArrowRight /></el-icon></button>
    <ctx-menu ref="tabCtxMenu" @select="onTabCtxSelect" />
  </div>
</template>

<script>
import CtxMenu from '../common/CtxMenu.vue';
import {
  store,
  tabDrag,
  closeTab,
  refreshSessionTab,
  api,
  detachTab,
  moveTabToWindow,
  copySessionToGroup,
  openSshSession,
  setDockTarget,
  clearDockTarget,
  setPendingRegionDrop,
  clearPendingRegionDrop,
  layoutMoveTab,
  reportRegionOrder,
  hostedInGroup,
  tabPayload,
  findAsset,
  enabledMethods,
} from '../../store';
import { t } from '../../i18n';
import { TAB_DRAG_TYPE } from '../../constants';
import { getProtocol } from '../../protocols';
import { isElementIcon } from '../../lib/icons';

/**
 * 分屏区域的页签条：主窗口与独立窗口的每个区域各有一条，样式与交互沿用原顶栏。
 * node 是布局树叶子（区域），页签成员与活动页签都来自它；main 标记主栏（左上角第一个
 * 区域），只有主栏向主进程上报栏矩形并承载主窗口的折叠树按钮。
 */
export default {
  name: 'TabBar',
  components: { CtxMenu },
  props: {
    node: { type: Object, required: true },
    main: { type: Boolean, default: false },
    treeHidden: { type: Boolean, default: false },
  },
  data() {
    return {
      drag: tabDrag,
      dropBeforeTabId: null,
      tabDragOver: false,
      tabOverflow: false,
      tabScrollLeft: false,
      tabScrollRight: false,
      dockGhostIndex: -1,
    };
  },
  computed: {
    tabs() {
      return this.node.tabs.map((id) => store.tabs.find((t) => t.id === id)).filter(Boolean);
    },
    showToggle() {
      return this.main && !hostedInGroup();
    },
    detachedHost() {
      return hostedInGroup();
    },
    localeTick() {
      return store.localeTick;
    },
  },
  watch: {
    'node.active'() {
      this.$nextTick(this.scrollActiveTabIntoView);
    },
    treeHidden() {
      this.scheduleReportBounds();
    },
  },
  created() {
    this._tabScrollFrame = 0;
    this._tabDragX = 0;
    this._tabClickBlockedUntil = 0;
    this._tabResizeObs = null;
    this._boundsTimer = 0;
    this._offDockClear = null;
  },
  mounted() {
    this.observeTabbar();
    this.$nextTick(this.updateTabArrows);
    if (this.main) this.reportTabbarBounds();
    if (this.main) window.addEventListener('resize', this.scheduleReportBounds);
    // 源窗口取消拖放或渲染进程中途死掉时不会给本窗口发 dragleave，落点提示只能由主进程统一收回。
    if (api.onSessionDockClear) {
      this._offDockClear = api.onSessionDockClear(() => this.clearDockGhost());
    }
  },
  beforeUnmount() {
    if (this._tabResizeObs) this._tabResizeObs.disconnect();
    if (this._offDockClear) this._offDockClear();
    if (this._boundsTimer) clearTimeout(this._boundsTimer);
    if (this.main) window.removeEventListener('resize', this.scheduleReportBounds);
  },
  methods: {
    isEpIcon(icon) {
      return isElementIcon(icon);
    },
    tabTitle(tab) {
      // touch localeTick so the home tab label follows language switches
      void this.localeTick;
      if (tab.id === 'home') return this.$t('nav.home');
      return tab.title;
    },
    /* ---- 拖拽：区域内重排 / 跨区落进别的区域栏 / 拖出建窗 / 接收外来页签 ---- */
    onTabDragStart(event, tab) {
      if (!tab.closable || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
      tabDrag.tabId = tab.id;
      tabDrag.handled = false;
      tabDrag.title = this.tabTitle(tab);
      tabDrag.show = false;
      const protocol = getProtocol(tab.kind);
      tabDrag.detachable = !!(protocol && protocol.component);
      // Chromium 只把拖放交给光标下最上层的窗口：先交描述符给主进程并抬起其他宿主窗口，
      // 别的窗口才可能收到这次 drop；落在本窗口区域内由 TabBar/PaneLayout 的 drop 处理。
      if (tabDrag.detachable && api.sessionDockPrepare) {
        tabDrag.prepared = true;
        api.sessionDockPrepare({ tab: tabPayload(tab) }).catch(() => {});
      }
    },
    onTabDragOver(event) {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (!tabDrag.tabId) {
        this.updateDockGhost(event.clientX);
        return;
      }
      this.tabDragOver = true;
      this._tabDragX = event.clientX;
      this.updateTabDropTarget();
      if (!this._tabScrollFrame) this._tabScrollFrame = requestAnimationFrame(this.scrollTabsForDrag);
    },
    onTabDragLeave(event) {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      this.tabDragOver = false;
      // 落点提示不在这儿清：`.tabbar-wrap` 只是整条栏的一部分，跨到滚动按钮上仍算瞄准中。
      cancelAnimationFrame(this._tabScrollFrame);
      this._tabScrollFrame = 0;
    },
    onTabDrop(event) {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!tabDrag.tabId) {
        this.acceptForeignTab(event.dataTransfer.getData(TAB_DRAG_TYPE), event.clientX);
        return;
      }
      this._tabDragX = event.clientX;
      tabDrag.handled = true;
      this.updateTabDropTarget();
      layoutMoveTab(tabDrag.tabId, this.node.id, this.dropBeforeTabId);
      reportRegionOrder();
      this.endTabDrag();
    },
    isForeignDrag(event) {
      return (
        !tabDrag.tabId &&
        !!event.dataTransfer &&
        Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)
      );
    },
    /** 上报给主进程判定的是整条栏；栏左边的按钮区也要能接住瞄准中的落点。 */
    onRowDragOver(event) {
      if (!this.isForeignDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.updateDockGhost(event.clientX);
    },
    onRowDragLeave(event) {
      if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
      this.clearDockGhost();
    },
    onRowDrop(event) {
      if (!this.isForeignDrag(event)) return;
      event.preventDefault();
      this.acceptForeignTab(event.dataTransfer.getData(TAB_DRAG_TYPE), event.clientX);
    },
    updateTabDropTarget() {
      const tabs = this.$refs.tabbarWrap.querySelectorAll('.tab[draggable="true"]');
      const before = Array.from(tabs).find((tab) => {
        const rect = tab.getBoundingClientRect();
        return this._tabDragX < rect.left + rect.width / 2;
      });
      this.dropBeforeTabId = before ? before.dataset.tabId : null;
    },
    scrollTabsForDrag() {
      this._tabScrollFrame = 0;
      const wrap = this.$refs.tabbarWrap;
      if (!wrap || !tabDrag.tabId || !this.tabDragOver) return;
      const rect = wrap.getBoundingClientRect();
      const direction = this._tabDragX < rect.left + 40 ? -1 : (this._tabDragX > rect.right - 40 ? 1 : 0);
      const previous = wrap.scrollLeft;
      wrap.scrollLeft += direction * 12;
      if (wrap.scrollLeft !== previous) {
        this.updateTabDropTarget();
        this._tabScrollFrame = requestAnimationFrame(this.scrollTabsForDrag);
      }
    },
    endTabDrag() {
      const dragged = tabDrag.tabId;
      // 松手不在任何落点上＝拖出窗口，按拆分独立窗口处理；跨窗口投放时主进程会在
      // session:detach 里按"页签已在别的窗口"兜底取消，不会重复建窗。
      const detach = dragged && !tabDrag.handled && tabDrag.detachable;
      if (tabDrag.prepared) {
        tabDrag.prepared = false;
        if (api.sessionDockAbort) api.sessionDockAbort({}).catch(() => {});
      }
      if (dragged) this._tabClickBlockedUntil = Date.now() + 150;
      tabDrag.tabId = '';
      tabDrag.handled = false;
      tabDrag.detachable = false;
      tabDrag.show = false;
      tabDrag.title = '';
      this.dropBeforeTabId = null;
      this.tabDragOver = false;
      this.clearDockGhost();
      cancelAnimationFrame(this._tabScrollFrame);
      this._tabScrollFrame = 0;
      if (detach) this.detachSessionTab(dragged, true);
    },
    /**
     * Landing slot for a tab dragged in from another window: highlight it and return the tab to
     * insert before. Only the visual index is known while hovering, since dataTransfer values stay
     * unreadable until the drop. 它只由事件清除（离开这条栏、落位、源窗口 dragend 的广播）。
     */
    updateDockGhost(clientX) {
      const wrap = this.$refs.tabbarWrap;
      if (!wrap || !Number.isFinite(clientX)) {
        this.clearDockGhost();
        return null;
      }
      const slots = wrap.querySelectorAll('.tab[data-tab-id]');
      let index = this.tabs.length;
      for (let i = 0; i < slots.length; i += 1) {
        const rect = slots[i].getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) {
          index = i;
          break;
        }
      }
      // 主窗口的主栏首页恒在首位；独立窗口没有首页，第一条前也能落。
      const floor = this.tabs[0] && this.tabs[0].id === 'home' ? 1 : 0;
      this.dockGhostIndex = Math.max(floor, Math.min(index, this.tabs.length));
      return this.dockGhostIndex < this.tabs.length ? this.tabs[this.dockGhostIndex].id : null;
    },
    clearDockGhost() {
      this.dockGhostIndex = -1;
    },
    async acceptForeignTab(tabId, clientX) {
      const beforeId = this.updateDockGhost(clientX);
      this.clearDockGhost();
      if (!tabId) return;
      if (this.detachedHost) {
        // 快照回推先落主栏，落点由 pendingRegionDrop 在下一帧快照消费一次。
        setPendingRegionDrop(tabId, this.node.id, beforeId);
        try {
          await moveTabToWindow(tabId, beforeId, false);
        } catch (e) {
          clearPendingRegionDrop(tabId);
          this.$message.error(e.code === 'DOCK_TAB' ? t('tab.dockFail') : e.message || t('tab.dockFail'));
        }
        return;
      }
      // 主窗口靠收回广播落位，dockTarget 必须等广播消费一次；只对本窗口确实托管的页签才登记，
      // 否则主进程会当成"本来就在这儿"直接原样返回，留下一个没人消费的落点。
      const parked = store.tabs.find((t) => t.id === tabId && t.detached);
      if (!parked) return;
      setDockTarget(tabId, beforeId, this.node.id);
      try {
        await moveTabToWindow(tabId, null, true);
      } catch (e) {
        clearDockTarget(tabId);
        this.$message.error(e.code === 'DOCK_TAB' ? t('tab.dockFail') : e.message || t('tab.dockFail'));
      }
    },
    async detachSessionTab(tabId, fromDrag) {
      try {
        await detachTab(tabId, fromDrag);
      } catch (e) {
        this.$message.error(e.code === 'DETACH_KIND' ? t('tab.detachBadKind') : e.message || t('tab.detachFail'));
      }
    },
    /** 独立窗口里的"收回主窗口"没有落点，按原相对位置回去：不预存 dockTarget。 */
    async dockTabToHost(tabId) {
      try {
        await moveTabToWindow(tabId, null, true);
      } catch (e) {
        this.$message.error(e.code === 'DOCK_TAB' ? t('tab.dockFail') : e.message || t('tab.dockFail'));
      }
    },
    async copySessionInWindow(tabId) {
      try {
        await copySessionToGroup(tabId);
      } catch (e) {
        // 失败原因都是主进程内部判定（页签刚被接走之类），只给一句本地化结论，不抛英文原文。
        this.$message.error(t('tab.copyFail'));
      }
    },
    /* ---- 主栏矩形上报：跨窗口拖放的命中判定用 ---- */
    scheduleReportBounds() {
      if (this._boundsTimer) return;
      this._boundsTimer = setTimeout(() => {
        this._boundsTimer = 0;
        this.reportTabbarBounds();
      }, 150);
    },
    reportTabbarBounds() {
      // 只有主栏的矩形参与跨窗口拖放命中判定；别的区域上报会覆盖同一窗口的主栏矩形。
      if (!this.main || !api.sessionTabbarBounds || !this.$el || !this.$el.getBoundingClientRect) return;
      const rect = this.$el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      api
        .sessionTabbarBounds({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) })
        .catch(() => {});
    },
    onTabClick(tab) {
      if (tabDrag.tabId || Date.now() < this._tabClickBlockedUntil) return;
      this.node.active = tab.id;
      store.activeTab = tab.id;
    },
    observeTabbar() {
      if (this._tabResizeObs) this._tabResizeObs.disconnect();
      this._tabResizeObs = null;
      const wrap = this.$refs.tabbarWrap;
      if (!wrap || !window.ResizeObserver) return;
      this._tabResizeObs = new ResizeObserver(() => {
        this.updateTabArrows();
        if (this.main) this.scheduleReportBounds();
      });
      this._tabResizeObs.observe(wrap);
      if (wrap.firstElementChild) this._tabResizeObs.observe(wrap.firstElementChild);
    },
    updateTabArrows() {
      const wrap = this.$refs.tabbarWrap;
      if (!wrap) {
        this.tabOverflow = false;
        this.tabScrollLeft = false;
        this.tabScrollRight = false;
        return;
      }
      const max = wrap.scrollWidth - wrap.clientWidth;
      this.tabOverflow = max > 1;
      this.tabScrollLeft = wrap.scrollLeft > 0;
      this.tabScrollRight = wrap.scrollLeft < max - 1;
    },
    scrollTabs(dir) {
      const wrap = this.$refs.tabbarWrap;
      if (!wrap) return;
      const step = Math.max(120, Math.round(wrap.clientWidth * 0.6));
      const max = wrap.scrollWidth - wrap.clientWidth;
      const target = Math.max(0, Math.min(max, wrap.scrollLeft + dir * step));
      wrap.scrollTo({ left: target, behavior: 'smooth' });
    },
    scrollActiveTabIntoView() {
      const wrap = this.$refs.tabbarWrap;
      if (!wrap) return;
      const target = Array.from(wrap.querySelectorAll('.tab')).find(
        (el) => el.dataset.tabId === this.node.active
      );
      if (!target) return;
      const wr = wrap.getBoundingClientRect();
      const tr = target.getBoundingClientRect();
      if (tr.left < wr.left) wrap.scrollLeft -= Math.ceil(wr.left - tr.left);
      else if (tr.right > wr.right) wrap.scrollLeft += Math.ceil(tr.right - wr.right);
      this.updateTabArrows();
    },
    /** 页签点与关闭确认共用这一判定：连接中或已连接都算活动会话。 */
    isLiveTab(tab) {
      return tab.connState === 'connecting' || tab.connState === 'ready';
    },
    closeTabById(id) {
      if (tabDrag.tabId || Date.now() < this._tabClickBlockedUntil) return;
      const tab = store.tabs.find((t) => t.id === id);
      if (!tab) return;
      if (this.isLiveTab(tab)) {
        this.$confirm(
          t('tab.closeConfirmMsg', { name: tab.title }),
          t('tab.closeConfirmTitle'),
          { confirmButtonText: t('msg.confirm'), cancelButtonText: t('msg.cancel'), type: 'warning' }
        ).then(() => {
          closeTab(id);
        }).catch(() => {});
      } else {
        closeTab(id);
      }
    },
    /** The asset's current SSH method, so a duplicated tab opens with today's settings, not the tab's stale copy. */
    sshSessionTarget(tab) {
      if (!tab) return null;
      const hit = findAsset(tab.assetId);
      if (!hit) return null;
      const method = enabledMethods(hit.asset).find((m) => m.id === (tab.methodId || 'ssh'));
      return method ? { asset: hit.asset, method } : null;
    },
    onTabContextmenu(event, tab) {
      const protocol = getProtocol(tab.kind);
      const isSession = !!(protocol && protocol.component);
      const isHome = tab.id === 'home';
      const items = [];
      if (isSession) {
        items.push({ label: t('tab.refresh'), icon: 'Refresh', action: 'refresh', tabId: tab.id });
        if (tab.kind === 'ssh' && this.sshSessionTarget(tab)) {
          items.push({ label: t('tab.copySession'), icon: 'DocumentCopy', action: 'copySession', tabId: tab.id });
        }
        if (this.detachedHost) {
          items.push({ label: t('tab.dockToHost'), icon: 'Position', action: 'dock', tabId: tab.id });
        }
        items.push(
          { label: t('tab.detachToWindow'), icon: 'Rank', action: 'detach', tabId: tab.id },
          { sep: true }
        );
      }
      if (!isHome) {
        items.push({ label: t('tab.closeCurrent'), icon: 'Close', action: 'closeCurrent', tabId: tab.id });
      }
      items.push({ label: t('tab.closeOthers'), icon: 'CircleClose', action: 'closeOthers', tabId: tab.id });
      if (!isHome) {
        items.push({ label: t('tab.closeLeft'), icon: 'Back', action: 'closeLeft', tabId: tab.id });
      }
      items.push(
        { label: t('tab.closeRight'), icon: 'Right', action: 'closeRight', tabId: tab.id },
        { label: t('tab.closeAll'), icon: 'CircleCloseFilled', action: 'closeAll', tabId: tab.id }
      );
      this.$refs.tabCtxMenu.open(event, items);
    },
    onTabCtxSelect(item) {
      if (!item) return;
      // Bulk operations only reach the tabs this region shows; a detached session owns its own
      // window and ends only when that window closes.
      const visible = this.tabs;
      const index = visible.findIndex((tb) => tb.id === item.tabId);
      if (index < 0) return;
      if (item.action === 'refresh') refreshSessionTab(item.tabId);
      else if (item.action === 'copySession') {
        // 独立窗口不能自己分配页签 id：交给主窗口建好再搬回来。
        if (this.detachedHost) this.copySessionInWindow(item.tabId);
        else {
          const target = this.sshSessionTarget(store.tabs.find((tb) => tb.id === item.tabId));
          // 传源页签作锚点：复制出来的页签落进本页签所在区域，紧跟其后。
          if (target) openSshSession(target.asset, target.method, item.tabId);
        }
      }
      else if (item.action === 'dock') this.dockTabToHost(item.tabId);
      else if (item.action === 'detach') this.detachSessionTab(item.tabId);
      else if (item.action === 'closeCurrent') this.closeTabById(item.tabId);
      else if (item.action === 'closeOthers') {
        this.closeTabsBulk(visible.filter((tb) => tb.id !== item.tabId));
      } else if (item.action === 'closeLeft') this.closeTabsBulk(visible.slice(0, index));
      else if (item.action === 'closeRight') this.closeTabsBulk(visible.slice(index + 1));
      else if (item.action === 'closeAll') this.closeTabsBulk(visible);
    },
    closeTabsBulk(targets) {
      const closable = targets.filter((tb) => tb.closable);
      if (!closable.length) return;
      const connected = closable.filter((tb) => this.isLiveTab(tb)).length;
      const run = () => closable.forEach((tb) => closeTab(tb.id));
      if (!connected) {
        run();
        return;
      }
      this.$confirm(
        t('tab.closeBulkConfirmMsg', { count: connected }),
        t('tab.closeConfirmTitle'),
        { confirmButtonText: t('msg.confirm'), cancelButtonText: t('msg.cancel'), type: 'warning' }
      ).then(run).catch(() => {});
    },
  },
};
</script>
