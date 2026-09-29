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
        <div
          v-for="(t, index) in tabs"
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
          <span v-else class="tab-glyph">{{ t.icon }}</span>
          <span>{{ tabTitle(t) }}</span>
          <i
            v-if="t.closable"
            class="x el-icon-close"
            @mousedown.stop.prevent
            @dragstart.stop.prevent
            @click.stop="closeTabById(t.id)"
          ></i>
        </div>
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
  </div>
</template>

<script>
import CtxMenu from './CtxMenu.vue';
import { store, closeTab, moveTab, refreshSessionTab, api, detachTab } from '../store';
import { t } from '../i18n';
import { OS_SVG } from '../constants';
import { getProtocol } from '../protocols';

const TAB_DRAG_TYPE = 'application/x-omnidesk-tab';
/** How often the tab bar rect is re-published for the detached window's hit test. */
const BOUNDS_REPORT_MS = 150;

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
    this._dragPoint = null;
    this._dropHandled = false;
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
      this._dragPoint = null;
      // dragend coordinates are not reliable, so track the pointer for the whole drag.
      document.addEventListener('dragover', this.onDocDragOver, true);
    },
    onDocDragOver(event) {
      if (!this.draggedTabId) return;
      this._dragPoint = { x: event.clientX, y: event.clientY };
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
      const detach = dragged && !this._dropHandled && this.isDraggedOutside();
      document.removeEventListener('dragover', this.onDocDragOver, true);
      if (dragged) this._tabClickBlockedUntil = Date.now() + 150;
      this.draggedTabId = '';
      this.dropBeforeTabId = null;
      this.tabDragOver = false;
      cancelAnimationFrame(this._tabScrollFrame);
      this._tabScrollFrame = 0;
      this._dropHandled = false;
      this._dragPoint = null;
      if (detach) this.detachSessionTab(dragged);
    },
    /** Released outside the tab bar row means "take this session into its own window". */
    isDraggedOutside() {
      const point = this._dragPoint;
      const row = this.$el && this.$el.getBoundingClientRect ? this.$el.getBoundingClientRect() : null;
      if (!point || !row) return false;
      return point.x < row.left || point.x > row.right || point.y < row.top || point.y > row.bottom;
    },
    async detachSessionTab(tabId) {
      try {
        await detachTab(tabId);
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
