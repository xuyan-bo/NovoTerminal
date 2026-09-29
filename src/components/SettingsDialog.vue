<template>
  <el-dialog
    :title="$t('settings.title')"
    :visible.sync="visible"
    width="560px"
    top="5vh"
    :close-on-click-modal="false"
  >
    <el-form
      ref="form"
      :model="form"
      :rules="rules"
      label-width="140px"
      size="small"
      @submit.native.prevent
    >
      <div class="set-section">
        <h4 class="set-h">{{ $t('settings.ui') }}</h4>
        <el-form-item :label="$t('settings.theme')" prop="theme">
          <div class="theme-picks">
            <button
              v-for="th in themes"
              :key="th.id"
              type="button"
              class="theme-pick"
              :class="{ on: form.theme === th.id }"
              @click="onTheme(th.id)"
            >{{ $t('settings.theme.' + th.id) }}</button>
          </div>
        </el-form-item>
        <el-form-item :label="$t('settings.lang')" prop="lang">
          <div class="theme-picks">
            <button
              type="button"
              class="theme-pick"
              :class="{ on: form.lang === 'zh' }"
              @click="onLang('zh')"
            >中文</button>
            <button
              type="button"
              class="theme-pick"
              :class="{ on: form.lang === 'en' }"
              @click="onLang('en')"
            >English</button>
          </div>
          <span class="hint" style="margin-left:8px">{{ $t('settings.previewLang') }}</span>
        </el-form-item>
        <el-form-item :label="$t('settings.zoom')">
          <div class="zoom-row">
            <el-slider v-model="form.zoom" :min="50" :max="200" :step="10" />
            <span class="zoom-val">{{ form.zoom }}%</span>
          </div>
          <span class="hint">{{ $t('settings.zoomApply') }}</span>
        </el-form-item>
        <el-form-item :label="$t('settings.font')">
          <el-select v-model="form.font" style="width:100%" @change="onFont">
            <el-option
              v-for="f in fonts"
              :key="f.id"
              :label="$t('settings.font.' + f.id)"
              :value="f.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="$t('settings.closeAction')">
          <el-radio-group v-model="form.closeAction">
            <el-radio :label="'ask'">{{ $t('settings.closeActionAsk') }}</el-radio>
            <el-radio :label="'minimize'">{{ $t('settings.closeActionMin') }}</el-radio>
            <el-radio :label="'quit'">{{ $t('settings.closeActionQuit') }}</el-radio>
          </el-radio-group>
        </el-form-item>
      </div>

      <div class="set-section">
        <h4 class="set-h">{{ $t('settings.data') }}</h4>
        <el-form-item prop="dataPath">
          <template slot="label">
            {{ $t('settings.dataPath') }}
            <el-tooltip :content="$t('settings.dataPathTip')" placement="top">
              <i class="el-icon-info"></i>
            </el-tooltip>
          </template>
          <div class="path-row">
            <el-input v-model="form.dataPath" readonly />
            <el-button :loading="browsing" @click="browse">{{ $t('settings.browse') }}</el-button>
          </div>
        </el-form-item>
        <el-form-item :label="$t('settings.backup')">
          <el-button size="mini" icon="el-icon-download" @click="exportJson">{{ $t('settings.exportCfg') }}</el-button>
          <el-button size="mini" icon="el-icon-upload2" @click="importJson">{{ $t('settings.importCfg') }}</el-button>
        </el-form-item>
      </div>

      <div class="set-section">
        <h4 class="set-h">{{ $t('settings.about') }}</h4>
        <div class="about-box">
          <img class="logo-mark" src="../assets/logo.svg" alt="OmniDesk" width="36" height="36" />
          <div>
            <div style="font-family:Consolas,monospace;font-weight:600">OmniDesk v0.1.0</div>
            <div class="meta" v-html="$t('settings.aboutBody')"></div>
            <div class="meta">
              {{ $t('settings.aboutSource') }}
              <a class="meta-link" @click="openUrl('https://gitee.com/xu-san333/omni-desk')">Gitee</a>
              <span class="meta-sep"> · </span>
              <a class="meta-link" @click="openUrl('https://github.com/xu-san333/omni-desk')">GitHub</a>
            </div>
          </div>
        </div>
      </div>
    </el-form>

    <template #footer>
      <span style="float:left;color:var(--text-3);font-size:11px;line-height:28px">
        {{ $t('settings.summary', { theme: themeLabel, lang: form.lang === 'zh' ? '中文' : 'English' }) }}
      </span>
      <el-button size="mini" @click="visible = false">{{ $t('settings.cancel') }}</el-button>
      <el-button size="mini" type="primary" :loading="saving" @click="save">
        {{ $t('settings.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script>
import { store, api, unwrap, refresh } from '../store';
import { applyTheme, applyFont, setLocale, t } from '../i18n';
import { UI_FONTS } from '../constants';
import locale from 'element-ui/lib/locale';
import zhLocale from 'element-ui/lib/locale/lang/zh-CN';
import enLocale from 'element-ui/lib/locale/lang/en';

export default {
  name: 'SettingsDialog',
  data() {
    return {
      saving: false,
      browsing: false,
      themes: [
        { id: 'dark', label: '深色' },
        { id: 'light', label: '浅色' },
        { id: 'system', label: '跟随系统' },
      ],
      fonts: UI_FONTS,
      form: { theme: 'system', lang: 'zh', dataPath: '', zoom: 100, font: 'default', closeAction: 'ask' },
      rules: {
        theme: [
          {
            validator(rule, value, cb) {
              if (!value) cb(new Error('请选择主题'));
              else cb();
            },
            trigger: 'change',
          },
        ],
        lang: [
          {
            validator(rule, value, cb) {
              if (!value) cb(new Error('请选择语言'));
              else cb();
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
        return store.settingsDialog;
      },
      set(v) {
        store.settingsDialog = v;
        if (!v && this.$refs.form) {
          this.$nextTick(() => this.$refs.form.clearValidate());
        }
      },
    },
    themeLabel() {
      return this.$t('settings.theme.' + this.form.theme);
    },
  },
  watch: {
    visible(v) {
      if (v) this.load();
    },
  },
  methods: {
    openUrl(url) {
      if (window.omniDesk && window.omniDesk.openExternal) {
        window.omniDesk.openExternal(url);
      }
    },
    async load() {
      const s = (await api.getSettings()) || store.snapshot.settings || {};
      this.form = {
        theme: s.theme || 'system',
        lang: s.lang || 'zh',
        dataPath: s.dataPath || '',
        zoom: Math.min(200, Math.max(50, Number(s.zoom) || 100)),
        font: s.font || 'default',
        closeAction: s.closeAction || 'ask',
      };
      applyTheme(this.form.theme);
      applyFont(this.form.font);
      setLocale(this.form.lang);
      locale.use(this.form.lang === 'en' ? enLocale : zhLocale);
      store.localeTick++;
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
    },
    onFont(id) {
      applyFont(id);
    },
    onTheme(id) {
      this.form.theme = id;
      applyTheme(id);
      store.localeTick++;
      if (this.$refs.form) this.$refs.form.validateField('theme');
    },
    onLang(lang) {
      this.form.lang = lang;
      setLocale(lang);
      locale.use(lang === 'en' ? enLocale : zhLocale);
      store.localeTick++;
      if (this.$refs.form) this.$refs.form.validateField('lang');
    },
    async browse() {
      if (!api.browseDataPath) {
        this.$message.warning(t('msg.needElectron'));
        return;
      }
      this.browsing = true;
      try {
        const s = await api.browseDataPath();
        if (s && s.dataPath) this.form.dataPath = s.dataPath;
        await refresh();
      } catch (e) {
        this.$message.error(e.message);
      } finally {
        this.browsing = false;
      }
    },
    async exportJson() {
      try {
        // OS identity is enforced in main (store:export); surface friendly errors here
        const text = unwrap(await api.exportGroups());
        const blob = new Blob([text], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'omnidesk-groups.json';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        this.authFriendlyError(e);
      }
    },
    importJson() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          if (api.importGroups) {
            // OS identity is enforced in main (store:import); surface friendly errors here
            unwrap(await api.importGroups(text));
          } else {
            throw new Error(t('msg.needElectron'));
          }
          await refresh();
          this.$message.success(t('settings.importDone'));
        } catch (e) {
          this.authFriendlyError(e);
        }
      };
      input.click();
    },
    authFriendlyError(e) {
      const code = (e && e.code) || '';
      let msg = e.message || String(e);
      if (/Canceled|UserCanceled/i.test(code) || /已取消|Canceled/i.test(msg)) {
        msg = t('auth.canceled');
      } else if (/NotConfigured/i.test(code) || /未配置身份验证|Hello/i.test(msg)) {
        msg = t('auth.notConfigured');
      }
      this.$message.error(msg);
    },
    save() {
      this.$refs.form.validate(async (valid) => {
        if (!valid) return;
        this.saving = true;
        try {
          unwrap(
            await api.updateSettings({
              theme: this.form.theme,
              lang: this.form.lang,
              zoom: this.form.zoom,
              font: this.form.font,
              closeAction: this.form.closeAction,
            })
          );
          await refresh();
          applyTheme(this.form.theme);
          setLocale(this.form.lang);
          locale.use(this.form.lang === 'en' ? enLocale : zhLocale);
          store.localeTick++;
          this.$message.success(t('msg.settingsSaved'));
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
.set-h {
  font-size: 12px;
  color: var(--text-2);
  margin: 0 0 12px;
  font-weight: 600;
}
.set-section {
  margin-bottom: 4px;
}
.set-section + .set-section {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.path-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.path-row .el-input {
  flex: 1;
}
.zoom-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.zoom-row .el-slider {
  flex: 1;
  margin-top: -6px;
}
.zoom-val {
  width: 44px;
  text-align: right;
  font-size: 12px;
  color: var(--text-2);
}
.about-box {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  gap: 14px;
}
.about-box .meta {
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.65;
}
.about-box .meta a {
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
}
.about-box .meta a:hover {
  text-decoration: underline;
}
.about-box .meta-link {
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
}
.about-box .meta-link:hover {
  text-decoration: underline;
}
.about-box .meta-sep {
  color: var(--text-3);
}
</style>
