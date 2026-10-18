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
          <svg-icon :name="isFullscreen ? 'fullscreen-out' : 'fullscreen-in'" />
        </button>
      </el-tooltip>
      <el-tooltip v-if="sftpAvailable" :content="$t('sftp.openTip')" placement="top">
        <button
          type="button"
          class="gear-icon-btn"
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
          <svg-icon :name="isDisconnected ? 'link' : 'link-broken'" />
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
import { connectionErrorMessage, api, unwrap, refresh, findAsset, enabledMethods, store } from '../../store';
import { t } from '../../i18n';
import init, {
  SessionBuilder,
  DesktopSize,
  InputTransaction,
  DeviceEvent,
  ClipboardData,
  Extension,
} from 'ironrdp-wasm';
import createFullscreenMixin from '../session/fullscreen';

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

// IronRDP 要求域和用户名分开，mstsc/xfreerdp 各自的处理见对应适配器，
// 所以资产里只有用户名一个字段时这里按 DOMAIN\user 的写法拆出来，两种引擎才等价。
function splitUserDomain(user) {
  const value = String(user || '');
  const sep = value.indexOf('\\');
  if (sep <= 0) return { user: value, domain: '' };
  return { user: value.slice(sep + 1), domain: value.slice(0, sep) };
}

const LOCK_KEYS = new Set(['CapsLock', 'NumLock', 'ScrollLock']);

/** IronErrorKind 是 d.ts 文档化的枚举（0–6），逐个映射成可读文案；其它形态仍显示原始信息。 */
const RDP_ERROR_KIND_KEYS = {
  0: 'err.rdp.general',
  1: 'err.rdp.wrongPassword',
  2: 'err.rdp.logonFailure',
  3: 'err.rdp.accessDenied',
  4: 'err.rdp.rdCleanPath',
  5: 'err.rdp.proxyConnect',
  6: 'err.rdp.negotiation',
};

/** 页签状态点：内嵌 RDP 的 connected 归到共用的 ready，ended 与 idle 是不连接的灰色。 */
const DOT_STATE = { connecting: 'connecting', connected: 'ready', error: 'error' };

