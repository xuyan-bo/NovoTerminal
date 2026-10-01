<template>
  <el-dialog
    :title="dialogTitle"
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
        <div class="nm">{{ $t('os.' + tp.id) }}</div>
        <div class="sub">{{ $t(tp.subKey) }}</div>
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
        <el-select
          v-model="form.gid"
          style="width:100%"
          clearable
          :placeholder="$t('asset.groupPh')"
        >
          <el-option
            v-for="g in groupOptions"
            :key="g.id"
            :label="g.name"
            :value="g.id"
            :disabled="!!g.disabled"
          />
        </el-select>
        <div class="hint" style="margin-top:4px">{{ $t('asset.groupOptional') }}</div>
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
          :type="passVisible ? 'text' : 'password'"
          :placeholder="$t('asset.passPh')"
        >
          <button
            slot="append"
            type="button"
            class="pass-reveal-btn"
            :disabled="authChecking"
            :title="authChecking ? $t('auth.verifying') : (passVisible ? $t('auth.hidePass') : $t('auth.revealPass'))"
            @click="onTogglePassVisible"
          >
            <svg-icon v-if="authChecking" class="spin-icon" name="spinner" :size="14" />
            <img v-else-if="!passVisible" :src="'icons/eye-open.svg'" alt="" width="20" height="20" aria-hidden="true">
            <img v-else :src="'icons/eye-closed.svg'" alt="" width="20" height="20" aria-hidden="true">
          </button>
        </el-input>
      </el-form-item>
      <el-form-item :label="$t('asset.note')" prop="note">
        <el-input v-model="form.note" type="textarea" :rows="2" />
      </el-form-item>
      <el-form-item label="" label-width="0" prop="methods" class="methods-item">
        <MethodConfig
          :catalog="catalog"
          :draft="draft"
          :primary-id="primaryId"
          :testing="testing"
          :testing-id="testingId"
          @toggle="onToggle"
          @port-change="onPortChange"
          @primary-change="syncPrimary"
          @advanced="openAdvanced"
          @test="testMethod"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <span style="float:left;color:var(--text-3);font-size:11px;line-height:28px">{{ summary }}</span>
      <el-button size="mini" @click="visible = false">{{ $t('settings.cancel') }}</el-button>
      <el-button size="mini" type="primary" :loading="saving" @click="save">
        {{ $t('asset.save') }}
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
import { OS_SVG, OS_NAME, CATALOG, UNGROUPED_ID, isUngroupedGroup } from '../constants';
import { t } from '../i18n';
import MethodConfig from './MethodConfig.vue';

const HOST_RE =
  /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?$/;

