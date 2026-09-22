<template>
  <el-dialog
    :title="title"
    :visible.sync="visible"
    width="620px"
    top="8vh"
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    append-to-body
  >
    <el-form label-width="120px" size="small" :disabled="saving" @submit.native.prevent>
      <el-form-item
          v-for="f in fields"
          :key="f.key"
          :label="fieldLabel(f)"
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
              style="width: 100%"
              :placeholder="$t('adv.rdp.client.placeholder')"
              :disabled="!clientOptions.length"
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
          <el-select
            v-else-if="f.type === 'select'"
            v-model="form[f.key]"
            style="width: 100%"
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
        <el-input
          v-else-if="f.type === 'number'"
          v-model.number="form[f.key]"
          type="number"
          :min="f.min"
          :max="f.max"
          :placeholder="ph(f)"
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
      <span class="hint adv-default-tip">{{ $t('adv.defaultTip') }}</span>
      <el-button size="mini" :disabled="saving" @click="reset">{{ $t('adv.reset') }}</el-button>
      <el-button size="mini" :disabled="saving" @click="visible = false">{{ $t('settings.cancel') }}</el-button>
      <el-button size="mini" type="primary" :loading="saving" :disabled="saving" @click="confirm">{{ $t('settings.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { store, api, unwrap, refresh, findAsset } from '../store';
import {
  ADVANCED_FIELDS,
  ADVANCED_DEFAULTS,
  advancedKey,
  resolveAdvanced,
  RDP_CLIENT_CATALOG,
  osKeyFromPlatform,
} from '../constants';
import { t } from '../i18n';

export default {
  name: 'MethodAdvancedDialog',
  data() {
    return { form: {}, saving: false };
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
      return this.allFields.filter((f) =>
        (!f.engines || f.engines.includes(engine)) &&
        (!f.showWhen || Object.entries(f.showWhen).every(([key, value]) => this.form[key] === value))
      );
    },
    allFields() {
      return ADVANCED_FIELDS[this.schemaKey] || [];
    },
    platformKey() {
      const p = (window.omniDesk && window.omniDesk.platform) || '';
      return osKeyFromPlatform(p);
    },
    clientOptions() {
      return RDP_CLIENT_CATALOG[this.platformKey] || [];
    },
    title() {
      return t('adv.title', { name: this.methodName });
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
      const key = this.form.engine === 'external' && opt.externalLabelKey ? opt.externalLabelKey : opt.labelKey;
      return key ? t(key) : opt.label;
    },
    ph(f) {
      if (!f.placeholderKey) return '';
      return t(f.placeholderKey);
    },
    defaults() {
      return { ...(ADVANCED_DEFAULTS[this.schemaKey] || {}) };
    },
    loadForm() {
      const saved = (this.dlg && this.dlg.advanced) || {};
      this.form = resolveAdvanced(this.methodId, saved);
    },
    reset() {
      if (this.saving) return;
      this.form = this.defaults();
    },
    validate() {
      if (this.schemaKey !== 'ssh') return true;
      const defaults = this.defaults();
      for (const f of this.fields) {
        const v = this.form[f.key];
        const blank = v == null || (typeof v === 'string' && v.trim() === '');
        let error = '';
        if (f.type === 'select' && !f.options.some((opt) => opt.value === v)) {
          error = t('adv.ssh.invalidOption', { name: t(f.labelKey) });
        } else if (f.type === 'number') {
          const n = blank ? defaults[f.key] : Number(v);
          if (!Number.isFinite(n) || (f.integer && !Number.isInteger(n)) || n < f.min || n > f.max) {
            error = t('adv.ssh.keepAliveInvalid');
          }
        } else if (f.required && (typeof v !== 'string' || blank)) {
          error = t('adv.ssh.privateKeyRequired');
        }
        if (error) {
          this.$message.error(error);
          return false;
        }
      }
      return true;
    },
    async confirm() {
      if (this.saving || !this.validate()) return;
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
        } else if (f.type === 'number') {
          const n = Number(v);
          payload[f.key] = Number.isNaN(n) || String(v).trim() === '' ? defaults[f.key] : n;
        } else if (f.type === 'switch') {
          payload[f.key] = !!v;
        } else if (f.type === 'password' && this.schemaKey === 'ssh') {
          payload[f.key] = v;
        } else {
          payload[f.key] = String(v).trim() === '' ? defaults[f.key] : v;
        }
      });

      let advanced = { ...(dlg.advanced || {}), ...payload };
      this.saving = true;
      try {
        const ctx = dlg.context;
        // 仅「资产详情」由本对话框直接写资产；「新建/编辑资产对话框」只回传 result，
        // 由 AssetDialog 保存时统一把 draft.advanced 写入资产，避免双写不一致/覆盖未保存改动
        const isDetail = ctx && ctx.type === 'detail';
        const assetId = isDetail && ctx.assetId ? ctx.assetId : null;
        if (assetId) {
          const hit = findAsset(assetId);
          if (!hit) throw new Error(t('detail.empty'));
          const methods = JSON.parse(JSON.stringify(hit.asset.methods || {}));
          const prev = methods[methodId] || {};
          advanced = { ...(prev.advanced || {}), ...payload };
          methods[methodId] = { ...prev, enabled: true, advanced };
          unwrap(
            await api.updateAsset(assetId, {
              methods,
              name: hit.asset.name,
              os: hit.asset.os,
              host: hit.asset.host,
              user: hit.asset.user,
              pass: hit.asset.pass,
              tags: hit.asset.tags,
              note: hit.asset.note,
              display: hit.asset.display,
              gid: hit.group.id,
            })
          );
          await refresh();
        }
        api.logWrite?.({
          level: 'info', source: 'settings',
          message: assetId ? 'advanced settings saved' : 'advanced settings staged',
          meta: { methodId, assetId, durationMs: Date.now() - started },
        }).catch(() => {});
        if (this.dlg !== dlg || !this.visible) return;
        store.methodAdvancedResult = {
          methodId,
          advanced,
          ts: Date.now(),
        };
        this.$message.success(t('msg.advSaved'));
        this.visible = false;
      } catch (e) {
        api.logWrite?.({
          level: 'error', source: 'settings', message: 'advanced settings save failed',
          meta: { methodId, code: e.code, durationMs: Date.now() - started },
        }).catch(() => {});
        if (this.dlg === dlg && this.visible) this.$message.error(e.message || t('err.connect'));
      } finally {
        this.saving = false;
      }
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
.adv-default-tip {
  float: left;
  font-size: 11px;
  line-height: 28px;
  max-width: 240px;
  text-align: left;
}
</style>
