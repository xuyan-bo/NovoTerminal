<template>
  <div ref="wrapEl" class="rdp-wrap">
    <div class="rdp-toolbar">
      <span class="pill rd">RDP</span>
      <span class="rdp-status" :class="status">{{ statusText }}</span>
      <span class="rdp-meta">{{ title }}</span>
      <el-tooltip :content="$t('rdp.fullscreenTip')" placement="top">
        <button
          type="button"
          class="gear-icon-btn"
          @click="onToggleFullscreen"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path v-if="!isFullscreen" d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            <path v-else d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
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
          <svg v-if="isDisconnected" viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M454.6048 328.8576a25.344 25.344 0 1 1-35.84-35.84l203.8784-203.9808c82.1248-82.176 212.992-84.992 292.352-5.632 79.36 79.4112 76.544 210.432-5.632 292.5568l-203.8272 203.9808c-82.1248 82.1248-212.992 84.992-292.352 5.632a25.344 25.344 0 0 1 35.84-35.8912c59.1874 59.2384 158.0032 57.088 220.672-5.632l203.8784-203.9808c62.6176-62.6688 64.8192-161.536 5.632-220.7744-59.2384-59.2384-158.0544-57.088-220.7232 5.632L454.6048 328.8064z m114.7904 366.2848a25.344 25.344 0 1 1 35.84 35.84L401.408 934.9632c-82.1248 82.176-212.992 84.992-292.352 5.632-79.36-79.4112-76.544-210.432 5.632-292.5568L318.464 444.0576c82.1248-82.1248 212.992-84.992 292.352-5.632a25.344 25.344 0 0 1-35.84 35.8912c-59.1872 59.2384-158.0032 57.088-220.672-5.632l-203.8784 203.9808c-62.6176 62.6688-64.8192 161.536-5.632 220.7744 59.2384 59.2384 158.0544 57.088 220.7232-5.632l203.8784-203.9296z"/>
          </svg>
          <svg v-else viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M465.0496 349.93664a25.344 25.344 0 1 1-35.84-35.84l203.8784-203.9808c82.1248-82.176 212.992-84.992 292.352-5.632 79.36 79.4112 76.544 210.432-5.632 292.5568l-185.9072 186.04032a25.33376 25.33376 0 0 1-35.82464 0.01536l-0.02048-0.02048a25.38496 25.38496 0 0 1 0.01024-35.88096l185.94816-186.04544c62.6176-62.6688 64.8192-161.536 5.632-220.7744-59.2384-59.2384-158.0544-57.088-220.7232 5.632l-203.8784 203.9808v0.0512z m129.1264 339.0464a25.344 25.344 0 0 1 11.264 42.5984l-203.8272 203.9808c-82.1248 82.176-212.992 84.992-292.352 5.632-79.36-79.4112-76.544-210.432 5.632-292.5568L318.464 444.0576c82.1248-82.1248 212.992-84.992 292.352-5.632a25.344 25.344 0 0 1-35.84 35.8912c-59.1872 59.2384-158.0032 57.088-220.672-5.632l-203.8784 203.9808c-62.6176 62.6688-64.8192 161.536-5.632 220.7744 59.2384 59.2384 158.0544 57.088 220.7232-5.632l203.8784-203.9296a25.344 25.344 0 0 1 24.576-6.7584zM403.15904 249.46688a23.04 23.04 0 0 1-45.2352-8.79616l19.53792-100.51584a23.04 23.04 0 0 1 45.2352 8.79104l-19.53792 100.52096zM143.33952 391.95136a23.04 23.04 0 1 1 8.79616-45.2352l100.51584 19.54304a23.04 23.04 0 1 1-8.79104 45.23008l-100.52096-19.54304z m54.3232-178.176a23.04 23.04 0 1 1 34.77504-30.2336l67.17952 77.28128a23.04 23.04 0 1 1-34.77504 30.22848L197.66272 213.77024zM659.4048 789.0432a23.04 23.04 0 0 1 45.73696 5.61664l-12.48256 101.632a23.04 23.04 0 0 1-45.73696-5.61152l12.48256-101.63712z m249.24672-160.256a23.04 23.04 0 0 1-5.61152 45.73184l-101.63712-12.47744a23.04 23.04 0 0 1 5.61664-45.73696l101.632 12.48256z m-43.27424 185.14944a23.04 23.04 0 0 1-34.77504 30.22848l-67.17952-77.28128a23.04 23.04 0 0 1 34.77504-30.2336l67.17952 77.2864z"/>
          </svg>
        </button>
      </el-tooltip>
    </div>
    <div ref="screenEl" class="rdp-screen">
      <canvas ref="canvas" v-show="showCanvas" class="rdp-canvas" tabindex="0"></canvas>
    </div>
    <transition name="fs-hint">
      <div v-if="fsHint" class="fs-hint">
        <kbd>Esc</kbd><span>{{ $t('rdp.fullscreenExitHint') }}</span>
      </div>
    </transition>
  </div>
