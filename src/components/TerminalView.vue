<template>
  <div ref="wrapEl" class="ssh-term-wrap">
    <div class="ssh-toolbar">
      <span class="pill ssh">{{ shortLabel }}</span>
      <span class="ssh-meta">{{ title }}</span>
      <span class="ssh-status" :class="status">{{ statusText }}</span>
      <el-tooltip :content="$t('sftp.openTip')" placement="top">
        <button
          type="button"
          class="gear-icon-btn"
          :disabled="!assetId"
          @click="openSftp"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z"/>
            <path d="M12 10v6m0-6l-2.5 2.5M12 10l2.5 2.5" fill="none" stroke="#0f1419" stroke-width="1.4"/>
          </svg>
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
          <svg v-if="isDisconnected" viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M454.6048 328.8576a25.344 25.344 0 1 1-35.84-35.84l203.8784-203.9808c82.1248-82.176 212.992-84.992 292.352-5.632 79.36 79.4112 76.544 210.432-5.632 292.5568l-203.8272 203.9808c-82.1248 82.1248-212.992 84.992-292.352 5.632a25.344 25.344 0 0 1 35.84-35.8912c59.1872 59.2384 158.0032 57.088 220.672-5.632l203.8784-203.9808c62.6176-62.6688 64.8192-161.536 5.632-220.7744-59.2384-59.2384-158.0544-57.088-220.7232 5.632L454.6048 328.8064z m114.7904 366.2848a25.344 25.344 0 1 1 35.84 35.84L401.408 934.9632c-82.1248 82.176-212.992 84.992-292.352 5.632-79.36-79.4112-76.544-210.432 5.632-292.5568L318.464 444.0576c82.1248-82.1248 212.992-84.992 292.352-5.632a25.344 25.344 0 0 1-35.84 35.8912c-59.1872-59.2384-158.0032-57.088-220.672 5.632l-203.8784 203.9808c-62.6176 62.6688-64.8192 161.536-5.632 220.7744 59.2384 59.2384 158.0544 57.088 220.7232-5.632l203.8784-203.9296z"/>
          </svg>
          <svg v-else viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M465.0496 349.93664a25.344 25.344 0 1 1-35.84-35.84l203.8784-203.9808c82.1248-82.176 212.992-84.992 292.352-5.632 79.36 79.4112 76.544 210.432-5.632 292.5568l-185.9072 186.04032a25.33376 25.33376 0 0 1-35.82464 0.01536l-0.02048-0.02048a25.38496 25.38496 0 0 1 0.01024-35.88096l185.94816-186.04544c62.6176-62.6688 64.8192-161.536 5.632-220.7744-59.2384-59.2384-158.0544-57.088-220.7232 5.632l-203.8784 203.8784v0.0512z m129.1264 339.0464a25.344 25.344 0 0 1 11.264 42.5984l-203.8272 203.9808c-82.1248 82.176-212.992 84.992-292.352 5.632-79.36-79.4112-76.544-210.432 5.632-292.5568l185.84576-186.04032a25.32864 25.32864 0 0 1 35.82464-0.01536l0.02048 0.02048a25.38496 25.38496 0 0 1-0.01024 35.88608L150.6304 684.52864c-62.6176 62.6688-64.8192 161.536-5.632 220.7744 59.2384 59.2384 158.0544 57.088 220.7232-5.632l203.8784-203.9296a25.344 25.344 0 0 1 24.576-6.7584zM403.15904 249.46688a23.04 23.04 0 0 1-45.2352-8.79616l19.53792-100.51584a23.04 23.04 0 0 1 45.2352 8.79104l-19.53792 100.52096zM143.33952 391.95136a23.04 23.04 0 1 1 8.79616-45.2352l100.51584 19.54304a23.04 23.04 0 1 1-8.79104 45.23008l-100.52096-19.53792z m54.3232-178.176a23.04 23.04 0 1 1 34.77504-30.2336l67.17952 77.28128a23.04 23.04 0 1 1-34.77504 30.22848L197.66272 213.77024zM659.4048 789.0432a23.04 23.04 0 0 1 45.73696 5.61664l-12.48256 101.632a23.04 23.04 0 0 1-45.73696-5.61152l12.48256-101.63712z m249.24672-160.256a23.04 23.04 0 0 1-5.61152 45.73184l-101.63712-12.47744a23.04 23.04 0 0 1 5.61664-45.73696l101.632 12.48256z m-43.27424 185.14944a23.04 23.04 0 0 1-34.77504 30.22848l-67.17952-77.28128a23.04 23.04 0 0 1 34.77504-30.2336l67.17952 77.2864z"/>
          </svg>
        </button>
      </el-tooltip>
    </div>
    <div ref="termEl" class="ssh-term"></div>
  </div>
</template>

<script>
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, unwrap, refresh } from '../store';
import { t } from '../i18n';

const FIT_DEBOUNCE_MS = 120;
const REMOTE_RESIZE_DEBOUNCE_MS = 220;

