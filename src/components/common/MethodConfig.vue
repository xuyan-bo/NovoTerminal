<template>
  <div class="methods-block">
    <div v-for="row in rows" :key="row.id" class="method-row on">
      <div class="method-id">
        <div class="nm">{{ $t(row.meta.nameKey) }}</div>
        <div class="hint desc">{{ $t(row.meta.descKey) }}</div>
      </div>
      <div class="port-cell">
        <span class="hint port-label">{{ $t('asset.port') }}</span>
        <el-input-number
          :model-value="row.conf.port"
          class="port-input"
          :min="1"
          :max="65535"
          controls-position="right"
          :disabled="disabled"
          @change="$emit('port-change', row, $event)"
        />
      </div>
      <div class="method-icon-actions">
        <!-- 凭证/高级/测试在只读态照样可点：打开的是子弹窗与探测，屏蔽由子弹窗自己的 isView 与保存按钮负责 -->
        <el-tooltip :content="$t('asset.authSettings')" placement="top">
          <button
            type="button"
            class="gear-icon-btn"
            :class="{ customized: row.source !== 'main' }"
            @click="$emit('auth', row)"
          >
            <el-icon aria-hidden="true"><Key /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('adv.gearTip')" placement="top">
          <button
            type="button"
            class="gear-icon-btn"
            :class="{ customized: hasCustomAdv(row) }"
            @click="$emit('advanced', row)"
          >
            <svg-icon name="gear" />
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('asset.test')" placement="top">
          <button
            type="button"
            class="gear-icon-btn"
            :disabled="!!testing"
            :class="{ spinning: testingId === row.id }"
            @click="$emit('test', row)"
          >
            <svg-icon name="link" />
          </button>
        </el-tooltip>
      </div>
      <el-popconfirm
        v-if="!disabled"
        :title="$t('asset.removeMethodConfirm')"
        :confirm-button-text="$t('msg.confirm')"
        :cancel-button-text="$t('settings.cancel')"
        @confirm="$emit('remove', row)"
      >
        <template #reference>
          <!-- reference 必须直接是可点击元素：包一层 el-tooltip 后 Element Plus 只把事件绑到内层提示，确认框不弹 -->
          <button type="button" class="gear-icon-btn danger" :title="$t('asset.removeMethod')">
            <svg-icon name="trash" />
          </button>
        </template>
      </el-popconfirm>
    </div>
    <el-dropdown
      v-if="!disabled"
      trigger="click"
      class="add-method"
      @command="(id) => $emit('add', id)"
    >
      <el-button plain>
        <el-icon aria-hidden="true"><Plus /></el-icon>
        <span>{{ $t('asset.addMethod') }}</span>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="item in menu" :key="item.id" :command="item.id" :disabled="item.added">
            <span class="mi-name">{{ item.label }}</span>
            <span class="hint">{{ item.added ? $t('asset.methodAdded') : item.defaultPort }}</span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<script>
import { authSourceOf } from '../../constants';
import { METHOD_ORDER, getProtocol } from '../../protocols';

export default {
  name: 'MethodConfig',
  props: {
    /** { [methodId]: { port, advanced?, auth? } }，键序即展示顺序 */
    draft: { type: Object, required: true },
    /** 主凭证模式：none / inline / credential，决定未自定义的方式显示哪种来源 */
    mainMode: { type: String, required: true },
    testing: { type: Boolean, default: false },
    testingId: { type: String, default: null },
    disabled: { type: Boolean, default: false },
  },
  computed: {
    rows() {
      return Object.keys(this.draft)
        .map((id) => {
          const meta = getProtocol(id);
          return meta ? { id, meta, conf: this.draft[id], source: authSourceOf(this.mainMode, this.draft[id].auth) } : null;
        })
        .filter(Boolean);
    },
    menu() {
      return METHOD_ORDER.map((id) => {
        const meta = getProtocol(id);
        return { id, label: meta.label, defaultPort: meta.defaultPort, added: !!this.draft[id] };
      });
    },
  },
  methods: {
    hasCustomAdv(row) {
      return !!(row.conf.advanced && Object.keys(row.conf.advanced).length);
    },
  },
};
</script>

<style scoped>
.methods-block {
  width: 100%;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
/* 全局 .method-row 的首列是勾选框留下的 auto，这里名称列要吃满剩余宽度 */
.method-row {
  grid-template-columns: 1fr auto auto auto;
}
.method-id {
  min-width: 0;
}
.method-row .desc {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.port-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  min-height: 32px;
}
.port-label {
  flex-shrink: 0;
  white-space: nowrap;
}
.port-input {
  /* 默认尺寸的 controls-position=right 数字框左右留白共 57px，五位端口需约 45px 文字区 */
  width: 110px;
  flex-shrink: 0;
}
.method-icon-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.gear-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
  color: var(--text-2);
  cursor: pointer;
  flex-shrink: 0;
}
.gear-icon-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.gear-icon-btn.danger:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
}
.gear-icon-btn.customized {
  color: var(--accent);
  border-color: rgba(64, 158, 255, 0.55);
}
.gear-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.gear-icon-btn.spinning {
  color: var(--accent);
  border-color: var(--accent);
}
.add-method {
  margin-top: 2px;
}
.add-method .el-icon {
  margin-right: 4px;
}
.mi-name {
  margin-right: 12px;
}
</style>
