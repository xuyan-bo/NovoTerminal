<template>
  <div class="ai-panel">
    <div class="panel-head">
      <svg-icon name="ai" :size="14" class="head-logo" />
      <span class="panel-title">{{ $t('ai.title') }}</span>
      <span class="panel-host mono">{{ hostText }}</span>
      <button v-if="available" type="button" class="panel-ghost" :title="$t('ai.reset')" @click="reset">
        <i class="el-icon-refresh-left"></i>
      </button>
      <button type="button" class="panel-close" :title="$t('ai.closeTip')" @click="$emit('close')">
        <i class="el-icon-close"></i>
      </button>
    </div>

    <div v-if="!available" class="ai-offline">
      <i class="el-icon-warning-outline"></i>
      <p>{{ $t('ai.offline') }}</p>
    </div>

    <div v-if="available && error" class="ai-error">
      <i class="el-icon-warning-outline"></i>
      <span class="ai-error-text">{{ errorText }}</span>
      <a v-if="errorNeedsSettings" class="ai-error-link" @click="openSettings">{{ $t('ai.openSettings') }}</a>
      <button type="button" class="panel-close" @click="error = null"><i class="el-icon-close"></i></button>
    </div>

    <div v-if="available" ref="logEl" class="ai-log">
      <div v-if="!items.length" class="ai-empty">
        <p>{{ $t('ai.empty') }}</p>
        <p v-if="!hasService" class="ai-empty-warn">
          {{ $t('ai.noService') }}
          <a class="ai-error-link" @click="openSettings">{{ $t('ai.openSettings') }}</a>
        </p>
      </div>
      <div v-for="group in view" :key="group.key" class="ai-item">
        <div v-if="group.kind === 'user'" class="msg-user">{{ group.item.text }}</div>
        <div v-else-if="group.kind === 'ai'" class="msg-ai">
          <ai-markdown :text="group.item.text" /><span v-if="group.item.typing" class="msg-ai-cursor"></span>
        </div>
        <div v-else class="steps" :class="{ 'is-open': stepsOpen(group) }">
          <button type="button" class="steps-head" @click="toggleSteps(group)">
            <i :class="stepsOpen(group) ? 'el-icon-arrow-down' : 'el-icon-arrow-right'"></i>
            <span class="steps-title">{{ $t('ai.steps', { n: group.items.length }) }}</span>
            <span v-if="groupBusy(group)" class="steps-run"><i class="el-icon-loading"></i> {{ $t('ai.stateRunning') }}</span>
            <span v-else-if="groupAsk(group)" class="steps-badge is-ask">{{ $t('ai.approveWait') }}</span>
            <span v-else-if="groupDenied(group)" class="steps-badge is-bad">{{ $t('ai.stateDenied') }}</span>
          </button>
          <div v-show="stepsOpen(group)" class="steps-body">
            <div
              v-for="item in group.items"
              :key="item.key"
              class="tool"
              :class="item.kind === 'approval' ? 'is-ask' : 'is-' + item.state"
            >
              <div class="tool-head">
                <span class="tool-kind">{{ $t(item.kind === 'approval' ? (item.readOnly ? 'ai.kindReadOnly' : 'ai.kindWrite') : 'ai.channel.' + item.channel) }}</span>
                <span class="tool-name mono">{{ item.name }}</span>
                <span v-if="item.auto" class="tool-kind is-auto">{{ $t('ai.autoRan') }}</span>
                <span class="tool-stat" :class="item.kind === 'approval' ? 'is-ask' : 'is-' + item.state">
                  <i v-if="item.state === 'running'" class="el-icon-loading"></i>
                  {{ item.kind === 'approval' ? (item.decided ? decidedText(item) : $t('ai.approveWait')) : toolStatText(item) }}
                </span>
              </div>
              <div v-if="item.command" class="tool-cmd mono">{{ item.command }}</div>
              <template v-if="item.output">
                <div v-show="!item.folded" class="tool-out mono">{{ item.output }}</div>
                <a class="tool-fold" @click="$set(item, 'folded', !item.folded)">
                  <i :class="item.folded ? 'el-icon-arrow-right' : 'el-icon-arrow-down'"></i>
                  {{ $t(item.folded ? 'ai.expandOutput' : 'ai.collapseOutput') }}
                </a>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="available" class="ai-input">
      <div v-if="pendingApproval" class="ai-ask">
        <div class="ai-ask-head">
          <i class="el-icon-warning-outline"></i>
          <span class="ai-ask-title">{{ $t(pendingApproval.readOnly ? 'ai.kindReadOnly' : 'ai.kindWrite') }}</span>
          <span class="ai-ask-name mono">{{ pendingApproval.name }}</span>
        </div>
        <div class="ai-ask-cmd mono">{{ pendingApproval.command }}</div>
        <div v-if="pendingApproval.reason" class="ai-ask-reason">{{ pendingApproval.reason }}</div>
        <div class="ai-ask-btns">
          <el-button size="mini" type="primary" @click="decide(pendingApproval, 'allow')">{{ $t('ai.approveAllow') }}</el-button>
          <el-button size="mini" @click="decide(pendingApproval, 'deny')">{{ $t('ai.approveDeny') }}</el-button>
        </div>
      </div>
      <div class="ai-box" :class="{ 'is-focus': boxFocused }">
        <div
          class="ai-box-grip"
          :class="{ dragging: boxDragging }"
          :title="$t('ai.resizeTip')"
          @mousedown.prevent="startBoxResize"
        ><i></i></div>
        <textarea
          ref="boxEl"
          v-model="input"
          class="ai-box-input"
          rows="4"
          :style="boxInputStyle"
          :placeholder="$t('ai.placeholder')"
          @focus="boxFocused = true"
          @blur="boxFocused = false"
          @keydown="onKeydown"
        ></textarea>
        <div class="ai-bar">
          <el-dropdown trigger="click" placement="top-start" @command="setPermission">
            <button type="button" class="bar-btn" :class="'perm-' + permission">
              <i :class="permissionIcon"></i>{{ $t('ai.perm.' + permission) }}<i class="el-icon-arrow-down bar-caret"></i>
            </button>
            <el-dropdown-menu slot="dropdown" class="ai-drop">
              <el-dropdown-item v-for="p in permissions" :key="p.id" :command="p.id" :disabled="savingPermission">
                <div class="drop-item" :class="{ on: p.id === permission }">
                  <i :class="p.icon"></i>
                  <span>{{ $t('ai.perm.' + p.id) }}</span>
                  <el-tooltip :content="$t('ai.permDesc.' + p.id)" placement="right">
                    <i class="el-icon-info drop-info"></i>
                  </el-tooltip>
                </div>
              </el-dropdown-item>
            </el-dropdown-menu>
          </el-dropdown>
          <span class="ai-bar-space"></span>
          <el-select
            :value="modelKey"
            size="mini"
            class="model-select"
            :placeholder="$t('ai.model')"
            placement="top"
            @change="setModel"
          >
            <el-option-group v-for="g in modelGroups" :key="g.label" :label="g.label">
              <el-option v-for="m in g.options" :key="m.key" :label="m.label" :value="m.key" />
            </el-option-group>
          </el-select>
          <button
            type="button"
            class="send-btn"
            :class="{ 'is-stop': running }"
            :title="$t(running ? 'ai.stopTip' : 'ai.sendTip')"
            @click="running ? cancel() : send()"
          >
            <i :class="running ? 'el-icon-video-pause' : 'el-icon-s-promotion'"></i>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { api, unwrap, store } from '../store';
