<template>
  <el-dialog
    :visible.sync="visible"
    width="480px"
    top="12vh"
    append-to-body
    :close-on-click-modal="false"
  >
    <div slot="title" class="dlg-head">
      <i class="dlg-icon" :class="mode === 'export' ? 'el-icon-download' : 'el-icon-upload2'"></i>
      <span>{{ mode === 'export' ? $t('backup.exportTitle') : $t('backup.importTitle') }}</span>
    </div>

    <div v-if="mode === 'export'" class="bk-body">
      <div class="bk-label">{{ $t('backup.contentLabel') }}</div>
      <el-checkbox-group v-model="include" class="bk-cats">
        <el-checkbox label="settings">{{ $t('backup.catSettings') }}</el-checkbox>
        <el-checkbox label="assets">{{ $t('backup.catAssets') }}</el-checkbox>
        <el-checkbox label="credentials">{{ $t('backup.catCredentials') }}</el-checkbox>
        <el-checkbox label="ai">{{ $t('backup.catAi') }}</el-checkbox>
      </el-checkbox-group>
      <div class="bk-label">{{ $t('backup.passwordLabel') }}</div>
      <el-input
        v-model="password"
        size="small"
        show-password
        maxlength="256"
        autocomplete="new-password"
        :placeholder="$t('backup.passwordTip')"
      />
      <el-input
        v-model="password2"
        size="small"
        class="bk-again"
        show-password
        maxlength="256"
        autocomplete="new-password"
        :placeholder="$t('backup.passwordAgain')"
      />
    </div>

    <div v-else class="bk-body">
      <div class="bk-label">{{ $t('backup.fileLabel') }}</div>
      <div class="bk-file">
        <el-button size="small" @click="pickFile">{{ $t('backup.chooseFile') }}</el-button>
        <span class="bk-file-name" :class="{ empty: !file }" :title="fileName">
          {{ fileName || $t('backup.noFile') }}
        </span>
      </div>
      <input ref="file" type="file" accept=".ntbak" class="bk-input" @change="onFileChange" />
      <div class="bk-label bk-gap">{{ $t('backup.passwordLabel') }}</div>
      <el-input
        v-model="password"
        size="small"
        show-password
        maxlength="256"
        autocomplete="new-password"
        :placeholder="$t('backup.importPasswordTip')"
      />
    </div>

    <template #footer>
      <el-button size="mini" @click="visible = false">{{ $t('settings.cancel') }}</el-button>
      <el-button size="mini" type="primary" :loading="busy" @click="submit">
        {{ $t('backup.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script>
import { store, api, unwrap, refresh } from '../../store';
import { t } from '../../i18n';

/** 与主进程 backup.js 的 MIN_PASSWORD 保持一致，仅用于提前提示；真正边界在主进程。 */
const MIN_PASSWORD = 6;

export default {
  name: 'BackupDialog',
  data() {
    return {
      include: ['settings', 'assets', 'credentials', 'ai'],
      password: '',
      password2: '',
      busy: false,
      file: null,
    };
  },
  computed: {
    mode() {
      return store.backupDialog === 'import' ? 'import' : 'export';
    },
    visible: {
      get() {
        return !!store.backupDialog;
      },
      set(v) {
        if (!v) store.backupDialog = '';
      },
    },
    fileName() {
      return this.file ? this.file.name : '';
    },
  },
  watch: {
    visible(v) {
      if (v) this.reset();
    },
  },
  methods: {
    reset() {
      this.include = ['settings', 'assets', 'ai'];
      this.password = '';
      this.password2 = '';
      this.busy = false;
      this.file = null;
      if (this.$refs.file) this.$refs.file.value = '';
    },
    pickFile() {
      if (this.$refs.file) this.$refs.file.click();
    },
    onFileChange(e) {
      this.file = (e.target.files && e.target.files[0]) || null;
    },
    async submit() {
      if (this.busy) return;
      if (this.mode === 'export') await this.doExport();
      else await this.doImport();
    },
    /** 密码长度与一致性在此先提示，避免无谓地走一趟身份验证。 */
    checkPassword() {
      if (this.password.length < MIN_PASSWORD) {
        this.$message.warning(t('backup.errPwdShort', { n: MIN_PASSWORD }));
        return false;
      }
      return true;
    },
    async doExport() {
      if (!this.include.length) {
        this.$message.warning(t('backup.errNoCategory'));
        return;
      }
      if (!this.checkPassword()) return;
      if (this.password !== this.password2) {
        this.$message.warning(t('backup.errPwdMismatch'));
        return;
      }
      this.busy = true;
      try {
        const r = unwrap(await api.backupExport({ include: this.include.slice(), password: this.password }));
        if (r && r.canceled) return;
        this.$message.success(t('backup.exportDone'));
        this.visible = false;
      } catch (e) {
        this.friendlyError(e);
      } finally {
        this.busy = false;
      }
    },
    async doImport() {
      if (!this.file) {
        this.$message.warning(t('backup.errNoFile'));
        return;
      }
      if (!this.checkPassword()) return;
      try {
        await this.$confirm(t('backup.overwriteWarn'), t('backup.importTitle'), {
          confirmButtonText: t('backup.confirm'),
          cancelButtonText: t('settings.cancel'),
          type: 'warning',
        });
      } catch (_) {
        return;
      }
      this.busy = true;
      try {
        const data = new Uint8Array(await this.file.arrayBuffer());
        unwrap(await api.backupImport({ data, password: this.password }));
        await refresh();
        this.$message.success(t('backup.importDone'));
        this.visible = false;
      } catch (e) {
        this.friendlyError(e);
      } finally {
        this.busy = false;
      }
    },
    /** 主进程错误码优先翻成产品文案，没有对应译文时回退原始 message。 */
    friendlyError(e) {
      const code = (e && e.code) || '';
      const msg = (e && e.message) || String(e);
      let text;
      if (code === 'BACKUP_PASSWORD') text = t('backup.errPassword');
      else if (code === 'BACKUP_PASSWORD_LEN') text = t('backup.errPwdShort', { n: MIN_PASSWORD });
      else if (code === 'BACKUP_BAD_FORMAT') text = t('backup.errFormat');
      else if (code === 'BACKUP_EMPTY') text = t('backup.errNoCategory');
      else if (/Canceled|UserCanceled/i.test(code) || /已取消|Canceled/i.test(msg)) text = t('auth.canceled');
      else if (/NotConfigured/i.test(code) || /未配置身份验证|Hello/i.test(msg)) text = t('auth.notConfigured');
      else text = msg;
      this.$message.error(text);
    },
  },
};
</script>

<style scoped>
.bk-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bk-label {
  font-size: 12px;
  color: var(--text-2);
}
.bk-gap {
  margin-top: 4px;
}
.bk-cats {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bk-cats /deep/ .el-checkbox {
  margin-right: 0;
}
.bk-again {
  margin-top: -2px;
}
.bk-file {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.bk-file-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bk-file-name.empty {
  color: var(--text-3);
}
.bk-input {
  display: none;
}
</style>