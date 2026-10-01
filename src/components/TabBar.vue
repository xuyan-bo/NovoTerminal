<template>
  <div class="tabbar-row">
    <button
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
      :class="{ 'drop-hint': dropHint }"
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
import CtxMenu from './CtxMenu.vue';
import { store, closeTab, moveTab, refreshSessionTab, api, detachTab, setDockTarget } from '../store';
import { t } from '../i18n';
import { OS_SVG } from '../constants';
import { getProtocol } from '../protocols';

const TAB_DRAG_TYPE = 'application/x-omnidesk-tab';
/** How often the tab bar rect is re-published for the detached window's hit test. */
const BOUNDS_REPORT_MS = 150;
/** Preview size of the detached-window outline shown while a tab is dragged out. */
const GHOST_W = 320;
const GHOST_H = 190;

export default {
  name: 'TabBar',
  components: { CtxMenu },
  props: {
    treeHidden: { type: Boolean, default: false },
  },
  data() {
    return {
      draggedTabId: '',
      dropBeforeTabId: null,
      tabDragOver: false,
      tabOverflow: false,
      tabScrollLeft: false,
      tabScrollRight: false,
      dropHint: false,
      dragGhost: { show: false, left: 0, top: 0, title: '' },
      dockGhostIndex: -1,
    };
  },
  computed: {
    tabs() {
      // A detached session lives in its own window and is not represented here at all; dragging
      // that window onto this row is what brings the tab back.
      return store.tabs.filter((t) => !t.detached);
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
    this._offDropHint = null;
  },
  mounted() {
    this.observeTabbar();
    this.$nextTick(this.updateTabArrows);
    this.reportTabbarBounds();
    if (api.onSessionDropHint) {
      this._offDropHint = api.onSessionDropHint((payload) => {
        this.dropHint = !!(payload && payload.active);
        if (this.dropHint) this.updateDockGhost(payload.tabId, payload.x);
        else this.dockGhostIndex = -1;
      });
    }
    window.addEventListener('resize', this.scheduleReportBounds);
  },
  beforeDestroy() {
    this.endTabDrag();
    if (this._tabResizeObs) this._tabResizeObs.disconnect();
    if (this._offDropHint) this._offDropHint();
    if (this._boundsTimer) clearTimeout(this._boundsTimer);
    window.removeEventListener('resize', this.scheduleReportBounds);
  },
  methods: {
    osSvg(os) {
      return OS_SVG[os] || '';
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
      if (!this.draggedTabId || !event.dataTransfer || !Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.tabDragOver = true;
      this._tabDragX = event.clientX;
      this.updateTabDropTarget();
      if (!this._tabScrollFrame) this._tabScrollFrame = requestAnimationFrame(this.scrollTabsForDrag);
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
      cancelAnimationFrame(this._tabScrollFrame);
      this._tabScrollFrame = 0;
    },
    onTabDrop(event) {
      if (!this.draggedTabId || !event.dataTransfer || !Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
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
     * A detached window dragged over the bar reports the cursor's x in page CSS px; show the
     * landing slot there. The store target survives the drop-hint clear because it arrives
     * before the merge broadcast that consumes it.
     */
    updateDockGhost(tabId, x) {
      const wrap = this.$refs.tabbarWrap;
      if (!tabId || !wrap || !Number.isFinite(x) || !this.$el) {
        this.dockGhostIndex = -1;
        return;
      }
      const clientX = this.$el.getBoundingClientRect().left + x;
      const slots = wrap.querySelectorAll('.tab[data-tab-id]');
      let index = this.tabs.length;
      for (let i = 0; i < slots.length; i += 1) {
        const rect = slots[i].getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) {
          index = i;
          break;
        }
      }
      index = Math.max(1, Math.min(index, this.tabs.length));
      this.dockGhostIndex = index;
      const visible = this.tabs;
      setDockTarget(tabId, index < visible.length ? visible[index].id : null);
    },
    async detachSessionTab(tabId, fromDrag) {
      try {
        await detachTab(tabId, fromDrag);
      } catch (e) {
        this.$message.error(e.code === 'DETACH_KIND' ? t('tab.detachBadKind') : e.message || t('tab.detachFail'));
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
    closeTabById(id) {
      if (this.draggedTabId || Date.now() < this._tabClickBlockedUntil) return;
      const tab = store.tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.connected) {
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
    onTabContextmenu(event, tab) {
      const protocol = getProtocol(tab.kind);
      const isSession = !!(protocol && protocol.component);
      const isHome = tab.id === 'home';
      const items = [];
      if (isSession) {
        items.push(
          { label: t('tab.refresh'), icon: 'el-icon-refresh', action: 'refresh', tabId: tab.id },
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
      const connected = closable.filter((tb) => tb.connected).length;
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
