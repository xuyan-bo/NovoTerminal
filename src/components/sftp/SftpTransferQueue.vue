<template>
  <div class="sftp-tasks">
    <div class="tasks-head"><span>{{ $t('sftp.tasks') }}</span></div>
    <div ref="viewport" class="vq-viewport" @scroll.passive="onScroll">
      <div class="vq-head" :style="gridStyle">
        <span class="vq-hcell" v-for="(col, i) in columns" :key="col.key">
          <span class="hcell-text">{{ $t(col.label) }}</span>
          <span class="col-resize" @mousedown.prevent="startResize($event, i)"></span>
        </span>
      </div>
      <div class="vq-spacer" :style="{ height: totalHeight + 'px', width: gridWidth + 'px' }">
        <div
          v-for="item in visibleRows"
          :key="item.row.taskId"
          class="vq-row"
          :class="{ striped: item.index % 2 === 1 }"
          :style="[gridStyle, { transform: 'translateY(' + (item.index * ROW_HEIGHT) + 'px)' }]"
        >
          <span class="c-name vq-cell" :title="item.row.name">
            <span class="indent" :style="{ width: item.depth * 16 + 'px' }"></span>
            <button
              v-if="isContainer(item.row)"
              type="button"
              class="tree-toggle"
              :class="{ open: isExpanded(item.row) }"
              @click.stop="toggleExpand(item.row)"
            ><el-icon><ArrowRight /></el-icon></button>
            <el-icon v-if="isContainer(item.row)" class="folder-tag" aria-hidden="true"><Folder /></el-icon>
            <span class="name-text">{{ item.row.name }}</span>
            <span v-if="isContainer(item.row)" class="folder-count">
              ({{ item.row.doneCount || 0 }}/{{ item.row.fileCount || 0 }})
            </span>
          </span>
          <span class="c-session vq-cell" :title="item.row.sessionName">{{ item.row.sessionName }}</span>
          <span class="c-size vq-cell">{{ item.row.sizeText }}</span>
          <span class="c-progress vq-cell">
            <span class="prog-line">
              <span class="prog-wrap"><span class="prog-bar" :style="{ width: (item.row.percent || 0) + '%' }"></span></span>
              <span class="prog-num" :title="item.row.error || ''">{{ progressText(item.row) }}</span>
            </span>
            <span v-if="item.row.status === 'error'" class="err-line" :title="item.row.error">{{ shortErr(item.row) }}</span>
          </span>
          <span class="c-speed vq-cell">{{ item.row.speedText }}</span>
          <span class="c-path vq-cell" :title="item.row.sourcePath">{{ item.row.sourcePath }}</span>
          <span class="c-path vq-cell" :title="item.row.targetPath">{{ item.row.targetPath }}</span>
          <span class="c-action vq-cell">
            <template v-if="!item.row.isDir">
              <el-tooltip :content="item.row.status === 'paused' ? $t('sftp.resume') : $t('sftp.pause')" placement="top">
                <button
                  type="button"
                  class="op-icon-btn"
                  :disabled="isTaskFinished(item.row)"
                  @click.stop="$emit('toggle-pause', item.row)"
                ><svg-icon :name="item.row.status !== 'paused' ? 'pause' : 'play'" /></button>
              </el-tooltip>
              <el-popconfirm
                :title="$t('sftp.confirmDeleteTask')"
                :confirm-button-text="$t('msg.confirm')"
                :cancel-button-text="$t('msg.cancel')"
                :width="240"
                placement="top"
                @confirm="$emit('remove-task', item.row)"
              >
                <template #reference>
                  <button type="button" class="op-icon-btn danger" @click.stop>
                    <svg-icon name="trash" />
                  </button>
                </template>
              </el-popconfirm>
            </template>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { isTaskFinished, transferErrorText } from './utils';

const ROW_HEIGHT = 40;
const OVERSCAN = 6;
const COLUMNS = [
  { key: 'name', label: 'sftp.colName', min: 120 },
  { key: 'session', label: 'sftp.colSession', min: 80 },
  { key: 'size', label: 'sftp.colSize', min: 56 },
  { key: 'progress', label: 'sftp.colProgress', min: 120 },
  { key: 'speed', label: 'sftp.colSpeed', min: 64 },
  { key: 'source', label: 'sftp.colSource', min: 160 },
  { key: 'target', label: 'sftp.colTarget', min: 160 },
  { key: 'action', label: 'sftp.colAction', min: 72 },
];
const DEFAULT_WIDTHS = [200, 92, 66, 155, 76, 240, 240, 72];

