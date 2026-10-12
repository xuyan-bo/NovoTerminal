<template>
  <el-dialog
    :title="state.title"
    :visible.sync="visible"
    width="380px"
    append-to-body
    :close-on-click-modal="false"
    @closed="onClosed"
  >
    <el-form
      ref="form"
      :model="form"
      :rules="rules"
      label-width="84px"
      size="small"
      @submit.native.prevent
    >
      <el-form-item :label="state.label" prop="name">
        <el-input ref="input" v-model="form.name" maxlength="255" @keyup.enter.native="submit" />
      </el-form-item>
    </el-form>
    <div slot="footer" class="name-footer">
      <el-button size="mini" @click="visible = false">{{ $t('msg.cancel') }}</el-button>
      <el-button size="mini" type="primary" @click="submit">{{ $t('msg.confirm') }}</el-button>
    </div>
  </el-dialog>
</template>

<script>
import { t } from '../../i18n';

export default {
  name: 'SftpNameDialog',
  data() {
    return {
      visible: false,
      state: { title: '', label: '' },
      form: { name: '' },
      settled: null,
    };
  },
  computed: {
    // 校验文案必须在校验时翻译，否则切换语言后报错仍是旧语言
    rules() {
      return {
        name: [
          {
            // required 只负责表单项前的红星，空值判定仍由 validator 给出译文
            required: true,
            validator(rule, value, cb) {
              const s = String(value == null ? '' : value).trim();
              if (!s) return cb(new Error(t('sftp.nameRequired')));
              if (s === '.' || s === '..' || /[\\/]/.test(s)) return cb(new Error(t('sftp.nameInvalid')));
              cb();
            },
            trigger: 'change',
          },
        ],
      };
    },
  },
  watch: {
    visible(on) {
      if (on) this.$nextTick(() => this.$refs.input && this.$refs.input.focus());
    },
  },
  methods: {
    open(title, label) {
      this.state = { title, label };
      this.form.name = '';
      this.visible = true;
      this.$nextTick(() => this.$refs.form && this.$refs.form.clearValidate());
      return new Promise((resolve) => {
        this.settled = resolve;
      });
    },
    submit() {
      this.$refs.form.validate((ok) => {
        if (!ok) return;
        this.finish(String(this.form.name).trim());
        this.visible = false;
      });
    },
    onClosed() {
      this.finish(null);
    },
    finish(name) {
      const resolve = this.settled;
      this.settled = null;
      if (resolve) resolve(name);
    },
  },
};
</script>

<style scoped>
.name-footer {
  text-align: right;
}
</style>
