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
        @change="$emit('toggle', m, $event)"
      />
      <div>
        <div style="font-weight:600;font-size:13px">
          {{ m.name }}
          <el-tag v-if="m.rec" size="mini" type="success">推荐</el-tag>
          <el-tag v-if="draftRow(m).enabled && draftRow(m).primary" size="mini">主</el-tag>
        </div>
        <div class="hint">{{ m.desc }}</div>
      </div>
      <div class="port-cell">
        <span class="hint port-label">端口</span>
        <el-input
          :value="draftRow(m).port"
          size="mini"
          class="port-input"
          :disabled="!draftRow(m).enabled"
          type="number"
          :min="1"
          :max="65535"
          @input="onPortInput(m, $event)"
        />
      </div>
      <el-radio
        :value="primaryId"
        :label="m.id"
        :disabled="!draftRow(m).enabled"
        @input="$emit('primary-change', $event)"
      >主</el-radio>
      <div class="method-icon-actions">
        <el-tooltip :content="$t('adv.gearTip')" placement="top">
          <button
            type="button"
            class="gear-icon-btn"
            :disabled="!draftRow(m).enabled"
            :class="{ customized: hasCustomAdv(m.id) }"
            @click="$emit('advanced', m)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7.05 7.05 0 00-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84a.48.48 0 00-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.48.48 0 00.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z"/>
            </svg>
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('asset.test')" placement="top">
          <button
            type="button"
            class="gear-icon-btn"
            :disabled="!draftRow(m).enabled || !!testing"
            :class="{ spinning: testingId === m.id }"
            @click="$emit('test', m)"
          >
            <!-- connection test icon (link) -->
            <svg viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M454.6048 328.8576a25.344 25.344 0 1 1-35.84-35.84l203.8784-203.9808c82.1248-82.176 212.992-84.992 292.352-5.632 79.36 79.4112 76.544 210.432-5.632 292.5568l-203.8272 203.9808c-82.1248 82.1248-212.992 84.992-292.352 5.632a25.344 25.344 0 0 1 35.84-35.8912c59.1872 59.2384 158.0032 57.088 220.672-5.632l203.8784-203.9808c62.6176-62.6688 64.8192-161.536 5.632-220.7744-59.2384-59.2384-158.0544-57.088-220.7232 5.632L454.6048 328.8064z m114.7904 366.2848a25.344 25.344 0 1 1 35.84 35.84L401.408 934.9632c-82.1248 82.176-212.992 84.992-292.352 5.632-79.36-79.4112-76.544-210.432 5.632-292.5568L318.464 444.0576c82.1248-82.1248 212.992-84.992 292.352-5.632a25.344 25.344 0 0 1-35.84 35.8912c-59.1872-59.2384-158.0032-57.088-220.672 5.632l-203.8784 203.9808c-62.6176 62.6688-64.8192 161.536-5.632 220.7744 59.2384 59.2384 158.0544 57.088 220.7232-5.632l203.8784-203.9296z"/>
            </svg>
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
    primaryId: { type: String, default: '' },
    testing: { type: Boolean, default: false },
    testingId: { type: String, default: null },
  },
  methods: {
    draftRow(method) {
      return this.draft[method.id] || {
        enabled: false,
        port: method.defaultPort,
        primary: false,
      };
    },
    hasCustomAdv(id) {
      const row = this.draft[id];
      return !!(row && row.advanced && Object.keys(row.advanced).length);
    },
    onPortInput(method, value) {
      // Match Vue's v-model.number conversion, including empty input.
      const port = parseFloat(value);
      this.$emit('port-change', method, isNaN(port) ? value : port);
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
  width: 80px;
  flex-shrink: 0;
}
/* primary radio + gear/test icons — keep tight */
.method-row .el-radio {
  margin-right: 0 !important;
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
