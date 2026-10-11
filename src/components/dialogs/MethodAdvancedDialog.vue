<template>
  <el-dialog
    :title="title"
    :visible.sync="visible"
    width="620px"
    top="8vh"
    :close-on-click-modal="false"
    append-to-body
  >
    <el-form
      ref="advForm"
      :model="form"
      :rules="formRules"
      label-width="186px"
      size="small"
      :disabled="isView"
      @submit.native.prevent
    >
      <el-form-item
          v-for="f in fields"
          :key="f.key"
          :label="fieldLabel(f)"
          :prop="f.key"
        >
          <template #label>
            {{ fieldLabel(f) }}
            <el-tooltip v-if="f.hintKey" placement="top">
              <span slot="content" class="adv-field-hint">{{ $t(f.hintKey) }}</span>
              <i class="el-icon-info" tabindex="0" :aria-label="$t(f.hintKey)"></i>
            </el-tooltip>
          </template>
          <el-radio-group
            v-if="f.type === 'engineRadio'"
            v-model="form[f.key]"
            class="adv-engine"
          >
            <el-radio v-for="opt in f.options" :key="opt.value" :label="opt.value">
              {{ optLabel(opt) }}
            </el-radio>
          </el-radio-group>
          <template v-else-if="f.type === 'clientSelect'">
            <el-select
              v-model="form[f.key]"
              class="client-select"
              :placeholder="$t('adv.rdp.client.placeholder')"
              :disabled="!clientOptions.length"
              @change="onClientChange"
            >
              <el-option
                v-for="opt in clientOptions"
                :key="opt.value"
                :label="optLabel(opt)"
                :value="opt.value"
              />
            </el-select>
            <div v-if="!clientOptions.length" class="hint client-none">
              {{ $t('adv.rdp.client.none') }}
            </div>
          </template>
          <template v-else-if="f.type === 'clientPathInput'">
            <div class="client-path-row">
              <el-input
                v-model="form[f.key]"
                class="client-path-input"
                clearable
                :placeholder="ph(f)"
              >
                <template slot="append">
                  <el-button icon="el-icon-search" :disabled="isView || !canBrowse" @click="runClientBrowse">
                    {{ $t('adv.rdp.clientPath.browse') }}
                  </el-button>
                </template>
              </el-input>
              <el-button
                class="client-path-probe"
                :disabled="isView || !form.client || !canProbe"
                :loading="probing"
                @click="runClientProbe"
              >
                {{ $t('adv.rdp.client.probe') }}
              </el-button>
            </div>
          </template>
          <el-select
            v-else-if="f.type === 'select'"
            v-model="form[f.key]"
            class="adv-select"
            :disabled="blockedField(f)"
          >
          <el-option
            v-for="opt in f.options"
            :key="opt.value"
            :label="optLabel(opt)"
            :value="opt.value"
          />
        </el-select>
        <el-switch v-else-if="f.type === 'switch'" v-model="form[f.key]" />
        <el-input
          v-else-if="f.type === 'password'"
          v-model="form[f.key]"
          type="password"
          show-password
          clearable
          :placeholder="ph(f)"
        />
        <el-input-number
          v-else-if="f.type === 'number'"
          v-model="form[f.key]"
          size="mini"
          :min="f.min"
          :max="f.max"
          :step="1"
          :precision="f.integer ? 0 : undefined"
          :placeholder="ph(f)"
          controls-position="right"
        />
        <el-input
          v-else
          v-model="form[f.key]"
          clearable
          :placeholder="ph(f)"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <template v-if="isView">
        <el-button size="mini" @click="visible = false">{{ $t('settings.close') }}</el-button>
      </template>
      <template v-else>
        <el-button size="mini" @click="reset">{{ $t('adv.reset') }}</el-button>
        <el-button size="mini" @click="visible = false">{{ $t('settings.cancel') }}</el-button>
        <el-button size="mini" type="primary" @click="confirm">{{ $t('settings.save') }}</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script>
import { store, api, unwrap } from '../../store';
import {
  ADVANCED_FIELDS,
  ADVANCED_DEFAULTS,
  advancedKey,
  resolveAdvanced,
  requiredRule,
  RDP_CLIENT_CATALOG,
  osKeyFromPlatform,
} from '../../constants';
import { t } from '../../i18n';

