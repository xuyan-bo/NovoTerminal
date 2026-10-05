<template>
  <div class="ai-panel">
    <div class="panel-head">
      <svg-icon name="ai" :size="14" class="head-logo" />
      <span class="panel-title">{{ $t('ai.title') }}</span>
      <span class="panel-host mono" :title="hostText">{{ hostText }}</span>
      <button v-if="available" type="button" class="panel-ghost" :title="$t('ai.history')" @click="openHistory">
        <i class="el-icon-time"></i>
      </button>
      <button
        v-if="available"
        type="button"
        class="panel-ghost"
        :title="$t('ai.newSessionTip')"
        :disabled="archiveBusy"
        @click="newSession"
      >
        <i :class="archiveBusy ? 'el-icon-loading' : 'el-icon-plus'"></i>
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

    <div v-if="available" class="ai-main">
      <div ref="logEl" class="ai-log" @scroll.passive="onLogScroll">
        <div v-if="!items.length" class="ai-empty">
          <p>{{ $t('ai.empty') }}</p>
          <p v-if="!hasService" class="ai-empty-warn">
            {{ $t('ai.noService') }}
            <a class="ai-error-link" @click="openSettings">{{ $t('ai.openSettings') }}</a>
          </p>
        </div>
        <div v-for="row in items" :key="row.key" class="ai-item">
          <div v-if="row.kind === 'user'" class="msg-user">{{ row.text }}</div>
          <div v-else-if="row.kind === 'answer'" class="answer">
            <ai-markdown :text="row.text" /><span v-if="row.typing" class="msg-ai-cursor"></span>
          </div>
          <div v-else-if="row.kind === 'note'" class="step-note is-center">{{ row.text }}</div>
          <div v-else class="turn" :class="row.running ? 'is-live' : 'is-done'">
            <button type="button" class="turn-head" @click="toggleTurn(row)">
              <i class="h-ico" :class="row.running ? 'el-icon-loading' : 'el-icon-circle-check'"></i>
              <span class="h-title">{{ $t(row.running ? 'ai.turnRunning' : 'ai.turnDone') }}</span>
              <span class="h-stat mono">{{ headStat(row) }}</span>
              <span class="h-count">{{ headCount(row) }}</span>
              <i class="h-caret" :class="turnOpen(row) ? 'el-icon-arrow-down' : 'el-icon-arrow-right'"></i>
            </button>
            <div v-show="turnOpen(row)" class="turn-body">
              <div v-for="n in row.nodes" :key="n.key" class="act" :class="actClass(n)">
                <div v-if="n.nk === 'say'" class="say">
                  <ai-markdown :text="n.text" /><span v-if="n.typing" class="msg-ai-cursor"></span>
                </div>
                <template v-else>
                  <button type="button" class="act-head" @click="toggleNode(n)">
                    <i class="a-ico" :class="nodeIcon(n)"></i>
                    <span class="a-title" :class="{ mono: n.nk === 'cmd' || n.nk === 'ask' }">{{ nodeTitle(n) }}</span>
                    <span class="a-stat mono">{{ nodeStat(n) }}</span>
                    <i class="a-caret" :class="n.open ? 'el-icon-arrow-down' : 'el-icon-arrow-right'"></i>
                  </button>
                  <div v-show="n.open" class="act-detail">
                    <div v-if="n.nk === 'think'" class="think-text mono" :class="{ typing: n.running }" :style="capStyle">{{ n.text }}</div>
                    <template v-else>
                      <div class="cmd-line mono">{{ n.nk === 'ask' ? n.command : n.command || n.name }}</div>
                      <div v-if="n.nk === 'cmd' && n.auto" class="step-note">{{ $t('ai.autoRanNote') }}</div>
                      <div v-if="n.reason" class="step-note">{{ n.reason }}</div>
                      <div v-if="n.nk === 'cmd' && n.output" class="cmd-out mono" :style="capStyle">{{ n.output }}</div>
                      <div v-if="n.nk === 'ask' && !n.decided" class="ask-btns">
                        <el-button size="mini" type="primary" @click="decide(n, 'allow')">
                          {{ $t('ai.approveAllow') }}
                        </el-button>
                        <el-button size="mini" @click="decide(n, 'deny')">
                          {{ $t('ai.approveDeny') }}
                        </el-button>
                      </div>
                      <div v-if="n.nk === 'choice'" class="choice-list">
                        <p class="step-note">{{ $t('ai.choiceTip') }}</p>
                        <button
                          v-for="(o, i) in n.options"
                          :key="o"
                          type="button"
                          class="choice"
                          :class="{ 'is-picked': n.picked === o, 'is-dim': n.state !== 'waiting' && n.picked !== o }"
                          :disabled="n.state !== 'waiting'"
                          @click="pick(n, o)"
                        >
                          <span class="k">{{ i + 1 }}</span>{{ o }}
                        </button>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
              <div v-if="row.live" class="turn-live">
                <span class="dots"><b></b><b></b><b></b></span>
                <span class="txt">{{ row.live }}</span>
                <span class="lbl mono">{{ elapsed(row.liveStart) }}</span>
              </div>
              <div v-if="usageText(row)" class="turn-usage mono">{{ usageText(row) }}</div>
            </div>
          </div>
        </div>
      </div>
      <button v-show="!follow" type="button" class="back-tail" @click="goBottom">{{ $t('ai.backBottom') }}</button>
    </div>

    <el-dialog
      :visible.sync="historyOpen"
      width="920px"
      top="7vh"
      :close-on-click-modal="false"
      custom-class="ai-hist"
      append-to-body
    >
      <div slot="title" class="hist-head">
        <span class="hist-title">{{ $t('ai.historyTitle') }}</span>
        <span class="hist-sub mono">{{ historyAssetText }}</span>
      </div>
      <div class="hist-tools">
        <el-input v-model="historyKeyword" size="mini" :placeholder="$t('ai.histSearch')" prefix-icon="el-icon-search" clearable class="hist-search" />
        <el-select v-model="historySort" size="mini" class="hist-sort">
          <el-option :label="$t('ai.histSortTime')" value="time" />
          <el-option :label="$t('ai.histSortName')" value="name" />
        </el-select>
        <span class="hist-count">{{ $t('ai.histCount', { n: historyCount }) }}</span>
      </div>
      <div v-loading="historyLoading" class="hist-list scroll">
        <div v-if="!historyGroups.length && !historyLoading" class="hist-empty">
          {{ $t(historyRows.length ? 'ai.histNoMatch' : 'ai.histEmpty') }}
        </div>
        <template v-for="group in historyGroups">
          <div :key="'g-' + group.key" class="hist-group">{{ group.label }}</div>
          <div
            v-for="s in group.items"
            :key="s.id"
            class="hist-row"
            :class="{ 'is-cur': s.id === recordId || s.isLive, 'is-edit': s.id === editingId }"
          >
            <i class="hist-ico" :class="s.isLive ? 'el-icon-edit' : 'el-icon-chat-line-round'"></i>
            <div class="hist-main">
              <div class="hist-line">
                <span v-if="s.id !== editingId" class="hist-name">{{ s.title || $t('ai.untitled') }}</span>
                <template v-if="s.id === recordId">
                  <span class="hist-chip is-cur">{{ $t('ai.histCurrent') }}</span>
                </template>
                <template v-if="s.isLive">
                  <span class="hist-chip is-open">{{ $t('ai.histUnarchived') }}</span>
                </template>
                <span v-if="s.id === editingId" class="hist-edit">
                  <el-input
                    ref="renameEl"
                    v-model="editingTitle"
                    size="mini"
                    @keyup.enter.native="saveRename(s)"
                    @keyup.esc.native="editingId = ''"
                  />
                  <button type="button" class="hist-yes" :title="$t('ai.histRename')" @click="saveRename(s)">
                    <i class="el-icon-check"></i>
                  </button>
                  <button type="button" class="hist-no" :title="$t('msg.cancel')" @click="editingId = ''">
                    <i class="el-icon-close"></i>
                  </button>
                </span>
              </div>
              <div class="hist-meta mono">
                <span>{{ s.timeText }}</span>
                <span>{{ $t('ai.histMsgs', { n: s.messages }) }}</span>
                <span v-if="s.steps">{{ $t('ai.histSteps', { n: s.steps }) }}</span>
                <span class="hist-preview">{{ s.preview }}</span>
              </div>
            </div>
            <div class="hist-acts">
              <el-button size="mini" type="primary" plain @click="loadSession(s)">
                {{ s.isLive || s.id === recordId ? $t('ai.histBack') : $t('ai.histLoad') }}
              </el-button>
              <el-button size="mini" icon="el-icon-edit-outline" :title="$t('ai.histRename')" @click="startRename(s)" />
              <el-popconfirm
                v-if="!s.isLive"
                placement="top-end"
                :title="$t('ai.histDeleteWarn', { name: s.title || $t('ai.untitled') })"
                :confirm-button-text="$t('ai.histDelete')"
                :cancel-button-text="$t('msg.cancel')"
                @confirm="deleteSession(s)"
              >
                <el-button slot="reference" size="mini" icon="el-icon-delete" class="hist-del" :title="$t('ai.histDelete')" />
              </el-popconfirm>
            </div>
          </div>
        </template>
      </div>
      <div slot="footer" class="hist-foot">
        <el-button size="mini" @click="historyOpen = false">{{ $t('ai.histClose') }}</el-button>
      </div>
    </el-dialog>

    <div v-if="available" class="ai-input">
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
const DAY_MS = 86400000;
const CAP_RATIO = 0.42;
const CAP_MIN = 140;
const TICK_MS = 200;

