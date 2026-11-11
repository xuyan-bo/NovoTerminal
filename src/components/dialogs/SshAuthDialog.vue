<template>
  <el-dialog
    :model-value="!!active"
    width="480px"
    append-to-body
    :close-on-click-modal="false"
    :before-close="cancel"
  >
    <template #header>
      <div class="dlg-head">
        <el-icon class="dlg-icon"><Key /></el-icon>
        <span>{{ 'SSH · ' + $t('ssh.authTitle') }}</span>
      </div>
    </template>

    <template v-if="active">
      <p>{{ active.host }}:{{ active.port }}</p>
      <p v-if="active.name">{{ active.name }}</p>
      <p v-if="active.instructions" class="instructions">{{ active.instructions }}</p>
      <el-form @submit.prevent="submit">
        <el-form-item v-for="(prompt, index) in active.prompts" :key="index" :label="prompt.prompt">
          <el-input
            v-model="active.answers[index]"
            :type="prompt.echo ? 'text' : 'password'"
            autocomplete="off"
            @keydown.enter.prevent="submit"
          />
        </el-form-item>
      </el-form>
    </template>
    <template #footer>
      <el-button @click="cancel">{{ $t('msg.cancel') }}</el-button>
      <el-button type="primary" @click="submit">{{ $t('msg.confirm') }}</el-button>
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
  beforeUnmount() {
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
