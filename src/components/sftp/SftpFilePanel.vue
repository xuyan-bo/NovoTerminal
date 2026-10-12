<template>
  <div
    class="sftp-panel"
    :class="{ 'sftp-panel-remote': side === 'remote' }"
    :data-side="side"
    @contextmenu.prevent="$emit('blank-context', $event, side)"
    @dragenter.prevent
    @dragover.prevent="$emit('drag-over', $event, side)"
    @drop.prevent.stop="$emit('zone-drop', $event, side)"
  >
    <div class="panel-head">
      <span class="panel-title">
        {{ $t(side === 'local' ? 'sftp.local' : 'sftp.remote') }}
        <slot name="connection" />
      </span>
      <div class="path-bar">
        <button type="button" class="path-icon-btn" :title="$t('sftp.back')" @click="$emit('up', $event)">
          <svg-icon name="chevron-left" />
        </button>
        <button type="button" class="path-icon-btn" :title="$t('sftp.home')" @click="$emit('home', $event)">
          <svg-icon name="home" />
        </button>
        <el-input
          :value="pathInput"
          size="mini"
          @input="$emit('path-input', $event)"
          @keyup.enter.native="$emit('navigate', pathInput, $event)"
        />
        <button
          type="button"
          class="path-icon-btn"
          :class="{ spinning: loading }"
          :title="$t('sftp.refresh')"
          :disabled="loading || refreshDisabled"
          @click="$emit('refresh', $event)"
        >
          <svg-icon name="refresh-cloud" />
        </button>
      </div>
    </div>
    <div class="file-head">
      <span
        v-for="col in columns"
        :key="col.key"
        :class="[col.cls, { 'sort-on': sort.key === col.key }]"
        @click="$emit('sort-change', side, col.key)"
      >{{ $t(col.label) }}<i class="sort-ico" :class="sortIcon(col.key)"></i></span>
    </div>
    <!-- Stop the native drop here so it cannot also reach the panel/root handlers. -->
    <div
      class="file-list"
      :data-side="side"
      @contextmenu.prevent="$emit('blank-context', $event, side)"
      @dragenter.prevent
      @dragover.prevent="$emit('drag-over', $event, side)"
      @drop.prevent.stop="$emit('zone-drop', $event, side)"
      @mousedown="onAreaMouseDown"
    >
      <div
        v-for="f in items"
        :key="(side === 'local' ? 'l-' : 'r-') + f.name"
        class="file-row"
        :class="{ sel: selected.indexOf(f.name) >= 0, 'drop-hi': dropHi === (side === 'local' ? 'l:' : 'r:') + f.name, parent: f.isParent }"
        :data-side="side"
        :data-name="f.name"
        :data-isdir="f.isDir ? '1' : '0'"
        :data-parent="f.isParent ? '1' : '0'"
        :draggable="true"
        @click="$emit('select', side, f.name, $event)"
        @dblclick="$emit('item-dbl', f, $event)"
        @contextmenu.prevent.stop="!f.isParent && $emit('item-context', $event, side, f)"
        @dragstart="$emit('drag-start', $event, side, f)"
        @dragend="$emit('drag-end', $event)"
        @dragover.prevent.stop="$emit('row-over', $event, side, f)"
        @dragleave="$emit('drag-leave', $event)"
      >
        <!-- Static src turns into a Vite import; public icons must resolve relative to the document (file:// included). -->
        <span class="c-name"><img v-if="f.isDir" class="f-ico" :src="'icons/folder.svg'" alt="" /><svg-icon v-else class="f-ico-file" name="file" :size="13" />{{ f.name }}</span>
        <span class="c-size">{{ f.sizeText }}</span>
        <span class="c-time">{{ f.mtime }}</span>
      </div>
    </div>
    <div v-if="marquee" class="marquee" :style="marqueeStyle"></div>
  </div>
</template>

<script>
export default {
  name: 'SftpFilePanel',
  props: {
    side: { type: String, required: true },
    items: { type: Array, default: () => [] },
    pathInput: { type: String, default: '' },
    selected: { type: Array, default: () => [] },
    sort: { type: Object, default: () => ({ key: 'name', dir: 'asc' }) },
    loading: { type: Boolean, default: false },
    dropHi: { type: String, default: '' },
    refreshDisabled: { type: Boolean, default: false },
  },
  data() {
    return {
      marquee: null,
      columns: [
        { key: 'name', cls: 'c-name', label: 'sftp.colName' },
        { key: 'size', cls: 'c-size', label: 'sftp.colSize' },
        { key: 'time', cls: 'c-time', label: 'sftp.colTime' },
      ],
    };
  },
  computed: {
    marqueeStyle() {
      const m = this.marquee;
      return m
        ? { left: m.left + 'px', top: m.top + 'px', width: m.width + 'px', height: m.height + 'px' }
        : {};
    },
  },
  created() {
    // Vue 2 does not proxy data keys beginning with an underscore.
    this._marquee = null;
    this._onMarqueeMove = null;
    this._onMarqueeUp = null;
  },
  beforeDestroy() {
    this.detachMarquee();
  },
  methods: {
    sortIcon(key) {
      if (!this.sort || this.sort.key !== key) return 'el-icon-d-caret';
      return this.sort.dir === 'desc' ? 'el-icon-caret-bottom' : 'el-icon-caret-top';
    },
    // Rubber-band selection starts on empty list space only: rows carry draggable=true,
    // so a press there must stay a drag gesture instead of a selection sweep.
    onAreaMouseDown(e) {
      if (e.button !== 0) return;
      const row = e.target && e.target.closest ? e.target.closest('.file-row') : null;
      if (row) return;
      const list = e.currentTarget.getBoundingClientRect();
      this._marquee = {
        x: e.clientX,
        y: e.clientY,
        list,
        additive: e.ctrlKey || e.metaKey || e.shiftKey,
        started: false,
      };
      e.preventDefault();
      this._onMarqueeMove = (ev) => this.onMarqueeMove(ev);
      this._onMarqueeUp = () => this.onMarqueeUp();
      window.addEventListener('mousemove', this._onMarqueeMove);
      window.addEventListener('mouseup', this._onMarqueeUp);
    },
    onMarqueeMove(e) {
      const m = this._marquee;
      if (!m) return;
      const x = Math.min(Math.max(e.clientX, m.list.left), m.list.right);
      const y = Math.min(Math.max(e.clientY, m.list.top), m.list.bottom);
      if (!m.started) {
        if (Math.abs(x - m.x) < 4 && Math.abs(y - m.y) < 4) return;
        m.started = true;
        this.$emit('marquee', this.side, { phase: 'begin', additive: m.additive });
      }
      const top = Math.min(m.y, y);
      const bottom = Math.max(m.y, y);
      this.marquee = {
        left: Math.min(m.x, x),
        top,
        width: Math.abs(x - m.x),
        height: bottom - top,
      };
      this.$emit('marquee', this.side, { phase: 'move', names: this.namesInBand(top, bottom) });
    },
    namesInBand(top, bottom) {
      const rows = this.$el.querySelectorAll('.file-list .file-row:not(.parent)');
      const names = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (r.bottom >= top && r.top <= bottom) names.push(rows[i].getAttribute('data-name'));
      }
      return names;
    },
    onMarqueeUp() {
      const m = this._marquee;
      this._marquee = null;
      this.detachMarquee();
      this.marquee = null;
      if (!m) return;
      if (m.started) this.$emit('marquee', this.side, { phase: 'end' });
      else this.$emit('blank-click', this.side);
    },
    detachMarquee() {
      if (this._onMarqueeMove) window.removeEventListener('mousemove', this._onMarqueeMove);
      if (this._onMarqueeUp) window.removeEventListener('mouseup', this._onMarqueeUp);
      this._onMarqueeMove = null;
      this._onMarqueeUp = null;
    },
  },
};
</script>

<style scoped>
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
.path-icon-btn.spinning .svg-icon {
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
.file-head span {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.file-head span:hover {
  color: var(--text-2);
}
.file-head span.sort-on {
  color: var(--accent);
}
.sort-ico {
  font-size: 10px;
  opacity: 0.45;
}
.file-head span.sort-on .sort-ico {
  opacity: 1;
}
.file-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  position: relative;
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
  width: 13px;
  height: 13px;
  margin-right: 4px;
  vertical-align: -2px;
  object-fit: contain;
}
/* SvgIcon's own scoped rule pins vertical-align: middle, so outrank it to match the folder image. */
.c-name .f-ico-file {
  margin-right: 4px;
  vertical-align: -2px;
}
.marquee {
  position: fixed;
  z-index: 20;
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  border-radius: 2px;
  pointer-events: none;
}
</style>
