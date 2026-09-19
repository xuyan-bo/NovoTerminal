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
      <el-button size="mini" @click="reconnect" :disabled="status === 'connecting'">
        {{ $t('ssh.reconnect') }}
      </el-button>
      <el-button size="mini" type="danger" plain @click="onDisconnectClick">
        {{ $t('ssh.disconnect') }}
      </el-button>
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

      // Observe the outer wrap (stable flex box), not the xterm DOM
      if (window.ResizeObserver) {
        this.ro = new ResizeObserver(() => this.scheduleFit());
        const target = this.$refs.wrapEl || this.$refs.termEl;
        if (target) this.ro.observe(target);
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

    /** Toolbar click — never pass the MouseEvent as `silent` */
    onDisconnectClick() {
      this.disconnectNow(false);
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
