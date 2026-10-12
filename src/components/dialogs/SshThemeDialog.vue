<template>
  <el-dialog
    :title="$t('theme.title')"
    :visible.sync="visible"
    width="520px"
    top="10vh"
    :close-on-click-modal="false"
  >
    <div class="theme-sec-title">{{ $t('theme.textColors') }}</div>
    <div class="theme-row" v-for="row in basicRows" :key="row.key">
      <span class="theme-row-label">{{ row.label }}</span>
      <el-color-picker
        v-model="form[row.key]"
        :predefine="predefine"
        :append-to-body="!inFullscreen"
        size="small"
      />
      <span class="theme-row-hex">{{ form[row.key] }}</span>
    </div>

    <div class="theme-sec-title">{{ $t('theme.ansiColors') }}</div>
    <div class="ansi-grid">
      <div
        v-for="(c, i) in form.ansi"
        :key="i"
        class="ansi-cell"
        :title="'ANSI ' + i + ' · ' + c"
      >
        <el-color-picker
          v-model="form.ansi[i]"
          size="mini"
          :predefine="predefine"
          :append-to-body="!inFullscreen"
        >
          <div
            slot="trigger"
            class="ansi-swatch"
            :style="{ background: c }"
          ></div>
        </el-color-picker>
        <span class="ansi-idx">{{ i < 8 ? '0' : '1' }}{{ i % 8 }}</span>
      </div>
    </div>

    <div class="theme-sec-title">{{ $t('theme.preview') }}</div>
    <div class="theme-preview" :style="previewStyle">
      <div class="preview-line">
        <span class="preview-normal">{{ $t('theme.previewNormal') }}</span>
      </div>
      <div class="preview-ansi">
        <span
          v-for="(c, i) in form.ansi"
          :key="i"
          class="preview-swatch"
          :style="{ background: c }"
        ></span>
      </div>
    </div>

    <template #footer>
      <el-button size="mini" @click="reset">{{ $t('theme.reset') }}</el-button>
      <el-button size="mini" @click="visible = false">{{ $t('settings.cancel') }}</el-button>
      <el-button size="mini" type="primary" :loading="saving" @click="confirm">{{ $t('settings.save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { api, unwrap, findAsset, refresh, store } from '../../store';
import { resolveSshTheme } from '../../constants';
import { t } from '../../i18n';

const PRE = [
  '#000000', '#0f1419', '#1e1e1e', '#282c34', '#c0c0c0', '#d7dde8', '#ffffff',
];

export default {
  name: 'SshThemeDialog',
  props: {
    assetId: { type: String, default: '' },
    /** When the SSH view is fullscreen, keep dialog + color pickers inside the
     * fullscreen element; body-appended popups are otherwise hidden/masked. */
    inFullscreen: { type: Boolean, default: false },
  },
  data() {
    return {
      visible: false,
      saving: false,
      form: resolveSshTheme(null),
      predefine: PRE,
    };
  },
  computed: {
    localeTick() {
      return store.localeTick;
    },
    basicRows() {
      // 标签只在求值时翻译一次：不接 localeTick，切换语言后这三项永远是旧语言
      void this.localeTick;
      return [
        { key: 'foreground', label: t('theme.normal') },
        { key: 'background', label: t('theme.background') },
        { key: 'cursor', label: t('theme.cursor') },
      ];
    },
    previewStyle() {
      return {
        background: this.form.background,
        color: this.form.foreground,
        borderColor: 'rgba(128,128,128,0.3)',
      };
    },
  },
  methods: {
    open() {
      // load saved scheme for this asset
      let saved = null;
      const hit = this.assetId && findAsset(this.assetId);
      if (hit && hit.asset.methods && hit.asset.methods.ssh) {
        const adv = hit.asset.methods.ssh.advanced || {};
        if (adv.colors) saved = adv.colors;
      }
      this.form = resolveSshTheme(saved);
      this.visible = true;
    },
    reset() {
      this.form = resolveSshTheme(null);
    },
    async confirm() {
      if (this.saving) return;
      this.saving = true;
      try {
        const hit = findAsset(this.assetId);
        if (!hit) throw new Error(t('detail.empty'));
        const methods = JSON.parse(JSON.stringify(hit.asset.methods || {}));
        const prev = methods.ssh || {};
        // 保留旧记录的额外字段（包括 bold），但只编辑、应用 xterm 支持的颜色。
        const colors = { ...(prev.advanced?.colors || {}), ...resolveSshTheme(this.form) };
        methods.ssh = {
          ...prev,
          // 保存配色不应顺手把 SSH 方法启用：沿用原状态，仅在没有记录时默认启用
          enabled: prev.enabled !== false,
          advanced: { ...(prev.advanced || {}), colors },
        };
        unwrap(
          await api.updateAsset(this.assetId, {
            methods,
            name: hit.asset.name,
            os: hit.asset.os,
            host: hit.asset.host,
            user: hit.asset.user,
            pass: hit.asset.pass,
            tags: hit.asset.tags,
            note: hit.asset.note,
            gid: hit.group.id,
          })
        );
        await refresh();
        api.logWrite?.({
          level: 'info', source: 'settings', message: 'ssh theme saved',
          meta: { assetId: this.assetId },
        }).catch(() => {});
        this.$emit('saved', colors);
        this.visible = false;
        this.$message.success(t('msg.advSaved'));
      } catch (e) {
        api.logWrite?.({
          level: 'error', source: 'settings', message: 'ssh theme save failed',
          meta: { assetId: this.assetId, code: e.code },
        }).catch(() => {});
        this.$message.error(e.message || t('err.connect'));
      } finally {
        this.saving = false;
      }
    },
  },
};
</script>

<style scoped>
.theme-sec-title {
  font-size: 12px;
  color: var(--text-3, #6b7789);
  margin: 10px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border, #2a3544);
}
.theme-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}
.theme-row-label {
  width: 100px;
  font-size: 13px;
  color: var(--text-1, #d7dde8);
}
.theme-row-hex {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: var(--text-3, #6b7789);
}
.ansi-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 8px;
}
.ansi-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.ansi-swatch {
  width: 26px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  cursor: pointer;
  box-sizing: border-box;
}
.ansi-idx {
  font-family: Consolas, monospace;
  font-size: 10px;
  color: var(--text-3, #6b7789);
}
.theme-preview {
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 6px;
  padding: 10px 12px;
  font-family: Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
}
.preview-line {
  display: flex;
  gap: 18px;
}
.preview-ansi {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.preview-swatch {
  flex: 1;
  height: 14px;
  border-radius: 3px;
}
</style>