export default {
  name: 'SftpTransferQueue',
  props: {
    tasks: { type: Array, default: () => [] },
    expandedKeys: { type: Array, default: () => [] },
  },
  data() {
    return {
      ROW_HEIGHT,
      columns: COLUMNS,
      colWidths: DEFAULT_WIDTHS.slice(),
      scrollTop: 0,
      viewportHeight: 300,
      viewportWidth: 0,
    };
  },
  computed: {
    totalColWidth() {
      return this.colWidths.reduce((sum, w) => sum + w, 0);
    },
    // 视口比列总宽宽时，把多余宽度分给来源/目标路径列（留 2px 余量防止子像素溢出触发横向滚动条）
    effWidths() {
      const extra = this.viewportWidth - this.totalColWidth - 2;
      if (extra <= 0 || !this.colWidths.length) return this.colWidths;
      const out = this.colWidths.slice();
      const flexIdx = [];
      this.columns.forEach((c, i) => {
        if (c.key === 'source' || c.key === 'target') flexIdx.push(i);
      });
      if (!flexIdx.length) {
        out[out.length - 1] += extra;
        return out;
      }
      const each = Math.floor(extra / flexIdx.length);
      flexIdx.forEach((i) => { out[i] += each; });
      return out;
    },
    gridWidth() {
      return this.effWidths.reduce((sum, w) => sum + w, 0);
    },
    gridStyle() {
      return {
        display: 'grid',
        gridTemplateColumns: this.effWidths.map((w) => `${w}px`).join(' '),
        width: `${this.gridWidth}px`,
      };
    },
    flatRows() {
      const out = [];
      const expanded = this.expandedKeys || [];
      const walk = (rows, depth) => {
        for (const row of rows || []) {
          if (!row) continue;
          out.push({ row, depth });
          if (this.isContainer(row) && expanded.indexOf(row.taskId) >= 0) {
            walk(row.children || [], depth + 1);
          }
        }
      };
      walk(this.tasks, 0);
      return out;
    },
    totalHeight() {
      return this.flatRows.length * ROW_HEIGHT;
    },
    visibleRows() {
      const rows = this.flatRows;
      // 表头是滚动容器内的 sticky 元素，占 34px，计算可见行时要从 scrollTop 扣除
      const top = Math.max(0, this.scrollTop - 34);
      const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
      const end = Math.min(rows.length, Math.ceil((top + this.viewportHeight) / ROW_HEIGHT) + OVERSCAN);
      const out = [];
      for (let i = start; i < end; i += 1) out.push({ row: rows[i].row, depth: rows[i].depth, index: i });
      return out;
    },
  },
  created() {
    this._drag = null;
  },
  mounted() {
    this._onResize = () => {
      const vp = this.$refs.viewport;
      if (!vp) return;
      this.viewportHeight = vp.clientHeight;
      this.viewportWidth = vp.clientWidth;
      if (!this._fitted && this.viewportWidth > 0) {
        this._fitted = true;
        this.fitWidths();
      }
    };
    this._onResize();
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObs = new ResizeObserver(this._onResize);
      if (this.$refs.viewport) this._resizeObs.observe(this.$refs.viewport);
    }
  },
  beforeUnmount() {
    if (this._resizeObs) this._resizeObs.disconnect();
    this._resizeObs = null;
    this._onResize = null;
    this._endResize();
  },
  methods: {
    isTaskFinished,
    isContainer(row) {
      return !!(row && (row.isFolder || row.isDir) && row.hasChildren);
    },
    isExpanded(row) {
      return (this.expandedKeys || []).indexOf(row.taskId) >= 0;
    },
    toggleExpand(row) {
      this.$emit('expand-change', row);
    },
    onScroll(e) {
      this.scrollTop = e.target.scrollTop;
    },
    // 首次可见时，若默认列总宽超出视口则从最宽的列开始收缩（不低于 min），避免初始横向滚动条
    fitWidths() {
      const avail = Math.max(0, this.viewportWidth - 2);
      const total = this.colWidths.reduce((s, w) => s + w, 0);
      const excess = total - avail;
      if (excess <= 0) return;
      const widths = this.colWidths.slice();
      const order = widths.map((w, i) => i).sort((a, b) => widths[b] - widths[a]);
      let remain = excess;
      for (const i of order) {
        if (remain <= 0) break;
        const cut = Math.min(widths[i] - this.columns[i].min, remain);
        widths[i] -= cut;
        remain -= cut;
      }
      this.colWidths = widths;
    },
    startResize(e, index) {
      this._drag = { index, startX: e.clientX, startWidth: this.colWidths[index] };
      this._onDragMove = (ev) => {
        if (!this._drag) return;
        const d = this._drag;
        const min = this.columns[d.index].min;
        const width = Math.max(min, d.startWidth + ev.clientX - d.startX);
        this.colWidths.splice(d.index, 1, width);
      };
      this._onDragUp = () => this._endResize();
      document.addEventListener('mousemove', this._onDragMove);
      document.addEventListener('mouseup', this._onDragUp);
    },
    _endResize() {
      if (this._onDragMove) document.removeEventListener('mousemove', this._onDragMove);
      if (this._onDragUp) document.removeEventListener('mouseup', this._onDragUp);
      this._onDragMove = null;
      this._onDragUp = null;
      this._drag = null;
    },
    progressText(row) {
      return `${row.percent || 0}%`;
    },
    shortErr(row) {
      const e = transferErrorText(row);
      return e.length > 48 ? e.slice(0, 48) + '…' : e;
    },
  },
};
</script>

