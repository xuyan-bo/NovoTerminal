<template>
  <el-dialog
    :title="$t('settings.title')"
    :visible.sync="visible"
    width="1120px"
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
          label-width="150px"
          size="small"
          @submit.native.prevent
        >
        <div v-show="activeMenu === 'general'" class="set-section">
          <el-form-item :label="$t('settings.homeWelcome')">
            <el-switch v-model="form.homeWelcome" />
          </el-form-item>
          <el-form-item :label="$t('settings.autoUpdateCheck')">
            <el-switch v-model="form.autoUpdateCheck" />
          </el-form-item>
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
          </el-form-item>
          <el-form-item :label="$t('settings.zoom')">
            <div class="zoom-row">
              <el-slider v-model="form.zoom" :min="50" :max="200" :step="10" />
              <span class="zoom-val">{{ form.zoom }}%</span>
            </div>
          </el-form-item>
          <el-form-item :label="$t('settings.font')">
            <el-select v-model="form.font" style="width: 100%; max-width: 240px" @change="onFont">
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
          <el-form-item>
            <template slot="label">
              {{ $t('settings.recentLimit') }}
              <el-tooltip :content="$t('settings.recentLimitTip')" placement="top">
                <i class="el-icon-info"></i>
              </el-tooltip>
            </template>
            <el-input-number
              v-model="form.recentLimit"
              size="mini"
              :min="1"
              :max="RECENT_LIMIT_MAX"
              :step="1"
            />
          </el-form-item>
          <el-form-item>
            <template slot="label">
              {{ $t('settings.logTotal') }}
              <el-tooltip :content="$t('settings.logTotalTip')" placement="top">
                <i class="el-icon-info"></i>
              </el-tooltip>
            </template>
            <el-input-number
              v-model="form.logTotalMb"
              size="mini"
              :min="LOG_TOTAL_MIN_MB"
              :max="LOG_TOTAL_MAX_MB"
              :step="5"
            />
          </el-form-item>
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
            <el-button size="mini" icon="el-icon-download" @click="openBackup('export')">{{ $t('settings.exportCfg') }}</el-button>
            <el-button size="mini" icon="el-icon-upload2" @click="openBackup('import')">{{ $t('settings.importCfg') }}</el-button>
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
              {{ $t('settings.ai.permission') }}
              <el-tooltip :content="$t('settings.ai.permissionTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-radio-group :value="ai.permission" @input="setAiPermission">
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
              {{ $t('settings.ai.temperature') }}
              <el-tooltip :content="$t('settings.ai.temperatureTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-input-number v-model="ai.temperature" size="mini" :min="AI_LIMITS.temperature[0]" :max="AI_LIMITS.temperature[1]" :step="0.1" :precision="1" />
          </el-form-item>
          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.timeout') }}
              <el-tooltip :content="$t('settings.ai.timeoutTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-input-number v-model="ai.commandTimeoutSec" size="mini" :min="AI_LIMITS.commandTimeoutSec[0]" :max="AI_LIMITS.commandTimeoutSec[1]" :step="10" />
          </el-form-item>
          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.turns') }}
              <el-tooltip :content="$t('settings.ai.turnsTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <el-input-number v-model="ai.maxTurns" size="mini" :min="AI_LIMITS.maxTurns[0]" :max="AI_LIMITS.maxTurns[1]" />
          </el-form-item>

          <el-form-item>
            <template slot="label">
              {{ $t('settings.ai.services') }}
              <el-tooltip :content="$t('settings.ai.servicesTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
            </template>
            <div class="svc-list">
              <div v-for="(svc, i) in ai.services" :key="svc.id" class="svc-card">
                <div class="svc-top">
                  <el-input v-model="svc.name" size="mini" class="svc-name" maxlength="60" :placeholder="$t('settings.ai.serviceName')" />
                  <el-tooltip v-if="svc.test" :content="svc.test.text" placement="top">
                    <span class="svc-tag" :class="svc.test.ok ? 'ok' : 'bad'">{{ svc.test.text }}</span>
                  </el-tooltip>
                  <span class="svc-ops">
                    <el-button size="mini" type="text" :loading="!!svc.testing" @click="testService(svc)">
                      {{ $t('settings.ai.test') }}
                    </el-button>
                    <el-popconfirm
                      placement="top-end"
                      :title="$t('settings.ai.deleteServiceConfirm', { name: svc.name || svc.baseUrl || '—' })"
                      :confirm-button-text="$t('settings.ai.confirm')"
                      :cancel-button-text="$t('settings.cancel')"
                      @confirm="removeService(i)"
                    >
                      <el-button slot="reference" size="mini" type="text" class="svc-del">{{ $t('settings.ai.deleteService') }}</el-button>
                    </el-popconfirm>
                  </span>
                </div>
                <div class="svc-grid">
                  <label class="svc-field">
                    <span>{{ $t('settings.ai.baseUrl') }}</span>
                    <el-input v-model="svc.baseUrl" size="mini" class="mono" maxlength="300" placeholder="https://api.example.com/v1" />
                    <span v-if="isInsecureUrl(svc.baseUrl)" class="svc-warn">{{ $t('settings.ai.baseUrlInsecure') }}</span>
                  </label>
                  <label class="svc-field">
                    <span>{{ $t('settings.ai.apiKey') }}</span>
                    <el-input v-model="svc.apiKey" size="mini" class="mono" maxlength="400" autocomplete="off"
                              :type="svc._keyVisible ? 'text' : 'password'" clearable>
                      <button
                        slot="append"
                        type="button"
                        class="svc-key-reveal"
                        :disabled="svc._keyChecking"
                        :title="svc._keyChecking ? $t('auth.verifying') : (svc._keyVisible ? $t('auth.hidePass') : $t('auth.revealPass'))"
                        @click="onToggleKeyVisible(svc)"
                      >
                        <svg v-if="svc._keyChecking" class="spin-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="28 28"/></svg>
                        <img v-else-if="!svc._keyVisible" :src="'icons/eye-open.svg'" alt="" width="18" height="18" aria-hidden="true">
                        <img v-else :src="'icons/eye-closed.svg'" alt="" width="18" height="18" aria-hidden="true">
                      </button>
                    </el-input>
                  </label>
                </div>
                <div class="svc-models">
                  <div class="svc-models-head">
                    {{ $t('settings.ai.models') }}
                    <el-tooltip :content="$t('settings.ai.modelsTip')" placement="top"><i class="el-icon-info"></i></el-tooltip>
                    <el-button
                      class="head-plus"
                      size="mini"
                      type="text"
                      icon="el-icon-plus"
                      :loading="!!svc.picking"
                      :title="$t('settings.ai.pickModels')"
                      @click="openModelPicker(svc)"
                    />
                  </div>
                  <div class="model-cols">
                    <span></span>
                    <span>{{ $t('settings.ai.colId') }}</span>
                    <span>{{ $t('settings.ai.colAlias') }}</span>
                    <span>{{ $t('settings.ai.colContext') }}</span>
                    <span>{{ $t('settings.ai.colOps') }}</span>
                  </div>
                  <div
                    v-for="(m, j) in svc.models"
                    :key="svc.id + '-' + m.id"
                    class="model-row"
                    :class="{
                      'is-dragging': modelDrag.svcId === svc.id && modelDrag.from === j,
                      'drop-before': modelDropEdge(svc, j) === 'before',
                      'drop-after': modelDropEdge(svc, j) === 'after'
                    }"
                    @dragover="onModelDragOver($event, svc, j)"
                    @drop="onModelDrop($event, svc)"
                  >
                    <i
                      class="model-handle el-icon-rank"
                      draggable="true"
                      @dragstart="onModelDragStart($event, svc, j)"
                      @dragend="endModelDrag"
                    ></i>
                    <span class="model-id mono" :title="m.id">{{ m.id }}</span>
                    <template v-if="editing[svc.id + '#' + m.id]">
                      <el-input
                        v-model="editing[svc.id + '#' + m.id].alias"
                        size="mini"
                        class="model-alias-input"
                        maxlength="60"
                        :placeholder="m.id"
                        @keyup.enter.native="commitModelEdit(svc, m)"
                      />
                      <el-input-number
                        v-model="editing[svc.id + '#' + m.id].contextK"
                        size="mini"
                        class="model-ctx-input"
                        :min="AI_LIMITS.contextK[0]"
                        :max="AI_LIMITS.contextK[1]"
                        :step="8"
                        controls-position="right"
                        @keyup.enter.native="commitModelEdit(svc, m)"
                      />
                    </template>
                    <template v-else>
                      <span class="model-alias" :title="m.alias || m.id">{{ m.alias || m.id }}</span>
                      <span class="model-ctx mono">{{ ctxText(m) }}</span>
                    </template>
                    <span class="model-ops">
                      <el-tooltip
                        :content="$t(isDefaultModel(svc, m) ? 'settings.ai.unsetDefaultModel' : 'settings.ai.setDefaultModel')"
                        placement="top"
                      >
                        <i
                          class="model-star"
                          :class="isDefaultModel(svc, m) ? 'el-icon-star-on on' : 'el-icon-star-off'"
                          @click="toggleDefaultModel(svc, m)"
                        ></i>
                      </el-tooltip>
                      <el-button
                        v-if="editing[svc.id + '#' + m.id]"
                        size="mini"
                        type="text"
                        @click="commitModelEdit(svc, m)"
                      >{{ $t('settings.ai.confirm') }}</el-button>
                      <el-button v-else size="mini" type="text" @click="startModelEdit(svc, m)">{{ $t('settings.ai.editAlias') }}</el-button>
                      <el-button
                        v-if="editing[svc.id + '#' + m.id]"
                        size="mini"
                        type="text"
                        @click="cancelModelEdit(svc, m)"
                      >{{ $t('settings.cancel') }}</el-button>
                      <el-popconfirm
                        v-else
                        placement="top-end"
                        :title="$t('settings.ai.deleteModelConfirm', { id: m.id })"
                        :confirm-button-text="$t('settings.ai.confirm')"
                        :cancel-button-text="$t('settings.cancel')"
                        @confirm="removeModel(svc, j)"
                      >
                        <el-button slot="reference" size="mini" type="text" class="svc-del">
                          {{ $t('settings.ai.deleteModel') }}
                        </el-button>
                      </el-popconfirm>
                    </span>
                  </div>
                  <div v-if="!svc.models.length" class="model-empty">{{ $t('settings.ai.modelsEmpty') }}</div>
                  <div v-if="manual[svc.id]" class="model-row model-add">
                    <span></span>
                    <el-input v-model="draft[svc.id].id" size="mini" class="mono" maxlength="120" :placeholder="$t('settings.ai.modelId')" @input="onDraftId(svc)" @keyup.enter.native="addModel(svc)" />
                    <el-input v-model="draft[svc.id].alias" size="mini" maxlength="60" :placeholder="$t('settings.ai.modelAlias')" @keyup.enter.native="addModel(svc)" />
                    <el-input-number
                      v-model="draft[svc.id].contextK"
                      size="mini"
                      class="add-ctx"
                      :min="AI_LIMITS.contextK[0]"
                      :max="AI_LIMITS.contextK[1]"
                      :step="8"
                      controls-position="right"
                      @change="markCtxTouched(svc)"
                      @keyup.enter.native="addModel(svc)"
                    />
                    <span class="model-ops">
                      <el-button size="mini" @click="addModel(svc)">{{ $t('settings.ai.addModel') }}</el-button>
                      <el-button size="mini" type="text" @click="closeManual(svc)">{{ $t('settings.cancel') }}</el-button>
                    </span>
                  </div>
                  <el-button v-else size="mini" type="text" icon="el-icon-plus" @click="openManual(svc)">
                    {{ $t('settings.ai.manualAdd') }}
                  </el-button>
                </div>
              </div>
              <el-button size="mini" icon="el-icon-plus" @click="addService">{{ $t('settings.ai.addService') }}</el-button>
            </div>
          </el-form-item>
        </div>

        <div v-show="activeMenu === 'about'" class="set-section">
          <div class="about-hero">
            <div class="about-logo">
              <img src="../../assets/logo.svg" alt="Logo" width="30" height="30" />
            </div>
            <div class="about-title">
              NovoTerminal<span class="about-ver">v{{ appVersion }}</span>
            </div>
            <div class="about-desc">{{ $t('settings.aboutDesc') }}</div>
          </div>

          <div class="about-card">
            <div class="about-card-title">{{ $t('settings.aboutInfoTitle') }}</div>
            <dl class="about-info">
              <dt>{{ $t('settings.aboutVersion') }}</dt>
              <dd><span class="about-badge">v{{ appVersion }}</span></dd>
              <dt>{{ $t('settings.aboutLicense') }}</dt>
              <dd>Apache-2.0 License</dd>
              <dt>{{ $t('settings.aboutSource') }}</dt>
              <dd>
                <a class="about-link" @click="openUrl(githubUrl)">
                  <img class="brand brand-github" :src="'icons/github.svg'" alt="" />GitHub
                </a>
                <span class="about-sep">·</span>
                <a class="about-link" @click="openUrl(repoUrl)">
                  <img class="brand" :src="'icons/gitee.svg'" alt="" />Gitee
                </a>
              </dd>
            </dl>
          </div>

          <div class="about-card">
            <div class="about-card-title">{{ $t('settings.aboutStackTitle') }}</div>
            <dl class="about-info">
              <dt>{{ $t('settings.aboutRuntime') }}</dt>
              <dd>Electron · Node.js</dd>
              <dt>{{ $t('settings.aboutFrontend') }}</dt>
              <dd>Vue · Element UI</dd>
              <dt>{{ $t('settings.aboutBuild') }}</dt>
              <dd>Vite</dd>
              <dt>{{ $t('settings.aboutSsh') }}</dt>
              <dd>xterm.js · ssh2</dd>
              <dt>{{ $t('settings.aboutRdp') }}</dt>
              <dd>IronRDP (WASM)</dd>
              <dt>{{ $t('settings.aboutVnc') }}</dt>
              <dd>noVNC</dd>
            </dl>
          </div>

          <div class="about-actions">
            <el-button size="small" icon="el-icon-refresh" :loading="checkingUpdate" @click="checkUpdate">
              {{ $t('settings.aboutCheckUpdate') }}
            </el-button>
            <el-popover v-model="releasePopover" placement="top" width="160" trigger="click">
              <div class="release-picks">
                <button
                  v-if="githubReleasesUrl"
                  type="button"
                  class="release-pick"
                  @click="goRelease(githubReleasesUrl)"
                >
                  <img class="brand brand-github" :src="'icons/github.svg'" alt="" />GitHub
                </button>
                <button type="button" class="release-pick" @click="goRelease(releasesUrl)">
                  <img class="brand" :src="'icons/gitee.svg'" alt="" />Gitee
                </button>
              </div>
              <el-button slot="reference" size="small" type="primary" icon="el-icon-upload2">
                {{ $t('settings.aboutReleases') }}
              </el-button>
            </el-popover>
          </div>

          <div class="about-footer">
            © {{ new Date().getFullYear() }} NovoTerminal
          </div>
        </div>
        </el-form>
      </div>
    </div>

    <el-dialog
      :title="$t('settings.ai.pickModels')"
      :visible.sync="picker.visible"
      width="620px"
      append-to-body
      :close-on-click-modal="false"
    >
      <div class="pick-head">
        <el-input
          v-model="picker.filter"
          size="mini"
          :placeholder="$t('settings.ai.pickFilter')"
          clearable
        />
      </div>
      <div v-if="picker.loading" class="pick-state"><i class="el-icon-loading"></i> {{ $t('settings.ai.pickLoading') }}</div>
      <div v-else-if="picker.error" class="pick-state bad">{{ picker.error }}</div>
      <div v-else class="pick-list">
        <div class="pick-row is-head">
          <span></span>
          <span>{{ $t('settings.ai.colId') }}</span>
          <span class="is-alias">{{ $t('settings.ai.colAlias') }}</span>
          <span class="is-ctx">{{ $t('settings.ai.colContext') }}</span>
        </div>
        <div v-for="row in filteredPickRows" :key="row.id" class="pick-row" :class="{ added: row.added }">
          <el-checkbox v-model="row.picked" :disabled="row.added" />
          <span class="pick-cell">
            <span class="pick-id mono" :title="row.id">{{ row.id }}</span>
            <span v-if="row.added" class="pick-added">{{ $t('settings.ai.pickAdded') }}</span>
          </span>
          <el-input v-model="row.alias" size="mini" maxlength="60" :placeholder="row.id" :disabled="row.added" />
          <el-input-number
            v-model="row.contextK"
            size="mini"
            class="pick-ctx"
            :min="AI_LIMITS.contextK[0]"
            :max="AI_LIMITS.contextK[1]"
            :step="8"
            controls-position="right"
            :disabled="row.added"
            @keyup.enter.native="confirmPick"
          />
        </div>
        <div v-if="!filteredPickRows.length" class="pick-state">{{ $t('settings.ai.pickEmpty') }}</div>
      </div>
      <template #footer>
        <el-button size="mini" @click="picker.visible = false">{{ $t('settings.cancel') }}</el-button>
        <el-button size="mini" type="primary" :disabled="!pickedCount" @click="confirmPick">
          {{ $t('settings.ai.pickConfirm') }}{{ pickedCount ? ' (' + pickedCount + ')' : '' }}
        </el-button>
      </template>
    </el-dialog>

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
import { store, api, unwrap, refresh, checkForUpdates } from '../../store';
import { applyTheme, applyFont, setLocale, t } from '../../i18n';
import {
  UI_FONTS,
  AI_PERMISSIONS,
  AI_DEFAULTS,
  AI_LIMITS,
  AI_CONTEXT_DEFAULT_K,
  AI_CONTEXT_PRESETS,
  RECENT_LIMIT_DEFAULT,
  RECENT_LIMIT_MAX,
  LOG_TOTAL_DEFAULT_MB,
  LOG_TOTAL_MIN_MB,
  LOG_TOTAL_MAX_MB,
} from '../../constants';
import locale from 'element-ui/lib/locale';
import zhLocale from 'element-ui/lib/locale/lang/zh-CN';
import enLocale from 'element-ui/lib/locale/lang/en';