import { t } from '../i18n';
import { AI_PERMISSIONS } from '../constants';
import AiMarkdown from './AiMarkdown.vue';

let seq = 0;
const nextKey = () => 'i' + (seq += 1);
const LINE_LIMIT = 120;
const BOX_MIN_H = 88;

export default {
  name: 'AiAssistantPanel',
  components: { AiMarkdown },
  props: {
    /** 当前存活的 SSH 会话 ID；重连后会变，届时重新拉历史。 */
    sessionId: { type: String, default: '' },
    /** 只有握手完成（status==='ready'）才允许提问，connecting 时 exec 通道还不存在。 */
    connected: { type: Boolean, default: false },
    hostText: { type: String, default: '' },
    cwd: { type: String, default: '' },
    /** 终端屏幕文本由宿主组件提供——xterm 实例的所有权在 TerminalView。 */
    readScreen: { type: Function, required: true },
  },
  data() {
    return {
      items: [],
      input: '',
      running: false,
      error: null,
      boxFocused: false,
      boxHeight: 0,
      boxDragging: false,
      savingPermission: false,
      /** 本会话的审批级别覆盖；为空表示跟随设置里的默认值。 */
      sessionPermission: '',
      /** 本会话选用的模型；同样只在会话内生效，随下一次请求递给主进程。 */
      sessionModel: null,
      modelKey: '',
      permissions: AI_PERMISSIONS,
      /** 执行过程分组的展开状态；没被点过的组走「跑的时候展开、跑完收起」。 */
      stepsState: {},
    };
  },
  computed: {
    available() {
      return !!(this.connected && this.sessionId);
    },
    /** 连续的工具/审批条目并成一组，用户关心的是结论，过程默认折起来。 */
    view() {
      const out = [];
      for (const item of this.items) {
        if (item.kind === 'tool' || item.kind === 'approval') {
          const last = out[out.length - 1];
          if (last && last.kind === 'steps') { last.items.push(item); continue; }
          out.push({ key: 'g' + item.key, kind: 'steps', items: [item] });
          continue;
        }
        out.push({ key: item.key, kind: item.kind, item });
      }
      if (out.length) out[out.length - 1].last = true;
      return out;
    },
    pendingApproval() {
      return this.items.find((i) => i.kind === 'approval' && !i.decided) || null;
    },
    boxInputStyle() {
      return this.boxHeight ? { height: this.boxHeight + 'px' } : {};
    },
    ai() {
      const settings = store.snapshot.settings || {};
      return settings.ai || {};
    },
    permission() {
      return this.sessionPermission || this.ai.permission || 'auto';
    },
    permissionIcon() {
      const hit = AI_PERMISSIONS.find((p) => p.id === this.permission);
      return (hit && hit.icon) || 'el-icon-question';
    },
    hasService() {
      return !!(this.ai.services && this.ai.services.length);
    },
    /** 模型下拉按服务分组，key 用「服务/模型」拼出来，回给主进程时再拆成两个字段。 */
    modelGroups() {
      return (this.ai.services || [])
        .filter((s) => s.models && s.models.length)
        .map((s) => ({
          label: s.name || s.baseUrl,
          options: s.models.map((m) => ({ key: s.id + '::' + m.id, label: m.alias || m.id })),
        }));
    },
    modelRef() {
      const [serviceId, modelId] = String(this.modelKey || '').split('::');
      return serviceId && modelId ? { serviceId, modelId } : null;
    },
    errorText() {
      if (!this.error) return '';
      const key = 'err.' + this.error.code;
      const mapped = t(key);
      return mapped === key ? this.error.message || t('err.AI_REQUEST') : mapped;
    },
    errorNeedsSettings() {
      return ['AI_NO_SERVICE', 'AI_NO_MODEL', 'AI_NO_KEY', 'AI_AUTH', 'AI_URL'].includes(this.error && this.error.code);
    },
  },
  watch: {
    sessionId() {
      this.clearConversation();
    },
    connected() {
      this.clearConversation();
    },
    /** 宿主半圆要显示「正在跑」的提示点。 */
    running(val) {
      this.$emit('running-change', val);
      if (val) return;
      // 一轮跑完就收起本轮的执行过程；用户手动点过的组保留他的选择，不覆盖。
      for (const group of this.view) {
        if (group.kind === 'steps' && this.stepsState[group.key] === undefined) this.$set(this.stepsState, group.key, false);
      }
    },
    /** 设置里改了服务或默认模型后，面板的下拉要跟着落到一个真实存在的选项上。 */
    modelGroups() {
      const alive = this.modelGroups.some((g) => g.options.some((o) => o.key === this.modelKey));
      if (!alive) this.pickDefaultModel();
    },
  },
  created() {
    this._offEvent = null;
    this._disposed = false;
    this._boxMove = null;
    this._boxUp = null;
    this.subscribe();
    this.clearConversation();
  },
  mounted() {
    this.scrollToEnd();
  },
  beforeDestroy() {
    this._disposed = true;
    if (this._boxUp) this._boxUp();
    if (this._offEvent) {
      this._offEvent();
      this._offEvent = null;
    }
  },
  methods: {
    subscribe() {
      if (this._offEvent || !api.onAiEvent) return;
      this._offEvent = api.onAiEvent((ev) => {
        if (this._disposed || !ev || ev.sessionId !== this.sessionId) return;
        this.onEvent(ev);
      });
    },

    pickDefaultModel() {
      const groups = this.modelGroups;
      if (!groups.length) { this.modelKey = ''; return; }
      const key = (ref) => (ref && ref.serviceId ? ref.serviceId + '::' + ref.modelId : '');
      const flat = groups.reduce((all, g) => all.concat(g.options), []);
      const wanted = key(this.sessionModel) || key(this.ai.defaultRef);
      // 会话选过的模型可能已在设置里被删掉，这时回落到默认模型而不是清单第一项
      const hit = flat.find((o) => o.key === wanted) || flat.find((o) => o.key === key(this.ai.defaultRef)) || flat[0];
      this.modelKey = hit.key;
    },

    /** 会话断开或换成另一条会话：旧对话不属于当前主机，直接清空，连上后再拉历史。 */
    clearConversation() {
      this.items = [];
      this.stepsState = {};
      this.error = null;
      this.sessionPermission = '';
      this.sessionModel = null;
      this.pickDefaultModel();
      if (!this.available) {
        this.running = false;
        return;
      }
      this.loadHistory();
    },

    async loadHistory() {
      if (!this.available || !api.aiHistory) return;
      try {
        const r = unwrap(await api.aiHistory({ sessionId: this.sessionId }));
        if (this._disposed || !r) return;
        this.sessionPermission = r.permissionOverride || '';
        if (r.modelOverride) {
          this.sessionModel = r.modelOverride;
          this.pickDefaultModel();
        }
        if (!r.messages) return;
        this.items = r.messages
          .map((m) => ({
            key: nextKey(),
            kind: m.role === 'user' ? 'user' : 'ai',
            text: typeof m.content === 'string' ? m.content : '',
          }))
          .filter((item) => item.text.trim());
        this.running = !!r.running;
        this.scrollToEnd();
      } catch (_) { /* 面板早于会话创建时拿不到历史，属正常 */ }
    },

    onEvent(ev) {
      if (ev.type === 'state') {
        this.running = !!ev.running;
        return;
      }
      if (ev.type === 'delta') {
        const last = this.items[this.items.length - 1];
        if (!last || last.kind !== 'ai' || !last.typing) {
          this.items.push({ key: nextKey(), kind: 'ai', text: ev.text || '', typing: true });
        } else {
          last.text += ev.text || '';
        }
        this.scrollToEnd();
        return;
      }
      if (ev.type === 'tool') {
        this.closeTyping();
        const existing = this.items.find((i) => i.kind === 'tool' && i.callId === ev.callId);
        if (existing) {
          this.$set(existing, 'state', ev.state);
          this.$set(existing, 'output', ev.output || existing.output);
          this.$set(existing, 'exitCode', ev.exitCode == null ? existing.exitCode : ev.exitCode);
          this.$set(existing, 'ms', ev.ms);
          this.$set(existing, 'channel', ev.channel || existing.channel);
          this.$set(existing, 'denied', !!ev.denied);
        } else {
          this.items.push({
            key: nextKey(), kind: 'tool', callId: ev.callId, name: ev.name, command: ev.command || '',
            channel: ev.channel || 'exec', state: ev.state, auto: !!ev.auto, folded: false, output: '',
          });
        }
        this.scrollToEnd();
        return;
      }
      if (ev.type === 'approval') {
        this.closeTyping();
        this.items.push({
          key: nextKey(), kind: 'approval', requestId: ev.requestId, name: ev.name, command: ev.command || '',
          reason: ev.reason || '', readOnly: !!ev.readOnly, decided: '',
        });
        this.scrollToEnd();
        return;
      }
      if (ev.type === 'approval-resolved') {
        const hit = this.items.find((i) => i.kind === 'approval' && i.requestId === ev.requestId);
        if (hit) this.$set(hit, 'decided', ev.decision === 'deny' ? 'timeout' : ev.decision);
        return;
      }
      if (ev.type === 'screen-request') {
        if (api.aiScreenReply) api.aiScreenReply({ sessionId: this.sessionId, requestId: ev.requestId, text: this.screenText() });
        return;
      }
      if (ev.type === 'done') {
        this.running = false;
        this.closeTyping();
        this.error = ev.error && ev.error.code !== 'AI_CANCELED' ? ev.error : null;
        return;
      }
    },

    /** 同时只有一条流式正文在打字；工具卡片或审批插进来后必须收尾，否则光标会一直闪。 */
    closeTyping() {
      for (const it of this.items) {
        if (it.kind === 'ai' && it.typing) this.$set(it, 'typing', false);
      }
    },

    /** 送进模型的屏幕：只取最近若干行，且尊重设置里的「读取屏幕」开关。 */
    screenText() {
      if (this.ai.readScreen === false) return '';
      const raw = String(this.readScreen() || '');
      return raw.split(/\r?\n/).slice(-LINE_LIMIT).join('\n');
    },

    async send() {
      const text = this.input.trim();
      if (!text || this.running || !this.available) return;
      if (!api.aiSend) { this.error = { code: 'NO_BRIDGE', message: t('msg.needElectron') }; return; }
      this.input = '';
      this.items.push({ key: nextKey(), kind: 'user', text });
      this.error = null;
      this.running = true;
      this.scrollToEnd();
      try {
        unwrap(await api.aiSend({ sessionId: this.sessionId, text, screen: this.screenText(), cwd: this.cwd, modelRef: this.modelRef }));
      } catch (e) {
        this.running = false;
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      }
    },

    async cancel() {
      if (!this.sessionId || !api.aiCancel) return;
      try { await api.aiCancel({ sessionId: this.sessionId }); } catch (_) { /* 主进程会自己收尾 */ }
    },

    async reset() {
      if (this.sessionId && api.aiReset) {
        try { await api.aiReset({ sessionId: this.sessionId }); } catch (_) {}
      }
      this.items = [];
      this.stepsState = {};
      this.error = null;
    },

    async decide(item, decision) {
      this.$set(item, 'decided', decision);
      if (!api.aiApprove) return;
      try {
        const r = unwrap(await api.aiApprove({ sessionId: this.sessionId, requestId: item.requestId, decision }));
        if (r && r.ok === false) this.$set(item, 'decided', '');
      } catch (e) {
        this.$set(item, 'decided', '');
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      }
    },

    async setPermission(id) {
      if (id === this.permission || this.savingPermission) return;
      if (id === 'full') {
        try {
          await this.$confirm(t('ai.fullWarn'), t('ai.fullTitle'), {
            confirmButtonText: t('ai.fullOk'),
            cancelButtonText: t('msg.cancel'),
            type: 'warning',
          });
        } catch (_) { return; }
      }
      if (!api.aiSetPermission) { this.error = { code: 'NO_BRIDGE', message: t('msg.needElectron') }; return; }
      this.savingPermission = true;
      try {
        unwrap(await api.aiSetPermission({ sessionId: this.sessionId, permission: id }));
        this.sessionPermission = id;
      } catch (e) {
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      } finally {
        this.savingPermission = false;
      }
    },

    /** 选模型只改本会话：随每次请求把 modelRef 递给主进程，不写设置的默认模型。 */
    setModel(key) {
      const [serviceId, modelId] = String(key).split('::');
      if (!serviceId || !modelId) return;
      this.modelKey = key;
      this.sessionModel = { serviceId, modelId };
    },

    openSettings() {
      store.settingsDialog = true;
    },

    onKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    },
    /** 输入区贴在面板底部，所以拖动手柄放在顶边：向上拖变高，向下拖变矮。 */
    startBoxResize(e) {
      const el = this.$refs.boxEl;
      if (!el) return;
      const startY = e.clientY;
      const startH = el.getBoundingClientRect().height;
      const max = Math.max(BOX_MIN_H, Math.floor(window.innerHeight * 0.46));
      this.boxDragging = true;
      this._boxMove = (ev) => {
        this.boxHeight = Math.min(max, Math.max(BOX_MIN_H, startH + (startY - ev.clientY)));
      };
      this._boxUp = () => {
        this.boxDragging = false;
        document.removeEventListener('mousemove', this._boxMove);
        document.removeEventListener('mouseup', this._boxUp);
        this._boxMove = null;
        this._boxUp = null;
      };
      document.addEventListener('mousemove', this._boxMove);
      document.addEventListener('mouseup', this._boxUp);
    },

    toolStatText(item) {
      if (item.state === 'running') return t('ai.stateRunning');
      if (item.state === 'denied') return t('ai.stateDenied');
      const secs = item.ms ? ' · ' + (item.ms / 1000).toFixed(1) + 's' : '';
      if (item.exitCode === null || item.exitCode === undefined) return t('ai.stateDone') + secs;
      return t('ai.stateExit', { code: item.exitCode }) + secs;
    },

    decidedText(item) {
      return t('ai.decided.' + item.decided);
    },

    stepsOpen(group) {
      const manual = this.stepsState[group.key];
      if (manual !== undefined) return manual;
      return this.running && !!group.last;
    },
    toggleSteps(group) {
      this.$set(this.stepsState, group.key, !this.stepsOpen(group));
    },
    groupBusy(group) {
      return group.items.some((i) => i.kind === 'tool' && i.state === 'running');
    },
    groupAsk(group) {
      return group.items.some((i) => i.kind === 'approval' && !i.decided);
    },
    groupDenied(group) {
      return group.items.some((i) => (i.kind === 'tool' && i.state === 'denied') || (i.kind === 'approval' && i.decided === 'deny'));
    },

    scrollToEnd() {
      this.$nextTick(() => {
        const el = this.$refs.logEl;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  },
};
</script>

<style scoped>
.mono { font-family: Consolas, "Courier New", monospace; }
.ai-panel {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
}
.panel-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px 9px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.head-logo { color: var(--accent); font-size: 14px; }
.panel-title { font-size: 12.5px; font-weight: 700; letter-spacing: 0.4px; color: var(--accent); }
.panel-host { flex: 1; min-width: 0; font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-ghost,
.panel-close {
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;
  flex: none;
}
.panel-ghost:hover,
.panel-close:hover { background: var(--bg-hover); color: var(--text); }
.ai-error {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 12px;
  font-size: 11.5px;
  color: var(--danger);
  background: rgba(245, 108, 108, 0.1);
  border-bottom: 1px solid var(--border);
}
.ai-error-text { flex: 1; min-width: 0; }
.ai-error-link { color: var(--accent); cursor: pointer; white-space: nowrap; }
.ai-error-link:hover { text-decoration: underline; }
.ai-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ai-empty { color: var(--text-3); font-size: 12px; line-height: 1.7; padding: 6px 4px; }
.ai-offline {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 18px;
  color: var(--text-3);
  font-size: 12.5px;
  line-height: 1.7;
  text-align: center;
}
.ai-offline i { font-size: 22px; }
.ai-empty-warn { margin-top: 8px; color: var(--warning); }
.ai-item { font-size: 12.5px; }
.msg-user {
  margin-left: auto;
  width: fit-content;
  max-width: 92%;
  background: var(--accent-soft);
  border: 1px solid rgba(64, 158, 255, 0.28);
  color: var(--text);
  border-radius: 9px 9px 2px 9px;
  padding: 7px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg-ai { color: var(--text); line-height: 1.7; }
.msg-ai-cursor {
  display: inline-block;
  width: 6px;
  height: 12px;
  background: var(--accent);
  vertical-align: -1px;
  animation: ai-blink 1s steps(1) infinite;
}
@keyframes ai-blink { 50% { opacity: 0; } }
.tool {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-left: 3px solid var(--text-3);
  border-radius: 6px;
  font-size: 11.5px;
  overflow: hidden;
}
.tool.is-running { border-left-color: var(--accent); }
.tool.is-done { border-left-color: var(--success); }
.tool.is-denied { border-left-color: var(--text-3); opacity: 0.8; }
.tool.is-ask { border-left-color: var(--warning); }
.tool-head { display: flex; align-items: center; gap: 7px; padding: 6px 9px; }
.tool-kind {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-2);
  white-space: nowrap;
  flex: none;
}
.tool-kind.is-auto { color: var(--danger); background: rgba(245, 108, 108, 0.14); }
.tool-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-stat { margin-left: auto; font-size: 10.5px; color: var(--text-3); white-space: nowrap; }
.tool-stat.is-running { color: var(--accent); }
.tool-stat.is-done { color: var(--success); }
.tool-stat.is-ask { color: var(--warning); }
.tool-cmd {
  margin: 0 9px 6px;
  padding: 5px 8px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
}
.tool-out {
  margin: 0 9px 7px;
  padding: 6px 8px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-2);
  white-space: pre-wrap;
  max-height: 132px;
  overflow: auto;
}
.tool-fold { display: block; margin: 0 9px 6px; font-size: 10.5px; color: var(--text-3); cursor: pointer; }
.tool-fold:hover { color: var(--accent); }
.steps { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.steps-head {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 6px 9px; border: none; background: none; cursor: pointer;
  font-size: 11.5px; color: var(--text-2); text-align: left;
}
.steps-head:hover { background: var(--bg-hover); color: var(--text); }
.steps-title { font-weight: 600; }
.steps-run { margin-left: auto; display: flex; align-items: center; gap: 4px; color: var(--accent); }
.steps-badge { margin-left: auto; font-size: 10.5px; }
.steps-badge.is-ask { color: var(--warning); }
.steps-badge.is-bad { color: var(--text-3); }
.steps-body { padding: 0 8px 8px; display: flex; flex-direction: column; gap: 7px; }
.steps-body .tool { background: var(--bg-app); }
.ai-ask {
  margin-bottom: 7px; padding: 8px 10px;
  background: rgba(230, 162, 60, 0.1);
  border: 1px solid var(--warning); border-radius: 8px;
}
.ai-ask-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--warning); }
.ai-ask-title { font-weight: 700; }
.ai-ask-name { font-size: 11px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-ask-cmd {
  margin: 6px 0 0; padding: 5px 8px; background: var(--bg-app);
  border: 1px solid var(--border); border-radius: 4px;
  font-size: 11.5px; color: var(--text); white-space: pre-wrap; word-break: break-all;
  max-height: 88px; overflow-y: auto;
}
.ai-ask-reason { margin-top: 5px; font-size: 11px; color: var(--text-2); line-height: 1.6; }
.ai-ask-btns { display: flex; gap: 7px; margin-top: 8px; flex-wrap: wrap; }
.ai-input { flex: 0 0 auto; border-top: 1px solid var(--border); background: var(--bg-panel); padding: 7px 9px 9px; }
.ai-box {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-app);
  overflow: hidden;
  transition: border-color 0.15s ease;
}
.ai-box.is-focus { border-color: var(--accent); }
.ai-box-grip {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 10px;
  background: none;
  cursor: ns-resize;
  user-select: none;
}
.ai-box-grip i {
  width: 26px;
  height: 3px;
  border-radius: 2px;
  background: var(--border);
  transition: background 0.15s ease;
}
.ai-box-grip:hover i,
.ai-box-grip.dragging i {
  background: var(--accent);
}
.ai-box-input {
  display: block;
  width: 100%;
  min-height: 88px;
  max-height: 46vh;
  resize: none;
  overflow-y: auto;
  padding: 10px 11px;
  font-size: 12.5px;
  line-height: 1.55;
  font-family: inherit;
  background: none;
  color: var(--text);
  border: none;
  border-bottom: 1px solid var(--border);
  outline: none;
}
.ai-box-input::placeholder { color: var(--text-3); }
.ai-box-input::-webkit-scrollbar { width: 6px; }
.ai-box-input::-webkit-scrollbar-track { background: transparent; }
.ai-box-input::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.ai-box-input::-webkit-scrollbar-thumb:hover { background: var(--text-3); }
.ai-bar { display: flex; align-items: center; gap: 6px; padding: 5px 7px; }
.ai-bar-space { flex: 1; min-width: 0; }
.bar-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  font-size: 11.5px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
}
.bar-btn:hover { background: var(--bg-hover); color: var(--text); }
.bar-caret { font-size: 9px; opacity: 0.7; }
.bar-btn.perm-auto { color: var(--warning); }
.bar-btn.perm-full { color: var(--danger); }
.model-select { width: 122px; flex: none; }
.model-select /deep/ .el-input__inner {
  height: 26px;
  line-height: 26px;
  font-size: 11.5px;
  background: none;
  border-color: transparent;
  color: var(--text-2);
  padding-left: 8px;
}
.model-select /deep/ .el-input__icon { line-height: 26px; font-size: 11px; }
.send-btn {
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.send-btn:hover { filter: brightness(1.08); }
.send-btn.is-stop { background: none; border-color: var(--danger); color: var(--danger); }
</style>

<style>
/* 下拉菜单挂在 body 上，scoped 样式够不到，单独收在面板命名空间里 */
.ai-drop .drop-item { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text); }
.ai-drop .drop-item.on { color: var(--accent); }
.ai-drop .drop-info { font-size: 12px; color: var(--text-3); cursor: help; }
.ai-drop .drop-info:hover { color: var(--accent); }
</style>