export default {
  name: 'TerminalView',
  props: {
    sessionId: { type: String, required: true },
    assetId: { type: String, required: true },
    methodId: { type: String, default: 'ssh' },
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
    };
  },
  computed: {
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
    // Tab switched back → layout is visible again; refit only, do NOT reconnect
    active(v) {
      if (v) {
        this._lastW = 0;
        this._lastH = 0;
        this.$nextTick(() => this.scheduleFit());
      }
    },
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
    this.connect();
    window.addEventListener('resize', this.scheduleFit);
  },
  activated() {
    this.scheduleFit();
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.scheduleFit);
    if (this._fitTimer) clearTimeout(this._fitTimer);
    if (this._rsTimer) clearTimeout(this._rsTimer);
    this.teardownTerm();
    this.disconnectNow(true);
  },
  methods: {
    initTerm() {
      if (this.term) return;
      const term = new Terminal({
        fontSize: 13,
        fontFamily: 'Consolas, "Courier New", monospace',
        cursorBlink: true,
        convertEol: false,
        // Avoid scrollback thrash during resize reflow
        scrollback: 2000,
        theme: {
          background: '#0f1419',
          foreground: '#d7dde8',
          cursor: '#409EFF',
          selectionBackground: 'rgba(64,158,255,0.35)',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(this.$refs.termEl);
      this.term = term;
      this.fit = fit;
      this._lastW = 0;
      this._lastH = 0;
      this.scheduleFit();

      term.onData((data) => {
        if (!this.liveSessionId) return;
        api.sshWrite && api.sshWrite(this.liveSessionId, data);
      });

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
            this.$message.success('已复制');
            return;
          }
        }
      } catch (_) {}
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          this.$message.success('已复制');
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
        this.$message.success('已复制');
      } catch (err) {
        this.$message.error('复制失败');
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
        this.$message.warning('剪贴板为空');
        return;
      }
      const term = this.term;
      if (!term) return;
      // Prefer term.paste (handles \n → CR for shell)
      try {
        if (typeof term.paste === 'function') {
          term.paste(text);
        } else if (this.liveSessionId && api.sshWrite) {
          api.sshWrite(this.liveSessionId, text.replace(/\r?\n/g, '\r'));
        }
      } catch (err) {
        this.$message.error('粘贴失败');
      }
    },

    scheduleFit() {
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
      if (this._rsTimer) clearTimeout(this._rsTimer);
      this._rsTimer = setTimeout(() => {
        if (!this.liveSessionId || !this.term) return;
        const cols = this.term.cols;
        const rows = this.term.rows;
        if (!cols || !rows) return;
        if (this._sentCols === cols && this._sentRows === rows) return;
        this._sentCols = cols;
        this._sentRows = rows;
        api.sshResize && api.sshResize(this.liveSessionId, cols, rows);
      }, REMOTE_RESIZE_DEBOUNCE_MS);
    },

    teardownTerm() {
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
      const termEl = this.$refs.termEl;
      if (termEl && this._onTermCtx) {
        try {
          termEl.removeEventListener('contextmenu', this._onTermCtx);
        } catch (_) {}
      }
      this._onTermCtx = null;
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

    async connect() {
      if (!this.term) this.initTerm();
      this.disconnectNow(true);
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

      try {
        // ensure local size is current before opening remote shell
        this.doFit();
        const cols = (this.term && this.term.cols) || 120;
        const rows = (this.term && this.term.rows) || 32;
        const r = unwrap(
          await api.sshConnect({
            assetId: this.assetId,
            methodId: this.methodId,
            cols,
            rows,
          })
        );
        const sid = r.sessionId;
        this.liveSessionId = sid;
        this._sentCols = cols;
        this._sentRows = rows;

        this.offData = api.onSshData(sid, (payload) => {
          if (!this.term) return;
          const chunk = this.chunkToWrite(payload);
          if (chunk != null) this.term.write(chunk);
        });

        this.offState = api.onSshState((ev) => {
          if (!ev || ev.sessionId !== sid) return;
          if (ev.type === 'ready') {
            this.status = 'ready';
            this.statusDetail = `${r.host}:${r.port}`;
          } else if (ev.type === 'ended') {
            this.status = 'ended';
            this.writeOut(t('ssh.endedHint'));
          } else if (ev.type === 'error') {
            this.status = 'error';
            this.statusDetail = ev.message || ev.code || '';
            this.writeOut((t('ssh.errorPrefix') + ' ' + (ev.message || ev.code || '')).trim());
          } else if (ev.type === 'hostkey-saved') {
            this.writeOut(t('ssh.hostkeySaved', { fp: ev.fp || '' }));
          } else if (ev.type === 'hostkey-mismatch') {
            this.writeOut(t('ssh.hostkeyMismatch'));
          } else if (ev.type === 'hostkey-unknown') {
            this.writeOut(t('ssh.hostkeyUnknown'));
          }
        });

        this.status = 'ready';
        this.statusDetail = `${r.host}:${r.port}`;
        // pull latest snapshot so home “recent” shows this SSH connect
        refresh().catch(() => {});
        // one delayed sync in case layout settled after mount/fullscreen
        this.scheduleRemoteResize();
      } catch (e) {
        this.status = 'error';
        this.statusDetail = e.message || '';
        this.writeOut((t('ssh.errorPrefix') + ' ' + (e.message || e.code || '')).trim());
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

    async openSftp() {
      if (!api.sftpOpenWindow) {
        this.$message.error(t('msg.needElectron'));
        return;
      }
      try {
        unwrap(
          await api.sftpOpenWindow({
            assetId: this.assetId,
          })
        );
      } catch (e) {
        this.$message.error(e.message || String(e));
      }
    },

    disconnectNow(silent) {
      const sid = this.liveSessionId;
      this.liveSessionId = null;
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
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-app, #0f1419);
}
.ssh-toolbar {
  display: flex;
  align-items: center;
  gap: 15px;
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
}
.ssh-term /deep/ .xterm {
  height: 100%;
  width: 100%;
}
.ssh-term /deep/ .xterm-viewport {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  background-color: transparent !important;
}
</style>
