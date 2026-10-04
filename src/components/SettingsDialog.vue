<template>
  <el-dialog
    :title="$t('settings.title')"
    :visible.sync="visible"
    width="760px"
    top="5vh"
    :close-on-click-modal="false"
  >
    <div class="settings-layout">
      <div class="settings-nav">
        <button
          v-for="sec in sections"
          :key="sec.id"
          type="button"
          class="nav-item"
          :class="{ on: activeMenu === sec.id }"
          @click="activeMenu = sec.id"
        >
          <svg-icon v-if="sec.svg" :name="sec.svg" :size="13" />
          <i v-else :class="sec.icon"></i>
          <span>{{ $t('settings.' + sec.id) }}</span>
        </button>
      </div>
      <div class="settings-body">
        <el-form
          ref="form"
          :model="form"
          :rules="rules"
          label-width="110px"
          size="small"
          @submit.native.prevent
        >
        <div v-show="activeMenu === 'general'" class="set-section">
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

        <div v-show="activeMenu === 'data'" class="set-section">
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

        <div v-show="activeMenu === 'ai'" class="set-section">
          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.enabled') }}
              <el-tooltip :content="$t('settings.ai.enabledTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-switch v-model="ai.enabled" />
          </el-form-item>

          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.services') }}
              <el-tooltip :content="$t('settings.ai.servicesTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <div class="svc-list">
              <div v-for="(svc, i) in ai.services" :key="svc.id" class="svc-card" :class="{ def: isDefaultService(svc) }">
                <div class="svc-top">
                  <el-input v-model="svc.name" size="mini" class="svc-name" :placeholder="$t('settings.ai.serviceName')" />
                  <span v-if="isDefaultService(svc)" class="svc-tag">{{ $t('settings.ai.defaultService') }}</span>
                  <span v-else-if="svc.test" class="svc-tag" :class="svc.test.ok ? 'ok' : 'bad'">{{ svc.test.text }}</span>
                  <span class="svc-ops">
                    <el-button size="mini" type="text" :disabled="isDefaultService(svc)" @click="setDefaultService(svc)">
                      {{ $t('settings.ai.setDefault') }}
                    </el-button>
                    <el-button size="mini" type="text" :loading="!!svc.testing" @click="testService(svc)">
                      {{ $t('settings.ai.test') }}
                    </el-button>
                    <el-button size="mini" type="text" class="svc-del" @click="removeService(i)">{{ $t('settings.ai.deleteService') }}</el-button>
                  </span>
                </div>
                <div class="svc-grid">
                  <label class="svc-field">
                    <span>{{ $t('settings.ai.baseUrl') }}</span>
                    <el-input v-model="svc.baseUrl" size="mini" class="mono" placeholder="https://api.example.com/v1" />
                  </label>
                  <label class="svc-field">
                    <span>{{ $t('settings.ai.apiKey') }}</span>
                    <el-input v-model="svc.apiKey" size="mini" class="mono" show-password autocomplete="off" />
                  </label>
                </div>
                <div class="svc-models">
                  <div class="svc-models-head">
                    {{ $t('settings.ai.models') }}
                    <el-tooltip :content="$t('settings.ai.modelsEmpty')" placement="top"><i class="el-icon-info"></i></el-tooltip>
                  </div>
                  <div v-for="(m, j) in svc.models" :key="svc.id + '-' + m.id" class="model-row">
                    <span class="model-id mono">{{ m.id }}</span>
                    <span class="model-alias">{{ m.alias || m.id }}</span>
                    <el-button
                      v-if="!isDefaultModel(svc, m)"
                      size="mini"
                      type="text"
                      @click="setDefaultModel(svc, m)"
                    >{{ $t('settings.ai.setDefaultModel') }}</el-button>
                    <span v-else class="svc-tag">{{ $t('settings.ai.defaultService') }}</span>
                    <el-button size="mini" type="text" class="svc-del" @click="svc.models.splice(j, 1)">{{ $t('settings.ai.deleteModel') }}</el-button>
                  </div>
                  <div v-if="!svc.models.length" class="model-empty">{{ $t('settings.ai.modelsEmpty') }}</div>
                  <div class="model-add">
                    <el-input v-model="draft[svc.id].id" size="mini" class="mono" :placeholder="$t('settings.ai.modelId')" @keyup.enter.native="addModel(svc)" />
                    <el-input v-model="draft[svc.id].alias" size="mini" :placeholder="$t('settings.ai.modelAlias')" @keyup.enter.native="addModel(svc)" />
                    <el-button size="mini" @click="addModel(svc)">{{ $t('settings.ai.addModel') }}</el-button>
                  </div>
                </div>
              </div>
              <el-button size="mini" icon="el-icon-plus" @click="addService">{{ $t('settings.ai.addService') }}</el-button>
            </div>
          </el-form-item>

          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.permission') }}
              <el-tooltip :content="$t('settings.ai.permissionTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-radio-group v-model="ai.permission">
              <el-radio v-for="p in permissions" :key="p.id" :label="p.id">
                {{ $t('ai.perm.' + p.id) }}
                <el-tooltip :content="$t('ai.permDesc.' + p.id)" placement="top"><i class="el-icon-info"></i></el-tooltip>
              </el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.readScreen') }}
              <el-tooltip :content="$t('settings.ai.readScreenTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-switch v-model="ai.readScreen" />
          </el-form-item>
          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.ptyControl') }}
              <el-tooltip :content="$t('settings.ai.ptyControlTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-switch v-model="ai.ptyControl" />
          </el-form-item>
          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.timeout') }}
              <el-tooltip :content="$t('settings.ai.timeoutTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-input-number v-model="ai.commandTimeoutSec" size="mini" :min="AI_LIMITS.commandTimeoutSec[0]" :max="AI_LIMITS.commandTimeoutSec[1]" />
          </el-form-item>
          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.turns') }}
              <el-tooltip :content="$t('settings.ai.turnsTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-input-number v-model="ai.maxTurns" size="mini" :min="AI_LIMITS.maxTurns[0]" :max="AI_LIMITS.maxTurns[1]" />
          </el-form-item>
        </div>

        <div v-show="activeMenu === 'about'" class="set-section">
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
      </div>
    </div>

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
import { UI_FONTS, AI_PERMISSIONS, AI_DEFAULTS, AI_LIMITS } from '../constants';
import locale from 'element-ui/lib/locale';
import zhLocale from 'element-ui/lib/locale/lang/zh-CN';
import enLocale from 'element-ui/lib/locale/lang/en';

