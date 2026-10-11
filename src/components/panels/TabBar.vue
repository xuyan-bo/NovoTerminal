<template>
  <div
    class="tabbar-row"
    @dragover="onRowDragOver"
    @dragleave="onRowDragLeave"
    @drop="onRowDrop"
  >
    <button
      v-if="!detached"
      class="tab-arrow tab-toggle"
      :aria-label="$t('tab.toggleTree')"
      :title="$t('tab.toggleTree')"
      @click="$emit('toggle-tree')"
    ><i :class="treeHidden ? 'el-icon-s-unfold' : 'el-icon-s-fold'"></i></button>
    <button
      v-show="tabOverflow"
      class="tab-arrow"
      :disabled="!tabScrollLeft"
      :aria-label="$t('tab.scrollLeft')"
      @click="scrollTabs(-1)"
    ><i class="el-icon-arrow-left"></i></button>
    <div
      ref="tabbarWrap"
      class="tabbar-wrap"
      @scroll.passive="updateTabArrows"
      @dragover="onTabDragOver"
      @dragleave="onTabDragLeave"
      @drop="onTabDrop"
    >
      <div class="tabbar">
        <template v-for="(t, index) in tabs">
          <div v-if="dockGhostIndex === index" :key="'dock-ghost-' + t.id" class="tab tab-dock-ghost"></div>
          <div
            :key="t.id"
            class="tab"
            :class="{
              active: activeTab === t.id,
              dragging: draggedTabId === t.id,
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
            <span
              v-if="t.os"
              class="tab-os"
              :class="'os-' + t.os"
              v-html="osSvg(t.os)"
            ></span>
            <i v-else-if="isGlyphIcon(t.icon)" class="tab-glyph" :class="t.icon" aria-hidden="true"></i>
            <svg-icon v-else class="tab-glyph" :name="t.icon" />
            <span>{{ tabTitle(t) }}</span>
            <span
              v-if="t.connState"
              class="conn-dot"
              :class="t.connState"
              :title="$t('conn.' + t.connState)"
            ></span>
            <i
              v-if="t.closable"
              class="x el-icon-close"
              @mousedown.stop.prevent
              @dragstart.stop.prevent
              @click.stop="closeTabById(t.id)"
            ></i>
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
    ><i class="el-icon-arrow-right"></i></button>
    <ctx-menu ref="tabCtxMenu" @select="onTabCtxSelect" />
    <div
      v-if="dragGhost.show"
      class="tab-ghost-window"
      :style="{ left: dragGhost.left + 'px', top: dragGhost.top + 'px' }"
    >
      <div class="ghost-bar"><span>{{ dragGhost.title }}</span></div>
      <div class="ghost-body"></div>
    </div>
  </div>
</template>

<script>
import CtxMenu from '../common/CtxMenu.vue';
import { store, closeTab, moveTab, refreshSessionTab, api, detachTab, moveTabToWindow, copySessionToGroup, setDockTarget, clearDockTarget, tabPayload, findAsset, enabledMethods, openSshSession } from '../../store';
import { t } from '../../i18n';
import { osIcon, TAB_DRAG_TYPE } from '../../constants';
import { getProtocol } from '../../protocols';

/** Preview size of the detached-window outline shown while a tab is dragged out. */
const GHOST_W = 320;
const GHOST_H = 190;
/** How often the tab bar rect is re-published for the drag-out drop test in the main process. */
const BOUNDS_REPORT_MS = 150;

