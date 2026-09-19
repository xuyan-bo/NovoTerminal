<template>
  <el-dialog
    :title="isEdit ? $t('asset.dialogEdit') : $t('asset.dialogNew')"
    :visible.sync="visible"
    width="760px"
    top="5vh"
    :close-on-click-modal="false"
  >
    <div class="hint" style="margin-bottom:8px">{{ $t('asset.osType') }}</div>
    <div class="type-cards">
      <div
        v-for="tp in types"
        :key="tp.id"
        class="type-card"
        :class="[tp.id, { on: form.os === tp.id }]"
        @click="setType(tp.id)"
      >
        <div class="os-slot" :class="tp.id" v-html="osSvg(tp.id)"></div>
        <div class="nm">{{ tp.label }}</div>
        <div class="sub">{{ tp.sub }}</div>
      </div>
    </div>

    <div class="hint" style="margin-bottom:8px">
      {{ $t('asset.info') }} <span class="badge-primary">{{ $t('asset.sharedTag') }}</span>
    </div>

    <el-form
      ref="form"
      :model="form"
      :rules="rules"
      label-width="100px"
      size="small"
      style="margin-bottom:8px"
      @submit.native.prevent
    >
      <el-form-item :label="$t('asset.name')" prop="name">
        <el-input v-model="form.name" :placeholder="$t('asset.namePh')" maxlength="128" clearable />
      </el-form-item>
      <el-form-item :label="$t('asset.group')" prop="gid">
        <el-select v-model="form.gid" style="width:100%">
          <el-option
            v-for="g in groups"
            :key="g.id"
            :label="g.name"
            :value="g.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="$t('asset.host')" prop="host">
        <el-input v-model="form.host" :placeholder="$t('asset.hostPh')" clearable />
      </el-form-item>
      <el-form-item :label="$t('asset.user')" prop="user">
        <el-input v-model="form.user" :placeholder="$t('asset.userPh')" clearable />
      </el-form-item>
      <el-form-item :label="$t('asset.pass')" prop="pass">
        <el-input
          v-model="form.pass"
          type="password"
          show-password
          :placeholder="$t('asset.passPh')"
        />
      </el-form-item>
      <el-form-item :label="$t('asset.tags')" prop="tags">
        <el-input v-model="form.tags" :placeholder="$t('asset.tagsPh')" />
      </el-form-item>
      <el-form-item :label="$t('asset.note')" prop="note">
        <el-input v-model="form.note" type="textarea" :rows="2" />
      </el-form-item>
      <el-form-item label="" label-width="0" prop="methods" class="methods-item">
        <div class="methods-block">
          <div class="hint methods-hint">
            {{ $t('asset.methods') }}
          </div>
          <div
            v-for="m in catalog"
            :key="m.id"
            class="method-row"
            :class="{ on: draftRow(m.id) && draftRow(m.id).enabled }"
          >
            <el-checkbox
              v-model="draftRow(m.id).enabled"
              @change="onToggle(m)"
            />
            <div>
              <div style="font-weight:600;font-size:13px">
                {{ m.name }}
                <el-tag v-if="m.rec" size="mini" type="success">推荐</el-tag>
                <el-tag v-if="draftRow(m.id).enabled && draftRow(m.id).primary" size="mini">主</el-tag>
              </div>
              <div class="hint">{{ m.desc }}</div>
            </div>
            <div class="port-cell">
              <span class="hint port-label">端口</span>
              <el-input
                v-model.number="draftRow(m.id).port"
                size="mini"
                class="port-input"
                :disabled="!draftRow(m.id).enabled"
                type="number"
                :min="1"
                :max="65535"
              />
            </div>
            <el-radio
              v-model="primaryId"
              :label="m.id"
              :disabled="!draftRow(m.id).enabled"
              @change="syncPrimary"
            >主</el-radio>
            <el-tooltip :content="$t('adv.gearTip')" placement="top">
              <button
                type="button"
                class="gear-icon-btn"
                :disabled="!draftRow(m.id).enabled"
                :class="{ customized: hasCustomAdv(m.id) }"
                @click="openAdvanced(m)"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7.05 7.05 0 00-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84a.48.48 0 00-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.48.48 0 00.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z"/>
                </svg>
              </button>
            </el-tooltip>
          </div>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <span style="float:left;color:var(--text-3);font-size:11px;line-height:28px">{{ summary }}</span>
      <el-button size="mini" @click="visible = false">{{ $t('settings.cancel') }}</el-button>
      <el-button size="mini" :loading="testing" @click="test">{{ $t('asset.test') }}</el-button>
      <el-button size="mini" type="primary" :loading="saving" @click="save">
        {{ isEdit ? $t('asset.save') : $t('asset.saveConnect') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script>
import {
  store,
  api,
  unwrap,
  refresh,
  findAsset,
  openAssetDetail,
  openMethodAdvanced,
} from '../store';
import { OS_SVG, OS_NAME, CATALOG } from '../constants';
import { t } from '../i18n';

const HOST_RE =
  /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?$/;

export default {
  name: 'AssetDialog',
  data() {
    return {
      saving: false,
      testing: false,
      types: [
        { id: 'win', label: 'Windows', sub: 'RDP / VNC 可选' },
        { id: 'mac', label: 'macOS', sub: 'VNC / SSH 可选' },
        { id: 'linux', label: 'Linux', sub: 'VNC / SSH / xrdp' },
      ],
      form: {
        name: '',
        os: 'win',
        gid: '',
        host: '',
        user: '',
        pass: '',
        tags: '',
        note: '',
      },
      draft: {
        rdp: { enabled: true, port: 3389, primary: true },
        vnc: { enabled: false, port: 5900, primary: false },
        ssh: { enabled: false, port: 22, primary: false },
      },
      primaryId: 'rdp',
      rules: {
        name: [
          {
            required: true,
            validator(rule, value, cb) {
              if (!String(value || '').trim()) cb(new Error(t('msg.nameRequired')));
              else cb();
            },
            trigger: 'blur',
          },
          {
            validator(rule, value, cb) {
              const n = String(value || '').trim().length;
              if (n && n > 128) cb(new Error('1–128 字符'));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        gid: [
          {
            required: true,
            validator(rule, value, cb) {
              if (!value) cb(new Error(t('msg.groupSelect')));
              else cb();
            },
            trigger: 'change',
          },
        ],
        host: [
          {
            required: true,
            validator(rule, value, cb) {
              const v = String(value || '').trim();
              if (!v) cb(new Error(t('msg.hostRequired')));
              else if (!HOST_RE.test(v)) cb(new Error(t('msg.hostInvalid')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        user: [
          {
            required: true,
            validator(rule, value, cb) {
              if (!String(value || '').trim()) cb(new Error(t('msg.userRequired')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        methods: [
          {
            required: true,
            validator: (rule, value, cb) => {
              const enabled = Object.keys(this.draft).filter(
                (k) => this.draft[k] && this.draft[k].enabled
              );
              if (enabled.length) cb();
              else cb(new Error(t('msg.methodsRequired')));
            },
            trigger: 'change',
          },
        ],
      },
    };
  },
  computed: {
    visible: {
      get() {
        return store.assetDialog.visible;
      },
      set(v) {
        store.assetDialog = { ...store.assetDialog, visible: v };
        if (!v && this.$refs.form) {
          this.$nextTick(() => this.$refs.form.clearValidate());
        }
      },
    },
    isEdit() {
      return !!store.assetDialog.editId;
    },
    groups() {
      return store.snapshot.groups || [];
    },
    catalog() {
      return CATALOG[this.form.os] || CATALOG.win;
    },
    summary() {
      const on = this.catalog
        .filter((m) => this.draft[m.id] && this.draft[m.id].enabled)
        .map((m) => `${m.name}:${this.draft[m.id].port}`);
      return `${OS_NAME[this.form.os]} · ${this.form.host || '?'} · ${
        on.join(' | ') || '未启用'
      }`;
    },
    methodAdvancedResult() {
      return store.methodAdvancedResult;
    },
  },
  created() {
    (CATALOG.win || []).forEach((m) => this.draftRow(m.id));
  },
  watch: {
    visible(v) {
      if (v) this.load();
    },
    methodAdvancedResult(r) {
      if (!r || !this.visible) return;
      const row = this.draftRow(r.methodId);
      if (row) {
        this.$set(row, 'advanced', r.advanced);
        this.draft = { ...this.draft };
      }
    },
  },
  methods: {
    draftRow(id) {
      if (!this.draft[id]) {
        this.$set(this.draft, id, { enabled: false, port: 3389, primary: false });
      }
      return this.draft[id];
    },
    hasCustomAdv(id) {
      const row = this.draft[id];
      return !!(row && row.advanced && Object.keys(row.advanced).length);
    },
    openAdvanced(m) {
      const row = this.draftRow(m.id);
      openMethodAdvanced({
        methodId: m.id,
        methodName: m.name,
        advanced: row.advanced || {},
        context: { type: 'asset-dialog' },
      });
    },
    osSvg(os) {
      return OS_SVG[os] || '';
    },
    defaultDraft(os) {
      const d = {};
      (CATALOG[os] || []).forEach((m) => {
        d[m.id] = { enabled: m.rec, port: m.defaultPort, primary: false };
      });
      const rec = (CATALOG[os] || []).find((m) => m.rec);
      if (rec) d[rec.id].primary = true;
      this.primaryId = rec ? rec.id : Object.keys(d)[0];
      return d;
    },
    setType(tp) {
      this.form.os = tp;
      this.draft = this.defaultDraft(tp);
      this.$nextTick(() => this.validateMethods());
    },
    onToggle(m) {
      const conf = this.draftRow(m.id);
      if (conf.enabled) {
        if (!conf.port) conf.port = m.defaultPort;
        const enabled = Object.keys(this.draft).filter(
          (k) => this.draft[k] && this.draft[k].enabled
        );
        if (!enabled.some((k) => this.draft[k].primary)) {
          conf.primary = true;
          this.primaryId = m.id;
        }
      } else {
        conf.primary = false;
        const enabled = Object.keys(this.draft).filter(
          (k) => this.draft[k] && this.draft[k].enabled
        );
        if (enabled.length && !enabled.some((k) => this.draft[k].primary)) {
          this.draft[enabled[0]].primary = true;
          this.primaryId = enabled[0];
        }
      }
      this.draft = { ...this.draft };
      this.validateMethods();
    },
    syncPrimary(id) {
      Object.keys(this.draft).forEach((k) => {
        if (this.draft[k]) this.draft[k].primary = k === id;
      });
      this.primaryId = id;
      this.draft = { ...this.draft };
    },
    validateMethods() {
      if (!this.$refs.form) return;
      this.$refs.form.validateField('methods');
    },
    async load() {
      const editId = store.assetDialog.editId;
      const gid = store.assetDialog.gid || (this.groups[0] || {}).id;
      if (editId) {
        const hit = findAsset(editId);
        if (!hit) return;
        const a = hit.asset;
        this.form = {
          name: a.name,
          os: a.os,
          gid: hit.group.id,
          host: a.host,
          user: a.user,
          pass: a.pass || '',
          tags: a.tags || '',
          note: a.note || '',
        };
        this.draft = JSON.parse(JSON.stringify(a.methods || {}));
        const pri = Object.keys(this.draft).find(
          (k) => this.draft[k] && this.draft[k].primary && this.draft[k].enabled
        );
        this.primaryId = pri || Object.keys(this.draft)[0] || '';
      } else {
        this.form = {
          name: '',
          os: 'win',
          gid,
          host: '',
          user: '',
          pass: '',
          tags: '',
          note: '',
        };
        this.draft = this.defaultDraft('win');
      }
      (CATALOG[this.form.os] || []).forEach((m) => this.draftRow(m.id));
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
    },
    async test() {
      // Element UI validateField fires the callback once per field;
      // await all of them so the probe runs a single time.
      const results = await Promise.all(
        ['name', 'host', 'user'].map(
          (prop) =>
            new Promise((resolve) => {
              this.$refs.form.validateField(prop, (err) => resolve(!err));
            })
        )
      );
      if (!results.every(Boolean)) return;
      const methodId = Object.keys(this.draft).find(
        (k) => this.draft[k] && this.draft[k].enabled
      );
      if (!methodId) {
        this.validateMethods();
        return;
      }
      this.testing = true;
      try {
        const r = await api.sessionTest({
          asset: { host: this.form.host },
          method: { protocol: methodId, port: this.draft[methodId].port },
        });
        if (r && r.ok)
          this.$message.success(`测试通过 · ${r.latencyMs ?? '-'} ms`);
        else this.$message.error(r.error || r.__error || '测试失败');
      } catch (e) {
        this.$message.error(e.message);
      } finally {
        this.testing = false;
      }
    },
    save() {
      this.$refs.form.validate(async (valid) => {
        if (!valid) return;
        this.saving = true;
        try {
          const enabled = Object.keys(this.draft).filter(
            (k) => this.draft[k] && this.draft[k].enabled
          );
          if (!enabled.includes(this.primaryId)) {
            this.draft[enabled[0]].primary = true;
          }
          const methods = {};
          enabled.forEach((k) => {
            const draftAdv = this.draft[k] && this.draft[k].advanced;
            methods[k] = {
              enabled: true,
              port: this.draft[k].port,
              primary: k === this.primaryId,
              advanced: draftAdv && Object.keys(draftAdv).length
                ? { ...draftAdv }
                : undefined,
            };
          });
          const payload = {
            name: this.form.name.trim(),
            os: this.form.os,
            host: this.form.host.trim(),
            user: this.form.user.trim(),
            pass: this.form.pass,
            tags: this.form.tags,
            note: this.form.note,
            methods,
            display: { layout: 'extend' },
            gid: this.form.gid,
          };
          if (this.isEdit) {
            unwrap(
              await api.updateAsset(store.assetDialog.editId, payload)
            );
            await refresh();
            this.$message.success(t('msg.assetUpdated'));
          } else {
            unwrap(await api.createAsset(this.form.gid, payload));
            await refresh();
            const snap = store.snapshot;
            let created = null;
            snap.groups.forEach((g) =>
              g.nodes.forEach((n) => {
                if (n.name === payload.name && n.host === payload.host)
                  created = n;
              })
            );
            if (created) openAssetDetail(created);
            this.$message.success(t('msg.assetCreated'));
          }
          this.visible = false;
        } catch (e) {
          this.$message.error(e.message);
        } finally {
          this.saving = false;
        }
      });
    },
  },
};
</script>

<style scoped>
.os-slot {
  height: 32px;
  display: grid;
  place-items: center;
  margin-bottom: 6px;
  line-height: 0;
}
.os-slot /deep/ svg {
  width: 30px;
  height: 30px;
  display: block;
}
.os-slot.win {
  color: var(--win);
}
.os-slot.mac {
  color: var(--mac);
}
.os-slot.linux {
  color: var(--linux);
}
.os-slot.linux /deep/ svg {
  /* Tux uses its own brand colors; keep CSS color off the paths */
  color: inherit;
}
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
.methods-item {
  width: 100%;
}
.methods-item /deep/ .el-form-item__label {
  float: none;
  display: none;
  width: 0;
  padding: 0;
  margin: 0;
}
.methods-item /deep/ .el-form-item__content {
  margin-left: 0 !important;
  line-height: normal;
}
.methods-item /deep/ .el-form-item__error {
  position: static;
  margin-top: 6px;
  padding-top: 0;
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
</style>
