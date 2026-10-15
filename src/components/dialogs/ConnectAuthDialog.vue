<template>
  <el-dialog
    :visible="!!active"
    :title="(active && active.title) || $t('asset.authSettings')"
    width="460px"
    append-to-body
    :close-on-click-modal="false"
    :show-close="false"
    :before-close="cancel"
  >
    <template v-if="active">
      <p class="hint ask-hint">{{ active.hint }}</p>
      <el-form
        ref="form"
        :model="form"
        :rules="rules"
        label-width="76px"
        size="small"
        @submit.native.prevent="submit"
      >
        <el-form-item :label="$t('asset.authPick')">
          <el-radio-group v-model="form.mode" @change="onModeChange">
            <el-radio label="inline">{{ $t('asset.mainInline') }}</el-radio>
            <el-radio label="credential">{{ $t('auth.selectCredential') }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <template v-if="form.mode === 'inline'">
          <el-form-item prop="user" :label="$t('asset.user')">
            <el-input v-model="form.user" :placeholder="$t('auth.userPh')" autocomplete="off" />
          </el-form-item>
          <el-form-item prop="pass" :label="$t('asset.pass')">
            <el-input v-model="form.pass" show-password :placeholder="$t('asset.passPh')" autocomplete="off" />
          </el-form-item>
        </template>
        <el-form-item v-else prop="credentialId" :label="$t('asset.credential')">
          <el-select v-model="form.credentialId" :placeholder="$t('asset.credentialPh')" style="width:100%">
            <el-option v-for="c in credentialOptions" :key="c.id" :label="c.name" :value="c.id">
              <span class="opt-name">{{ c.name }}</span>
              <span class="pill" :class="c.kind === 'key' ? 'cred-kind-key' : 'cred-kind-pass'">
                {{ c.kind === 'key' ? $t('cred.kindKey') : $t('cred.kindPassword') }}
              </span>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label-width="0" class="remember-row">
          <el-tooltip :content="$t('auth.rememberTip')" placement="top">
            <i class="el-icon-info remember-tip" aria-hidden="true"></i>
          </el-tooltip>
          <el-checkbox v-model="form.remember">{{ $t('auth.remember') }}</el-checkbox>
        </el-form-item>
      </el-form>
    </template>
    <template #footer>
      <el-button size="mini" @click="cancel">{{ $t('settings.cancel') }}</el-button>
      <el-button size="mini" type="primary" @click="submit">{{ $t('msg.confirm') }}</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { store, api } from '../../store';
import { t } from '../../i18n';

function emptyForm() {
  // 走到这个弹窗就是「没配好凭证」，所以默认落在手填；选已有凭证是次要分支
  return { mode: 'inline', credentialId: '', user: '', pass: '', remember: false };
}

export default {
  name: 'ConnectAuthDialog',
  data() {
    return {
      requests: [],
      form: emptyForm(),
      rules: {
        credentialId: [
          {
            required: true,
            validator: (rule, value, cb) => {
              if (this.form.mode === 'credential' && !value) cb(new Error(t('asset.credentialSelect')));
              else cb();
            },
            trigger: 'change',
          },
        ],
        user: [
          {
            required: true,
            validator: (rule, value, cb) => {
              if (this.form.mode === 'inline' && !String(value || '').trim()) cb(new Error(t('msg.userRequired')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
        pass: [
          {
            required: true,
            validator: (rule, value, cb) => {
              if (this.form.mode === 'inline' && !String(value || '').trim()) cb(new Error(t('msg.passRequired')));
              else cb();
            },
            trigger: 'blur',
          },
        ],
      },
    };
  },
  computed: {
    active() {
      return this.requests[0] || null;
    },
    /** 主进程按访问方式给出可用类型：私钥只对 SSH/SFTP 有意义 */
    credentialOptions() {
      const kinds = (this.active && this.active.kinds) || ['password'];
      return (store.snapshot.credentials || []).filter((c) => kinds.includes(c.kind));
    },
  },
  created() {
    this._offRequest = api.onAuthRequest && api.onAuthRequest((req) => {
      this.requests.push(req);
      this.form = emptyForm();
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
    });
    this._offCancel = api.onAuthCancel && api.onAuthCancel(({ requestId }) => {
      const wasActive = this.active && this.active.requestId === requestId;
      this.requests = this.requests.filter((r) => r.requestId !== requestId);
      if (wasActive) this.form = emptyForm();
    });
  },
  beforeDestroy() {
    if (this._offRequest) this._offRequest();
    if (this._offCancel) this._offCancel();
    for (const req of this.requests) api.sessionAuthReply(req.requestId, null);
    this.requests = [];
  },
  methods: {
    onModeChange(mode) {
      this.form.credentialId = mode === 'credential' ? this.form.credentialId : '';
      this.form.user = mode === 'inline' ? this.form.user : '';
      this.form.pass = mode === 'inline' ? this.form.pass : '';
      if (this.$refs.form) this.$refs.form.clearValidate();
    },
    finish(answer) {
      const req = this.active;
      if (!req) return;
      this.requests.shift();
      this.form = emptyForm();
      api.sessionAuthReply(req.requestId, answer);
    },
    cancel() {
      this.finish(null);
    },
    submit() {
      this.$refs.form.validate((valid) => {
        if (!valid) return;
        this.finish({
          mode: this.form.mode,
          credentialId: this.form.credentialId,
          user: this.form.user,
          pass: this.form.pass,
          remember: this.form.remember,
        });
      });
    },
  },
};
</script>

<style scoped>
.ask-hint {
  /* 两种提示都是"要用户处理"的状态，用警示色比灰字醒目 */
  color: var(--danger);
  margin: 0 0 14px;
  line-height: 1.6;
}
.opt-name {
  margin-right: 8px;
}
.remember-row {
  margin-bottom: 0;
}
.remember-tip {
  margin-right: 6px;
  color: var(--text-3);
  cursor: help;
}
</style>