export default {
  name: 'AssetDialog',
  components: { MethodConfig },
  data() {
    return {
      saving: false,
      testing: false,
      testingId: null,
      types: [
        { id: 'win', subKey: 'asset.subWin' },
        { id: 'mac', subKey: 'asset.subMac' },
        { id: 'linux', subKey: 'asset.subLinux' },
      ],
      form: {
        name: '',
        os: 'win',
        gid: '',
        host: '',
        user: '',
        pass: '',
        note: '',
      },
      draft: {
        rdp: { enabled: true, port: 3389, primary: true },
        vnc: { enabled: false, port: 5900, primary: false },
        ssh: { enabled: false, port: 22, primary: false },
      },
      passVisible: false,
      authChecking: false,
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
              if (n && n > 128) cb(new Error(t('asset.len128')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        gid: [
          {
            required: false,
            validator(rule, value, cb) {
              // optional — empty means default ungrouped bucket
              if (!value) cb();
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
        pass: [
          {
            required: true,
            validator(rule, value, cb) {
              if (!String(value || '').trim()) cb(new Error(t('msg.passRequired')));
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
    isClone() {
      return !store.assetDialog.editId && !!store.assetDialog.cloneId;
    },
    dialogTitle() {
      if (this.isEdit) return this.$t('asset.dialogEdit');
      return this.isClone ? this.$t('asset.dialogClone') : this.$t('asset.dialogNew');
    },
    groups() {
      return (store.snapshot.groups || []).filter((g) => !isUngroupedGroup(g));
    },
    groupOptions() {
      const list = this.groups.slice();
      const onUngrouped =
        this.form.gid === UNGROUPED_ID ||
        this.form.gid === 'g-default' ||
        (store.snapshot.groups || []).some(
          (g) => g.id === this.form.gid && isUngroupedGroup(g)
        );
      if (onUngrouped) {
        list.unshift({
          id: this.form.gid || UNGROUPED_ID,
          name: t('sidebar.untitled'),
          disabled: true,
        });
      }
      return list;
    },
    catalog() {
      return CATALOG[this.form.os] || CATALOG.win;
    },
    summary() {
      const on = this.catalog
        .filter((m) => this.draft[m.id] && this.draft[m.id].enabled)
        .map((m) => `${t(m.nameKey)}:${this.draft[m.id].port}`);
      return `${OS_NAME[this.form.os]} · ${this.form.host || '?'} · ${
        on.join(' | ') || t('asset.notEnabled')
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
      else this.passVisible = false;
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
        const method = this.catalog.find((m) => m.id === id);
        if (!method) return;
        this.$set(this.draft, id, { enabled: false, port: method.defaultPort, primary: false });
      }
      return this.draft[id];
    },
    openAdvanced(m) {
      const row = this.draftRow(m.id);
      if (!row) return;
      openMethodAdvanced({
        methodId: m.id,
        methodName: t(m.nameKey),
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
    onPortChange(m, port) {
      const row = this.draftRow(m.id);
      if (row) this.$set(row, 'port', port);
    },
    onToggle(m, enabled) {
      const conf = this.draftRow(m.id);
      if (!conf) return;
      this.$set(conf, 'enabled', enabled);
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
    /** Chrome-style: system identity check before revealing saved password */
    async onTogglePassVisible() {
      if (this.authChecking) return;
      if (this.passVisible) {
        this.passVisible = false;
        return;
      }
      if (!this.isEdit && !this.isClone) {
        this.passVisible = true;
        return;
      }
      if (!api.verifySystemAuth) {
        this.$message.error(t('auth.needElectron'));
        return;
      }
      this.authChecking = true;
      try {
        const r = unwrap(await api.verifySystemAuth(t('auth.viewPassReason')));
        if (r && r.ok) {
          this.passVisible = true;
        } else {
          const code = (r && r.code) || '';
          let msg = t('auth.failed');
          if (/Canceled|UserCanceled/i.test(code)) msg = t('auth.canceled');
          else if (/NotConfigured/i.test(code)) msg = t('auth.notConfigured');
          else if (r && r.message) msg = r.message;
          this.$message.error(msg);
        }
      } catch (e) {
        const code = e.code || '';
        let msg = e.message || t('auth.failed');
        if (/Canceled|UserCanceled/i.test(code)) msg = t('auth.canceled');
        else if (/NotConfigured/i.test(code)) msg = t('auth.notConfigured');
        this.$message.error(msg);
      } finally {
        this.authChecking = false;
      }
    },
    async load() {
      this.passVisible = false;
      const editId = store.assetDialog.editId;
      const cloneId = store.assetDialog.cloneId;
      const sourceId = editId || cloneId;
      // new assets: leave group empty by default → ungrouped on save
      const fallbackGid = store.assetDialog.gid || '';
      if (sourceId) {
        const hit = findAsset(sourceId);
        if (!hit) return;
        const a = hit.asset;
        this.form = {
          name: cloneId && !editId ? `${a.name} ${t('asset.cloneSuffix')}` : a.name,
          os: a.os,
          gid: hit.group.id,
          host: a.host,
          user: a.user,
          pass: a.pass || '',
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
          gid: fallbackGid,
          host: '',
          user: '',
          pass: '',
          note: '',
        };
        this.draft = this.defaultDraft('win');
      }
      (CATALOG[this.form.os] || []).forEach((m) => this.draftRow(m.id));
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
    },
    async testMethod(m) {
      const row = this.draftRow(m.id);
      if (!row || !row.enabled || this.testing) return;
      const results = await Promise.all(
        ['name', 'host', 'user'].map(
          (prop) =>
            new Promise((resolve) => {
              this.$refs.form.validateField(prop, (err) => resolve(!err));
            })
        )
      );
      if (!results.every(Boolean)) return;
      this.testing = true;
      this.testingId = m.id;
      try {
        const r = unwrap(
          await api.sessionTest({
            asset: {
              host: this.form.host,
              user: this.form.user,
              pass: this.form.pass,
            },
            method: { protocol: m.id, port: row.port, advanced: row.advanced || {} },
          })
        );
        if (r && r.ok) {
          const parts = [`${t(m.nameKey)} · ${r.latencyMs ?? '-'} ms`];
          if (r.nla) parts.push(t('asset.testNla'));
          if (r.note) parts.push(r.note);
          this.$message.success(parts.join(' · '));
        } else {
          const code = (r && r.code) || '';
          const map = {
            NO_HOST: t('asset.testNoHost'),
            TCP_TIMEOUT: t('asset.testTcpFail'),
            TCP_ERROR: t('asset.testTcpFail'),
            AUTH_FAILED: t('asset.testAuthFail'),
            HOSTKEY_REJECTED: t('asset.testHostkey'),
            SSH_KEY_READ: t('asset.testKeyRead'),
            VNC_NO_AUTH: t('asset.testVncNoAuth'),
            VNC_REJECTED: t('asset.testVncRejected'),
            RDP_BAD_RESPONSE: t('asset.testRdpBad'),
          };
          const detail = r && (r.error || r.__error);
          const base = map[code];
          const msg = base && detail ? base + ' — ' + detail : base || detail || t('asset.testFail');
          this.$message.error(msg);
        }
      } catch (e) {
        this.$message.error(e.message);
      } finally {
        this.testing = false;
        this.testingId = null;
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
            this.primaryId = enabled[0];
          }
          this.syncPrimary(this.primaryId);
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
            note: this.form.note,
            methods,
            // empty → store layer puts the asset under 未分组
            gid: this.form.gid || UNGROUPED_ID,
          };
          if (this.isEdit) {
            unwrap(
              await api.updateAsset(store.assetDialog.editId, payload)
            );
            await refresh();
            this.$message.success(t('msg.assetUpdated'));
          } else {
            unwrap(await api.createAsset(payload.gid, payload));
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
.pass-reveal-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 100%;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--text-2, #9aa7b8);
  cursor: pointer;
}
.pass-reveal-btn img {
  pointer-events: none;
}
.pass-reveal-btn:hover:not(:disabled) {
  color: var(--accent, #409eff);
}
.pass-reveal-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.spin-icon {
  animation: auth-spin 0.8s linear infinite;
}
@keyframes auth-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
