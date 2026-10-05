<template>
  <div ref="wrapEl" class="ssh-term-wrap">
    <div class="ssh-toolbar">
      <span class="pill ssh">{{ shortLabel }}</span>
      <span class="ssh-status" :class="status">{{ statusText }}</span>
      <span class="ssh-meta">{{ title }}</span>
      <el-tooltip :content="$t('ssh.fullscreenTip')" placement="top">
        <button
          type="button"
          class="gear-icon-btn"
          @click="onToggleFullscreen"
        >
          <svg-icon :name="isFullscreen ? 'fullscreen-out' : 'fullscreen-in'" />
        </button>
      </el-tooltip>
      <el-tooltip :content="$t('theme.tip')" placement="top">
        <button
          type="button"
          class="gear-icon-btn"
          @click="openThemeDialog"
        >
          <svg-icon name="palette" />
        </button>
      </el-tooltip>
      <el-tooltip :content="$t('sftp.openTip')" placement="top">
        <button
          type="button"
          class="gear-icon-btn"
          :disabled="!assetId"
          @click="openSftp"
        >
          <svg-icon name="folder-download" />
        </button>
      </el-tooltip>
      <el-tooltip :content="connToggleTip" placement="top">
        <button
          type="button"
          class="gear-icon-btn"
          :class="{ 'is-danger': !isDisconnected }"
          @click="onConnToggle"
        >
          <!-- disconnected → reconnect (link); connecting/ready → disconnect (broken link) -->
          <svg-icon :name="isDisconnected ? 'link' : 'link-broken'" />
        </button>
      </el-tooltip>
    </div>
    <div class="ssh-body">
      <div class="ssh-term-main">
        <button
          type="button"
          class="monitor-toggle"
          :class="{ active: monitorOpen }"
          :title="$t('monitor.toggleTip')"
          @click="toggleMonitor"
        >
          <svg-icon name="monitor-pulse" :size="15" />
        </button>
        <button
          v-if="aiEnabled"
          type="button"
          class="monitor-toggle ai-toggle"
          :class="{ active: aiOpen, busy: aiRunning }"
          :title="$t('ai.toggleTip')"
          @click="toggleAi"
        >
          <svg-icon name="ai" :size="15" />
          <span v-if="aiUnread" class="ai-unread">{{ aiUnread > 9 ? '9+' : aiUnread }}</span>
        </button>
        <div ref="termEl" class="ssh-term"></div>
      </div>
      <div class="ssh-monitor-host" :class="{ open: sideOpen, dragging: monitorDragging || sideDragging }" :style="monitorHostStyle">
        <div
          v-show="sideOpen"
          ref="monitorSplitter"
          class="monitor-splitter"
          @mousedown="onSplitStart"
        >
          <span class="grip"></span>
        </div>
        <div class="ssh-side-col">
          <div v-show="monitorOpen" class="ssh-side-pane" :style="monitorPaneStyle">
            <ssh-monitor-panel
              v-if="monitorEver"
              ref="monitorPanel"
              :state="monitorState"
              :meta="monitorMeta"
              :snapshot="monitorSnapshot"
              :interval-sec="monitorIntervalSec"
              @close="closeMonitor"
              @interval-change="onMonitorInterval"
            />
          </div>
          <div v-if="monitorOpen && aiOpen" class="side-hsplit" @mousedown="onSideSplitStart"><i></i></div>
          <div v-show="aiOpen" class="ssh-side-pane" :style="aiPaneStyle">
            <ai-assistant-panel
              v-if="aiEver"
              ref="aiPanel"
              :session-id="liveSessionId || ''"
              :connected="status === 'ready'"
              :host-text="title"
              :cwd="oscCwd"
              :read-screen="readScreenText"
              :open="aiOpen"
              @close="closeAi"
              @need-input="onAiNeedInput"
              @running-change="aiRunning = $event"
            />
          </div>
        </div>
      </div>
    </div>
    <transition name="fs-hint">
      <div v-if="fsHint" class="fs-hint">
        <kbd>Esc</kbd><span>{{ $t('ssh.fullscreenExitHint') }}</span>
      </div>
    </transition>
    <ssh-theme-dialog ref="themeDialog" :asset-id="assetId" :in-fullscreen="isFullscreen" @saved="onThemeSaved" />
  </div>
</template>

<script>
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, unwrap, refresh, findAsset, store, takeSessionHandover } from '../store';
import { t } from '../i18n';
import { sshThemeToXterm, resolveSshTheme } from '../constants';
import SshThemeDialog from './SshThemeDialog.vue';
import createFullscreenMixin from './session/fullscreen';

const FIT_DEBOUNCE_MS = 120;
const REMOTE_RESIZE_DEBOUNCE_MS = 220;
/** 页签状态点：ended 与 idle 同样归为未连接的灰色。 */
const DOT_STATE = { connecting: 'connecting', ready: 'ready', error: 'error' };

