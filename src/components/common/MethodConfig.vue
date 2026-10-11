<template>
  <div class="methods-block">
    <div class="hint methods-hint">
      {{ $t('asset.methods') }}
    </div>
    <div
      v-for="m in catalog"
      :key="m.id"
      class="method-row"
      :class="{ on: draftRow(m).enabled }"
    >
      <el-checkbox
        :value="draftRow(m).enabled"
        :disabled="disabled"
        @change="$emit('toggle', m, $event)"
      />
      <div>
        <div style="font-weight:600;font-size:13px">
          {{ $t(m.nameKey) }}
        </div>
        <div class="hint">{{ $t(m.descKey) }}</div>
      </div>
      <div class="port-cell">
        <span class="hint port-label">{{ $t('asset.port') }}</span>
        <el-input-number
          :value="draftRow(m).port"
          class="port-input"
          size="mini"
          :min="1"
          :max="65535"
          controls-position="right"
          :disabled="!draftRow(m).enabled"
          @change="$emit('port-change', m, $event)"
        />
      </div>
      <div class="method-icon-actions">
        <el-tooltip :content="$t('adv.gearTip')" placement="top">
          <button
            type="button"
            class="gear-icon-btn"
            :disabled="!draftRow(m).enabled"
            :class="{ customized: hasCustomAdv(m.id) }"
            @click="$emit('advanced', m)"
          >
            <svg-icon name="gear" />
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('asset.test')" placement="top">
          <button
            type="button"
            class="gear-icon-btn"
            :disabled="disabled || !draftRow(m).enabled || !!testing"
            :class="{ spinning: testingId === m.id }"
            @click="$emit('test', m)"
          >
            <svg-icon name="link" />
          </button>
        </el-tooltip>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'MethodConfig',
  props: {
    catalog: { type: Array, required: true },
    draft: { type: Object, required: true },
    testing: { type: Boolean, default: false },
    testingId: { type: String, default: null },
    disabled: { type: Boolean, default: false },
  },
  methods: {
    draftRow(method) {
      return this.draft[method.id] || {
        enabled: false,
        port: method.defaultPort,
      };
    },
    hasCustomAdv(id) {
      const row = this.draft[id];
      return !!(row && row.advanced && Object.keys(row.advanced).length);
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
.methods-hint {
  margin-bottom: 8px;
}
.method-row /deep/ .el-checkbox {
  margin-right: 0;
}
.port-cell {
  display: flex;
  align-items: center;
  justify-content: flex-end;
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
</style>
