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
          :value="row.conf.port"
          class="port-input"
          size="mini"
          :min="1"
          :max="65535"
          controls-position="right"
          :disabled="disabled"
          @change="$emit('port-change', row, $event)"
        />
      </div>
      <div class="method-icon-actions">
        <el-tooltip :content="$t('asset.authSettings')" placement="top">
          <button
            type="button"
            class="gear-icon-btn"
            :class="{ customized: row.source !== 'main' }"
            :disabled="disabled"
            @click="$emit('auth', row)"
          >
            <i class="el-icon-key" aria-hidden="true"></i>
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('adv.gearTip')" placement="top">
          <button
            type="button"
            class="gear-icon-btn"
            :disabled="disabled"
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
            :disabled="disabled || !!testing"
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
        <el-tooltip slot="reference" :content="$t('asset.removeMethod')" placement="top">
          <button type="button" class="gear-icon-btn danger">
            <svg-icon name="trash" />
          </button>
        </el-tooltip>
      </el-popconfirm>
    </div>
    <el-dropdown
      v-if="!disabled"
      trigger="click"
      class="add-method"
      @command="(id) => $emit('add', id)"
    >
      <el-button size="mini" plain>
        <i class="el-icon-plus" aria-hidden="true"></i>
        <span>{{ $t('asset.addMethod') }}</span>
      </el-button>
      <el-dropdown-menu slot="dropdown">
        <el-dropdown-item v-for="item in menu" :key="item.id" :command="item.id" :disabled="item.added">
          <span class="mi-name">{{ item.label }}</span>
          <span class="hint">{{ item.added ? $t('asset.methodAdded') : item.defaultPort }}</span>
        </el-dropdown-item>
      </el-dropdown-menu>
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
  /* el-input-number--mini 主题宽 130px，右侧箭头要占 50px 内边距，低于 101px 时 5 位端口会被裁掉 */
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
.add-method .el-icon-plus {
  margin-right: 4px;
}
.mi-name {
  margin-right: 12px;
}
</style>