export default {
  name: 'TerminalView',
  components: {
    SshThemeDialog,
    SshMonitorPanel: () => import('./SshMonitorPanel.vue'),
    AiAssistantPanel: () => import('./AiAssistantPanel.vue'),
  },
  mixins: [createFullscreenMixin({
    fallbackClass: 'is-terminal-fullscreen',
    onResize() { this.scheduleFit(); },
  })],
  props: {
    sessionId: { type: String, required: true },
    assetId: { type: String, required: true },
    methodId: { type: String, default: 'ssh' },
    /** Set when this instance should re-host an already open session instead of connecting. */
    attachSessionId: { type: String, default: '' },
    title: { type: String, default: '' },
    /** true when this terminal tab is the active view — keep session, only refit */
    active: { type: Boolean, default: true },
  },
  data() {
    return {
      status: 'idle',
      statusDetail: '',
      liveSessionId: null,
      term: null,
      fit: null,
      offData: null,
      offState: null,
      ro: null,
      roTerm: null,
      monitorOpen: false,
      monitorEver: false,
      monitorState: 'probing',
      monitorMeta: null,
      monitorSnapshot: null,
      monitorWidth: 30,
      monitorDragging: false,
      monitorIntervalSec: null,
      oscCwd: '',
      aiOpen: false,
      aiEver: false,
      /** 面板在跑回合时半圆亮提示点；回合归属主进程，收起面板也不会停。 */
      aiRunning: false,
      /** 面板收起时到达的审批/反问数，角标亮一下随后随自动展开清零。 */
      aiUnread: 0,
      /** 两个面板同时打开时的高度分配（监控占比 %），拖拽中间横条调整。 */
      sideSplit: 52,
      sideDragging: false,
    };
  },
  computed: {
    /** 设置里关掉助手就收起半圆按钮；未定义按开启处理，避免旧配置没有 ai 段时按钮消失。 */
    aiEnabled() {
      const ai = (store.snapshot.settings || {}).ai;
      return !ai || ai.enabled !== false;
    },
    /** 监控与 AI 共用右侧这一列，任一打开就占宽，避免把终端挤两次。 */
    sideOpen() {
      return this.monitorOpen || this.aiOpen;
    },
    monitorHostStyle() {
      const pct = this.sideOpen ? this.monitorWidth : 0;
      return { width: pct + '%', flexBasis: pct + '%' };
    },
    monitorPaneStyle() {
      return this.monitorOpen && this.aiOpen ? { flex: '0 0 ' + this.sideSplit + '%' } : {};
    },
    aiPaneStyle() {
      return this.monitorOpen && this.aiOpen ? { flex: '1 1 0%' } : {};
    },
    shortLabel() {
      return this.methodId === 'ssh' ? 'SSH' : String(this.methodId || '').toUpperCase();
    },
    statusText() {
      const map = {
        idle: t('ssh.status.idle'),
        connecting: t('ssh.status.connecting'),
        ready: t('ssh.status.ready'),
        ended: t('ssh.status.ended'),
        error: t('ssh.status.error'),
      };
      return (map[this.status] || this.status) + (this.statusDetail ? ' · ' + this.statusDetail : '');
    },
    /** ended/error → show reconnect; connecting/ready/idle → show disconnect */
    isDisconnected() {
      return this.status === 'ended' || this.status === 'error';
    },
    connToggleTip() {
      return this.isDisconnected ? t('ssh.reconnect') : t('ssh.disconnect');
    },
  },
  watch: {
    status(val) {
      const connected = val === 'connecting' || val === 'ready';
      const tab = store.tabs.find((t) => t.id === this.sessionId);
      if (tab) tab.connState = DOT_STATE[val] || 'idle';
      this.$emit('connection', connected);
      if (val === 'ready') {
        if (this.monitorOpen && this.monitorState !== 'live') this.startMonitor();
      } else if (val === 'ended' || val === 'error') {
        if (this.monitorOpen) {
          this.stopMonitor();
          this.monitorState = 'offline';
        }
      }
    },
    // Tab switched back → layout is visible again; refit only, do NOT reconnect
    active(v) {
      if (v) {
        this._lastW = 0;
        this._lastH = 0;
        this.$nextTick(() => {
          this.scheduleFit();
          // xterm only receives keystrokes while focused; tab switches can steal it
          if (this.term) {
            try {
              this.term.focus();
            } catch (_) {}
          }
        });
      }
    },
  },
  created() {
    this._disposed = false;
    this._connectVersion = 0;
    this._handedOff = false;
    this._aiUnreadTimer = null;
    this._inputSubscriptions = [];
    this._offMonitor = null;
    this._offMonitorEnd = null;
    this._splitMove = null;
    this._splitUp = null;
    this._sideMove = null;
    this._sideUp = null;
    this._offOsc7 = null;
  },
  mounted() {
    this._fitTimer = null;
    this._rsTimer = null;
    this._lastW = 0;
    this._lastH = 0;
    this._sentCols = 0;
    this._sentRows = 0;
    this._fitting = false;
    this.initTerm();
    if (this.attachSessionId && api.sshAttach) this.attachTo(this.attachSessionId);
    else this.connect();
    window.addEventListener('resize', this.scheduleFit);
  },
  activated() {
    this.scheduleFit();
  },
  beforeDestroy() {
    this._disposed = true;
    window.removeEventListener('resize', this.scheduleFit);
    if (this._fitTimer) clearTimeout(this._fitTimer);
    if (this._rsTimer) clearTimeout(this._rsTimer);
    if (this._aiUnreadTimer) clearTimeout(this._aiUnreadTimer);
    if (this._offMonitor) {
      this._offMonitor();
      this._offMonitor = null;
    }
    if (this._offMonitorEnd) {
      this._offMonitorEnd();
      this._offMonitorEnd = null;
    }
    if (this._splitMove) {
      window.removeEventListener('mousemove', this._splitMove);
      this._splitMove = null;
    }
    if (this._splitUp) {
      window.removeEventListener('mouseup', this._splitUp);
      this._splitUp = null;
    }
    if (this._sideMove) {
      window.removeEventListener('mousemove', this._sideMove);
      this._sideMove = null;
    }
    if (this._sideUp) {
      window.removeEventListener('mouseup', this._sideUp);
      this._sideUp = null;
    }
    document.body.style.userSelect = '';
    if (this.monitorOpen && this.liveSessionId && api.monitorStop) {
      try {
        const r = api.monitorStop(this.liveSessionId);
        if (r && typeof r.then === 'function') r.catch(() => {});
      } catch (_) {}
    }
    // A handover means another window is about to re-host this very connection.
    if (this.liveSessionId && takeSessionHandover(this.sessionId)) this.releaseHost();
    else this.disconnectNow(true);
    this.teardownTerm();
  },
  methods: {
    /** Read this asset's saved SSH color scheme (or defaults if unset) */
    getAssetTheme() {
      const hit = findAsset(this.assetId);
      const adv = hit && hit.asset.methods && hit.asset.methods.ssh && hit.asset.methods.ssh.advanced;
      return resolveSshTheme((adv && adv.colors) || null);
    },
    /** Sync CSS background + xterm theme so both render surfaces match */
    syncSurface(colors) {
      const theme = sshThemeToXterm(colors);
      const bg = theme.background || '#000000';
      const el = this.$refs.wrapEl;
      if (el) el.style.setProperty('--ssh-bg', bg);
      if (this.term) {
        try {
          // xterm 5.5: assigning options.theme triggers a repaint; setOption('theme') does not
          this.term.options.theme = theme;
        } catch (_) {}
      }
      return theme;
    },
    applyTheme(colors) {
      this.syncSurface(colors || this.getAssetTheme());
    },
    openThemeDialog() {
      this.$refs.themeDialog && this.$refs.themeDialog.open();
    },
    onThemeSaved(colors) {
      this.applyTheme(colors);
    },
    initTerm() {
      if (this.term) return;
      const term = new Terminal({
        fontSize: 13,
        fontFamily: 'Consolas, "Courier New", monospace',
        cursorBlink: true,
        convertEol: false,
        // Avoid scrollback thrash during resize reflow
        scrollback: 2000,
        theme: sshThemeToXterm(this.getAssetTheme()),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(this.$refs.termEl);
      this.term = term;
      this.fit = fit;
      // 远端 shell 自带集成时会用 OSC 7 报告当前目录，记下它供 SFTP 打开时定位
      this._offOsc7 = term.parser.registerOscHandler(7, (data) => this.onOscCwd(data));
      // sync CSS background variable with theme (canvas bg comes from options.theme)
      this.syncSurface(this.getAssetTheme());
      this._lastW = 0;
      this._lastH = 0;
      this.scheduleFit();
      // Grab focus so typing works immediately (open() does not focus)
      try {
        term.focus();
      } catch (_) {}

      this._inputSubscriptions.push(term.onData((data) => this.sendInput(data)));
      this._inputSubscriptions.push(term.onBinary((data) => this.sendInput(data, true)));

      // Xshell-style right click: copy selection, or paste if none
      this._onTermCtx = (e) => this.onTermContextmenu(e);
      const termEl = this.$refs.termEl;
      if (termEl) {
        termEl.addEventListener('contextmenu', this._onTermCtx);
      }

      // Observe the outer wrap (stable flex box), not the xterm DOM
      if (window.ResizeObserver) {
        this.ro = new ResizeObserver(() => this.scheduleFit());
        const target = this.$refs.wrapEl || this.$refs.termEl;
        if (target) this.ro.observe(target);
        // The monitor panel changes the terminal width without touching the wrap, so the
        // terminal element itself needs its own observer.
        this.roTerm = new ResizeObserver(() => this.scheduleFit());
        if (this.$refs.termEl) this.roTerm.observe(this.$refs.termEl);
      }
    },

    async sendInput(data, binary = false) {
      const sid = this.liveSessionId;
      if (!sid || this.status !== 'ready') return;
      try {
        const write = binary ? api.sshWriteBinary : api.sshWrite;
        unwrap(await write(sid, data));
        if (this.liveSessionId === sid) this.statusDetail = '';
      } catch (error) {
        if (this.liveSessionId === sid && !this._disposed) this.statusDetail = error.message || error.code;
      }
    },
    onTermContextmenu(e) {
      e.preventDefault();
      e.stopPropagation();
      const term = this.term;
      if (!term) return;
      let selected = '';
      try {
        selected = term.hasSelection && term.hasSelection() ? term.getSelection() : '';
      } catch (_) {
        selected = '';
      }
      if (selected && String(selected).length) {
        this.copySelection(selected);
      } else {
        this.pasteFromClipboard();
      }
    },
    async copySelection(text) {
      const value = String(text || '');
      if (!value) return;
      try {
        if (api.clipboardWriteText) {
          const ok = await api.clipboardWriteText(value);
          if (ok) {
            this.$message.success(this.$t('clipboard.copied'));
            return;
          }
        }
      } catch (_) {}
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          this.$message.success(this.$t('clipboard.copied'));
          return;
        }
      } catch (_) {}
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this.$message.success(this.$t('clipboard.copied'));
      } catch (err) {
        this.$message.error(this.$t('clipboard.copyFail'));
      }
    },
    async pasteFromClipboard() {
      let text = '';
      try {
        if (api.clipboardReadText) {
          text = await api.clipboardReadText();
        }
      } catch (_) {
        text = '';
      }
      if (!text) {
        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            text = await navigator.clipboard.readText();
          }
        } catch (_) {
          text = '';
        }
      }
      if (!text) {
        this.$message.warning(this.$t('clipboard.empty'));
        return;
      }
      const term = this.term;
      if (!term) return;
      // Prefer term.paste (handles \n → CR for shell)
      try {
        if (typeof term.paste === 'function') {
          term.paste(text);
        } else {
          await this.sendInput(text.replace(/\r?\n/g, '\r'));
        }
      } catch (err) {
        this.$message.error(this.$t('clipboard.pasteFail'));
      }
    },

    scheduleFit() {
      if (this._disposed) return;
      if (this._fitTimer) clearTimeout(this._fitTimer);
      this._fitTimer = setTimeout(() => this.doFit(), FIT_DEBOUNCE_MS);
    },

    doFit() {
      if (!this.term || !this.fit || this._fitting) return;
      const el = this.$refs.termEl;
      if (!el) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w < 60 || h < 40) return;
      // Skip if container pixel size unchanged — prevents fit ↔ layout loops
      if (w === this._lastW && h === this._lastH) return;
      this._lastW = w;
      this._lastH = h;

      const prevCols = this.term.cols;
      const prevRows = this.term.rows;
      this._fitting = true;
      try {
        this.fit.fit();
      } catch (_) {
        /* ignore */
      }
      this._fitting = false;

      const cols = this.term.cols;
      const rows = this.term.rows;
      if (cols !== prevCols || rows !== prevRows) {
        this.scheduleRemoteResize();
      }
    },

    /** Only push TIOCSWINSZ to remote when cols/rows actually changed */
    scheduleRemoteResize() {
      if (this._disposed) return;
      if (this._rsTimer) clearTimeout(this._rsTimer);
      this._rsTimer = setTimeout(async () => {
        const sid = this.liveSessionId;
        if (!sid || !this.term || this.status !== 'ready') return;
        const cols = this.term.cols;
        const rows = this.term.rows;
        if (!cols || !rows) return;
        if (this._sentCols === cols && this._sentRows === rows) return;
        try {
          const resized = unwrap(await api.sshResize(sid, cols, rows));
          if (resized && this.liveSessionId === sid && !this._disposed) {
            this._sentCols = cols;
            this._sentRows = rows;
          }
        } catch (error) {
          if (this.liveSessionId === sid && this.status === 'ready' && !this._disposed) {
            this.statusDetail = error.message || error.code;
          }
        }
      }, REMOTE_RESIZE_DEBOUNCE_MS);
    },

    teardownTerm() {
      for (const subscription of this._inputSubscriptions) subscription.dispose();
      this._inputSubscriptions = [];
      if (this.offData) {
        this.offData();
        this.offData = null;
      }
      if (this.offState) {
        this.offState();
        this.offState = null;
      }
      if (this.ro) {
        try {
          this.ro.disconnect();
        } catch (_) {}
        this.ro = null;
      }
      if (this.roTerm) {
        try {
          this.roTerm.disconnect();
        } catch (_) {}
        this.roTerm = null;
      }
      const termEl = this.$refs.termEl;
      if (termEl && this._onTermCtx) {
        try {
          termEl.removeEventListener('contextmenu', this._onTermCtx);
        } catch (_) {}
      }
      this._onTermCtx = null;
      if (this._offOsc7) {
        try {
          this._offOsc7.dispose();
        } catch (_) {}
        this._offOsc7 = null;
      }
      this.oscCwd = '';
      if (this.term) {
        try {
          this.term.dispose();
        } catch (_) {}
        this.term = null;
        this.fit = null;
      }
    },

    writeOut(text) {
      if (!this.term) return;
      this.term.writeln(text);
    },

    chunkToWrite(payload) {
      if (payload == null) return null;
      if (typeof payload === 'string') return payload;
      if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
      if (ArrayBuffer.isView(payload)) return payload;
      if (payload.type === 'Buffer' && Array.isArray(payload.data)) {
        return Uint8Array.from(payload.data);
      }
      return payload;
    },

    /** Subscribe before the shell starts so the first output cannot be lost. */
    bindSession(sid, isCurrent) {
      this.offData = api.onSshData(sid, (payload) => {
        if (!isCurrent() || !this.term) return;
        const chunk = this.chunkToWrite(payload);
        if (chunk != null) this.term.write(chunk);
      });
      this.offState = api.onSshState((ev) => {
        if (!isCurrent() || !ev || ev.sessionId !== sid) return;
        if (ev.type === 'ready') {
          this.status = 'ready';
          this.statusDetail = '';
        } else if (ev.type === 'ended' || ev.type === 'error') {
          this.disconnectNow(true);
          this.status = ev.type === 'error' ? 'error' : 'ended';
          this.statusDetail = ev.type === 'error' ? ev.message || ev.code || '' : '';
          this.writeOut(ev.type === 'error'
            ? (t('ssh.errorPrefix') + ' ' + this.statusDetail).trim()
            : t('ssh.endedHint'));
        }
      });
    },

    /**
     * Take over a session that stays open in the main process (tab ⇄ detached window). The tail is
     * what the previous instance already rendered, so the user keeps the screen they had.
     */
    async attachTo(sid) {
      if (this._disposed) return;
      if (!this.term) this.initTerm();
      this.disconnectNow(true);
      const version = this._connectVersion;
      this.status = 'connecting';
      this.statusDetail = '';
      this._sentCols = 0;
      this._sentRows = 0;
      this._lastW = 0;
      this._lastH = 0;
      this.scheduleFit();
      if (this.term) this.term.clear();
      this.liveSessionId = sid;
      this.$emit('session', sid);

      const isCurrent = () => !this._disposed && this._connectVersion === version && this.liveSessionId === sid;
      try {
        this.bindSession(sid, isCurrent);
        this.doFit();
        const cols = (this.term && this.term.cols) || 120;
        const rows = (this.term && this.term.rows) || 32;
        const r = unwrap(await api.sshAttach({ tabId: this.sessionId, sessionId: sid, cols, rows }));
        if (!isCurrent()) return;
        this._sentCols = cols;
        this._sentRows = rows;
        if (this.term && r.tail) r.tail.forEach((chunk) => this.term.write(chunk));
        this.status = r.ready ? 'ready' : 'connecting';
        // The previous host may have left a monitor runner polling for its now-dead window.
        if (!this.monitorOpen) this.stopMonitor();
        refresh().catch(() => {});
        if (this.active && this.term) this.term.focus();
      } catch (e) {
        if (!isCurrent()) return;
        if (e.code === 'SSH_GONE') {
          // Nothing left to take over (e.g. it was reconnected in the other window), so start fresh.
          this.connect();
          return;
        }
        this.disconnectNow(true);
        this.status = 'error';
        this.statusDetail = e.message || e.code || '';
        this.writeOut((t('ssh.errorPrefix') + ' ' + this.statusDetail).trim());
      }
    },

    /** Drop this window's hooks but keep the main-process connection for the next host. */
    releaseHost() {
      this._connectVersion += 1;
      this._handedOff = true;
      if (this._rsTimer) clearTimeout(this._rsTimer);
      if (this.offData) {
        this.offData();
        this.offData = null;
      }
      if (this.offState) {
        this.offState();
        this.offState = null;
      }
      this.status = 'idle';
    },

    async connect() {
      if (this._disposed) return;
      if (!this.term) this.initTerm();
      this.disconnectNow(true);
      const version = this._connectVersion;
      this._handedOff = false;
      this.status = 'connecting';
      this.statusDetail = '';
      this._sentCols = 0;
      this._sentRows = 0;
      this._lastW = 0;
      this._lastH = 0;
      this.scheduleFit();
      if (this.term) this.term.clear();
      this.writeOut(t('ssh.connectingHint', { host: this.title || this.assetId }));

      if (!api.sshConnect) {
        this.status = 'error';
        this.writeOut(t('msg.needElectron'));
        return;
      }

      const sid = 'ssh-' + crypto.randomUUID();
      const isCurrent = () => !this._disposed && this._connectVersion === version && this.liveSessionId === sid;
      this.liveSessionId = sid;
      this.$emit('session', sid);
      try {
        this.bindSession(sid, isCurrent);
        this.doFit();
        const cols = (this.term && this.term.cols) || 120;
        const rows = (this.term && this.term.rows) || 32;
        const result = unwrap(await api.sshConnect({
          requestId: sid,
          assetId: this.assetId,
          methodId: this.methodId,
          cols,
          rows,
        }));
        if (!isCurrent()) {
          // Handover means another window re-hosted this very session id, so it stays open there.
          if (!this._handedOff) await api.sshDisconnect(result.sessionId);
          return;
        }
        this._sentCols = cols;
        this._sentRows = rows;
        this.status = 'ready';
        this.statusDetail = '';
        refresh().catch(() => {});
        this.scheduleRemoteResize();
        if (this.active && this.term) this.term.focus();
      } catch (e) {
        if (!isCurrent()) return;
        this.disconnectNow(true);
        this.status = 'error';
        this.statusDetail = e.message || e.code || '';
        this.writeOut((t('ssh.errorPrefix') + ' ' + this.statusDetail).trim());
      }
    },

    reconnect() {
      this.connect();
    },

    /** Single toggle: disconnected → reconnect; otherwise disconnect */
    onConnToggle() {
      if (this.isDisconnected) {
        this.reconnect();
      } else {
        this.disconnectNow(false);
      }
    },

    toggleMonitor() {
      if (this.monitorOpen) {
        this.closeMonitor();
        return;
      }
      this.monitorOpen = true;
      this.monitorEver = true;
      this.subscribeMonitor();
      if (this.status === 'ready') this.startMonitor();
      else this.monitorState = 'offline';
    },

    closeMonitor() {
      this.monitorOpen = false;
      this.stopMonitor();
    },

    toggleAi() {
      this.aiOpen = !this.aiOpen;
      // 面板一旦创建就常驻：回合在主进程里继续跑，收起只藏起来，重开时接上同一份历史
      this.aiEver = true;
      this.aiUnread = 0;
      if (this.aiOpen) this.scheduleFit();
    },

    closeAi() {
      this.aiOpen = false;
      this.aiUnread = 0;
      this.scheduleFit();
    },

    /** 审批/反问到达但面板收着：先亮角标，片刻后自动展开，让用户看见「有事发生」再看到问题。 */
    onAiNeedInput() {
      if (this.aiOpen) return;
      this.aiUnread += 1;
      if (this._aiUnreadTimer) return;
      this._aiUnreadTimer = setTimeout(() => {
        this._aiUnreadTimer = null;
        this.aiUnread = 0;
        if (this._disposed || this.aiOpen) return;
        this.aiOpen = true;
        this.aiEver = true;
        this.scheduleFit();
      }, 1200);
    },

    /** 交给 AI 面板取屏幕文本：xterm 的 buffer 已是去掉转义序列的纯文本，比剥 tail 的 ANSI 干净。 */
    readScreenText() {
      const term = this.term;
      if (!term) return '';
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i += 1) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return lines.join('\n');
    },

    onSideSplitStart(e) {
      e.preventDefault();
      if (this._sideMove) return;
      const onMove = (ev) => {
        const col = this.$refs.wrapEl && this.$refs.wrapEl.querySelector('.ssh-side-col');
        if (!col) return;
        const rect = col.getBoundingClientRect();
        const pct = ((ev.clientY - rect.top) / rect.height) * 100;
        this.sideSplit = Math.min(76, Math.max(24, pct));
      };
      const onUp = () => {
        this.sideDragging = false;
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        this._sideMove = null;
        this._sideUp = null;
      };
      this.sideDragging = true;
      document.body.style.userSelect = 'none';
      this._sideMove = onMove;
      this._sideUp = onUp;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },

    async onMonitorInterval(sec) {
      const value = Number(sec);
      if (!Number.isInteger(value) || value < 1 || value > 60) return;
      this.monitorIntervalSec = value;
      const sid = this.liveSessionId;
      if (!sid || this.status !== 'ready' || !this.monitorOpen || !api.monitorStart) return;
      try {
        const r = unwrap(await api.monitorStart(sid, value));
        if (this._disposed || this.liveSessionId !== sid) return;
        if (r && r.intervalSec) this.monitorIntervalSec = r.intervalSec;
      } catch (_) {
        /* the running monitor keeps its old cadence */
      }
    },

    subscribeMonitor() {
      if (this._offMonitor || !api.onMonitorSnapshot) return;
      this._offMonitor = api.onMonitorSnapshot((ev) => {
        if (this._disposed || !ev || ev.sessionId !== this.liveSessionId) return;
        this.monitorSnapshot = ev.snapshot;
        this.monitorState = 'live';
      });
      if (api.onMonitorEnd) {
        this._offMonitorEnd = api.onMonitorEnd((ev) => {
          if (this._disposed || !ev || ev.sessionId !== this.liveSessionId) return;
          this.monitorState = 'error';
        });
      }
    },

    async startMonitor() {
      const sid = this.liveSessionId;
      if (!api.monitorStart || !sid) {
        this.monitorState = 'unsupported';
        return;
      }
      this.monitorState = 'probing';
      if (this.$refs.monitorPanel) this.$refs.monitorPanel.resetHistory();
      try {
        const r = unwrap(await api.monitorStart(sid, this.monitorIntervalSec || undefined));
        if (this._disposed || this.liveSessionId !== sid || !this.monitorOpen) return;
        if (!r || !r.supported) {
          this.monitorState = r && r.reason === 'not-ready' ? 'offline' : 'unsupported';
          return;
        }
        if (r.intervalSec) this.monitorIntervalSec = r.intervalSec;
        this.monitorMeta = r.meta || null;
        this.monitorSnapshot = r.snapshot || null;
        this.monitorState = r.snapshot ? 'live' : 'probing';
      } catch (e) {
        if (this._disposed || this.liveSessionId !== sid) return;
        this.monitorState = 'error';
      }
    },

    stopMonitor() {
      const sid = this.liveSessionId;
      if (sid && api.monitorStop) {
        try {
          const r = api.monitorStop(sid);
          if (r && typeof r.then === 'function') r.catch(() => {});
        } catch (_) {}
      }
    },

    onSplitStart(e) {
      e.preventDefault();
      if (this._splitMove) return;
      const onMove = (ev) => {
        const wrap = this.$refs.wrapEl;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        const pct = ((rect.right - ev.clientX) / rect.width) * 100;
        this.monitorWidth = Math.min(60, Math.max(18, pct));
      };
      const onUp = () => {
        this.monitorDragging = false;
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        this._splitMove = null;
        this._splitUp = null;
        this.scheduleFit();
      };
      this.monitorDragging = true;
      document.body.style.userSelect = 'none';
      this._splitMove = onMove;
      this._splitUp = onUp;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },

    /** OSC 7 载荷形如 file://host/percent/encoded/path，可能再跟 ; 附加参数。 */
    onOscCwd(data) {
      const raw = String(data == null ? '' : data);
      const at = raw.indexOf('file://');
      if (at < 0) return false;
      const rest = raw.slice(at + 7).split(';')[0];
      const slash = rest.indexOf('/');
      if (slash < 0) return false;
      let p = null;
      try {
        p = decodeURIComponent(rest.slice(slash));
      } catch (_) {
        return false;
      }
      if (p && p.charAt(0) === '/' && p.length <= 4096) this.oscCwd = p;
      return true;
    },

    async openSftp() {
      if (!api.sftpOpenWindow) {
        this.$message.error(t('msg.needElectron'));
        return;
      }
      const req = { assetId: this.assetId };
      // 终端当前目录：shell 自己报过就用它，否则把会话 ID 交给主进程去反查
      if (this.oscCwd) req.remotePath = this.oscCwd;
      else if (this.status === 'ready' && this.liveSessionId) req.sshSessionId = this.liveSessionId;
      try {
        unwrap(await api.sftpOpenWindow(req));
      } catch (e) {
        this.$message.error(e.message || String(e));
      }
    },

    disconnectNow(silent) {
      this._connectVersion += 1;
      if (this._rsTimer) clearTimeout(this._rsTimer);
      const sid = this.liveSessionId;
      this.liveSessionId = null;
      // 重连后旧目录已无意义，交给下次 OSC 7 或主进程探测重新确定
      this.oscCwd = '';
      if (this.offData) {
        this.offData();
        this.offData = null;
      }
      if (this.offState) {
        this.offState();
        this.offState = null;
      }
      if (sid && api.sshDisconnect) {
        try {
          const r = api.sshDisconnect(sid);
          if (r && typeof r.then === 'function') r.catch(() => {});
        } catch (_) {}
      }
      if (!silent) {
        this.status = 'ended';
        this.statusDetail = '';
        this.writeOut(t('ssh.endedHint'));
      }
    },
  },
};
</script>