export default {
  name: 'TabBar',
  components: { CtxMenu },
  props: {
    treeHidden: { type: Boolean, default: false },
    /** 'host' 主窗口页签栏，'group' 独立窗口页签栏：同一份外观，两处不同的宿主语义。 */
    scope: { type: String, default: 'host' },
  },
  data() {
    return {
      draggedTabId: '',
      dropBeforeTabId: null,
      tabDragOver: false,
      tabOverflow: false,
      tabScrollLeft: false,
      tabScrollRight: false,
      dragGhost: { show: false, left: 0, top: 0, title: '' },
      dockGhostIndex: -1,
    };
  },
  computed: {
    detached() {
      return this.scope === 'group';
    },
    tabs() {
      // 主窗口里拆出去的页签不出现（它只是留给收回时落位的停放副本）；
      // 独立窗口的 store.tabs 就是它自己承载的那些，全部显示。
      return this.detached ? store.tabs : store.tabs.filter((t) => !t.detached);
    },
    activeTab() {
      return store.activeTab;
    },
    localeTick() {
      return store.localeTick;
    },
  },
  watch: {
    activeTab() {
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
    this._dropHandled = false;
    this._dragDetachable = false;
    this._dragTitle = '';
    this._boundsTimer = 0;
    this._dragPrepared = false;
    this._offDockClear = null;
  },
  mounted() {
    this.observeTabbar();
    this.$nextTick(this.updateTabArrows);
    this.reportTabbarBounds();
    window.addEventListener('resize', this.scheduleReportBounds);
    // 源窗口取消拖放或渲染进程中途死掉时不会给本窗口发 dragleave，落点提示只能由主进程统一收回。
    if (api.onSessionDockClear) {
      this._offDockClear = api.onSessionDockClear(() => this.clearDockGhost());
    }
  },
  beforeDestroy() {
    this.endTabDrag();
    if (this._tabResizeObs) this._tabResizeObs.disconnect();
    if (this._offDockClear) this._offDockClear();
    if (this._boundsTimer) clearTimeout(this._boundsTimer);
    window.removeEventListener('resize', this.scheduleReportBounds);
  },
  methods: {
    osSvg(os) {
      return osIcon(os);
    },
    isGlyphIcon(icon) {
      return typeof icon === 'string' && icon.startsWith('el-icon-');
    },
    tabTitle(tab) {
      // touch localeTick so the home tab label follows language switches
      void this.localeTick;
      if (tab.id === 'home') return this.$t('nav.home');
      return tab.title;
    },
    onTabDragStart(event, tab) {
      if (!tab.closable || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
      this.draggedTabId = tab.id;
      this._dropHandled = false;
      const protocol = getProtocol(tab.kind);
      this._dragDetachable = !!(protocol && protocol.component);
      this._dragTitle = this.tabTitle(tab);
      this.dragGhost.show = false;
      // Chromium 只把拖放交给光标下最上层的窗口，也就是起手这个窗口自己；
      // 先把描述符交给主进程并让它抬起其他宿主窗口，别处的页签栏才可能收到这次 drop。
      if (this._dragDetachable && api.sessionDockPrepare) {
        this._dragPrepared = true;
        api.sessionDockPrepare({ tab: tabPayload(tab) }).catch(() => {});
      }
      document.addEventListener('dragover', this.onDocDragOver, true);
    },
    onDocDragOver(event) {
      if (!this.draggedTabId) return;
      this.updateDragGhost(event.clientX, event.clientY);
    },
    updateDragGhost(x, y) {
      const row = this.$el && this.$el.getBoundingClientRect ? this.$el.getBoundingClientRect() : null;
      const outsideRow = !row || x < row.left || x > row.right || y < row.top || y > row.bottom;
      if (!this._dragDetachable || !outsideRow) {
        this.dragGhost.show = false;
        return;
      }
      this.dragGhost.title = this._dragTitle;
      this.dragGhost.left = Math.max(8, Math.min(x - GHOST_W / 2, window.innerWidth - GHOST_W - 8));
      this.dragGhost.top = Math.max(8, Math.min(y - GHOST_H / 2, window.innerHeight - GHOST_H - 8));
      this.dragGhost.show = true;
    },
    onTabDragOver(event) {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (!this.draggedTabId) {
        this.updateDockGhost(event.clientX);
        return;
      }
      this.tabDragOver = true;
      this._tabDragX = event.clientX;
      this.updateTabDropTarget();
      if (!this._tabScrollFrame) this._tabScrollFrame = requestAnimationFrame(this.scrollTabsForDrag);
    },
    isForeignDrag(event) {
      return (
        !this.draggedTabId &&
        !!event.dataTransfer &&
        Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)
      );
    },
    /**
     * 上报给主进程做抬起判定的是整条页签栏（含折叠与左右滚动按钮），Chromium 却只把拖放事件交给
     * 光标底下的元素：只监听 `.tabbar-wrap` 时，光标落在按钮区窗口会被抬起来却看不到落点，
     * 而两种窗口的这条栏左边宽度不同（独立窗口没有折叠按钮），同一个位置就会一边有一边没有。
     */
    onRowDragOver(event) {
      if (!this.isForeignDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.updateDockGhost(event.clientX);
    },
    onRowDragLeave(event) {
      if (this.draggedTabId) return;
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
      if (!wrap || !this.draggedTabId || !this.tabDragOver) return;
      const rect = wrap.getBoundingClientRect();
      const direction = this._tabDragX < rect.left + 40 ? -1 : (this._tabDragX > rect.right - 40 ? 1 : 0);
      const previous = wrap.scrollLeft;
      wrap.scrollLeft += direction * 12;
      if (wrap.scrollLeft !== previous) {
        this.updateTabDropTarget();
        this._tabScrollFrame = requestAnimationFrame(this.scrollTabsForDrag);
      }
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
      if (!this.draggedTabId) {
        this.acceptForeignTab(event.dataTransfer.getData(TAB_DRAG_TYPE), event.clientX);
        return;
      }
      this._tabDragX = event.clientX;
      this._dropHandled = true;
      this.updateTabDropTarget();
      moveTab(this.draggedTabId, this.dropBeforeTabId);
      this.endTabDrag();
    },
    endTabDrag() {
      const dragged = this.draggedTabId;
      // Releasing outside the window gives no trustworthy coordinates (and no dragexit without a
      // drop target), so the main process re-checks the live cursor: a release over the tab bar
      // row comes back cancelled instead of detached.
      const detach = dragged && !this._dropHandled && this._dragDetachable;
      document.removeEventListener('dragover', this.onDocDragOver, true);
      if (this._dragPrepared) {
        this._dragPrepared = false;
        if (api.sessionDockAbort) api.sessionDockAbort({}).catch(() => {});
      }
      if (dragged) this._tabClickBlockedUntil = Date.now() + 150;
      this.draggedTabId = '';
      this.dropBeforeTabId = null;
      this.tabDragOver = false;
      this.dragGhost.show = false;
      this._dragDetachable = false;
      cancelAnimationFrame(this._tabScrollFrame);
      this._tabScrollFrame = 0;
      this._dropHandled = false;
      if (detach) this.detachSessionTab(dragged, true);
    },
    /**
     * Landing slot for a tab dragged in from another window: highlight it and return the tab to
     * insert before. Only the visual index is known while hovering, since dataTransfer values stay
     * unreadable until the drop. 它只由事件清除（离开这条栏、落位、源窗口 dragend 的广播），
     * 不用计时器过期——停下来瞄准落点时 Chromium 不再发 dragover，计时器会在松手前把提示吃掉。
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
      // 主窗口的首页恒在首位；独立窗口没有首页，第一条前也能落。
      this.dockGhostIndex = Math.max(this.detached ? 0 : 1, Math.min(index, this.tabs.length));
      const visible = this.tabs;
      return this.dockGhostIndex < visible.length ? visible[this.dockGhostIndex].id : null;
    },
    clearDockGhost() {
      this.dockGhostIndex = -1;
    },
    async acceptForeignTab(tabId, clientX) {
      const beforeId = this.updateDockGhost(clientX);
      this.clearDockGhost();
      if (!tabId) return;
      if (this.detached) {
        try {
          await moveTabToWindow(tabId, beforeId, false);
        } catch (e) {
          this.$message.error(e.code === 'DOCK_TAB' ? t('tab.dockFail') : e.message || t('tab.dockFail'));
        }
        return;
      }
      // 主窗口靠收回广播落位，dockTarget 必须等广播消费一次；只对本窗口确实托管的页签才登记，
      // 否则主进程会当成"本来就在这儿"直接原样返回，留下一个没人消费的落点。
      const parked = store.tabs.find((t) => t.id === tabId && t.detached);
      if (!parked) return;
      setDockTarget(tabId, beforeId);
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
    /** 独立窗口的"收回主窗口"没有落点，按原相对位置回去：不预存 dockTarget。 */
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
    /** Keep the main process telling the detached windows where the tab bar currently is. */
    scheduleReportBounds() {
      if (this._boundsTimer) return;
      this._boundsTimer = setTimeout(() => {
        this._boundsTimer = 0;
        this.reportTabbarBounds();
      }, BOUNDS_REPORT_MS);
    },
    reportTabbarBounds() {
      if (!api.sessionTabbarBounds || !this.$el || !this.$el.getBoundingClientRect) return;
      const rect = this.$el.getBoundingClientRect();
      api
        .sessionTabbarBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
        .catch(() => {});
    },
    onTabClick(tab) {
      if (this.draggedTabId || Date.now() < this._tabClickBlockedUntil) return;
      store.activeTab = tab.id;
    },
    observeTabbar() {
      if (this._tabResizeObs) this._tabResizeObs.disconnect();
      this._tabResizeObs = null;
      const wrap = this.$refs.tabbarWrap;
      if (!wrap || !window.ResizeObserver) return;
      this._tabResizeObs = new ResizeObserver(() => {
        this.updateTabArrows();
        this.scheduleReportBounds();
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
        (el) => el.dataset.tabId === this.activeTab
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
      if (this.draggedTabId || Date.now() < this._tabClickBlockedUntil) return;
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
        items.push({ label: t('tab.refresh'), icon: 'el-icon-refresh', action: 'refresh', tabId: tab.id });
        if (tab.kind === 'ssh' && this.sshSessionTarget(tab)) {
          items.push({ label: t('tab.copySession'), icon: 'el-icon-document-copy', action: 'copySession', tabId: tab.id });
        }
        if (this.detached) {
          items.push({ label: t('tab.dockToHost'), icon: 'el-icon-position', action: 'dock', tabId: tab.id });
        }
        items.push(
          { label: t('tab.detachToWindow'), icon: 'el-icon-rank', action: 'detach', tabId: tab.id },
          { sep: true }
        );
      }
      if (!isHome) {
        items.push({ label: t('tab.closeCurrent'), icon: 'el-icon-close', action: 'closeCurrent', tabId: tab.id });
      }
      items.push({ label: t('tab.closeOthers'), icon: 'el-icon-circle-close', action: 'closeOthers', tabId: tab.id });
      if (!isHome) {
        items.push({ label: t('tab.closeLeft'), icon: 'el-icon-back', action: 'closeLeft', tabId: tab.id });
      }
      items.push(
        { label: t('tab.closeRight'), icon: 'el-icon-right', action: 'closeRight', tabId: tab.id },
        { label: t('tab.closeAll'), icon: 'el-icon-error', action: 'closeAll', tabId: tab.id }
      );
      this.$refs.tabCtxMenu.open(event, items);
    },
    onTabCtxSelect(item) {
      if (!item) return;
      // Bulk operations only reach the tabs this row shows; a detached session owns its own window
      // and ends only when that window closes.
      const visible = this.tabs;
      const index = visible.findIndex((tb) => tb.id === item.tabId);
      if (index < 0) return;
      if (item.action === 'refresh') refreshSessionTab(item.tabId);
      else if (item.action === 'copySession') {
        // 独立窗口不能自己分配页签 id：交给主窗口建好再搬回来。
        if (this.detached) this.copySessionInWindow(item.tabId);
        else {
          const target = this.sshSessionTarget(store.tabs.find((tb) => tb.id === item.tabId));
          if (target) openSshSession(target.asset, target.method);
        }
      } else if (item.action === 'dock') this.dockTabToHost(item.tabId);
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