export default {
  name: 'MethodAdvancedDialog',
  data() {
    return { form: {}, probing: false };
  },
  computed: {
    dlg() {
      return store.methodAdvancedDialog || {};
    },
    visible: {
      get() {
        return !!(this.dlg && this.dlg.visible);
      },
      set(v) {
        store.methodAdvancedDialog = { ...this.dlg, visible: v };
      },
    },
    methodId() {
      return (this.dlg && this.dlg.methodId) || '';
    },
    methodName() {
      return (this.dlg && this.dlg.methodName) || this.methodId;
    },
    schemaKey() {
      return advancedKey(this.methodId);
    },
    fields() {
      const engine = this.form.engine;
      const client = this.form.client;
      return this.allFields.filter((f) => {
        if (f.engines && !f.engines.includes(engine)) return false;
        if (f.showWhen && !Object.entries(f.showWhen).every(([key, value]) => this.form[key] === value)) return false;
        // 外部客户端专属字段：需先选定 client，且该 client 支持此字段
        if (engine === 'external' && f.clients) {
          if (!client || !f.clients.includes(client)) return false;
        }
        return true;
      });
    },
    allFields() {
      return ADVANCED_FIELDS[this.schemaKey] || [];
    },
    formRules() {
      const rules = {};
      if (this.schemaKey === 'rdp' && this.form.engine === 'external') {
        rules.client = [{ ...requiredRule(t, 'adv.rdp.client.required', 'change'), required: true }];
        rules.clientPath = [{ ...requiredRule(t, 'adv.rdp.clientPath.ph', ['blur', 'change']), required: true }];
        return rules;
      }
      // SSH/SFTP 的必填与枚举合法性走 el-form 规则，校验结果落在字段下方而不是弹一条 $message
      if (this.schemaKey === 'ssh' || this.schemaKey === 'sftp') {
        for (const f of this.allFields) {
          const list = [];
          if (f.type === 'select') list.push({ validator: this.selectOptionRule(f), trigger: 'change' });
          if (f.required) list.push({ ...requiredRule(t, 'adv.ssh.privateKeyRequired'), required: true });
          if (list.length) rules[f.key] = list;
        }
      }
      return rules;
    },
    platformKey() {
      const p = (window.novoTerminal && window.novoTerminal.platform) || '';
      return osKeyFromPlatform(p);
    },
    clientOptions() {
      return RDP_CLIENT_CATALOG[this.platformKey] || [];
    },
    canProbe() {
      return typeof api.rdpProbeClient === 'function';
    },
    canBrowse() {
      return typeof api.rdpPickClientBinary === 'function';
    },
    title() {
      return t('adv.title', { name: this.methodName });
    },
    isView() {
      return !!(this.dlg && this.dlg.context && this.dlg.context.isView);
    },
  },
  watch: {
    dlg(v) {
      if (v.visible) this.loadForm();
    },
  },
  methods: {
    fieldLabel(f) {
      return t(f.labelKey);
    },
    optLabel(opt) {
      return opt.labelKey ? t(opt.labelKey) : opt.label;
    },
    ph(f) {
      if (!f.placeholderKey) return '';
      return t(f.placeholderKey);
    },
    blockedField(f) {
      // 外部客户端只有「窗口 + 单屏」才用分辨率：/f 与 /multimon 会拿本地屏幕尺寸覆盖 /size、/w /h
      return f.key === 'resolution' && this.form.engine === 'external' &&
        (this.form.screenMode !== 'window' || this.form.monitors !== 'single');
    },
    defaults() {
      return { ...(ADVANCED_DEFAULTS[this.schemaKey] || {}) };
    },
    loadForm() {
      const saved = (this.dlg && this.dlg.advanced) || {};
      this.form = resolveAdvanced(this.methodId, saved);
      this.probing = false;
      this.clearFieldErrors();
    },
    reset() {
      this.form = this.defaults();
      this.probing = false;
      this.clearFieldErrors();
    },
    onClientChange() {
      this.form.clientPath = '';
      this.probing = false;
      this.clearFieldErrors(['client', 'clientPath']);
    },
    validateForm() {
      const form = this.$refs.advForm;
      if (!form) return Promise.resolve(true);
      return new Promise((resolve) => {
        form.validate((valid) => resolve(!!valid));
      });
    },
    clearFieldErrors(props) {
      this.$nextTick(() => {
        if (this.$refs.advForm) this.$refs.advForm.clearValidate(props);
      });
    },
    async runClientProbe() {
      if (this.probing) return;
      const id = String(this.form.client || '');
      if (!id || !api.rdpProbeClient) return;
      this.probing = true;
      try {
        const res = unwrap(await api.rdpProbeClient(id));
        if (this.form.client !== id) return;
        if (res && res.ok && res.path) {
          this.form.clientPath = res.path;
          this.clearFieldErrors('clientPath');
          this.$message.success(t('adv.rdp.clientPath.detectOk', { path: res.path }));
        } else {
          this.$message.warning(t('adv.rdp.clientPath.detectMissing'));
        }
      } catch (e) {
        if (this.form.client !== id) return;
        this.$message.warning(t('adv.rdp.clientPath.detectMissing'));
      } finally {
        this.probing = false;
      }
    },
    async runClientBrowse() {
      if (!api.rdpPickClientBinary) return;
      try {
        const res = unwrap(await api.rdpPickClientBinary(String(this.form.client || '')));
        if (res && res.ok && res.path) {
          this.form.clientPath = res.path;
          this.clearFieldErrors('clientPath');
        } else if (res && (res.code === 'MISMATCH' || res.code === 'NOT_FOUND')) {
          this.$message.error(t('adv.rdp.clientPath.wrongFile'));
        }
      } catch (e) {
        this.$message.error(e.message || t('err.connect'));
      }
    },
    selectOptionRule(f) {
      return (rule, value, cb) => {
        if (!f.options || f.options.some((opt) => opt.value === value)) return cb();
        cb(new Error(t('adv.ssh.invalidOption', { name: t(f.labelKey) })));
      };
    },
    async confirm() {
      if (this.isView) return;
      const formOk = await this.validateForm();
      if (!formOk) return;
      const dlg = this.dlg;
      const methodId = this.methodId;
      const started = Date.now();
      const defaults = this.defaults();
      const payload = {};
      // 隐藏字段仍参与保存；显式空值覆盖旧值，不能因合并配色而恢复已清除的凭据。
      this.allFields.forEach((f) => {
        const v = this.form[f.key];
        if (v === undefined || v === null) {
          payload[f.key] = defaults[f.key];
        } else if (f.type === 'switch') {
          payload[f.key] = !!v;
        } else if (f.type === 'password' && this.schemaKey === 'ssh') {
          payload[f.key] = v;
        } else {
          payload[f.key] = String(v).trim() === '' ? defaults[f.key] : v;
        }
      });

      // 各入口都只回传结果，由 AssetDialog 统一把 draft.advanced 写入资产，
      // 避免在弹窗里再写一次造成双写不一致或覆盖未保存改动
      store.methodAdvancedResult = {
        methodId,
        advanced: { ...(dlg.advanced || {}), ...payload },
        ts: Date.now(),
      };
      api.logWrite?.({
        level: 'info', source: 'settings',
        message: 'advanced settings staged',
        meta: { methodId, durationMs: Date.now() - started },
      }).catch(() => {});
      this.$message.success(t('msg.advSaved'));
      this.visible = false;
    },
  },
};
</script>

<style scoped>
.adv-field-hint {
  display: block;
  max-width: 320px;
  line-height: 1.5;
}
/* 引擎单选组为行内 flex，参与行内基线，与左侧标签同一水平线并对齐 */
.adv-engine {
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  vertical-align: middle;
  gap: 12px;
}
.adv-engine .el-radio {
  white-space: nowrap;
  margin-right: 0;
}
.client-none {
  margin-top: 6px;
  font-size: 12px;
}
.adv-select {
  width: 100%;
  max-width: 220px;
}
.client-select {
  width: 100%;
}
.client-path-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.client-path-row .client-path-probe {
  flex: 0 0 auto;
  width: 60px;
  padding-left: 0;
  padding-right: 0;
}
.client-path-row .client-path-input {
  flex: 1;
  min-width: 0;
}
</style>