<style scoped>
.sftp-tasks {
  flex: 1 1 auto;
  min-height: 100px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 8px 8px;
  box-sizing: border-box;
}
.tasks-head {
  padding: 8px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  flex: 0 0 auto;
}
.vq-head {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 34px;
  line-height: 34px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-fill-color-light);
  font-size: 12px;
  font-weight: 500;
  color: var(--el-text-color-regular);
  box-sizing: border-box;
}
.vq-hcell {
  position: relative;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-right: 1px solid var(--el-border-color-lighter);
  box-sizing: border-box;
  min-width: 0;
}
.vq-hcell:last-child {
  border-right: none;
}
.hcell-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.col-resize {
  position: absolute;
  right: -3px;
  top: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 3;
}
.col-resize:hover {
  background: var(--accent-soft);
}
.vq-viewport {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--el-border-color);
  box-sizing: border-box;
  position: relative;
}
.vq-spacer {
  position: relative;
}
.vq-row {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 40px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  box-sizing: border-box;
  font-size: 12px;
  color: var(--el-text-color-regular);
  will-change: transform;
}
.vq-row.striped {
  background: var(--bg-elevated);
}
.vq-row:hover {
  background: var(--bg-hover);
}
.vq-cell {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0 8px;
  border-right: 1px solid var(--el-border-color-lighter);
  box-sizing: border-box;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.vq-cell:last-child {
  border-right: none;
}
.vq-cell.c-progress {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  overflow: visible;
}
.indent {
  flex: 0 0 auto;
}
.tree-toggle,
.tree-toggle-space {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
}
.tree-toggle {
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.12s linear;
}
.tree-toggle.open {
  transform: rotate(90deg);
}
.folder-tag {
  margin-right: 4px;
  color: var(--text-3);
  flex: 0 0 auto;
}
.name-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.folder-count {
  color: var(--text-3);
  font-size: 10px;
  flex: 0 0 auto;
  margin-left: 4px;
}
.prog-line {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.prog-wrap {
  flex: 1 1 auto;
  min-width: 32px;
  height: 6px;
  border-radius: 3px;
  background: var(--bg-hover);
  overflow: hidden;
}
.prog-bar {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.15s linear;
}
.prog-num {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--text-3);
  min-width: 36px;
  text-align: right;
}
.err-line {
  font-size: 10px;
  color: #f56c6c;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.op-icon-btn {
  width: 24px;
  height: 24px;
  margin: 0 2px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  flex: 0 0 auto;
}
.op-icon-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.op-icon-btn.danger:hover:not(:disabled) {
  color: #f56c6c;
  border-color: #f56c6c;
}
.op-icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
