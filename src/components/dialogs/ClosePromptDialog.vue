<template>
  <el-dialog
    :visible.sync="visible"
    :title="title"
    width="400px"
    :close-on-click-modal="false"
    :show-close="true"
    append-to-body
    custom-class="close-prompt-dialog"
    @closed="onCloseFinished"
  >
    <el-radio-group v-model="choice" class="close-opts">
      <el-radio label="minimize" class="close-opt">{{ $t('closePrompt.minimize') }}</el-radio>
      <el-radio label="quit" class="close-opt">{{ $t('closePrompt.quit') }}</el-radio>
    </el-radio-group>
    <div class="close-remember">
      <el-checkbox v-model="remember">{{ $t('closePrompt.remember') }}</el-checkbox>
    </div>
    <div slot="footer" class="dialog-footer">
      <el-button size="mini" type="primary" @click="confirm">{{ $t('msg.confirm') }}</el-button>
    </div>
  </el-dialog>
</template>

<script>
import { api } from '../../store';

export default {
  name: 'ClosePromptDialog',
  data() {
    return {
      visible: false,
      choice: 'minimize',
      remember: false,
    };
  },
  computed: {
    title() {
      return this.$t('closePrompt.title');
    },
  },
  mounted() {
    this._off = api.onClosePrompt && api.onClosePrompt(() => {
      this.choice = 'minimize';
      this.remember = false;
      this.visible = true;
    });
  },
  beforeDestroy() {
    if (this._off) this._off();
  },
  methods: {
    confirm() {
      // store the intent but delay IPC until the dialog close animation has fully
      // finished (@closed). Otherwise win.hide() interrupts the fade-out and the
      // half-closed dialog flashes on the next tray show.
      this._pending = { action: this.choice === 'quit' ? 'quit' : 'minimize', remember: this.remember };
      this.visible = false;
    },
    onCloseFinished() {
      // fires after both Confirm AND the user clicking the X (cancel) — respect it
      const p = this._pending;
      this._pending = null;
      if (!p) return; // user cancelled via X
      if (api.resolveClose) api.resolveClose(p.action, p.remember);
    },
  },
};
</script>

<style scoped>
.close-opts {
  display: flex;
  width: 100%;
  margin-bottom: 14px;
}
.close-opt {
  flex: 1;
  margin: 0;
}
.close-opt + .close-opt {
  margin-left: 8px;
}
.close-remember {
  margin-left: 2px;
}
</style>
<style>
.close-prompt-dialog .el-dialog__body {
  padding: 16px 20px;
}
.close-prompt-dialog .el-dialog__footer {
  padding: 10px 20px 14px;
}
</style>