const pad2 = (n) => (n < 10 ? '0' + n : String(n));
const clip = (text, n) => (text.length > n ? text.slice(0, n) + '…' : text);
const fmtS = (ms) => (Math.max(0, ms) / 1000).toFixed(1) + 's';
const fmtK = (n) => (n >= 1000 ? Math.round(n / 100) / 10 + 'k' : String(n || 0));

function newTurn(turnId) {
  return {
    key: nextKey(), kind: 'turn', turnId, nodes: [],
    running: true, open: true, started: Date.now(), ms: null, usage: null, label: '', live: '', liveStart: 0,
  };
}

/**
 * 回合收尾：末段正文是答复，必须搬到回合外面（回合折叠后照样要能看见）。
 * 搬完空下来的回合整行去掉，只剩提问与答复，不留空回合。
 */
function settleTurn(turn) {
  // 尾巴上可能还挂着网关补发的思考，答复要往前找最后一个 say
  let at = turn.nodes.length - 1;
  while (at >= 0 && turn.nodes[at].nk === 'think') at -= 1;
  const say = at >= 0 && turn.nodes[at].nk === 'say' ? turn.nodes.splice(at, 1)[0] : null;
  turn.running = false;
  turn.live = '';
  if (!turn.nodes.length) return { dropped: true, answer: say ? say.text : '' };
  turn.open = false;
  return { dropped: false, answer: say ? say.text : '' };
}