</template>

<script>
import { api, unwrap, refresh, findAsset, store } from '../store';
import { t } from '../i18n';
import init, {
  SessionBuilder,
  DesktopSize,
  InputTransaction,
  DeviceEvent,
  ClipboardData,
  Extension,
} from 'ironrdp-wasm';
import createFullscreenMixin from './session/fullscreen';

// keyboard `e.code` → IronRDP scancode (set-top boxes style scancodes), ported
// from the ironrdp-wasm example.
const SCANCODE_MAP = {
  'Escape': 0x01, 'Digit1': 0x02, 'Digit2': 0x03, 'Digit3': 0x04,
  'Digit4': 0x05, 'Digit5': 0x06, 'Digit6': 0x07, 'Digit7': 0x08,
  'Digit8': 0x09, 'Digit9': 0x0A, 'Digit0': 0x0B, 'Minus': 0x0C,
  'Equal': 0x0D, 'Backspace': 0x0E, 'Tab': 0x0F,
  'KeyQ': 0x10, 'KeyW': 0x11, 'KeyE': 0x12, 'KeyR': 0x13,
  'KeyT': 0x14, 'KeyY': 0x15, 'KeyU': 0x16, 'KeyI': 0x17,
  'KeyO': 0x18, 'KeyP': 0x19, 'BracketLeft': 0x1A, 'BracketRight': 0x1B,
  'Enter': 0x1C, 'ControlLeft': 0x1D,
  'KeyA': 0x1E, 'KeyS': 0x1F, 'KeyD': 0x20, 'KeyF': 0x21,
  'KeyG': 0x22, 'KeyH': 0x23, 'KeyJ': 0x24, 'KeyK': 0x25,
  'KeyL': 0x26, 'Semicolon': 0x27, 'Quote': 0x28, 'Backquote': 0x29,
  'ShiftLeft': 0x2A, 'Backslash': 0x2B,
  'KeyZ': 0x2C, 'KeyX': 0x2D, 'KeyC': 0x2E, 'KeyV': 0x2F,
  'KeyB': 0x30, 'KeyN': 0x31, 'KeyM': 0x32, 'Comma': 0x33,
  'Period': 0x34, 'Slash': 0x35, 'ShiftRight': 0x36,
  'NumpadMultiply': 0x37, 'AltLeft': 0x38, 'Space': 0x39,
  'CapsLock': 0x3A,
  'F1': 0x3B, 'F2': 0x3C, 'F3': 0x3D, 'F4': 0x3E,
  'F5': 0x3F, 'F6': 0x40, 'F7': 0x41, 'F8': 0x42,
  'F9': 0x43, 'F10': 0x44,
  'NumLock': 0x45, 'ScrollLock': 0x46,
  'Numpad7': 0x47, 'Numpad8': 0x48, 'Numpad9': 0x49,
  'NumpadSubtract': 0x4A, 'Numpad4': 0x4B, 'Numpad5': 0x4C,
  'Numpad6': 0x4D, 'NumpadAdd': 0x4E, 'Numpad1': 0x4F,
  'Numpad2': 0x50, 'Numpad3': 0x51, 'Numpad0': 0x52,
  'NumpadDecimal': 0x53,
  'F11': 0x57, 'F12': 0x58,
  'NumpadEnter': 0xE01C, 'ControlRight': 0xE01D,
  'NumpadDivide': 0xE035, 'PrintScreen': 0xE037,
  'AltRight': 0xE038, 'Home': 0xE047, 'ArrowUp': 0xE048,
  'PageUp': 0xE049, 'ArrowLeft': 0xE04B, 'ArrowRight': 0xE04D,
  'End': 0xE04F, 'ArrowDown': 0xE050, 'PageDown': 0xE051,
  'Insert': 0xE052, 'Delete': 0xE053,
  'MetaLeft': 0xE05B, 'MetaRight': 0xE05C, 'ContextMenu': 0xE05D,
  'Pause': 0xE11D45,
};

function parseResolution(res) {
  if (!res || res === 'auto') return null;
  const parts = String(res).split('x').map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
    return { width: parts[0], height: parts[1] };
  }
  return null;
}

