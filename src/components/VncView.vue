<template>
  <div ref="wrapEl" class="vnc-wrap">
    <div class="vnc-toolbar">
      <span class="pill vnc">VNC</span>
      <span class="vnc-status" :class="status">{{ statusText }}</span>
      <span class="vnc-meta">{{ title }}</span>
      <el-tooltip :content="$t('vnc.fullscreenTip')" placement="top">
        <button
          type="button"
          class="gear-icon-btn"
          @click="onToggleFullscreen"
        >
          <svg-icon :name="isFullscreen ? 'fullscreen-out' : 'fullscreen-in'" />
        </button>
      </el-tooltip>
      <el-tooltip :content="connToggleTip" placement="top">
        <button
          type="button"
          class="gear-icon-btn"
          :class="{ 'is-danger': !isDisconnected }"
          @click="onConnToggle"
        >
          <svg-icon :name="isDisconnected ? 'link' : 'link-broken'" />
        </button>
      </el-tooltip>
    </div>
    <div ref="screenEl" class="vnc-screen"></div>
    <transition name="fs-hint">
      <div v-if="fsHint" class="fs-hint">
        <kbd>Esc</kbd><span>{{ $t('vnc.fullscreenExitHint') }}</span>
      </div>
    </transition>
  </div>
</template>

<script>
import { api, unwrap, refresh, findAsset, store } from '../store';
import { t } from '../i18n';
import RFB from '@novnc/novnc';
import createFullscreenMixin from './session/fullscreen';

/** 页签状态点：ended 与 idle 同样归为未连接的灰色。 */
const DOT_STATE = { connecting: 'connecting', ready: 'ready', error: 'error' };