/** 服务与模型的临时字段（测试状态、新增草稿）不进持久化对象。 */
function cleanService(svc) {
  return { id: svc.id, name: String(svc.name || '').trim(), baseUrl: String(svc.baseUrl || '').trim(), apiKey: String(svc.apiKey || ''), models: (svc.models || []).map((m) => ({ id: m.id, alias: m.alias || m.id })) };
}

export default {
  name: 'SettingsDialog',
  data() {
    return {
      saving: false,
      browsing: false,
      activeMenu: 'general',
      permissions: AI_PERMISSIONS,
      AI_LIMITS,
      draft: {},
      ai: { ...AI_DEFAULTS, services: [], defaultRef: null },
      sections: [
        { id: 'general', icon: 'el-icon-setting' },
        { id: 'data', icon: 'el-icon-folder' },
        { id: 'ai', icon: '', svg: 'ai' },
        { id: 'about', icon: 'el-icon-info' },
      ],
      themes: [{ id: 'dark' }, { id: 'light' }, { id: 'system' }],
      fonts: UI_FONTS,
      form: { theme: 'system', lang: 'zh', dataPath: '', zoom: 100, font: 'default', closeAction: 'ask' },
      rules: {
        theme: [
          {
            validator(rule, value, cb) {
              if (!value) cb(new Error(t('settings.themeRequired')));
              else cb();
            },
            trigger: 'change',
          },
        ],
        lang: [
          {
            validator(rule, value, cb) {
              if (!value) cb(new Error(t('settings.langRequired')));
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
      if (v) {
        this.activeMenu = 'general';
        this.load();
      }
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
      const ai = s.ai || {};
      this.ai = {
        ...AI_DEFAULTS,
        ...ai,
        permission: AI_PERMISSIONS.some((p) => p.id === ai.permission) ? ai.permission : AI_DEFAULTS.permission,
        services: (Array.isArray(ai.services) ? ai.services : []).map(cleanService),
        defaultRef: ai.defaultRef ? { ...ai.defaultRef } : null,
      };
      this.ensureDrafts();
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
    /* ---- AI 服务与模型：与终端面板共用同一份 settings.ai ---- */
    ensureDrafts() {
      for (const svc of this.ai.services) {
        if (!this.draft[svc.id]) this.$set(this.draft, svc.id, { id: '', alias: '' });
      }
    },
    isDefaultService(svc) {
      return !!(this.ai.defaultRef && this.ai.defaultRef.serviceId === svc.id);
    },
    isDefaultModel(svc, model) {
      const ref = this.ai.defaultRef;
      return !!(ref && ref.serviceId === svc.id && ref.modelId === model.id);
    },
    setDefaultService(svc) {
      const first = svc.models && svc.models[0];
      if (!first) {
        this.$message.warning(t('settings.ai.needModelFirst'));
        return;
      }
      this.ai.defaultRef = { serviceId: svc.id, modelId: first.id };
    },
    setDefaultModel(svc, model) {
      this.ai.defaultRef = { serviceId: svc.id, modelId: model.id };
    },
    addService() {
      const id = 'svc-' + crypto.randomUUID();
      this.ai.services = [...this.ai.services, { id, name: t('settings.ai.newService'), baseUrl: '', apiKey: '', models: [] }];
      this.$set(this.draft, id, { id: '', alias: '' });
    },
    removeService(i) {
      const [gone] = this.ai.services.splice(i, 1);
      if (gone) {
        this.$delete(this.draft, gone.id);
        if (this.ai.defaultRef && this.ai.defaultRef.serviceId === gone.id) this.ai.defaultRef = null;
      }
    },
    addModel(svc) {
      const box = this.draft[svc.id] || { id: '', alias: '' };
      const id = String(box.id || '').trim();
      if (!id) return;
      if (svc.models.some((m) => m.id === id)) {
        this.$message.warning(t('settings.ai.modelExists'));
        return;
      }
      svc.models.push({ id, alias: String(box.alias || '').trim() });
      this.$set(this.draft, svc.id, { id: '', alias: '' });
      if (!this.ai.defaultRef) this.ai.defaultRef = { serviceId: svc.id, modelId: id };
    },
    async testService(svc) {
      if (!api.aiTest) {
        this.$message.warning(t('msg.needElectron'));
        return;
      }
      if (!String(svc.baseUrl || '').trim() || !String(svc.apiKey || '').trim()) {
        this.$set(svc, 'test', { ok: false, text: t('settings.ai.testIncomplete') });
        return;
      }
      this.$set(svc, 'testing', true);
      this.$set(svc, 'test', null);
      try {
        const r = unwrap(await api.aiTest({ baseUrl: svc.baseUrl, apiKey: svc.apiKey, model: svc.models[0] ? svc.models[0].id : '' }));
        const extra = r.models && r.models.length ? t('settings.ai.testModels', { n: r.models.length }) : '';
        this.$set(svc, 'test', { ok: true, text: t('settings.ai.testOk', { ms: r.ms }) + extra });
        // 拉到模型清单而服务里还空着，就填前 20 个进去，省得手抄
        if (r.models && r.models.length && !svc.models.length) {
          this.$set(svc, 'models', r.models.slice(0, 20).map((id) => ({ id, alias: id })));
        }
      } catch (e) {
        const key = 'err.' + (e.code || '');
        const mapped = e.code ? t(key) : '';
        this.$set(svc, 'test', { ok: false, text: (mapped && mapped !== key ? mapped : e.message) || t('settings.ai.testFail') });
      } finally {
        this.$set(svc, 'testing', false);
      }
    },
    aiPayload() {
      const temp = Number(this.ai.temperature);
      return {
        enabled: !!this.ai.enabled,
        permission: this.ai.permission,
        readScreen: !!this.ai.readScreen,
        ptyControl: !!this.ai.ptyControl,
        commandTimeoutSec: Number(this.ai.commandTimeoutSec) || AI_DEFAULTS.commandTimeoutSec,
        maxTurns: Number(this.ai.maxTurns) || AI_DEFAULTS.maxTurns,
        maxTokens: Number(this.ai.maxTokens) || AI_DEFAULTS.maxTokens,
        temperature: Number.isFinite(temp) ? temp : AI_DEFAULTS.temperature,
        services: this.ai.services.map(cleanService),
        defaultRef: this.ai.defaultRef || null,
      };
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
              ai: this.aiPayload(),
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
.settings-layout {
  display: flex;
  align-items: stretch;
  min-height: 380px;
}
.settings-nav {
  flex: none;
  width: 148px;
  padding-right: 10px;
  border-right: 1px solid var(--border);
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  margin-bottom: 4px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.nav-item:hover {
  background: var(--bg-hover);
}
.nav-item.on {
  background: var(--bg-hover);
  color: var(--accent);
  font-weight: 600;
}
.settings-body {
  flex: 1;
  min-width: 0;
  padding-left: 20px;
  max-height: 62vh;
  overflow-y: auto;
}
.settings-body::-webkit-scrollbar {
  width: 6px;
}
.settings-body::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}
.settings-body::-webkit-scrollbar-thumb:hover {
  background: var(--text-3);
}
.settings-body::-webkit-scrollbar-track {
  background: transparent;
}
.set-section {
  margin-bottom: 4px;
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
.mono { font-family: Consolas, "Courier New", monospace; }
.svc-list { display: flex; flex-direction: column; gap: 10px; }
.svc-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.svc-card.def { border-color: var(--accent); }
.svc-top { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.svc-name { max-width: 150px; flex: none; }
.svc-tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); white-space: nowrap; }
.svc-tag.ok { background: rgba(103, 194, 58, 0.16); color: var(--success); }
.svc-tag.bad { background: rgba(245, 108, 108, 0.16); color: var(--danger); }
.svc-ops { margin-left: auto; display: flex; align-items: center; }
.svc-ops .el-button + .el-button { margin-left: 8px; }
.svc-del { color: var(--text-3); }
.svc-del:hover { color: var(--danger); }
.svc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
.svc-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.svc-field > span { font-size: 11px; color: var(--text-3); }
.svc-models { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border); }
.svc-models-head { font-size: 11px; color: var(--text-3); margin-bottom: 2px; }
.model-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 2px 0; }
.model-id { color: var(--text); max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-alias { color: var(--text-2); font-size: 11.5px; }
.model-empty { font-size: 11.5px; color: var(--text-3); padding: 2px 0 4px; }
.model-add { display: flex; gap: 6px; margin-top: 6px; }
.model-add .el-input { flex: 1; }
.el-radio-group .el-radio { display: block; margin-right: 0; line-height: 1.9; }
.el-radio-group .el-radio i.el-icon-info { color: var(--text-3); cursor: help; }
.el-radio-group .el-radio i.el-icon-info:hover { color: var(--accent); }
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
