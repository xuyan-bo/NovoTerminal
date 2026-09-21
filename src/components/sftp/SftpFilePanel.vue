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
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
        <button type="button" class="path-icon-btn" :title="$t('sftp.home')" @click="$emit('home', $event)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
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
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0012 4a8 8 0 107.73 10h-2.08A6 6 0 1112 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        </button>
      </div>
    </div>
    <div class="file-head">
      <span class="c-name">{{ $t('sftp.colName') }}</span>
      <span class="c-size">{{ $t('sftp.colSize') }}</span>
      <span class="c-time">{{ $t('sftp.colTime') }}</span>
    </div>
    <!-- Stop the native drop here so it cannot also reach the panel/root handlers. -->
    <div
      class="file-list"
      :data-side="side"
      @contextmenu.prevent="$emit('blank-context', $event, side)"
      @dragenter.prevent
      @dragover.prevent="$emit('drag-over', $event, side)"
      @drop.prevent.stop="$emit('zone-drop', $event, side)"
    >
      <div
        v-for="f in items"
        :key="(side === 'local' ? 'l-' : 'r-') + f.name"
        class="file-row"
        :class="{ sel: selected === f.name, 'drop-hi': dropHi === (side === 'local' ? 'l:' : 'r:') + f.name, parent: f.isParent }"
        :data-side="side"
        :data-name="f.name"
        :data-isdir="f.isDir ? '1' : '0'"
        :data-parent="f.isParent ? '1' : '0'"
        :draggable="true"
        @click="$emit('select', f.name, $event)"
        @dblclick="$emit('item-dbl', f, $event)"
        @contextmenu.prevent.stop="!f.isParent && $emit('item-context', $event, side, f)"
        @dragstart="$emit('drag-start', $event, side, f)"
        @dragend="$emit('drag-end', $event)"
        @dragover.prevent.stop="$emit('row-over', $event, side, f)"
        @dragleave="$emit('drag-leave', $event)"
      >
        <span class="c-name"><span class="f-ico">{{ f.isDir ? '\uD83D\uDCC1' : '\uD83D\uDCC4' }}</span>{{ f.name }}</span>
        <span class="c-size">{{ f.sizeText }}</span>
        <span class="c-time">{{ f.mtime }}</span>
      </div>
      <div v-if="!items.length && !loading" class="empty-box">{{ $t('sftp.empty') }}</div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'SftpFilePanel',
  props: {
    side: { type: String, required: true },
    items: { type: Array, default: () => [] },
    pathInput: { type: String, default: '' },
    selected: { type: String, default: '' },
    loading: { type: Boolean, default: false },
    dropHi: { type: String, default: '' },
    refreshDisabled: { type: Boolean, default: false },
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
.path-icon-btn.spinning svg {
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
  margin-right: 4px;
}
</style>