/** 上下文窗口：界面按 k token 输入（1k = 1000 token），落盘仍是 token。 */
const K_UNIT = 1000;
const MODEL_DRAG_TYPE = 'application/x-novoterminal-model';
const clampK = (n) => Math.min(AI_LIMITS.contextK[1], Math.max(AI_LIMITS.contextK[0], n));

/** 模型 ID 对应的窗口初值（k token）：只在新增、拉取和旧记录缺字段时预填，保存后以设置值为准。 */
function presetContextK(id) {
  const key = String(id || '').toLowerCase();
  const hit = AI_CONTEXT_PRESETS.find(([prefix]) => key.startsWith(prefix));
  return clampK(hit ? hit[1] : AI_CONTEXT_DEFAULT_K);
}

/** 存的始终是 token，界面按 k 输入：把任何来源都收敛成一个可显示的 k 值。 */
function contextK(tokens, id) {
  const n = Math.round(Number(tokens));
  return n > 0 ? clampK(Math.round(n / K_UNIT)) : presetContextK(id);
}

/** 输入框里的 k 值 → token：越界夹住，清空视为未填并按模型 ID 的预置兜底。 */
function toTokens(k, id) {
  const n = Math.round(Number(k));
  return (n > 0 ? clampK(n) : presetContextK(id)) * K_UNIT;
}

