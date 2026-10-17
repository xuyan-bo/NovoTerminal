<template>
  <el-dialog
    :visible="!!active"
    width="480px"
    append-to-body
    :close-on-click-modal="false"
    :before-close="cancel"
  >
    <div slot="title" class="dlg-head">
      <i class="dlg-icon el-icon-key"></i>
      <span>{{ 'SSH · ' + $t('ssh.authTitle') }}</span>
    </div>

    <template v-if="active">
      <p>{{ active.host }}:{{ active.port }}</p>
      <p v-if="active.name">{{ active.name }}</p>
      <p v-if="active.instructions" class="instructions">{{ active.instructions }}</p>
      <el-form @submit.native.prevent="submit">
        <el-form-item v-for="(prompt, index) in active.prompts" :key="index" :label="prompt.prompt">
          <el-input
            v-model="active.answers[index]"
            :type="prompt.echo ? 'text' : 'password'"
            autocomplete="off"
            @keydown.enter.native.prevent="submit"
          />
        </el-form-item>
      </el-form>
    </template>
    <template #footer>
      <el-button size="small" @click="cancel">{{ $t('msg.cancel') }}</el-button>
      <el-button size="small" type="primary" @click="submit">{{ $t('msg.confirm') }}</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { api, unwrap } from '../../store';

export default {
  name: 'SshAuthDialog',
  data() {
    return { requests: [] };
  },
  computed: {
    active() { return this.requests[0] || null; },
  },
  created() {
    this._offPrompt = api.onSshAuthPrompt && api.onSshAuthPrompt((req) => {
      this.requests.push({ ...req, answers: req.prompts.map(() => '') });
    });
    this._offCancel = api.onSshAuthCancel && api.onSshAuthCancel(({ requestId }) => {
      this.requests = this.requests.filter((r) => r.requestId !== requestId);
    });
  },
  beforeDestroy() {
    if (this._offPrompt) this._offPrompt();
    if (this._offCancel) this._offCancel();
    for (const req of this.requests) api.sshAuthReply(req.requestId, null).catch(() => {});
    this.requests = [];
  },
  methods: {
    cancel() { this.finish(null); },
    submit() { if (this.active) this.finish(this.active.answers.slice()); },
    async finish(answers) {
      const req = this.active;
      if (!req) return;
      this.requests.shift();
      req.answers = [];
      try {
        unwrap(await api.sshAuthReply(req.requestId, answers));
      } catch (error) {
        this.$message.error(error.message);
      }
    },
  },
};
</script>

<style scoped>
.instructions {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
