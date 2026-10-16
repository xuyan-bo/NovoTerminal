<template>
  <el-dialog
    :title="$t('asset.authSettings') + ' · ' + dlg.methodName"
    :visible.sync="visible"
    width="520px"
    top="14vh"
    append-to-body
    :close-on-click-modal="false"
  >
    <el-form
      ref="form"
      :model="form"
      :rules="rules"
      label-width="92px"
      size="small"
      @submit.native.prevent
    >
      <el-form-item :label="$t('asset.authSource')">
        <el-radio-group v-model="use" @change="onUseChange">
          <el-radio label="main" :disabled="!mainUsable">{{ $t('asset.useMainAuth') }}</el-radio>
          <el-radio label="custom">{{ $t('asset.customAuth') }}</el-radio>
        </el-radio-group>
        <div v-if="!mainUsable" class="hint main-off">{{ $t('asset.mainAuthUnavailable') }}</div>
      </el-form-item>

      <template v-if="use === 'custom'">
        <el-form-item :label="$t('asset.authPick')">
          <el-radio-group v-model="form.mode" @change="onModeChange">
            <el-radio label="inline">{{ $t('asset.authInline') }}</el-radio>
            <el-radio label="credential">{{ $t('asset.authCredential') }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <template v-if="form.mode === 'inline'">
          <el-form-item :label="$t('asset.user')" prop="user">
            <el-input v-model="form.user" :placeholder="$t('asset.userPh')" />
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
                <svg-icon v-else-if="!passVisible" name="eye-open" :size="20" />
                <svg-icon v-else name="eye-closed" :size="20" />
              </button>
            </el-input>
          </el-form-item>
        </template>
        <el-form-item v-if="form.mode === 'credential'" :label="$t('asset.credential')" prop="credentialId">
          <el-select v-model="form.credentialId" :placeholder="$t('asset.credentialPh')" style="width:100%">
            <el-option v-for="c in credentialOptions" :key="c.id" :label="c.name" :value="c.id">
              <span class="opt-name">{{ c.name }}</span>
              <span class="pill" :class="c.kind === 'key' ? 'cred-kind-key' : 'cred-kind-pass'">
                {{ $t('cred.kind' + cap(c.kind)) }}
              </span>
            </el-option>
          </el-select>
        </el-form-item>
      </template>
    </el-form>

    <template #footer>
      <el-button size="mini" @click="visible = false">{{ $t('settings.cancel') }}</el-button>
      <el-button size="mini" type="primary" @click="confirm">{{ $t('msg.confirm') }}</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { store, api, unwrap } from '../../store';
import { t } from '../../i18n';

const MODES = ['inline', 'credential'];

export default {
  name: 'MethodAuthDialog',
  data() {
    return {
      use: 'main',
      form: { mode: 'inline', user: '', pass: '', credentialId: '' },
      passVisible: false,
      authChecking: false,
      rules: {
        user: [
          {
            required: true,
            validator: (rule, value, cb) => {
              const inline = this.use === 'custom' && this.form.mode === 'inline';
              if (inline && !String(this.form.user || '').trim()) cb(new Error(t('msg.userRequired')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        pass: [
          {
            required: true,
            validator: (rule, value, cb) => {
              const inline = this.use === 'custom' && this.form.mode === 'inline';
              if (inline && !String(this.form.pass || '').trim()) cb(new Error(t('msg.passRequired')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        credentialId: [
          {
            required: true,
            validator: (rule, value, cb) => {
              if (this.use === 'custom' && this.form.mode === 'credential' && !value) {
                cb(new Error(t('asset.credentialSelect')));
              } else cb();
            },
            trigger: 'change',
          },
        ],
      },
    };
  },
  computed: {
    dlg() {
      return store.methodAuthDialog || {};
    },
    visible: {
      get() {
        return !!this.dlg.visible;
      },
      set(v) {
        store.methodAuthDialog = { ...this.dlg, visible: v };
        if (!v && this.$refs.form) this.$nextTick(() => this.$refs.form.clearValidate());
      },
    },
    /** 主凭证不可用时（未设置，或是私钥而本方式只吃口令）整条分支锁死在自定义 */
    mainUsable() {
      const main = this.dlg.main || { mode: 'none' };
      if (!main.mode || main.mode === 'none') return false;
      if (main.kind === 'key' && !(this.dlg.authKinds || []).includes('key')) return false;
      return true;
    },
    credentialOptions() {
      const kinds = this.dlg.authKinds || ['password'];
      return (store.snapshot.credentials || []).filter((c) => kinds.includes(c.kind));
    },
  },
  watch: {
    'dlg.visible'(v) {
      if (v) this.load();
    },
  },
  methods: {
    cap(kind) {
      return kind === 'key' ? 'Key' : 'Password';
    },
    load() {
      // 该方式没配自定义凭证时 auth 为 null（默认状态），此时表单必须是空的草稿
      const custom = this.dlg.auth && this.dlg.auth.use === 'custom' ? this.dlg.auth : null;
      this.passVisible = false;
      this.use = custom ? 'custom' : 'main';
      if (!this.mainUsable) this.use = 'custom';
      const mode = custom && MODES.includes(custom.mode) ? custom.mode : 'inline';
      const src = custom || {};
      this.form = {
        mode,
        user: mode === 'inline' ? src.user || '' : '',
        pass: mode === 'inline' ? src.pass || '' : '',
        credentialId: mode === 'credential' ? src.credentialId || '' : '',
      };
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
    },
    onUseChange(v) {
      if (v === 'main') this.passVisible = false;
    },
    onModeChange(mode) {
      if (mode !== 'inline') {
        this.form.user = '';
        this.form.pass = '';
      }
      if (mode !== 'credential') this.form.credentialId = '';
      this.passVisible = false;
    },
    /** 与资产表单同一条规则：查看已保存的口令要先过系统身份验证 */
    async onTogglePassVisible() {
      if (this.authChecking) return;
      if (this.passVisible) {
        this.passVisible = false;
        return;
      }
      if (!this.form.pass) {
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
        if (r && r.ok) this.passVisible = true;
        else this.$message.error(this.authMessage(r));
      } catch (e) {
        this.$message.error(this.authMessage(e));
      } finally {
        this.authChecking = false;
      }
    },
    authMessage(r) {
      const code = (r && r.code) || '';
      if (/Canceled|UserCanceled/i.test(code)) return t('auth.canceled');
      if (/NotConfigured/i.test(code)) return t('auth.notConfigured');
      return (r && r.message) || t('auth.failed');
    },
    confirm() {
      this.$refs.form.validate((valid) => {
        if (!valid) return;
        store.methodAuthResult = { methodId: this.dlg.methodId, auth: this.buildAuth() };
        this.visible = false;
      });
    },
    buildAuth() {
      if (this.use === 'main') return null;
      if (this.form.mode === 'credential') {
        return { use: 'custom', mode: 'credential', credentialId: this.form.credentialId };
      }
      return { use: 'custom', mode: 'inline', user: this.form.user, pass: this.form.pass };
    },
  },
};
</script>

<style scoped>
.main-off {
  line-height: 1.6;
}
.opt-name {
  margin-right: 8px;
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
  color: var(--text-2);
  cursor: pointer;
}
.pass-reveal-btn:hover:not(:disabled) {
  color: var(--accent);
}
.pass-reveal-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