export default {
  name: 'RdpView',
  mixins: [
    createFullscreenMixin({
      fallbackClass: 'is-rdp-fullscreen',
      onResize() {
        this._applyScale();
      },
      resizeOnNextTick: true,
    }),
  ],
  props: {
    sessionId: { type: String, required: true },
    assetId: { type: String, required: true },
    methodId: { type: String, default: 'rdp' },
    title: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  data() {
    return {
      status: 'idle',
      statusDetail: '',
      liveSessionId: null,
      session: null,
      offState: null,
      showCanvas: false,
    };
  },
  computed: {
    statusText() {
      const map = {
        idle: t('rdp.status.idle'),
        connecting: t('rdp.status.connecting'),
        connected: t('rdp.status.connected'),
        ended: t('rdp.status.ended'),
        error: t('rdp.status.error'),
      };
      const base = map[this.status] || this.status;
      const detail = this.statusDetail ? ' · ' + this.statusDetail : '';
      return base + detail;
    },
    isDisconnected() {
      return this.status === 'ended' || this.status === 'error' || this.status === 'idle';
    },
    connToggleTip() {
      return this.isDisconnected ? t('rdp.reconnect') : t('rdp.disconnect');
    },
  },
  watch: {
    status(val) {
      const connected = val === 'connecting' || val === 'connected';
      const tab = store.tabs.find((t) => t.id === this.sessionId);
      if (tab) tab.connected = connected;
      this.$emit('connection', connected);
    },
    active(v) {
      if (v && this.session) {
        this.$nextTick(() => {
          const c = this.$refs.canvas;
          c && c.focus();
        });
      }
    },
  },
  mounted() {
    this._resizeObserver = null;
    this._clipboardEnabled = true;
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
    errText(e) {
      const v = e && typeof e === 'object' ? e : null;
      if (v) {
        for (const k of ['message', 'code', 'origin']) {
          const val = v[k];
          if (typeof val === 'string' && val) return val;
          if (val && typeof val === 'object') {
            try {
              return JSON.stringify(val);
            } catch (_) {}
          }
        }
        try {
          return JSON.stringify(v);
        } catch (_) {}
      }
      return String(e);
    },
    async connect() {
      this.disconnectNow(true);
      this._closing = false;
      this.status = 'connecting';
      this.statusDetail = '';

      if (!api.rdpConnect) {
        this.status = 'error';
        this.statusDetail = t('msg.needElectron');
        return;
      }

      let r;
      try {
        r = unwrap(await api.rdpConnect({ assetId: this.assetId, methodId: this.methodId }));
      } catch (e) {
        this.status = 'error';
        this.statusDetail = this.errText(e);
        return;
      }

      this.liveSessionId = r.sessionId;
      this.offState = api.onRdpState((ev) => {
        if (!ev || ev.sessionId !== this.liveSessionId) return;
        if (ev.type === 'connected') {
          this.status = 'connected';
          this.statusDetail = '';
        } else if (ev.type === 'ended') {
          this.status = 'ended';
          this.statusDetail = '';
        } else if (ev.type === 'error') {
          this.status = 'error';
          this.statusDetail = this.errText(ev);
        }
      });

      const canvas = this.$refs.canvas;
      const screenEl = this.$refs.screenEl;
      if (!canvas || !screenEl) {
        this.status = 'error';
        this.statusDetail = 'no screen element';
        return;
      }

      this._clipboardEnabled = true;
      try {
        const asset = findAsset(this.assetId);
        const method =
          asset && asset.asset && asset.asset.methods && asset.asset.methods[this.methodId];
        const advanced = (method && method.advanced) || {};
        const host = r.host || (asset && asset.asset && asset.asset.host) || '';
        const port = r.port || 3389;
        const username = (asset && asset.asset && asset.asset.user) || '';
        const password = (asset && asset.asset && asset.asset.pass) || '';
        const nla = advanced.nla !== false;
        const clipboard = advanced.clipboard !== false;
        this._clipboardEnabled = clipboard;

        await init();

        const parsed = parseResolution(advanced.resolution);
        // "跟随窗口"取当前设备屏幕分辨率（主显示器），作为 RDP 桌面请求尺寸。
        let dw = (parsed && parsed.width) || window.screen.width || screenEl.clientWidth || 1280;
        let dh = (parsed && parsed.height) || window.screen.height || screenEl.clientHeight || 720;
        if (dw < 320) dw = 320;
        if (dh < 240) dh = 240;

        const builder = new SessionBuilder();
        builder.username(username);
        builder.password(password);
        builder.destination(`${host}:${port}`);
        builder.proxyAddress(r.wsUrl);
        builder.authToken('none');
        builder.renderCanvas(canvas);
        builder.desktopSize(new DesktopSize(dw, dh));
        builder.extension(new Extension('enable_credssp', nla));

        builder.setCursorStyleCallbackContext(canvas);
        builder.setCursorStyleCallback(function (style) {
          canvas.style.cursor = style || 'default';
        });
        builder.canvasResizedCallback(() => {
          if (!this.$refs.canvas) return;
          this.showCanvas = true;
          this.$nextTick(() => this._applyScale());
        });

        if (clipboard) {
          builder.remoteClipboardChangedCallback((cbData) => this._onRemoteClipboard(cbData));
          builder.forceClipboardUpdateCallback(() => this._syncLocalToRemote());
        }

        const session = await builder.connect();
        this.session = session;
        const ds = session.desktopSize();
        canvas.width = ds.width;
        canvas.height = ds.height;
        this.showCanvas = true;
        this.status = 'connected';
        this.statusDetail = '';
        this.setupInput(canvas, session);
        this._applyScale();
        this._startClipPoll();

        if (typeof ResizeObserver !== 'undefined' && screenEl) {
          if (this._resizeObserver) this._resizeObserver.disconnect();
          this._resizeObserver = new ResizeObserver(() => this._applyScale());
          this._resizeObserver.observe(screenEl);
        }

        session
          .run()
          .then((info) => {
            if (info) {
              const r = info.reason;
              console.info(
                '[rdp] session ended, reason:',
                r && (r.description || r.type) ? { type: r.type, description: r.description } : info
              );
            }
            if (this.session === session) this.cleanupSession(session);
          })
          .catch((e) => {
            if (this._closing) return;
            console.error('[rdp] session.run error:', this.errText(e));
            if (this.session === session) {
              this.session = null;
              this.status = 'error';
              this.statusDetail = this.errText(e);
            }
          });

        refresh().catch(() => {});
      } catch (e) {
        console.error('[rdp] connect error:', e);
        this.status = 'error';
        this.statusDetail = this.errText(e);
      }
    },

    // Send a single device input transaction to ironrdp-wasm.
    _sendInput(makeEvent) {
      const session = this.session;
      if (!session) return;
      try {
        const tx = new InputTransaction();
        tx.addEvent(makeEvent());
        session.applyInputs(tx);
      } catch (_) {
        // Suppress frequent mouse/keyboard errors.
      }
    },

    _sendKey(code, down) {
      const scancode = SCANCODE_MAP[code];
      if (scancode === null || scancode === undefined) return;
      this._sendInput(() =>
        down ? DeviceEvent.keyPressed(scancode) : DeviceEvent.keyReleased(scancode)
      );
    },

    _sendMouseButton(button, down) {
      this._sendInput(() =>
        down ? DeviceEvent.mouseButtonPressed(button) : DeviceEvent.mouseButtonReleased(button)
      );
    },

    _sendMouseMove(x, y) {
      this._sendInput(() => DeviceEvent.mouseMove(x, y));
    },

    _sendWheel(vertical, amount) {
      this._sendInput(() => DeviceEvent.wheelRotations(vertical, amount, 1));
    },

    setupInput(canvas, session) {
      if (this._disposeInput) this._disposeInput();
      const onKey = (down) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.session !== session) return;
        this._sendKey(e.code, down);
      };
      const onMouseMove = (e) => {
        if (this.session !== session) return;
        if (!canvas.width || !canvas.height) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        this._sendMouseMove(
          Math.round((e.clientX - rect.left) * scaleX),
          Math.round((e.clientY - rect.top) * scaleY)
        );
      };
      const onMouseDown = (e) => {
        e.preventDefault();
        canvas.focus();
        if (this.session !== session) return;
        this._sendMouseButton(e.button, true);
      };
      const onMouseUp = (e) => {
        e.preventDefault();
        if (this.session !== session) return;
        this._sendMouseButton(e.button, false);
      };
      const onWheel = (e) => {
        e.preventDefault();
        if (this.session !== session) return;
        if (e.deltaY !== 0) this._sendWheel(true, e.deltaY > 0 ? -1 : 1);
        if (e.deltaX !== 0) this._sendWheel(false, e.deltaX > 0 ? -1 : 1);
      };
      const onContext = (e) => e.preventDefault();

      canvas.addEventListener('keydown', onKey(true));
      canvas.addEventListener('keyup', onKey(false));
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mousedown', onMouseDown);
      canvas.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', onContext);

      this._disposeInput = () => {
        canvas.removeEventListener('keydown', onKey(true));
        canvas.removeEventListener('keyup', onKey(false));
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mousedown', onMouseDown);
        canvas.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('contextmenu', onContext);
        this._disposeInput = null;
      };
    },

    // Remote → local clipboard.
    _onRemoteClipboard(cbData) {
      const session = this.session;
      if (!session || !this._clipboardEnabled) return;
      try {
        if (!cbData || cbData.isEmpty()) return;
        let text = '';
        for (const item of cbData.items() || []) {
          try {
            if (item && item.mimeType() === 'text/plain' && typeof item.value() === 'string') {
              text += item.value();
            }
          } catch (_) {}
        }
        if (text) {
          api.clipboardWriteText(text.replace(/\r\n/g, '\n')).catch(() => {});
          // Mark as seen so the local→remote poll does not push it straight back.
          this._lastClipText = text;
        }
      } catch (_) {}
    },

    // Local → remote clipboard (CLIPRDR init/update).
    async _syncLocalToRemote() {
      const session = this.session;
      if (!session || !this._clipboardEnabled) return;
      try {
        const text = await api.clipboardReadText();
        const data = new ClipboardData();
        if (typeof text === 'string' && text) data.addText('text/plain', text);
        await session.onClipboardPaste(data);
      } catch (_) {}
    },

    // Poll the local clipboard and push changes into the remote session.
    // required for "copy on host → paste inside" to work, since IronRDP only
    // calls forceClipboardUpdateCallback opportunistically on its own terms.
    _startClipPoll() {
      this._stopClipPoll();
      // Reset baseline so the first host change after connect is always pushed.
      this._lastClipText = '';
      this._clipPollTimer = setInterval(() => {
        if (this.status !== 'connected' || !this.session || !this._clipboardEnabled) return;
        this._pollClipboardPush();
      }, 900);
    },

    _stopClipPoll() {
      if (this._clipPollTimer) {
        clearInterval(this._clipPollTimer);
        this._clipPollTimer = null;
      }
    },

    async _pollClipboardPush() {
      try {
        const text = await api.clipboardReadText();
        const cur = typeof text === 'string' ? text : '';
        if (!cur || cur === (this._lastClipText || '')) return;
        this._lastClipText = cur;
        const session = this.session;
        if (!session) return;
        const data = new ClipboardData();
        data.addText('text/plain', cur);
        await session.onClipboardPaste(data);
      } catch (_) {}
    },

    _applyScale() {
      const canvas = this.$refs.canvas;
      const wrap = this.$refs.screenEl;
      if (!canvas || !wrap || !canvas.width || !canvas.height) return;
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      if (!cw || !ch) return;
      const scale = Math.min(cw / canvas.width, ch / canvas.height);
      canvas.style.width = Math.floor(canvas.width * scale) + 'px';
      canvas.style.height = Math.floor(canvas.height * scale) + 'px';
    },

    cleanupSession(session) {
      if (this.session === session) {
        this.session = null;
        if (this._disposeInput) this._disposeInput();
      }
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

    disconnectNow(silent) {
      this._closing = true;
      const sid = this.liveSessionId;
      this.liveSessionId = null;
      if (this.offState) {
        this.offState();
        this.offState = null;
      }
      if (this.session) {
        const s = this.session;
        this.session = null;
        try {
          s.shutdown();
        } catch (_) {}
      }
      if (this._disposeInput) this._disposeInput();
      this._stopClipPoll();
      // Clear the last rendered frame so the screen does not linger after close.
      const canvasEl = this.$refs.canvas;
      if (canvasEl) {
        const ctx = canvasEl.getContext && canvasEl.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      }
      this.showCanvas = false;
      if (sid && api.rdpDisconnect) {
        try {
          const r = api.rdpDisconnect(sid);
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
.rdp-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: #141414;
}
.rdp-wrap.is-rdp-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 9999;
  width: 100vw;
  height: 100vh;
}
.rdp-toolbar {
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
.rdp-meta {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: var(--text-2, #9aa7b8);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rdp-status {
  font-size: 11px;
  color: var(--text-3, #6b7789);
  white-space: nowrap;
}
.rdp-status.connected {
  color: #67c23a;
}
.rdp-status.connecting {
  color: #e6a23c;
}
.rdp-status.error,
.rdp-status.ended {
  color: #f56c6c;
}
.rdp-screen {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #141414;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
}
.rdp-canvas {
  display: block;
  background: var(--bg, #1b232e);
  cursor: default;
  outline: none;
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