/** 手输新增那行的草稿：窗口先给默认值，模型 ID 变化时再按预置刷新。 */
const newModelDraft = () => ({ id: '', alias: '', contextK: AI_CONTEXT_DEFAULT_K });

/** 服务与模型的临时字段（测试状态、新增草稿）不进持久化对象；窗口一律落成明确的 token 数。 */
function cleanModel(m) {
  return { id: m.id, alias: m.alias || m.id, contextTokens: contextK(m.contextTokens, m.id) * K_UNIT };
}

function cleanService(svc) {
  return { id: svc.id, name: String(svc.name || '').trim(), baseUrl: String(svc.baseUrl || '').trim(), apiKey: String(svc.apiKey || ''), models: (svc.models || []).map(cleanModel) };
}

/** 手输的模型 ID：非空、不含空白、长度受主进程 normalize 的 120 上限约束。 */
const MODEL_ID_RE = /^[^\s]{1,120}$/;

/** 什么都没填的服务商是误点「添加」留下的，保存时直接丢掉，不该拦住整次保存。 */
function isEmptyService(svc) {
  return !String(svc.name || '').trim() && !String(svc.baseUrl || '').trim()
    && !String(svc.apiKey || '').trim() && !(svc.models || []).length;
}

export default {
  name: 'SettingsDialog',
  data() {
    return {
      saving: false,
      browsing: false,
      checkingUpdate: false,
      repoUrl: import.meta.env.VITE_HOMEPAGE,
      githubUrl: import.meta.env.VITE_GITHUB_HOMEPAGE,
      releasesUrl: import.meta.env.VITE_HOMEPAGE + '/releases',
      githubReleasesUrl: import.meta.env.VITE_GITHUB_HOMEPAGE
        ? import.meta.env.VITE_GITHUB_HOMEPAGE + '/releases'
        : '',
      releasePopover: false,
      activeMenu: 'general',
      appVersion: import.meta.env.VITE_APP_VERSION || '0.1.0',
      newSvcIds: new Set(),
      permissions: AI_PERMISSIONS,
      AI_LIMITS,
      RECENT_LIMIT_MAX,
      LOG_TOTAL_MIN_MB,
      LOG_TOTAL_MAX_MB,
      draft: {},
      manual: {},
      editing: {},
      /** 手输模型时是否改过窗口：没改过就跟着模型 ID 刷新预填值。 */
      ctxTouched: {},
      /** 模型行拖动排序：svcId + from 标记被拖行，to 是插入位置（0 ~ length），-1 表示未在拖。 */
      modelDrag: { svcId: '', from: -1, to: -1 },
      picker: { visible: false, service: null, loading: false, error: '', filter: '', rows: [] },
      ai: { ...AI_DEFAULTS, services: [], defaultRef: null },
      sections: [
        { id: 'general', icon: 'el-icon-setting' },
        { id: 'data', icon: 'el-icon-folder' },
        { id: 'ai', icon: '', svg: 'ai' },
        { id: 'about', icon: 'el-icon-info' },
      ],
      themes: [{ id: 'dark' }, { id: 'light' }, { id: 'system' }],
      fonts: UI_FONTS,
      form: {
        theme: 'system',
        lang: 'zh',
        dataPath: '',
        zoom: 100,
        font: 'default',
        closeAction: 'ask',
        homeWelcome: true,
        autoUpdateCheck: true,
        recentLimit: RECENT_LIMIT_DEFAULT,
        logTotalMb: LOG_TOTAL_DEFAULT_MB,
      },
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
        if (!v) {
          this.picker.visible = false;
          // 没保存就不该留下预览效果：按已落盘的设置重新应用一遍（保存路径里 snapshot 已刷新，等于保持新外观）
          this.applyAppearance((store.snapshot && store.snapshot.settings) || {});
          if (this.$refs.form) this.$nextTick(() => this.$refs.form.clearValidate());
        }
      },
    },
    themeLabel() {
      return this.$t('settings.theme.' + this.form.theme);
    },
    /** 弹窗里的模型行，按用户输入的关键词过滤模型 ID。 */
    filteredPickRows() {
      const kw = String(this.picker.filter || '').trim().toLowerCase();
      return kw ? this.picker.rows.filter((r) => r.id.toLowerCase().includes(kw)) : this.picker.rows;
    },
    pickedCount() {
      return this.picker.rows.filter((r) => r.picked && !r.added).length;
    },
    /** 备份弹窗开着时设置表单会停在旧值；备份关掉后按最新设置重载，避免用户随手保存又覆盖回去。 */
    backupMode() {
      return store.backupDialog;
    },
  },
  watch: {
    visible(v) {
      if (v) {
        this.activeMenu = 'general';
        this.load();
      }
    },
    backupMode(v) {
      if (!v && this.visible) this.load();
    },
  },
  methods: {
    // 最近连接数量始终落在 1–100，与主进程 recentCap 的收敛一致
    clampedRecentLimit(v) {
      return Math.min(RECENT_LIMIT_MAX, Math.max(1, Number(v) || RECENT_LIMIT_DEFAULT));
    },
    // 日志总量以 MB 表示，主进程按 5MB 单文件折算保留份数
    clampedLogTotalMb(v) {
      return Math.min(LOG_TOTAL_MAX_MB, Math.max(LOG_TOTAL_MIN_MB, Math.floor(Number(v)) || LOG_TOTAL_DEFAULT_MB));
    },
    openUrl(url) {
      if (window.novoTerminal && window.novoTerminal.openExternal) {
        window.novoTerminal.openExternal(url);
      }
    },
    goRelease(url) {
      this.releasePopover = false;
      this.openUrl(url);
    },
    /** 手动检查必须给结果；有新版本时弹窗已由 store 打开，这里只补「没有更新」「还没有发行版」两种反馈。 */
    async checkUpdate() {
      this.checkingUpdate = true;
      try {
        const r = await checkForUpdates();
        if (r.hasUpdate) return;
        if (r.reason === 'no_release') this.$message.info(t('update.noRelease'));
        else this.$message.success(t('update.latest', { version: r.current }));
      } catch (e) {
        // 具体失败原因（哪一路、HTTP 状态）已经落在运行日志里，界面只给可操作的通用提示
        this.$message.error(t('update.checkFailed'));
      } finally {
        this.checkingUpdate = false;
      }
    },
    /** 「完全访问」跳过所有审批，与面板内切换共用同一条风险确认；取消就不改级别。 */
    setAiPermission(id) {
      if (id !== 'full' || this.ai.permission === 'full') {
        this.ai.permission = id;
        return;
      }
      this.$confirm(t('ai.fullWarn'), t('ai.fullTitle'), {
        confirmButtonText: t('ai.fullOk'),
        cancelButtonText: t('msg.cancel'),
        type: 'warning',
      }).then(() => { this.ai.permission = 'full'; }).catch(() => {});
    },
    async load() {
      this.newSvcIds = new Set();
      const s = (await api.getSettings()) || store.snapshot.settings || {};
      this.form = {
        theme: s.theme || 'system',
        lang: s.lang || 'zh',
        dataPath: s.dataPath || '',
        zoom: Math.min(200, Math.max(50, Number(s.zoom) || 100)),
        font: s.font || 'default',
        closeAction: s.closeAction || 'ask',
        homeWelcome: s.homeWelcome !== false,
        autoUpdateCheck: s.autoUpdateCheck !== false,
        recentLimit: this.clampedRecentLimit(s.recentLimit),
        logTotalMb: this.clampedLogTotalMb(s.logTotalMb),
      };
      const ai = s.ai || {};
      const services = (Array.isArray(ai.services) ? ai.services : []).map(cleanService);
      const ref = ai.defaultRef;
      const refOk = !!(ref && services.some((sv) => sv.id === ref.serviceId && sv.models.some((m) => m.id === ref.modelId)));
      this.manual = {};
      this.editing = {};
      this.picker = { visible: false, service: null, loading: false, error: '', filter: '', rows: [] };
      this.ai = {
        ...AI_DEFAULTS,
        ...ai,
        permission: AI_PERMISSIONS.some((p) => p.id === ai.permission) ? ai.permission : AI_DEFAULTS.permission,
        services,
        defaultRef: refOk ? { serviceId: ref.serviceId, modelId: ref.modelId } : null,
      };
      this.ensureDrafts();
      this.applyAppearance(this.form);
      this.$nextTick(() => {
        if (this.$refs.form) this.$refs.form.clearValidate();
      });
    },
    /** 主题、字体、语言是「先预览、保存才落盘」，所以生效与回退都走同一条路径。 */
    applyAppearance(s) {
      const lang = s.lang || 'zh';
      applyTheme(s.theme || 'system');
      applyFont(s.font || 'default');
      setLocale(lang);
      locale.use(lang === 'en' ? enLocale : zhLocale);
      store.localeTick++;
    },
    onFont(id) {
      this.applyAppearance(this.form);
    },
    onTheme(id) {
      this.form.theme = id;
      this.applyAppearance(this.form);
      if (this.$refs.form) this.$refs.form.validateField('theme');
    },
    onLang(lang) {
      this.form.lang = lang;
      this.applyAppearance(this.form);
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
        if (!this.draft[svc.id]) this.$set(this.draft, svc.id, newModelDraft());
      }
    },
    addService() {
      const id = 'svc-' + crypto.randomUUID();
      this.ai.services = [...this.ai.services, { id, name: '', baseUrl: '', apiKey: '', models: [] }];
      this.$set(this.draft, id, newModelDraft());
      this.newSvcIds.add(id);
    },
    async onToggleKeyVisible(svc) {
      if (svc._keyChecking) return;
      if (svc._keyVisible) {
        this.$set(svc, '_keyVisible', false);
        return;
      }
      if (!String(svc.apiKey || '').trim() || this.newSvcIds.has(svc.id)) {
        this.$set(svc, '_keyVisible', true);
        return;
      }
      if (!api.verifySystemAuth) {
        this.$message.error(t('auth.needElectron'));
        return;
      }
      this.$set(svc, '_keyChecking', true);
      try {
        const r = unwrap(await api.verifySystemAuth(t('auth.viewKeyReason')));
        if (r && r.ok) {
          this.$set(svc, '_keyVisible', true);
        } else {
          const code = (r && r.code) || '';
          let msg = t('auth.failed');
          if (/Canceled|UserCanceled/i.test(code)) msg = t('auth.canceled');
          else if (/NotConfigured/i.test(code)) msg = t('auth.notConfigured');
          else if (r && r.message) msg = r.message;
          this.$message.error(msg);
        }
      } catch (e) {
        const code = e.code || '';
        let msg = e.message || t('auth.failed');
        if (/Canceled|UserCanceled/i.test(code)) msg = t('auth.canceled');
        else if (/NotConfigured/i.test(code)) msg = t('auth.notConfigured');
        this.$message.error(msg);
      } finally {
        this.$set(svc, '_keyChecking', false);
      }
    },
    removeService(i) {
      const [gone] = this.ai.services.splice(i, 1);
      if (!gone) return;
      this.$delete(this.draft, gone.id);
      this.$delete(this.manual, gone.id);
      if (this.ai.defaultRef && this.ai.defaultRef.serviceId === gone.id) this.ai.defaultRef = null;
      if (this.picker.service && this.picker.service.id === gone.id) this.picker.visible = false;
    },
    isDefaultModel(svc, model) {
      const ref = this.ai.defaultRef;
      return !!(ref && ref.serviceId === svc.id && ref.modelId === model.id);
    },
    /** 默认只由模型行的星标切换，新增模型时不提供默认选项。 */
    toggleDefaultModel(svc, model) {
      this.ai.defaultRef = this.isDefaultModel(svc, model) ? null : { serviceId: svc.id, modelId: model.id };
    },
    openManual(svc) {
      if (!this.draft[svc.id]) this.$set(this.draft, svc.id, newModelDraft());
      this.$set(this.manual, svc.id, true);
    },
    closeManual(svc) {
      this.$set(this.draft, svc.id, newModelDraft());
      this.$set(this.ctxTouched, svc.id, false);
      this.$set(this.manual, svc.id, false);
    },
    startModelEdit(svc, model) {
      this.$set(this.editing, svc.id + '#' + model.id, {
        alias: model.alias || model.id,
        contextK: contextK(model.contextTokens, model.id),
      });
    },
    cancelModelEdit(svc, model) {
      this.$delete(this.editing, svc.id + '#' + model.id);
    },
    /** 一次编辑同时收别名与上下文窗口，避免模型行堆两对按钮。 */
    applyModelEdit(model, box) {
      model.alias = String(box.alias || '').trim() || model.id;
      this.$set(model, 'contextTokens', toTokens(box.contextK, model.id));
    },
    commitModelEdit(svc, model) {
      const box = this.editing[svc.id + '#' + model.id];
      if (box) this.applyModelEdit(model, box);
      this.cancelModelEdit(svc, model);
    },
    /** 只读态直接显示生效的窗口数字，单位 k token。 */
    ctxText(m) {
      return contextK(m.contextTokens, m.id) + 'k';
    },
    /** 手输模型 ID 时跟着刷新窗口初值，用户自己改过就不再覆盖。 */
    onDraftId(svc) {
      const box = this.draft[svc.id];
      if (box && !this.ctxTouched[svc.id]) box.contextK = presetContextK(box.id);
    },
    markCtxTouched(svc) {
      this.$set(this.ctxTouched, svc.id, true);
    },
    removeModel(svc, j) {
      const [gone] = svc.models.splice(j, 1);
      if (!gone) return;
      this.$delete(this.editing, svc.id + '#' + gone.id);
      const ref = this.ai.defaultRef;
      if (ref && ref.serviceId === svc.id && ref.modelId === gone.id) this.ai.defaultRef = null;
    },
    addModel(svc) {
      const box = this.draft[svc.id] || newModelDraft();
      const id = String(box.id || '').trim();
      if (!MODEL_ID_RE.test(id)) {
        this.$message.warning(t('settings.ai.modelIdInvalid'));
        return;
      }
      if (svc.models.some((m) => m.id === id)) {
        this.$message.warning(t('settings.ai.modelExists'));
        return;
      }
      svc.models.push({ id, alias: String(box.alias || '').trim() || id, contextTokens: toTokens(box.contextK, id) });
      this.closeManual(svc);
    },
    onModelDragStart(event, svc, j) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(MODEL_DRAG_TYPE, svc.id + '#' + j);
      // 整行作为拖拽影像，只有柄可拖，输入框里的选区不受影响
      event.dataTransfer.setDragImage(event.currentTarget.parentNode, 12, 10);
      this.modelDrag = { svcId: svc.id, from: j, to: -1 };
    },
    onModelDragOver(event, svc, j) {
      const d = this.modelDrag;
      if (d.from < 0 || d.svcId !== svc.id || !this.isModelDragPayload(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = event.currentTarget.getBoundingClientRect();
      d.to = event.clientY - rect.top < rect.height / 2 ? j : j + 1;
    },
    onModelDrop(event, svc) {
      const d = this.modelDrag;
      if (d.from < 0 || d.to < 0 || d.svcId !== svc.id || !this.isModelDragPayload(event)) return;
      event.preventDefault();
      const target = d.to > d.from ? d.to - 1 : d.to;
      if (target !== d.from) {
        const list = svc.models;
        list.splice(target, 0, list.splice(d.from, 1)[0]);
      }
      this.endModelDrag();
    },
    endModelDrag() {
      this.modelDrag = { svcId: '', from: -1, to: -1 };
    },
    /** 落在被拖行自身或其原位相邻侧时不画插入线。 */
    modelDropEdge(svc, j) {
      const d = this.modelDrag;
      if (d.from < 0 || d.to < 0 || d.svcId !== svc.id) return '';
      if (d.to === j && j !== d.from) return 'before';
      if (d.to === j + 1 && j + 1 !== d.from) return 'after';
      return '';
    },
    isModelDragPayload(event) {
      const types = event.dataTransfer && event.dataTransfer.types;
      return !!types && Array.from(types).includes(MODEL_DRAG_TYPE);
    },
    /** 点「模型」旁的加号：拉服务商的 /models，勾选后按行写别名。 */
    async openModelPicker(svc) {
      if (!api.aiModels) {
        this.$message.warning(t('msg.needElectron'));
        return;
      }
      if (!String(svc.baseUrl || '').trim() || !String(svc.apiKey || '').trim()) {
        this.$message.warning(t('settings.ai.testIncomplete'));
        return;
      }
      const existing = new Set((svc.models || []).map((m) => m.id));
      this.$set(svc, 'picking', true);
      this.picker = { visible: true, service: svc, loading: true, error: '', filter: '', rows: [] };
      try {
        const r = unwrap(await api.aiModels({ baseUrl: svc.baseUrl, apiKey: svc.apiKey }));
        // 网关回什么 ID 都有可能：含空格或超长的 ID 主进程收不下，别让用户勾一个存不进去的
        this.picker.rows = (r.models || [])
          .filter((id) => MODEL_ID_RE.test(String(id)))
          .map((id) => ({ id, alias: id, contextK: presetContextK(id), added: existing.has(id), picked: false }));
      } catch (e) {
        this.picker.error = this.aiErrorText(e);
      } finally {
        this.picker.loading = false;
        this.$set(svc, 'picking', false);
      }
    },
    confirmPick() {
      const svc = this.picker.service;
      if (!svc) return;
      const chosen = this.picker.rows.filter((r) => r.picked && !r.added);
      if (!chosen.length) {
        this.$message.warning(t('settings.ai.pickNone'));
        return;
      }
      for (const row of chosen) {
        if (svc.models.some((m) => m.id === row.id)) continue;
        svc.models.push({ id: row.id, alias: String(row.alias || '').trim() || row.id, contextTokens: toTokens(row.contextK, row.id) });
      }
      this.picker.visible = false;
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
        this.$set(svc, 'test', { ok: true, text: t('settings.ai.testOk', { ms: r.ms }) });
      } catch (e) {
        this.$set(svc, 'test', { ok: false, text: this.aiErrorText(e) });
      } finally {
        this.$set(svc, 'testing', false);
      }
    },
    /** 主进程错误码优先翻成产品文案，没有对应译文时回退原始 message。 */
    aiErrorText(e) {
      const key = 'err.' + (e && e.code ? e.code : '');
      const mapped = e && e.code ? t(key) : '';
      return (mapped && mapped !== key ? mapped : (e && e.message)) || t('settings.ai.testFail');
    },
    aiPayload() {
      const temp = Number(this.ai.temperature);
      const services = this.ai.services.filter((svc) => !isEmptyService(svc)).map(cleanService);
      const ref = this.ai.defaultRef;
      // 默认模型必须指向仍然存在的模型，删掉服务商后留下的悬空引用在这里断掉
      const refOk = !!(ref && services.some((sv) => sv.id === ref.serviceId && sv.models.some((m) => m.id === ref.modelId)));
      return {
        enabled: !!this.ai.enabled,
        permission: this.ai.permission,
        readScreen: !!this.ai.readScreen,
        commandTimeoutSec: Number(this.ai.commandTimeoutSec) || AI_DEFAULTS.commandTimeoutSec,
        maxTurns: Number(this.ai.maxTurns) || AI_DEFAULTS.maxTurns,
        temperature: Number.isFinite(temp) ? temp : AI_DEFAULTS.temperature,
        services,
        defaultRef: refOk ? { serviceId: ref.serviceId, modelId: ref.modelId } : null,
      };
    },

    /** 备份交给独立弹窗；系统身份验证先于弹窗，未通过则不打开导出/导入弹窗。 */
    async openBackup(mode) {
      if (!api.verifySystemAuth) {
        this.$message.error(t('auth.needElectron'));
        return;
      }
      try {
        const r = unwrap(await api.verifySystemAuth(t(mode === 'import' ? 'auth.importReason' : 'auth.exportReason')));
        if (!r || !r.ok) {
          this.authFriendlyError(r);
          return;
        }
      } catch (e) {
        this.authFriendlyError(e);
        return;
      }
      store.backupDialog = mode;
    },
    /** 身份验证错误码优先翻成产品文案，没有对应译文时回退原始 message。 */
    authFriendlyError(e) {
      const code = (e && e.code) || '';
      const msg = (e && e.message) || '';
      let text;
      if (/Canceled|UserCanceled/i.test(code) || /已取消|Canceled/i.test(msg)) text = t('auth.canceled');
      else if (/NotConfigured/i.test(code) || /未配置身份验证|Hello/i.test(msg)) text = t('auth.notConfigured');
      else text = msg || t('auth.failed');
      this.$message.error(text);
    },
    /** 保存前收尾：编辑框里的别名与窗口就地提交，手输框里残留的模型 ID 必须先生效或清空。 */
    commitPendingAi() {
      for (const svc of this.ai.services) {
        for (const m of svc.models) {
          const box = this.editing[svc.id + '#' + m.id];
          if (box) this.applyModelEdit(m, box);
        }
      }
      this.editing = {};
      const stale = this.ai.services.some((svc) => {
        const box = this.draft[svc.id];
        return !!(box && String(box.id || '').trim());
      });
      if (stale) this.$message.warning(t('settings.ai.pendingModel'));
      return !stale;
    },
    /** 主进程 normalize 会整条丢掉没有 http(s) 前缀的服务，连带它下面的模型一起消失；
     *  不前端拦一下，用户看到的是「保存成功」，重开设置却发现服务没了。 */
    checkAiServices() {
      const bad = this.ai.services.find((svc) => {
        const url = String(svc.baseUrl || '').trim();
        return !isEmptyService(svc) && !/^https?:\/\//i.test(url);
      });
      if (!bad) return true;
      const name = String(bad.name || '').trim();
      this.$message.error(name
        ? t('settings.ai.baseUrlInvalid', { name })
        : t('settings.ai.baseUrlMissing', { name: t('settings.ai.serviceUnnamed') }));
      return false;
    },
    /** 明文 HTTP 不拦（内网网关确实这么部署），但要提醒 Key 和命令内容会被窃听。 */
    isInsecureUrl(url) {
      return /^http:\/\//i.test(String(url || '').trim());
    },
    save() {
      this.$refs.form.validate(async (valid) => {
        if (!valid) return;
        if (!this.commitPendingAi()) return;
        if (!this.checkAiServices()) return;
        this.saving = true;
        try {
          unwrap(
            await api.updateSettings({
              theme: this.form.theme,
              lang: this.form.lang,
              zoom: this.form.zoom,
              font: this.form.font,
              closeAction: this.form.closeAction,
              homeWelcome: !!this.form.homeWelcome,
              autoUpdateCheck: !!this.form.autoUpdateCheck,
              recentLimit: this.clampedRecentLimit(this.form.recentLimit),
              logTotalMb: this.clampedLogTotalMb(this.form.logTotalMb),
              ai: this.aiPayload(),
            })
          );
          await refresh();
          this.applyAppearance(this.form);
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
  height: 62vh;
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
  height: 100%;
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
  max-width: 560px;
}
.path-row .el-input {
  flex: 1;
}
.zoom-row {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 360px;
}
.mono { font-family: Consolas, "Courier New", monospace; }
.svc-list { display: flex; flex-direction: column; gap: 10px; }
.svc-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.svc-top { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.svc-name { max-width: 150px; flex: none; }
.svc-tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; flex: none; }
.svc-tag.ok { background: rgba(103, 194, 58, 0.16); color: var(--success); }
.svc-tag.bad { background: rgba(245, 108, 108, 0.16); color: var(--danger); }
.svc-ops { margin-left: auto; display: flex; align-items: center; flex: none; gap: 6px; }
.svc-del { color: var(--danger); }
.svc-del:hover { color: var(--danger-hover, #f78989); }
.svc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
.svc-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.svc-field > span { font-size: 11px; color: var(--text-3); }
.svc-warn { color: var(--warning); }
.svc-models { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border); }
.svc-models-head { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); margin-bottom: 2px; }
.svc-models-head .el-button.head-plus { padding: 0; height: 18px; font-size: 13px; color: var(--accent); }
/* 模型区与拉取弹框共用列宽：拖拽柄 / ID / 别名 / 上下文 / 操作 */
.model-cols,
.model-row {
  display: grid;
  grid-template-columns: 14px minmax(0, 1.4fr) minmax(0, 1fr) 108px 132px;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.model-cols { padding: 0 0 5px; border-bottom: 1px solid var(--border); font-size: 10.5px; letter-spacing: 0.4px; color: var(--text-3); }
.model-row { position: relative; padding: 3px 0; }
.model-handle { cursor: grab; font-size: 12px; color: var(--text-3); }
.model-handle:hover { color: var(--accent); }
.model-handle:active { cursor: grabbing; }
.model-row.is-dragging { opacity: 0.5; }
.model-row.drop-before::before,
.model-row.drop-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}
.model-row.drop-before::before { top: 0; }
.model-row.drop-after::after { bottom: 0; }
.model-id { color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-alias { color: var(--text-2); font-size: 11.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-alias-input { width: 100%; min-width: 0; }
.model-ctx-input { width: 100%; margin-top: 0; }
.model-ctx-input /deep/ .el-input__inner { text-align: left; font-size: 11.5px; }
.model-ctx {
  justify-self: start;
  min-width: 52px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-2);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}
.model-ops { display: flex; align-items: center; gap: 6px; min-width: 0; }
.model-star { cursor: pointer; font-size: 14px; color: var(--text-3); }
.model-star:hover { color: #e6a23c; }
.model-star.on { color: #f0c040; }
.model-empty { font-size: 11.5px; color: var(--text-3); padding: 2px 0 4px; }
.model-add { margin-top: 4px; }
.model-add .add-ctx { width: 100%; margin-top: 0; }
.model-add .add-ctx /deep/ .el-input__inner { text-align: left; font-size: 11.5px; }
.pick-head { margin-bottom: 8px; }
.pick-list { max-height: 44vh; overflow-y: auto; }
.pick-list::-webkit-scrollbar { width: 6px; }
.pick-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.pick-list::-webkit-scrollbar-thumb:hover { background: var(--text-3); }
.pick-list::-webkit-scrollbar-track { background: transparent; }
/* 与模型列表同一套列宽，只是少了拖拽柄与操作两列 */
.pick-row {
  display: grid;
  grid-template-columns: 14px minmax(0, 1.4fr) minmax(0, 1fr) 108px;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
}
/* 列头与模型列表的 .model-cols 保持同一外观：只有一条下边框，不铺底色 */
.pick-row.is-head {
  padding: 0 0 5px;
  border-bottom: 1px solid var(--border);
  font-size: 10.5px;
  letter-spacing: 0.4px;
  color: var(--text-3);
}
/* 列头左对齐到单元格里的文字：mini 输入框与数字框的文字都内缩 15px（浏览器实测） */
.pick-row.is-head .is-alias { padding-left: 15px; }
.pick-row.is-head .is-ctx { padding-left: 15px; }
.pick-row.added { opacity: 0.55; }
.pick-row /deep/ .el-checkbox { margin-right: 0; }
.pick-ctx { width: 100%; margin-top: 0; }
.pick-ctx /deep/ .el-input__inner { text-align: left; font-size: 11.5px; }
.pick-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pick-id { color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-added { font-size: 10px; color: var(--text-3); flex: none; }
.pick-state { font-size: 12px; color: var(--text-3); padding: 10px 0; }
.pick-state.bad { color: var(--danger); }
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
.about-hero {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 22px 20px;
  text-align: center;
}
.about-logo {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 14px;
}
.about-logo img {
  width: 30px;
  height: 30px;
}
.about-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.3px;
  font-family: Consolas, "JetBrains Mono", monospace;
  color: var(--text);
}
.about-ver {
  font-size: 11px;
  color: var(--text-3);
  margin-left: 6px;
  font-weight: 400;
}
.about-desc {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.6;
}
.about-card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 15px 18px;
  margin-top: 12px;
}
.about-card-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.about-card-title::before {
  content: '';
  width: 3px;
  height: 12px;
  background: var(--accent);
  border-radius: 2px;
}
.about-info {
  display: grid;
  grid-template-columns: 86px 1fr;
  gap: 7px 14px;
  font-size: 12px;
}
.about-info dt {
  color: var(--text-3);
  text-align: right;
  white-space: nowrap;
}
.about-info dd {
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 6px;
}
.about-badge {
  display: inline-block;
  font-size: 10.5px;
  padding: 1.5px 6px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: Consolas, monospace;
}
.about-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
}
.about-link:hover {
  text-decoration: underline;
}
.about-sep {
  display: inline-block;
  margin: 0 6px;
  color: var(--text-3);
}
.about-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-top: 14px;
}
.release-picks {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.release-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.release-pick:hover {
  background: var(--bg-elevated);
}
.brand {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  object-fit: contain;
}
/* GitHub 原色为黑，深色主题反相为白以保证可见；Gitee 保持原红不动 */
.brand-github {
  filter: invert(1);
}
html.theme-light .brand-github {
  filter: none;
}
.about-footer {
  margin-top: 14px;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.7;
}
.svc-key-reveal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 100%;
  padding: 0 6px;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.svc-key-reveal img {
  pointer-events: none;
}
.svc-key-reveal:hover:not(:disabled) {
  color: var(--accent);
}
.svc-key-reveal:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.svc-key-reveal .spin-icon {
  animation: auth-spin 0.8s linear infinite;
}
@keyframes auth-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