<style scoped>
.ssh-term-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--ssh-bg, #000000);
}
/* Fallback fullscreen when the Fullscreen API is unavailable:
   cover the whole app root and hide sidebar/statusbar chrome. */
.ssh-term-wrap.is-terminal-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 9999;
}
.fs-hint {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(20, 28, 38, 0.92);
  border: 1px solid var(--border, #2a3544);
  color: var(--text-2, #9aa7b8);
  font-size: 12px;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}
.fs-hint kbd {
  padding: 1px 7px;
  border-radius: 4px;
  background: #2a3544;
  border: 1px solid #3a4657;
  color: #d7dde8;
  font-family: Consolas, monospace;
  font-size: 11px;
}
.fs-hint-enter-active,
.fs-hint-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.fs-hint-enter,
.fs-hint-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
}
.ssh-toolbar {
  display: flex;
  align-items: center;
  gap: 7.5px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #2a3544);
  background: var(--bg-panel, #151b24);
  flex: 0 0 auto;
  overflow: hidden;
}
/* Element UI adds margin-left between sibling buttons; keep only flex gap */
.ssh-toolbar .el-button + .el-button {
  margin-left: 0;
}
.gear-icon-btn.is-danger {
  color: #f56c6c;
  border-color: rgba(245, 108, 108, 0.55);
}
.gear-icon-btn.is-danger:hover:not(:disabled) {
  color: #f56c6c;
  border-color: #f56c6c;
}
.ssh-meta {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: var(--text-2, #9aa7b8);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssh-status {
  font-size: 11px;
  color: var(--text-3, #6b7789);
  white-space: nowrap;
}
.ssh-status.ready {
  color: #67c23a;
}
.ssh-status.connecting {
  color: #e6a23c;
}
.ssh-status.error,
.ssh-status.ended {
  color: #f56c6c;
}
.ssh-term {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 4px 6px 6px;
  box-sizing: border-box;
  background: var(--ssh-bg, #000000);
}
.ssh-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.ssh-term-main {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}
.ssh-monitor-host {
  flex: 0 0 0%;
  width: 0;
  display: flex;
  overflow: hidden;
  transition: flex-basis 0.28s ease, width 0.28s ease;
}
.ssh-monitor-host.dragging {
  transition: none;
}
/* 展开后按比例可能窄到装不下 AI 输入条，兜最小宽度让终端侧让步而不是裁掉按钮 */
.ssh-monitor-host.open {
  min-width: 322px;
}
.monitor-splitter {
  flex: 0 0 6px;
  cursor: col-resize;
  background: var(--bg-panel, #151b23);
  border-right: 1px solid var(--border, #2a3544);
  display: flex;
  align-items: center;
  justify-content: center;
}
.monitor-splitter:hover .grip,
.ssh-monitor-host.dragging .grip {
  background: var(--accent, #409eff);
}
.monitor-splitter .grip {
  width: 2px;
  height: 26px;
  border-radius: 1px;
  background: var(--border, #2a3544);
  transition: background 0.15s ease;
}
/* Semicircular monitor toggle: flat edge flush with the terminal's right side, bulges left */
.monitor-toggle {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 10;
  width: 24px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--border, #2a3544);
  border-right: none;
  border-radius: 22px 0 0 22px;
  background: rgba(21, 27, 35, 0.55);
  backdrop-filter: blur(2px);
  color: var(--accent, #409eff);
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.18s ease, background 0.18s ease;
}
.monitor-toggle:hover {
  opacity: 1;
  background: rgba(28, 36, 48, 0.9);
}
.monitor-toggle.active {
  opacity: 1;
  background: var(--bg-elevated, #1c2430);
  color: var(--text, #e6edf3);
}
/* AI 半圆沿用监控半圆的尺寸与悬停语义，只是贴在它下面 */
.ai-toggle {
  top: 52px;
}
.ai-toggle.busy::after {
  content: '';
  position: absolute;
  top: -3px;
  left: -3px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--warning, #e6a23c);
  border: 1px solid var(--bg-app, #0f1419);
  animation: ai-dot-pulse 1s ease-in-out infinite;
}
@keyframes ai-dot-pulse {
  50% {
    opacity: 0.35;
  }
}
/* 未读角标收在按钮左下角内部，避开右上角进行中的提示点，也不会被侧栏裁掉 */
.ai-unread {
  position: absolute;
  bottom: 2px;
  left: 2px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--danger, #f56c6c);
  color: #fff;
  font-size: 9px;
  line-height: 13px;
  text-align: center;
  pointer-events: none;
}
.ssh-side-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.ssh-side-pane {
  flex: 1 1 0%;
  min-height: 0;
  display: flex;
}
.side-hsplit {
  flex: 0 0 5px;
  cursor: row-resize;
  background: var(--bg-panel, #151b23);
  border-top: 1px solid var(--border, #2a3544);
  border-bottom: 1px solid var(--border, #2a3544);
  display: flex;
  align-items: center;
  justify-content: center;
}
.side-hsplit i {
  width: 26px;
  height: 2px;
  border-radius: 1px;
  background: var(--border, #2a3544);
  transition: background 0.15s ease;
}
.side-hsplit:hover i {
  background: var(--accent, #409eff);
}
.ssh-term /deep/ .xterm {
  height: 100%;
  width: 100%;
  background: transparent;
}
.ssh-term /deep/ .xterm-viewport {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  background-color: var(--ssh-bg, #000000);
}
.ssh-term /deep/ .xterm-screen {
  background: transparent;
}
.ssh-term /deep/ .xterm-screen canvas {
  background: transparent;
}
</style>