/** 落盘记录 → 面板行：与实时事件走同一套「逻辑回合 + 末段答复」规则。 */
function rowsFromRecord(record) {
  const rows = [];
  let turn = null;
  const useTurn = () => {
    if (!turn) {
      turn = { ...newTurn(''), running: false, open: false, started: 0 };
      rows.push(turn);
    }
    return turn;
  };
  for (const e of record || []) {
    if (e.role === 'user') {
      turn = null;
      rows.push({ key: nextKey(), kind: 'user', text: e.text });
    } else if (e.role === 'turn') {
      if (turn) {
        turn.ms = e.ms;
        turn.usage = e.promptTokens || e.completionTokens
          ? { promptTokens: e.promptTokens || 0, completionTokens: e.completionTokens || 0 }
          : null;
      }
    } else if (e.role === 'think') {
      useTurn().nodes.push({ key: nextKey(), nk: 'think', text: e.text, ms: e.ms, running: false, startedAt: 0, open: false });
    } else if (e.role === 'ai') {
      useTurn().nodes.push({ key: nextKey(), nk: 'say', text: e.text, typing: false });
    } else if (e.role === 'step') {
      useTurn().nodes.push({
        key: nextKey(), nk: 'cmd', callId: '', name: e.name, command: e.command || '', channel: e.channel || 'exec',
        state: e.state || 'done', auto: !!e.auto, output: e.output || '',
        exitCode: e.exitCode == null ? null : e.exitCode, ms: e.ms, open: false,
      });
    } else if (e.role === 'approval') {
      useTurn().nodes.push({
        key: nextKey(), nk: 'ask', requestId: '', name: e.name, command: e.command || '', reason: e.reason || '',
        readOnly: !!e.readOnly, decided: e.decision || 'allow', askedAt: 0, open: false,
      });
    } else if (e.role === 'choice') {
      useTurn().nodes.push({
        key: nextKey(), nk: 'choice', requestId: '', question: e.question, options: e.options || [],
        picked: e.choice || '', state: e.state === 'skipped' ? 'skipped' : 'picked', askedAt: 0, open: false,
      });
    }
  }
  const out = [];
  for (const row of rows) {
    if (row.kind !== 'turn') { out.push(row); continue; }
    const settled = settleTurn(row);
    if (!settled.dropped) out.push(row);
    if (settled.answer) out.push({ key: nextKey(), kind: 'answer', text: settled.answer, typing: false });
  }
  return out;
}

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
    /** 面板此刻是否可见：审批/反问到达时据此决定要不要留一行「面板已自动展开」。 */
    open: { type: Boolean, default: true },
  },
  data() {
    return {
      /** 渲染行：提问气泡、逻辑回合、答复气泡、提示行。 */
      items: [],
      input: '',
      running: false,
      error: null,
      /** 自动跟随底部；用户往上翻阅时暂停，出现「回到底部」胶囊。 */
      follow: true,
      /** 思考全文/命令输出的展开上限，按会话区高度算，见 syncCap。 */
      actCap: 240,
      /** 心跳时间戳，驱动「处理中 3.2s」「等待选择 12.4s」这类实时统计。 */
      tickNow: Date.now(),
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
      /** 历史会话弹框：列表来自磁盘上的会话记录，当前会话未归档时以「live」虚拟行插在最前。 */
      historyOpen: false,
      historyLoading: false,
      historyRows: [],
      historyAsset: null,
      historyKeyword: '',
      historySort: 'time',
      editingId: '',
      editingTitle: '',
      archiveBusy: false,
      /** 这条对话对应的记录文件；空表示还没归档过。 */
      recordId: '',
      sessionTitle: '',
    };
  },
  computed: {
    available() {
      return !!(this.connected && this.sessionId);
    },
    capStyle() {
      return { maxHeight: this.actCap + 'px' };
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
    sessionTitleText() {
      if (!this.items.length) return t('ai.sessionNew');
      if (this.sessionTitle) return this.sessionTitle;
      const first = this.items.find((i) => i.kind === 'user');
      return first ? clip(String(first.text).replace(/\s+/g, ' ').trim(), 40) : t('ai.untitled');
    },
    historyAssetText() {
      const a = this.historyAsset;
      if (!a) return this.hostText;
      return [a.assetName || a.host, a.host + ':' + a.port, String(a.protocol).toUpperCase()].filter(Boolean).join(' · ');
    },
    /** 归档过的记录加上未归档的当前对话，过滤与排序都在这里收敛，模板只管分组渲染。 */
    historyRowsView() {
      const live = this.liveRow();
      const rows = (live ? [live] : []).concat(this.historyRows);
      const kw = this.historyKeyword.trim().toLowerCase();
      const hit = kw
        ? rows.filter((s) => ((s.title || '') + ' ' + (s.preview || '')).toLowerCase().includes(kw))
        : rows.slice();
      if (this.historySort === 'name') {
        hit.sort((a, b) => String(a.title || t('ai.untitled')).localeCompare(String(b.title || t('ai.untitled')), 'zh'));
      } else {
        hit.sort((a, b) => b.updatedAt - a.updatedAt);
      }
      return hit;
    },
    historyCount() {
      return this.historyRowsView.length;
    },
    historyGroups() {
      const order = ['Today', 'Yesterday', 'Earlier'];
      const buckets = new Map();
      for (const s of this.historyRowsView) {
        const key = this.dayKey(s.updatedAt);
        if (!buckets.has(key)) buckets.set(key, { key, label: t('ai.day' + key), items: [] });
        buckets.get(key).items.push(s);
      }
      return order.filter((key) => buckets.has(key)).map((key) => buckets.get(key));
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
    /** 会话区节点是 v-if 出来的，连上之后才有实测高度可依。 */
    available(val) {
      if (val) this.$nextTick(() => this.observeLog());
    },
    /** 宿主半圆要显示「正在跑」的提示点；心跳只在回合进行中走。 */
    running(val) {
      this.$emit('running-change', val);
      this.setTicker(val);
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
    this._tick = null;
    this._ro = null;
    this.subscribe();
    this.clearConversation();
  },
  mounted() {
    this.scrollToEnd();
    this.observeLog();
  },
  beforeDestroy() {
    this._disposed = true;
    this.setTicker(false);
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
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
      this.error = null;
      this.follow = true;
      this.sessionPermission = '';
      this.sessionModel = null;
      this.sessionTitle = '';
      this.recordId = '';
      this.editingId = '';
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
        this.sessionTitle = r.title || '';
        this.recordId = r.recordId || '';
        this.items = rowsFromRecord(r.record);
        // 上一轮还在跑（例如会话换了宿主）：记录里那条是已归档的片段，新事件另起一个进行中的回合
        this.running = !!r.running;
        if (this.running) this.startTurn('');
        this.follow = true;
        this.scrollToEnd();
      } catch (_) { /* 面板早于会话创建时拿不到历史，属正常 */ }
    },

    /**
     * 事件都带 turnId：命中已有回合就并进同一条逻辑回合；
     * turnId 还没同步过来（本轮第一个事件）时挂到进行中的回合，实在没有就新建一个。
     */
    turnOf(ev) {
      if (ev.turnId) {
        const hit = this.items.find((i) => i.kind === 'turn' && i.turnId === ev.turnId);
        if (hit) return hit;
      }
      const live = this.items.filter((i) => i.kind === 'turn' && i.running).pop();
      if (live) {
        if (ev.turnId) live.turnId = ev.turnId;
        return live;
      }
      return this.startTurn(ev.turnId || '');
    },

    startTurn(turnId) {
      const turn = newTurn(turnId);
      turn.live = this.$t('ai.liveRequest');
      turn.liveStart = Date.now();
      this.items.push(turn);
      this.stick();
      return turn;
    },

    /** 占位动画：只在没有内容到达的间隙出现，内容一到就消失，不进记录。 */
    busy(turn, label) {
      if (turn.live === label) return;
      turn.live = label;
      turn.liveStart = Date.now();
    },

    endThink(turn) {
      for (const n of turn.nodes) {
        if (n.nk === 'think' && n.running) {
          n.running = false;
          n.ms = Date.now() - n.startedAt;
          n.open = false;
        }
      }
    },

    /** 同一段正文只保留一个正在打字的 say；后面来了命令或审批就收掉光标。 */
    closeSay(turn) {
      for (const n of turn.nodes) {
        if (n.nk === 'say' && n.typing) n.typing = false;
      }
    },

    onEvent(ev) {
      if (ev.type === 'state') {
        this.running = !!ev.running;
        return;
      }
      if (ev.type === 'delta') {
        const turn = this.turnOf(ev);
        this.endThink(turn);
        turn.live = '';
        // 同一段正文要一直并在一行里追加：中间插进来的思考不能把答复切成两行，
        // 否则收尾时只剩后半截被搬出回合。命令/审批会用 closeSay 收掉真正的段落边界。
        const say = turn.nodes.filter((n) => n.nk === 'say' && n.typing).pop();
        if (say) say.text += ev.text || '';
        else turn.nodes.push({ key: nextKey(), nk: 'say', text: ev.text || '', typing: true });
        this.stick();
        return;
      }
      if (ev.type === 'think') {
        const turn = this.turnOf(ev);
        turn.live = '';
        if (ev.state === 'end') {
          const open = turn.nodes.filter((n) => n.nk === 'think' && n.running).pop();
          if (open) {
            open.running = false;
            open.ms = ev.ms;
            open.open = false;
          }
          this.busy(turn, this.$t('ai.liveRequest'));
          return;
        }
        let node = turn.nodes[turn.nodes.length - 1];
        if (!node || node.nk !== 'think' || !node.running) {
          node = { key: nextKey(), nk: 'think', text: '', ms: null, running: true, startedAt: Date.now(), open: true };
          turn.nodes.push(node);
        }
        node.text += ev.text || '';
        this.stick();
        return;
      }
      if (ev.type === 'tool') {
        const turn = this.turnOf(ev);
        this.endThink(turn);
        this.closeSay(turn);
        let node = turn.nodes.find((n) => n.nk === 'cmd' && n.callId === ev.callId);
        if (!node) {
          node = {
            key: nextKey(), nk: 'cmd', callId: ev.callId, name: ev.name, command: ev.command || '',
            channel: ev.channel || 'exec', state: 'running', auto: !!ev.auto, output: '',
            exitCode: null, ms: null, open: true,
          };
          turn.nodes.push(node);
        }
        node.state = ev.state;
        node.auto = !!ev.auto || node.auto;
        if (ev.state === 'running') {
          this.busy(turn, '');
        } else {
          node.channel = ev.channel || node.channel;
          node.exitCode = ev.exitCode == null ? node.exitCode : ev.exitCode;
          node.ms = ev.ms;
          node.output = ev.output || node.output;
          node.open = false;
          this.busy(turn, this.$t('ai.liveNext'));
        }
        this.stick();
        return;
      }
      if (ev.type === 'approval') {
        const turn = this.turnOf(ev);
        this.endThink(turn);
        this.closeSay(turn);
        turn.live = '';
        turn.open = true;
        turn.nodes.push({
          key: nextKey(), nk: 'ask', requestId: ev.requestId, name: ev.name, command: ev.command || '',
          reason: ev.reason || '', readOnly: !!ev.readOnly, decided: '', askedAt: Date.now(), open: true,
        });
        this.needInput(this.$t('ai.needApproval'));
        this.stick();
        return;
      }
      if (ev.type === 'approval-resolved') {
        const node = this.findNode((n) => n.nk === 'ask' && n.requestId === ev.requestId);
        if (node) {
          node.decided = ev.reason === 'timeout' ? 'timeout' : 'deny';
          node.open = false;
        }
        return;
      }
      if (ev.type === 'ask') {
        const turn = this.turnOf(ev);
        this.endThink(turn);
        this.closeSay(turn);
        turn.live = '';
        turn.open = true;
        turn.nodes.push({
          key: nextKey(), nk: 'choice', requestId: ev.requestId, question: ev.question || '',
          options: ev.options || [], picked: '', state: 'waiting', askedAt: Date.now(), open: true,
        });
        this.needInput(this.$t('ai.needChoice'));
        this.stick();
        return;
      }
      if (ev.type === 'ask-resolved') {
        const node = this.findNode((n) => n.nk === 'choice' && n.requestId === ev.requestId);
        if (node) {
          node.state = 'skipped';
          node.open = false;
        }
        return;
      }
      if (ev.type === 'screen-request') {
        if (api.aiScreenReply) api.aiScreenReply({ sessionId: this.sessionId, requestId: ev.requestId, text: this.screenText() });
        return;
      }
      if (ev.type === 'done') {
        this.running = false;
        const turn = this.turnOf(ev);
        this.endThink(turn);
        this.closeSay(turn);
        turn.ms = ev.ms;
        turn.usage = ev.usage || null;
        turn.label = ev.error
          ? this.$t(ev.error.code === 'AI_MAX_TURNS' ? 'ai.turnUnfinished' : 'ai.turnStopped')
          : '';
        const settled = settleTurn(turn);
        if (settled.dropped) this.removeTurn(turn);
        if (settled.answer) this.items.push({ key: nextKey(), kind: 'answer', text: settled.answer, typing: false });
        // 第一轮提问起记录就存在，主进程把 id 带回来，面板立刻知道自己是「哪一条历史」
        if (ev.recordId) this.recordId = ev.recordId;
        this.error = ev.error && ev.error.code !== 'AI_CANCELED' ? ev.error : null;
        this.stick();
        return;
      }
    },

    findNode(match) {
      for (const row of this.items) {
        if (row.kind !== 'turn') continue;
        const hit = row.nodes.find(match);
        if (hit) return hit;
      }
      return null;
    },

    /** 需要用户参与（审批/反问）时通知宿主展开面板；面板本来收着才留一行说明。 */
    needInput(why) {
      if (!this.open) this.items.push({ key: nextKey(), kind: 'note', text: this.$t('ai.autoExpanded', { why }) });
      this.$emit('need-input', why);
    },

    toggleTurn(turn) {
      turn.open = !turn.open;
      if (turn.open) this.stick();
    },
    turnOpen(turn) {
      return !!turn.open;
    },
    toggleNode(node) {
      node.open = !node.open;
      if (node.open) this.stick();
    },

    headStat(turn) {
      const ms = turn.running ? this.tickNow - turn.started : turn.ms;
      if (ms == null) return turn.label || '';
      return fmtS(ms) + (turn.label ? ' · ' + turn.label : '');
    },
    headCount(turn) {
      // 中间正文不算「步」，否则一段长答复会被数成几十步
      const steps = turn.nodes.filter((n) => n.nk !== 'say');
      const parts = [];
      if (steps.length) parts.push(this.$t('ai.turnSteps', { n: steps.length }));
      const cmds = steps.filter((n) => n.nk === 'cmd').length;
      if (cmds) parts.push(this.$t('ai.turnCmds', { n: cmds }));
      return parts.join(' · ');
    },
    usageText(turn) {
      const u = turn.usage;
      if (!u || !(u.promptTokens || u.completionTokens)) return '';
      return this.$t('ai.turnUsage', { in: fmtK(u.promptTokens), out: fmtK(u.completionTokens) });
    },
    elapsed(from) {
      return from ? fmtS(this.tickNow - from) : '';
    },

    actClass(node) {
      if (node.nk === 'think') return node.running ? 'is-think is-live' : 'is-think';
      if (node.nk === 'cmd') return node.state === 'running' ? 'is-live' : node.state === 'denied' ? 'is-deny' : 'is-ok';
      if (node.nk === 'ask') return node.decided ? (node.decided === 'allow' ? 'is-ok' : 'is-deny') : 'is-ask';
      if (node.nk === 'choice') return node.state === 'waiting' ? 'is-ask' : node.picked ? 'is-ok' : 'is-deny';
      return '';
    },
    nodeIcon(node) {
      if (node.nk === 'think') return 'el-icon-magic-stick';
      if (node.nk === 'cmd') return node.state === 'denied' ? 'el-icon-circle-close' : 'el-icon-monitor';
      if (node.nk === 'ask') {
        if (!node.decided) return 'el-icon-warning';
        return node.decided === 'allow' ? 'el-icon-circle-check' : 'el-icon-circle-close';
      }
      if (node.state === 'waiting') return 'el-icon-question';
      return node.picked ? 'el-icon-circle-check' : 'el-icon-circle-close';
    },
    nodeTitle(node) {
      if (node.nk === 'think') return this.$t(node.running ? 'ai.thinkRunning' : 'ai.thinkDone');
      if (node.nk === 'cmd') return node.command || (node.name === 'read_terminal_screen' ? this.$t('ai.toolReadScreen') : node.name);
      const cmd = node.command || node.name;
      if (node.nk === 'ask') {
        if (!node.decided) return this.$t('ai.askTitle', { cmd });
        if (node.decided === 'timeout') return this.$t('ai.askTimeout', { cmd });
        return this.$t(node.decided === 'allow' ? 'ai.askAllowed' : 'ai.askDenied', { cmd });
      }
      if (node.state === 'waiting') return node.question;
      return node.picked ? this.$t('ai.choicePicked') : this.$t('ai.choiceSkipped');
    },
    nodeStat(node) {
      if (node.nk === 'think') return node.running ? this.elapsed(node.startedAt) : (node.ms ? this.$t('ai.thinkMs', { ms: fmtS(node.ms) }) : '');
      if (node.nk === 'cmd') {
        if (node.state === 'running') return this.$t('ai.stateRunning');
        if (node.state === 'denied') return this.$t('ai.stateDenied');
        const secs = node.ms ? ' · ' + fmtS(node.ms) : '';
        return node.exitCode === null || node.exitCode === undefined
          ? this.$t('ai.stateDone') + secs
          : this.$t('ai.stateExit', { code: node.exitCode }) + secs;
      }
      if (node.nk === 'ask') return node.decided ? this.$t('ai.decided.' + node.decided) : this.$t('ai.approveWait') + ' ' + this.elapsed(node.askedAt);
      if (node.state === 'waiting') return this.$t('ai.choiceWait') + ' ' + this.elapsed(node.askedAt);
      return node.picked ? clip(node.picked, 18) : '';
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
      const turn = this.startTurn('');
      this.error = null;
      this.running = true;
      this.follow = true;
      this.scrollToEnd();
      try {
        unwrap(await api.aiSend({ sessionId: this.sessionId, text, screen: this.screenText(), cwd: this.cwd, modelRef: this.modelRef, title: this.sessionTitle }));
      } catch (e) {
        this.running = false;
        // 主进程在校验阶段就回绝了（未启用、上一条还没结束等），不该留下空回合
        this.removeTurn(turn);
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      }
    },

    removeTurn(turn) {
      const at = this.items.indexOf(turn);
      if (at >= 0) this.items.splice(at, 1);
    },

    async cancel() {
      if (!this.sessionId || !api.aiCancel) return;
      try { await api.aiCancel({ sessionId: this.sessionId }); } catch (_) { /* 主进程会自己收尾 */ }
    },

    /** 新建会话：先让主进程把当前对话写成一条会话记录，再清空面板重新攒。 */
    async newSession() {
      if (this.running || this.archiveBusy) return;
      if (!this.items.length) { this.clearLocal(); return; }
      if (!api.aiArchiveSession) { this.error = { code: 'NO_BRIDGE', message: t('msg.needElectron') }; return; }
      this.archiveBusy = true;
      try {
        const r = unwrap(await api.aiArchiveSession({ sessionId: this.sessionId, title: this.sessionTitle }));
        if (this._disposed) return;
        this.clearLocal();
        if (r && r.archived) this.$message.success(t('ai.archived', { name: r.archived.title || t('ai.untitled') }));
      } catch (e) {
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      } finally {
        this.archiveBusy = false;
      }
    },

    clearLocal() {
      this.items = [];
      this.error = null;
      this.follow = true;
      this.sessionTitle = '';
      this.recordId = '';
      this.editingId = '';
    },

    async openHistory() {
      this.historyOpen = true;
      this.editingId = '';
      await this.refreshHistory();
    },

    async refreshHistory() {
      if (!this.available || !api.aiSessionList) return;
      this.historyLoading = true;
      try {
        const r = unwrap(await api.aiSessionList({ sessionId: this.sessionId }));
        if (this._disposed) return;
        this.historyRows = r.sessions || [];
        this.historyAsset = r.asset || null;
        if (r.current) this.recordId = r.current;
      } catch (e) {
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      } finally {
        this.historyLoading = false;
      }
    },

    /** 未归档的当前对话也占一行，否则用户看不到「正在写的这条」在哪。 */
    liveRow() {
      if (!this.items.length || this.recordId) return null;
      const texts = this.items.filter((i) => i.kind === 'user' || i.kind === 'answer');
      const last = texts[texts.length - 1];
      // 与落盘记录的 steps 同口径：只数命令、审批与反问，正文和思考不算
      let nodes = 0;
      for (const i of this.items) {
        if (i.kind !== 'turn') continue;
        nodes += i.nodes.filter((n) => n.nk === 'cmd' || n.nk === 'ask' || n.nk === 'choice').length;
      }
      const at = Date.now();
      return {
        id: 'live', isLive: true, title: this.sessionTitle, updatedAt: at, timeText: this.fmtTime(at),
        messages: texts.length, steps: nodes,
        preview: clip(String((last && last.text) || ''), 160),
      };
    },

    dayKey(ts) {
      const a = new Date(ts);
      const b = new Date();
      const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
      const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
      const diff = Math.round((db - da) / DAY_MS);
      return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : 'Earlier';
    },

    fmtTime(ts) {
      const d = new Date(ts);
      const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      return this.dayKey(ts) === 'Earlier'
        ? pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm
        : hm;
    },

    async loadSession(s) {
      if (s.isLive || s.id === this.recordId) { this.historyOpen = false; return; }
      // 当前对话还没落成文件，加载会覆盖面板：先归档，用户不同意就不动
      if (this.items.length && !this.recordId) {
        try {
          await this.$confirm(t('ai.loadConfirm', { name: this.sessionTitleText }), t('ai.loadConfirmTitle'), {
            confirmButtonText: t('ai.loadConfirmOk'),
            cancelButtonText: t('msg.cancel'),
            type: 'warning',
          });
        } catch (_) { return; }
      }
      if (!api.aiSessionOpen) { this.error = { code: 'NO_BRIDGE', message: t('msg.needElectron') }; return; }
      this.historyLoading = true;
      try {
        const r = unwrap(await api.aiSessionOpen({ sessionId: this.sessionId, id: s.id }));
        if (this._disposed) return;
        this.applySession(r.session);
        this.historyOpen = false;
        this.$message.success(t('ai.loaded', { name: r.session.title || t('ai.untitled') }));
      } catch (e) {
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      } finally {
        this.historyLoading = false;
      }
    },

    applySession(rec) {
      this.items = rowsFromRecord(rec.messages);
      this.error = null;
      this.follow = true;
      this.sessionTitle = rec.title || '';
      this.recordId = rec.id;
      this.scrollToEnd();
    },

    startRename(s) {
      this.editingId = s.id;
      this.editingTitle = s.title || '';
      this.$nextTick(() => {
        const refs = this.$refs.renameEl;
        const el = Array.isArray(refs) ? refs[0] : refs;
        if (el) el.focus();
      });
    },

    async saveRename(s) {
      const title = this.editingTitle.trim();
      this.editingId = '';
      if (!title) return;
      if (s.isLive) {
        this.sessionTitle = title;
        this.$message.success(t('ai.renamed', { name: title }));
        return;
      }
      if (!api.aiSessionRename) return;
      try {
        const r = unwrap(await api.aiSessionRename({ sessionId: this.sessionId, id: s.id, title }));
        const hit = this.historyRows.find((x) => x.id === s.id);
        if (hit) hit.title = r.session.title;
        if (s.id === this.recordId) this.sessionTitle = r.session.title;
        this.$message.success(t('ai.renamed', { name: r.session.title }));
      } catch (e) {
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      }
    },

    async deleteSession(s) {
      if (!api.aiSessionDelete) return;
      try {
        const r = unwrap(await api.aiSessionDelete({ sessionId: this.sessionId, id: s.id }));
        this.historyRows = this.historyRows.filter((x) => x.id !== s.id);
        if (r && r.cleared) this.clearLocal();
        this.$message.success(t('ai.deleted', { name: s.title || t('ai.untitled') }));
      } catch (e) {
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      }
    },

    async decide(node, decision) {
      node.decided = decision;
      node.open = false;
      if (!api.aiApprove) return;
      try {
        const r = unwrap(await api.aiApprove({ sessionId: this.sessionId, requestId: node.requestId, decision }));
        if (r && r.ok === false) { node.decided = ''; node.open = true; }
      } catch (e) {
        node.decided = '';
        node.open = true;
        this.error = { code: e.code || 'AI_REQUEST', message: e.message };
      }
    },

    /** 反问的答复同样走 ai:approve，只是 decision 换成选中的那一项文本；不选就什么都不发。 */
    async pick(node, option) {
      node.picked = option;
      node.state = 'picked';
      node.open = false;
      if (!api.aiApprove) return;
      try {
        const r = unwrap(await api.aiApprove({ sessionId: this.sessionId, requestId: node.requestId, choice: option }));
        if (r && r.ok === false) { node.picked = ''; node.state = 'waiting'; node.open = true; }
      } catch (e) {
        node.picked = '';
        node.state = 'waiting';
        node.open = true;
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

    /** 距底部还有余量就算「不在末尾」，留 24px 容忍滚动回整与亚像素。 */
    atBottom() {
      const el = this.$refs.logEl;
      if (!el) return true;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    },
    onLogScroll() {
      this.follow = this.atBottom();
    },
    goBottom() {
      this.follow = true;
      this.scrollToEnd();
    },
    /** 流式增量只在用户没有往上翻时才把会话区拽到底部。 */
    stick() {
      if (this.follow) this.scrollToEnd();
    },

    scrollToEnd() {
      this.$nextTick(() => {
        const el = this.$refs.logEl;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    /** 会话区高度随侧栏拖动/拆分窗口变化，细节上限只能实测，不能按视口估。 */
    observeLog() {
      if (typeof ResizeObserver !== 'function') return;
      if (this._ro) this._ro.disconnect();
      this._ro = new ResizeObserver(() => this.syncCap());
      if (this.$refs.logEl) this._ro.observe(this.$refs.logEl);
      this.syncCap();
    },
    syncCap() {
      const el = this.$refs.logEl;
      if (!el || !el.clientHeight) return;
      this.actCap = Math.max(CAP_MIN, Math.round(el.clientHeight * CAP_RATIO));
    },

    /** 心跳只在有东西在跳动时开启：进行中的回合、等审批/等选择的秒数。 */
    setTicker(on) {
      if (this._tick) {
        clearInterval(this._tick);
        this._tick = null;
      }
      if (!on) return;
      this._tick = setInterval(() => { this.tickNow = Date.now(); }, TICK_MS);
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
.panel-host { flex: 1; min-width: 0; font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
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
.ai-main {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}
.ai-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px 16px;
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
.ai-item { font-size: 12.5px; flex: none; }
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
.msg-ai-cursor {
  display: inline-block;
  width: 6px;
  height: 12px;
  background: var(--accent);
  vertical-align: -1px;
  animation: ai-blink 1s steps(1) infinite;
}
@keyframes ai-blink { 50% { opacity: 0; } }
/* 一次提问 = 一个逻辑回合，但视觉上不是一座卡片：头部一行灰字，步骤缩进在左侧细线里逐行排列 */
.turn-head {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 2px 0;
  border: none; background: none; color: var(--text-3); cursor: pointer; font-size: 11.5px; text-align: left;
}
.turn-head:hover { color: var(--text-2); }
.turn-head .h-ico { font-size: 12px; color: var(--text-3); flex: none; }
.turn.is-live .turn-head .h-ico { color: var(--accent); }
.turn.is-done .turn-head .h-ico { color: var(--success); }
.h-title { font-weight: 600; color: var(--text-2); white-space: nowrap; }
.turn.is-done .h-title { color: var(--text-3); font-weight: 500; }
.h-stat { color: var(--text-3); white-space: nowrap; }
.h-count { margin-left: auto; color: var(--text-3); font-size: 10.5px; white-space: nowrap; }
.h-caret { font-size: 11px; color: var(--text-3); flex: none; }
.turn-body {
  margin: 4px 0 0 6px; padding-left: 10px; border-left: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 3px;
}
.turn-body > * { flex: none; }
.act-head {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 4px; border-radius: 5px;
  border: none; background: none; color: var(--text-2); font-size: 11.5px; cursor: pointer; text-align: left;
}
.act-head:hover { background: var(--bg-hover); color: var(--text); }
.a-ico { font-size: 12px; color: var(--text-3); flex: none; }
.act.is-live .a-ico { color: var(--accent); }
.act.is-ok .a-ico { color: var(--success); }
.act.is-think .a-ico { color: var(--think); }
.act.is-ask .a-ico { color: var(--warning); }
.act.is-deny .a-ico { color: var(--danger); }
.a-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.a-title.mono { font-size: 11px; }
.a-stat { margin-left: auto; font-size: 10.5px; color: var(--text-3); white-space: nowrap; flex: none; }
.a-caret { font-size: 10px; color: var(--text-3); flex: none; }
.act-detail { margin: 2px 0 4px 18px; font-size: 11.5px; line-height: 1.7; color: var(--text-2); }
.think-text {
  white-space: pre-wrap; word-break: break-word;
  border-left: 2px solid var(--think); background: var(--think-soft);
  border-radius: 0 6px 6px 0; padding: 6px 9px; overflow-y: auto;
}
.cmd-line {
  padding: 5px 8px; margin-bottom: 5px; background: var(--bg-elevated);
  border: 1px solid var(--border); border-radius: 5px;
  font-size: 11.5px; color: var(--text); white-space: pre-wrap; word-break: break-all;
}
.cmd-out {
  padding: 6px 8px; background: var(--bg-elevated);
  border: 1px solid var(--border); border-radius: 5px;
  font-size: 11px; color: var(--text-2); white-space: pre-wrap; overflow-y: auto;
}
.typing::after {
  content: ''; display: inline-block; width: 5px; height: 11px; margin-left: 2px;
  background: var(--think); vertical-align: -1px; animation: ai-blink 1s steps(1) infinite;
}
.say { color: var(--text); line-height: 1.7; padding: 2px 0; }
.step-note { font-size: 10.5px; color: var(--text-3); line-height: 1.6; }
.step-note.is-center { text-align: center; }
.turn-live {
  display: flex; align-items: center; gap: 8px; padding: 3px 4px;
  font-size: 11.5px; color: var(--text-2);
}
.turn-live .dots { display: inline-flex; gap: 3px; }
.turn-live .dots b {
  width: 4px; height: 4px; border-radius: 50%; background: var(--accent);
  animation: ai-bounce 1.1s infinite ease-in-out;
}
.turn-live .dots b:nth-child(2) { animation-delay: 0.16s; }
.turn-live .dots b:nth-child(3) { animation-delay: 0.32s; }
.turn-live .lbl { color: var(--text-3); margin-left: auto; }
@keyframes ai-bounce { 0%, 70%, 100% { transform: translateY(0); opacity: 0.45; } 35% { transform: translateY(-4px); opacity: 1; } }
.turn-usage { font-size: 10.5px; color: var(--text-3); text-align: right; padding-top: 2px; }
.answer { color: var(--text); }
.ask-btns { margin-top: 7px; display: flex; gap: 7px; }
.choice-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.choice {
  text-align: left; padding: 6px 9px; border-radius: 6px; cursor: pointer; font-size: 11.5px;
  border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text);
}
.choice:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.choice .k { color: var(--text-3); margin-right: 7px; font-family: Consolas, "Courier New", monospace; }
.choice.is-picked { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); cursor: default; }
.choice.is-dim { opacity: 0.45; cursor: default; }
.choice:disabled { cursor: not-allowed; }
.back-tail {
  position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 2;
  padding: 3px 11px; border-radius: 999px; cursor: pointer; font-size: 10.5px;
  background: var(--bg-elevated); border: 1px solid var(--accent); color: var(--accent);
}
.back-tail:hover { background: var(--accent-soft); }
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

/* 历史会话弹框：append-to-body 后节点不在本组件作用域内，样式统一收在 ai-hist 命名空间 */
.ai-hist { display: flex; flex-direction: column; max-height: 84vh; }
.ai-hist .el-dialog__header { padding: 14px 18px 10px; border-bottom: 1px solid var(--border); }
.ai-hist .el-dialog__body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 18px; }
.ai-hist .el-dialog__footer { padding: 10px 18px; border-top: 1px solid var(--border); }
.ai-hist .hist-head { display: flex; align-items: baseline; gap: 10px; padding-right: 24px; }
.ai-hist .hist-title { font-size: 15px; font-weight: 600; color: var(--text); }
.ai-hist .hist-sub { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-hist .hist-tools { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 0 10px; border-bottom: 1px solid var(--border); }
.ai-hist .hist-search { width: 220px; }
.ai-hist .hist-sort { width: 96px; }
.ai-hist .hist-count { margin-left: auto; font-size: 11px; color: var(--text-3); white-space: nowrap; }
.ai-hist .hist-list { flex: none; height: 430px; overflow-y: auto; padding: 4px 0 10px; }
.ai-hist .hist-empty { padding: 44px 0; text-align: center; font-size: 12px; color: var(--text-3); }
.ai-hist .hist-group { padding: 12px 2px 6px; font-size: 10.5px; letter-spacing: 0.8px; color: var(--text-3); }
.ai-hist .hist-row {
  display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 7px;
  border: 1px solid transparent; cursor: pointer;
}
.ai-hist .hist-row:hover { background: var(--bg-elevated); border-color: var(--border); }
.ai-hist .hist-row.is-cur { background: var(--accent-soft); border-color: var(--accent); }
.ai-hist .hist-ico { width: 24px; height: 24px; flex: none; border-radius: 6px; background: var(--bg-hover); color: var(--text-3); display: flex; align-items: center; justify-content: center; font-size: 12px; }
.ai-hist .hist-row.is-cur .hist-ico { background: var(--accent); color: #fff; }
.ai-hist .hist-main { flex: 1; min-width: 0; }
.ai-hist .hist-line { display: flex; align-items: center; gap: 7px; }
.ai-hist .hist-name { font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-hist .hist-chip { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--bg-hover); color: var(--text-2); flex: none; }
.ai-hist .hist-chip.is-cur { background: var(--accent); color: #fff; }
.ai-hist .hist-chip.is-open { background: rgba(230, 162, 60, 0.16); color: var(--warning); }
.ai-hist .hist-edit { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
.ai-hist .hist-yes,
.ai-hist .hist-no {
  flex: none; width: 24px; height: 24px; border-radius: 50%; cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 12px;
  border: 1px solid var(--border); background: var(--bg-panel); color: var(--text-2);
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.ai-hist .hist-yes:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
.ai-hist .hist-no:hover { background: var(--bg-hover); border-color: var(--text-3); color: var(--danger); }
.ai-hist .hist-meta { display: flex; align-items: center; gap: 8px; margin-top: 3px; font-size: 11px; color: var(--text-3); }
.ai-hist .hist-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-hist .hist-acts { flex: none; display: flex; align-items: center; gap: 6px; opacity: 0; transition: opacity 0.12s ease; }
.ai-hist .hist-row:hover .hist-acts,
.ai-hist .hist-row.is-edit .hist-acts { opacity: 1; }
.ai-hist .hist-acts .el-button + .el-button { margin-left: 0; }
.ai-hist .hist-acts .el-button.is-circle,
.ai-hist .hist-acts .el-button [class*="el-icon-"] + span { margin-left: 0; }
.ai-hist .hist-del:hover { color: var(--danger); border-color: var(--danger); }
.ai-hist .hist-foot { display: flex; align-items: center; justify-content: flex-end; }
</style>