/** 认证失败后当场自动重问几次（与主进程 SSH_AUTH_RETRY 同值） */
const RDP_AUTH_RETRY = 2;

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
    localeTick() {
      return store.localeTick;
    },
    statusText() {
      // 状态没变、只换语言时这个 computed 不会重算，必须显式依赖 localeTick
      void this.localeTick;
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
      void this.localeTick;
      return this.isDisconnected ? t('rdp.reconnect') : t('rdp.disconnect');
    },
    /** 与侧栏/详情页同一条件：资产启用了 SFTP 方式才给入口。 */
    sftpAvailable() {
      const hit = findAsset(this.assetId);
      return !!(hit && enabledMethods(hit.asset).some((m) => m.id === 'sftp'));
    },
  },
  watch: {
    status(val) {
      const connected = val === 'connecting' || val === 'connected';
      const tab = store.tabs.find((t) => t.id === this.sessionId);
      if (tab) tab.connState = DOT_STATE[val] || 'idle';
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
    this._disposed = false;
    this._connectVersion = 0;
    this._reask = false;
    this._authTries = 0;
    this._lastAuthError = false;
    this.connect();
  },
  beforeDestroy() {
    this._disposed = true;
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
        // 主进程错误码优先查词条，查不到才回退英文技术描述
        if (typeof v.code === 'string' && v.code) {
          const coded = 'err.' + v.code;
          const mapped = t(coded);
          if (mapped !== coded) return mapped;
        }
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
    errUserText(e) {
      if (e && typeof e.kind === 'function') {
        const key = RDP_ERROR_KIND_KEYS[e.kind()];
        if (key) return t(key);
      }
      return this.errText(e);
    },
    /** IronErrorKind 1/2 是口令类错误：记下重问标记，错误文案照旧返回给用户 */
    authErrorText(e) {
      const kind = e && typeof e.kind === 'function' ? e.kind() : -1;
      this._lastAuthError = kind === 1 || kind === 2;
      if (this._lastAuthError) this._reask = true;
      return this.errUserText(e);
    },
    /**
     * 口令被服务器拒绝时当场重新要一次凭证（与 VNC、SSH 的重问一致），不等用户点重连。
     * 上限内自动重建会话；非认证错误或预算用尽就停在错误态。
     */
    retryAuth() {
      if (!this._lastAuthError) return;
      this._lastAuthError = false;
      if (this._authTries >= RDP_AUTH_RETRY) return;
      this._authTries += 1;
      this.connect();
    },
    async connect() {
      this.disconnectNow(true);
      this._closing = false;
      const version = ++this._connectVersion;
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
        this.statusDetail = this.authErrorText(e);
        this.retryAuth();
        return;
      }

      this.liveSessionId = r.sessionId;

      // 关页签时握手还没回来：这条代理已无人接管，立刻释放。
      if (this._disposed || version !== this._connectVersion) {
        this.disconnectNow(true);
        return;
      }

      this.offState = api.onRdpState((ev) => {
        if (!ev || ev.sessionId !== this.liveSessionId) return;
        // 代理的 connected 只到 TCP+TLS 与 RDCleanPath，认证仍发生在 wasm 侧，不能提前翻绿：
        // builder.connect() 取回 Session 才算连上，与 VNC 故意忽略代理 ready 是同一条口径。
        if (ev.type === 'ended') {
          // 代理在报错后紧接着也会结束，不能让随后的 ended 把失败原因抹成「已断开」。
          if (this.status === 'error') return;
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
        this.disconnectNow(true);
        this.status = 'error';
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
        // IronRDP 在渲染端建会话，登录名与口令由主进程按凭证解析后只回给这个窗口
        const auth = unwrap(
          await api.sessionAuth({ assetId: this.assetId, methodId: this.methodId, reask: this._reask })
        );
        const logon = splitUserDomain(auth.username || '');
        const password = auth.password || '';
        const nla = advanced.nla !== false;
        const clipboard = advanced.clipboard !== false;
        this._clipboardEnabled = clipboard;

        await init();

        if (this._disposed || version !== this._connectVersion) {
          this.disconnectNow(true);
          return;
        }

        const parsed = parseResolution(advanced.resolution);
        // 「跟随系统」按本机屏幕尺寸请求桌面；两种取值都只在连接时定一次，之后靠 CSS 缩放适配容器
        let dw = (parsed && parsed.width) || window.screen.width || 1280;
        let dh = (parsed && parsed.height) || window.screen.height || 720;
        if (dw < 320) dw = 320;
        if (dh < 240) dh = 240;

        const builder = new SessionBuilder();
        builder.username(logon.user);
        if (logon.domain) builder.serverDomain(logon.domain);
        builder.password(password);
        // IPv6 不加方括号时代理按最后一个冒号切端口，会把地址本身切坏（与外部客户端适配器同一条规则）
        const rdpTarget = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        builder.destination(`${rdpTarget}:${port}`);
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
        if (this._disposed || version !== this._connectVersion) {
          try {
            session.shutdown();
          } catch (_) {}
          this.disconnectNow(true);
          return;
        }
        this.session = session;
        const ds = session.desktopSize();
        canvas.width = ds.width;
        canvas.height = ds.height;
        this.showCanvas = true;
        this.status = 'connected';
        this.statusDetail = '';
        this._reask = false;
        this._authTries = 0;
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
            // 正常结束也记下原因，否则失败排查只剩一条「已断开」。
            if (info) console.info('[rdp] session ended, reason:', info.reason());
            if (this.session === session) this.cleanupSession(session);
          })
          .catch((e) => {
            if (this._closing) return;
            console.error('[rdp] session.run error:', e);
            if (this.session === session) {
              this.session = null;
              this._stopClipPoll();
              this.status = 'error';
              this.statusDetail = this.authErrorText(e);
              this.retryAuth();
            }
          });

        refresh().catch(() => {});
      } catch (e) {
        console.error('[rdp] connect error:', e);
        // 代理已建立或订阅已挂上时失败要就地释放，不能留到组件销毁才清
        this.disconnectNow(true);
        this.status = 'error';
        this.statusDetail = this.authErrorText(e);
        this.retryAuth();
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
        // keydown 时 modifier 还是切换前的值，锁键要等 keyup 再同步，否则远端永远慢一拍
        if (!down && LOCK_KEYS.has(e.code)) this._syncLockKeys(e);
      };
      const onKeyDown = onKey(true);
      const onKeyUp = onKey(false);
      const onBlur = () => {
        if (this.session !== session) return;
        // 失焦时不会有 keyup，锁在远端的按键要在这里放开。
        try {
          session.releaseAllInputs();
        } catch (_) {}
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

      canvas.addEventListener('keydown', onKeyDown);
      canvas.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('blur', onBlur);
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mousedown', onMouseDown);
      canvas.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', onContext);

      this._disposeInput = () => {
        canvas.removeEventListener('keydown', onKeyDown);
        canvas.removeEventListener('keyup', onKeyUp);
        canvas.removeEventListener('blur', onBlur);
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mousedown', onMouseDown);
        canvas.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('contextmenu', onContext);
        this._disposeInput = null;
      };
    },

    _syncLockKeys(e) {
      const session = this.session;
      if (!session) return;
      try {
        session.synchronizeLockKeys(
          e.getModifierState('ScrollLock'),
          e.getModifierState('NumLock'),
          e.getModifierState('CapsLock'),
          false
        );
      } catch (_) {}
    },

    /** 与 VncView 同一条政策：只有正被看着、页面拿到焦点的会话才允许读写本机剪贴板。 */
    _canClipboard() {
      const el = this.$refs.screenEl;
      return this.status === 'connected' && this.active && document.hasFocus() &&
        !!el && el.contains(document.activeElement);
    },

    // Remote → local clipboard.
    _onRemoteClipboard(cbData) {
      const session = this.session;
      if (!session || !this._clipboardEnabled || !this._canClipboard()) return;
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
          const normalized = text.replace(/\r\n/g, '\n');
          api.clipboardWriteText(normalized).catch(() => {});
          // Mark as seen so the local→remote poll does not push it straight back.
          this._lastClipText = normalized;
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
        if (!this._clipboardEnabled || !this._canClipboard()) return;
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
        // 会话自己结束时也要停掉剪贴板轮询，不能留到页签销毁
        this._stopClipPoll();
      }
    },

    async openSftp() {
      if (!api.sftpOpenWindow) {
        this.$message.error(t('msg.needElectron'));
        return;
      }
      try {
        unwrap(await api.sftpOpenWindow({ assetId: this.assetId }));
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      }
    },

    reconnect() {
      // 手动重连给一次新的重问预算
      this._authTries = 0;
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