export default {
  name: 'VncView',
  mixins: [createFullscreenMixin({
    fallbackClass: 'is-vnc-fullscreen',
    onResize() { this._applyVncScale(); },
    resizeOnNextTick: true,
  })],
  props: {
    sessionId: { type: String, required: true },
    assetId: { type: String, required: true },
    methodId: { type: String, default: 'vnc' },
    title: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  data() {
    return {
      status: 'idle',
      statusDetail: '',
      liveSessionId: null,
      rfb: null,
      offState: null,
      desktopName: '',
    };
  },
  computed: {
    statusText() {
      const map = {
        idle: t('vnc.status.idle'),
        connecting: t('vnc.status.connecting'),
        ready: t('vnc.status.ready'),
        ended: t('vnc.status.ended'),
        error: t('vnc.status.error'),
      };
      const base = map[this.status] || this.status;
      const detail = this.statusDetail ? ' · ' + this.statusDetail : '';
      const name = this.desktopName ? ' · ' + this.desktopName : '';
      return base + detail + name;
    },
    isDisconnected() {
      return this.status === 'ended' || this.status === 'error' || this.status === 'idle';
    },
    connToggleTip() {
      return this.isDisconnected ? t('vnc.reconnect') : t('vnc.disconnect');
    },
  },
  watch: {
    status(val) {
      const connected = val === 'connecting' || val === 'ready';
      const tab = store.tabs.find((t) => t.id === this.sessionId);
      if (tab) tab.connState = DOT_STATE[val] || 'idle';
      this.$emit('connection', connected);
    },
    active(v) {
      if (v && this.rfb) {
        this.$nextTick(() => {
          this.rfb.focus();
        });
      }
    },
  },
  mounted() {
    this._resizeObserver = null;
    this.connect();
  },
  beforeDestroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this.disconnectNow(true);
  },
  methods: {
    async connect() {
      this.disconnectNow(true);
      this.status = 'connecting';
      this.statusDetail = '';
      this.desktopName = '';

      if (!api.vncConnect) {
        this.status = 'error';
        this.statusDetail = t('msg.needElectron');
        return;
      }

      try {
        const asset = findAsset(this.assetId);
        const method = asset && asset.asset && asset.asset.methods && asset.asset.methods[this.methodId];
        const advPassword = (method && method.advanced && method.advanced.password) || '';
        const password = advPassword || (asset && asset.asset && asset.asset.pass) || '';

        const r = unwrap(
          await api.vncConnect({
            assetId: this.assetId,
            methodId: this.methodId,
          })
        );

        this.liveSessionId = r.sessionId;

        this.offState = api.onVncState((ev) => {
          if (!ev || ev.sessionId !== this.liveSessionId) return;
          if (ev.type === 'ready') {
            this.status = 'ready';
            this.statusDetail = '';
          } else if (ev.type === 'ended') {
            this.status = 'ended';
            this.statusDetail = '';
          } else if (ev.type === 'error') {
            this.status = 'error';
            this.statusDetail = ev.message || ev.code || '';
          }
        });

        const screenEl = this.$refs.screenEl;
        if (!screenEl) {
          this.status = 'error';
          this.statusDetail = 'no screen element';
          return;
        }

        const isFit = !r.scale || r.scale === 'fit';
        const rfb = new RFB(screenEl, r.wsUrl, {
          credentials: { password },
          wsProtocols: ['binary'],
          shared: r.shared !== false,
        });
        rfb.scaleViewport = isFit;
        rfb.clipViewport = !isFit;
        rfb.viewOnly = !!r.viewOnly;
        rfb.showDotCursor = r.localCursor !== false;

        this._vncScale = r.scale;

        // Apply quality/compression settings
        if (r.jpegQuality != null) {
          rfb.qualityLevel = Number(r.jpegQuality);
        }
        if (r.compressLevel != null) {
          rfb.compressionLevel = Number(r.compressLevel);
        }

        rfb.addEventListener('connect', () => {
          if (this.rfb !== rfb) return;
          this.status = 'ready';
          this.statusDetail = '';
          this._applyVncScale();
          if (r.clipboard !== false && !rfb.viewOnly) {
            this._cleanupClipboard = this._setupClipboard(rfb);
          }
        });

        rfb.addEventListener('disconnect', () => {
          if (this.rfb !== rfb) return;
          if (this._cleanupClipboard) {
            this._cleanupClipboard();
            this._cleanupClipboard = null;
          }
          if (this.status !== 'ended' && this.status !== 'error') {
            this.status = 'ended';
          }
        });

        rfb.addEventListener('desktopname', (e) => {
          this.desktopName = e.name || '';
        });

        rfb.addEventListener('credentialsrequired', () => {
          rfb.sendCredentials({ password });
        });

        this.rfb = rfb;

        if (typeof ResizeObserver !== 'undefined' && screenEl) {
          this._resizeObserver = new ResizeObserver(() => {
            this._applyVncScale();
          });
          this._resizeObserver.observe(screenEl);
        }

        refresh().catch(() => {});
      } catch (e) {
        this.status = 'error';
        this.statusDetail = e.message || String(e);
      }
    },

    _setupClipboard(rfb) {
      const screenEl = this.$refs.screenEl;
      const keyboard = rfb._keyboard;
      const forwardKey = keyboard.onkeyevent;
      const heldKeys = new Set();
      let disposed = false;
      let lastText;
      let revision = 0;
      let focusRevision = 0;
      let pendingRead = null;
      let pendingWrite = Promise.resolve();
      let keyQueue = null;
      const normalize = (text) => text.replace(/\r\n/g, '\n');
      const canSync = () => !disposed && this.rfb === rfb && this.active && !rfb.viewOnly &&
        document.hasFocus() && screenEl.contains(document.activeElement);

      const syncLocal = (force = false) => {
        if (pendingRead) return force ? pendingRead.then(() => syncLocal(true)) : pendingRead;
        pendingRead = (async () => {
          while (canSync()) {
            const readRevision = revision;
            await pendingWrite;
            if (!canSync()) return false;
            if (revision !== readRevision) continue;
            const text = await api.clipboardReadText();
            if (!canSync() || typeof text !== 'string') return false;
            if (revision !== readRevision) continue;
            const normalized = normalize(text);
            // noVNC can clear its offered text on receipt of a remote clipboard, even an echo.
            if (force || normalized !== lastText) {
              rfb.clipboardPasteFrom(text);
              lastText = normalized;
            }
            return true;
          }
          return false;
        })().catch(() => {
          console.warn('[VNC] Clipboard read failed');
          return false;
        }).finally(() => {
          pendingRead = null;
        });
        return pendingRead;
      };

      const onRemoteClipboard = (e) => {
        const text = e.detail && e.detail.text;
        if (!canSync() || typeof text !== 'string') return;
        revision++;
        const normalized = normalize(text);
        if (normalized === lastText) return;
        lastText = normalized;
        pendingWrite = pendingWrite.then(async () => {
          if (!canSync()) return;
          if (!await api.clipboardWriteText(text)) {
            console.warn('[VNC] Clipboard write failed');
          }
        }).catch(() => {
          console.warn('[VNC] Clipboard write failed');
        });
      };

      const flushKeys = async () => {
        while (!disposed && keyQueue.length) {
          const { args, paste, keyFocus } = keyQueue.shift();
          if (paste && !await syncLocal(true)) continue;
          if (!disposed && (!args[2] || (keyFocus === focusRevision && canSync()))) {
            forwardKey(...args);
          }
        }
        keyQueue = null;
      };

      // Keep translated key presses and releases ordered across clipboard IPC.
      keyboard.onkeyevent = (...args) => {
        const [, code, down] = args;
        down ? heldKeys.add(code) : heldKeys.delete(code);
        const control = heldKeys.has('ControlLeft') || heldKeys.has('ControlRight');
        const meta = heldKeys.has('MetaLeft') || heldKeys.has('MetaRight');
        const shift = heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight');
        const alt = heldKeys.has('AltLeft') || heldKeys.has('AltRight');
        const paste = down && !alt && ((code === 'KeyV' && (control || meta)) ||
          (code === 'Insert' && shift));
        if (keyQueue) {
          keyQueue.push({ args, paste, keyFocus: focusRevision });
        } else if (paste && canSync()) {
          keyQueue = [{ args, paste, keyFocus: focusRevision }];
          flushKeys();
        } else {
          forwardKey(...args);
        }
      };

      const onFocus = () => { if (canSync()) syncLocal(); };
      const onBlur = () => {
        focusRevision++;
        keyboard._allKeysUp();
      };
      const timer = setInterval(onFocus, 250);
      screenEl.addEventListener('focusin', onFocus);
      screenEl.addEventListener('focusout', onBlur);
      window.addEventListener('focus', onFocus);
      window.addEventListener('blur', onBlur);
      rfb.addEventListener('clipboard', onRemoteClipboard);
      onFocus();

      return () => {
        disposed = true;
        clearInterval(timer);
        screenEl.removeEventListener('focusin', onFocus);
        screenEl.removeEventListener('focusout', onBlur);
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('blur', onBlur);
        rfb.removeEventListener('clipboard', onRemoteClipboard);
        keyboard.onkeyevent = forwardKey;
        // Releases may already have left noVNC's key state but still be queued here.
        if (keyQueue) {
          for (const { args } of keyQueue) {
            if (!args[2]) forwardKey(...args);
          }
        }
        heldKeys.clear();
      };
    },

    reconnect() {
      this.connect();
    },

    onConnToggle() {
      if (this.isDisconnected) {
        this.reconnect();
      } else {
        this.disconnectNow(false);
      }
    },

    _applyVncScale() {
      const rfb = this.rfb;
      if (!rfb) return;
      const s = this._vncScale;
      if (!s || s === 'fit') {
        rfb.scaleViewport = true;
        return;
      }
      rfb.scaleViewport = false;
      const factor = Number(s) / 100;
      if (factor > 0 && rfb._display) {
        rfb._display.scale = factor;
      }
    },

    disconnectNow(silent) {
      const sid = this.liveSessionId;
      this.liveSessionId = null;
      if (this.offState) {
        this.offState();
        this.offState = null;
      }
      if (this._cleanupClipboard) {
        this._cleanupClipboard();
        this._cleanupClipboard = null;
      }
      if (this.rfb) {
        try { this.rfb.disconnect(); } catch (_) {}
        this.rfb = null;
      }
      if (sid && api.vncDisconnect) {
        try {
          const r = api.vncDisconnect(sid);
          if (r && typeof r.then === 'function') r.catch(() => {});
        } catch (_) {}
      }
      if (!silent) {
        this.status = 'ended';
        this.statusDetail = '';
      }
    },
  },
};
</script>

<style scoped>
.vnc-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: #1a1a2e;
}
.vnc-wrap.is-vnc-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 9999;
  width: 100vw;
  height: 100vh;
}
.vnc-toolbar {
  display: flex;
  align-items: center;
  gap: 7.5px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #2a3544);
  background: var(--bg-panel, #151b24);
  flex: 0 0 auto;
  overflow: hidden;
}
.gear-icon-btn.is-danger {
  color: #f56c6c;
  border-color: rgba(245, 108, 108, 0.55);
}
.gear-icon-btn.is-danger:hover:not(:disabled) {
  color: #f56c6c;
  border-color: #f56c6c;
}
.vnc-meta {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: var(--text-2, #9aa7b8);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vnc-status {
  font-size: 11px;
  color: var(--text-3, #6b7789);
  white-space: nowrap;
}
.vnc-status.ready {
  color: #67c23a;
}
.vnc-status.connecting {
  color: #e6a23c;
}
.vnc-status.error,
.vnc-status.ended {
  color: #f56c6c;
}
.vnc-screen {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #1a1a2e;
  position: relative;
  cursor: default;
}
.vnc-screen /deep/ canvas {
  display: block;
  margin: 0 auto;
  cursor: default !important;
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
</style>
