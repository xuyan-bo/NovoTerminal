<template>
  <div class="sftp-tasks">
    <div class="tasks-head"><span>{{ $t('sftp.tasks') }}</span></div>
    <div class="tasks-table-wrap">
      <el-table
        :data="tasks"
        size="mini"
        height="100%"
        border
        stripe
        lazy
        row-key="taskId"
        :load="loadChildren"
        :tree-props="{ children: 'children', hasChildren: 'hasChildren' }"
        :expand-row-keys="expandedKeys"
        empty-text=""
        class="sftp-el-table"
        @expand-change="onExpandChange"
      >
        <el-table-column prop="name" :label="$t('sftp.colName')" min-width="140" show-overflow-tooltip>
          <template slot-scope="scope">
            <span v-if="scope.row.isFolder || scope.row.isDir" class="folder-tag">&#128193;</span>
            {{ scope.row.name }}
            <span v-if="scope.row.isFolder || scope.row.isDir" class="folder-count">
              ({{ scope.row.doneCount || 0 }}/{{ scope.row.fileCount || 0 }})
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="sizeText" :label="$t('sftp.colSize')" width="80" />
        <el-table-column :label="$t('sftp.colProgress')" min-width="160">
          <template slot-scope="scope">
            <div class="prog-line">
              <div class="prog-wrap">
                <div class="prog-bar" :style="{ width: (scope.row.percent || 0) + '%' }"></div>
              </div>
              <span class="prog-num" :title="scope.row.error || ''">{{ progressText(scope.row) }}</span>
            </div>
            <div v-if="scope.row.status === 'error'" class="err-line" :title="scope.row.error">
              {{ shortErr(scope.row) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="speedText" :label="$t('sftp.colSpeed')" width="90" />
        <el-table-column prop="sourcePath" :label="$t('sftp.colSource')" min-width="120" show-overflow-tooltip />
        <el-table-column prop="targetPath" :label="$t('sftp.colTarget')" min-width="120" show-overflow-tooltip />
        <el-table-column :label="$t('sftp.colAction')" width="100" align="center">
          <template slot-scope="scope">
            <template v-if="!scope.row.isDir">
              <el-tooltip :content="scope.row.status === 'paused' ? $t('sftp.resume') : $t('sftp.pause')" placement="top">
                <button
                  type="button"
                  class="op-icon-btn"
                  :disabled="isTaskFinished(scope.row)"
                  @click.stop="$emit('toggle-pause', scope.row)"
                >
                  <svg-icon :name="scope.row.status !== 'paused' ? 'pause' : 'play'" />
                </button>
              </el-tooltip>
              <el-tooltip :content="$t('sftp.removeTask')" placement="top">
                <button type="button" class="op-icon-btn danger" @click.stop="$emit('remove-task', scope.row)">
                  <svg-icon name="trash" />
                </button>
              </el-tooltip>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script>
import { isTaskFinished } from './utils';

export default {
  name: 'SftpTransferQueue',
  props: {
    tasks: { type: Array, default: () => [] },
    expandedKeys: { type: Array, default: () => [] },
  },
  methods: {
    isTaskFinished,
    /** Children are resolved by the page, which owns the incrementally scanned task tree. */
    loadChildren(row, treeNode, resolve) {
      this.$emit('load-children', row, treeNode, resolve);
    },
    progressText(row) {
      return `${row.percent || 0}%`;
    },
    shortErr(row) {
      const e = String(row.error || this.$t('sftp.transferFailed'));
      return e.length > 48 ? e.slice(0, 48) + '…' : e;
    },
    onExpandChange(row, expandedRows) {
      this.$emit('expand-change', row, expandedRows);
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
.tasks-table-wrap {
  flex: 1;
  min-height: 0;
}
.sftp-el-table {
  height: 100%;
  background: transparent;
}
.sftp-el-table /deep/ .el-table__header-wrapper th,
.sftp-el-table /deep/ .el-table__body-wrapper td {
  background: transparent;
  color: var(--text-2);
  border-color: var(--border) !important;
}
.sftp-el-table /deep/ .el-table__header-wrapper th {
  color: var(--text-3);
}
.sftp-el-table /deep/ .el-table--border,
.sftp-el-table /deep/ .el-table--group {
  border-color: var(--border) !important;
}
.sftp-el-table /deep/ .el-table__body tr:hover > td {
  background: var(--bg-hover) !important;
}
/* Element-style thin scrollbar, matching the file panels */
.sftp-el-table /deep/ .el-table__body-wrapper::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.sftp-el-table /deep/ .el-table__body-wrapper::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}
.sftp-el-table /deep/ .el-table__body-wrapper::-webkit-scrollbar-thumb:hover {
  background: var(--text-3);
}
.sftp-el-table /deep/ .el-table__body-wrapper::-webkit-scrollbar-track,
.sftp-el-table /deep/ .el-table__body-wrapper::-webkit-scrollbar-corner {
  background: transparent;
}
.folder-tag {
  margin-right: 4px;
}
.folder-count {
  color: var(--text-3);
  font-size: 10px;
}
.prog-line {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  min-width: 0;
}
.prog-wrap {
  flex: 1 1 auto;
  min-width: 48px;
  height: 6px;
  border-radius: 3px;
  background: var(--bg-elevated);
  overflow: hidden;
}
.prog-bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s linear;
}
.prog-num {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
  min-width: 40px;
  text-align: right;
}
.err-line {
  margin-top: 2px;
  font-size: 10px;
  color: #f56c6c;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.op-icon-btn {
  width: 26px;
  height: 26px;
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
  vertical-align: middle;
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
