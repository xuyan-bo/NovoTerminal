<template>
  <el-dialog
    :title="title"
    :visible.sync="visible"
    width="560px"
    top="8vh"
    :close-on-click-modal="false"
    append-to-body
  >
    <div class="hint adv-hint">{{ $t('adv.hint') }}</div>
    <el-form label-width="120px" size="small" @submit.native.prevent>
      <el-form-item
        v-for="f in fields"
        :key="f.key"
        :label="fieldLabel(f)"
      >
        <el-select
          v-if="f.type === 'select'"
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
      <el-button size="mini" @click="reset">{{ $t('adv.reset') }}</el-button>
      <el-button size="mini" @click="visible = false">{{ $t('settings.cancel') }}</el-button>
      <el-button size="mini" type="primary" @click="confirm">{{ $t('settings.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { store, api, unwrap, refresh, findAsset } from '../store';
import { ADVANCED_FIELDS, ADVANCED_DEFAULTS, advancedKey, resolveAdvanced } from '../constants';
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
      return ADVANCED_FIELDS[this.schemaKey] || [];
    },
    title() {
      return t('adv.title', { name: this.methodName });
    },
    context() {
      return this.dlg && this.dlg.context;
    },
  },
  watch: {
    visible(v) {
      if (v) this.loadForm();
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
    defaults() {
      return { ...(ADVANCED_DEFAULTS[this.schemaKey] || {}) };
    },
    loadForm() {
      const saved = (this.dlg && this.dlg.advanced) || {};
      this.form = resolveAdvanced(this.methodId, saved);
    },
    reset() {
      this.form = this.defaults();
    },
    async confirm() {
      const payload = {};
      this.fields.forEach((f) => {
        const v = this.form[f.key];
        if (f.type === 'number') {
          const n = Number(v);
          payload[f.key] = Number.isNaN(n) || String(v).trim() === '' ? this.defaults()[f.key] : n;
        } else if (f.type === 'switch') {
          payload[f.key] = !!v;
        } else {
          const s = v == null ? '' : String(v);
          payload[f.key] = s.trim() === '' ? this.defaults()[f.key] : v;
        }
      });

      this.saving = true;
      try {
        const ctx = this.context;
        const assetId = (ctx && ctx.type === 'detail' && ctx.assetId) || store.assetDialog.editId || null;
        if (assetId) {
          const hit = findAsset(assetId);
          if (!hit) throw new Error(t('detail.empty'));
          const methods = JSON.parse(JSON.stringify(hit.asset.methods || {}));
          const prev = methods[this.methodId] || {};
          methods[this.methodId] = { ...prev, enabled: true, advanced: payload };
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
        store.methodAdvancedResult = {
          methodId: this.methodId,
          advanced: payload,
          ts: Date.now(),
        };
        this.$message.success(t('msg.advSaved'));
        this.visible = false;
      } catch (e) {
        this.$message.error(e.message || t('err.connect'));
      } finally {
        this.saving = false;
      }
    },
  },
};
</script>

<style scoped>
.adv-hint {
  margin-bottom: 12px;
  line-height: 1.5;
}
.adv-default-tip {
  float: left;
  font-size: 11px;
  line-height: 28px;
  max-width: 240px;
  text-align: left;
}
</style>
