<template>
  <div ref="root" class="ai-sel-pop" :style="{ left: posX + 'px', top: posY + 'px', width: width + 'px', height: height + 'px' }">
    <div class="ai-sel-head" :title="$t('ai.selDragTip')" @mousedown="onDragStart">
      <span class="ai-sel-logo"><svg-icon name="ai" :size="15" /></span>
      <span class="ai-sel-title">{{ title }}</span>
      <span class="ai-sel-close" :title="$t('ai.selClose')" @mousedown.stop @click.stop="$emit('close')">
        <el-icon><Close /></el-icon>
      </span>
    </div>
    <div class="ai-sel-quote">{{ quote }}</div>
    <div ref="body" class="ai-sel-body">
      <div v-if="!display && !errorText" class="ai-sel-loading">
        <span class="ai-sel-spinner"></span>
        <span>{{ $t('ai.selThinking') }}<span class="ai-sel-dots"></span></span>
      </div>
      <div v-else class="ai-sel-text">{{ display }}<span v-if="typing" class="ai-sel-cursor"></span></div>
      <div v-if="errorText" class="ai-sel-error">{{ errorText }}</div>
    </div>
    <div class="ai-sel-resize" :title="$t('ai.selResizeTip')" @mousedown.stop="onResizeStart"></div>
  </div>
</template>

<script>
import { api, unwrap } from '../../store';
import { t } from '../../i18n';

function makeRequestId() {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
  return 'os-' + rand.replace(/[^a-zA-Z0-9_-]/g, '');
}

export default {
  name: 'AiSelectionPopover',
  props: {
    mode: { type: String, required: true },
    text: { type: String, default: '' },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
  },
  emits: ['close'],
  data() {
    return {
      posX: 0,
      posY: 0,
      width: 560,
      height: 340,
      display: '',
      typing: false,
      loading: true,
      errorText: '',
    };
  },
  computed: {
    title() {
      return this.mode === 'explain' ? t('term.aiExplain') : t('term.aiTranslate');
    },
    /** 保留原始换行，引用区自己可滚动，不再截断。 */
    quote() {
      return String(this.text || '').trim();
    },
  },
  created() {
    this._requestId = makeRequestId();
    this._offEvent = null;
    this._typeTimer = null;
    this._pending = '';
    this._done = false;
    this._drag = null;
    this._resize = null;
  },
  mounted() {
    if (api.onAiEvent) this._offEvent = api.onAiEvent((ev) => this.onEvent(ev));
    this.$nextTick(() => this.place());
    this.start();
  },
  beforeUnmount() {
    this.stopTypewriter();
    this.stopDrag();
    this.stopResize();
    if (this._offEvent) { this._offEvent(); this._offEvent = null; }
    if (!this._done && api.aiOneShotCancel) api.aiOneShotCancel({ requestId: this._requestId });
  },
  methods: {
    place() {
      const el = this.$el;
      if (!el) return;
      const pad = 8;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      this.posX = Math.max(pad, Math.min(this.x + 12, window.innerWidth - w - pad));
      this.posY = Math.max(pad, Math.min(this.y + 12, window.innerHeight - h - pad));
    },
    async start() {
      try {
        const res = unwrap(await api.aiOneShot({ requestId: this._requestId, mode: this.mode, text: this.text }));
        if (res && res.ok === false) {
          this.setError(res.code, res.message);
        }
      } catch (e) {
        this.setError(e.code, e.message);
      }
    },
    setError(code, message) {
      const key = 'err.' + (code || 'AI_REQUEST');
      const mapped = t(key);
      this.errorText = mapped === key ? (message || t('err.AI_REQUEST')) : mapped;
      this.loading = false;
      this._done = true;
      this.stopTypewriter();
    },
    onEvent(ev) {
      if (!ev || !ev.oneShot || ev.requestId !== this._requestId) return;
      if (ev.type === 'state') {
        this.loading = !!ev.running;
      } else if (ev.type === 'delta') {
        this.loading = false;
        this._pending += ev.text || '';
        this.runTypewriter();
      } else if (ev.type === 'done') {
        this._done = true;
        this.loading = false;
        if (ev.error && ev.error.code !== 'AI_CANCELED') this.setError(ev.error.code, ev.error.message);
      }
    },
    runTypewriter() {
      if (this._typeTimer) return;
      this.typing = true;
      this._typeTimer = setInterval(() => this.typeTick(), 22);
    },
    typeTick() {
      if (!this._pending) {
        this.stopTypewriter();
        return;
      }
      // 流式分片可能一次到很多字：积压多时多吐几个，尾段仍保持逐字效果
      const step = this._pending.length > 40 ? 3 : (this._pending.length > 15 ? 2 : 1);
      this.display += this._pending.slice(0, step);
      this._pending = this._pending.slice(step);
      this.$nextTick(() => {
        const body = this.$refs.body;
        if (body) body.scrollTop = body.scrollHeight;
      });
    },
    stopTypewriter() {
      if (this._typeTimer) clearInterval(this._typeTimer);
      this._typeTimer = null;
      this.typing = false;
    },
    onDragStart(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      this._drag = { sx: e.clientX, sy: e.clientY, ox: this.posX, oy: this.posY };
      document.addEventListener('mousemove', this.onDragMove);
      document.addEventListener('mouseup', this.onDragEnd);
    },
    onDragMove(e) {
      if (!this._drag) return;
      const pad = 8;
      this.posX = Math.max(pad, Math.min(this._drag.ox + e.clientX - this._drag.sx, window.innerWidth - this.width - pad));
      this.posY = Math.max(pad, Math.min(this._drag.oy + e.clientY - this._drag.sy, window.innerHeight - this.height - pad));
    },
    onDragEnd() {
      this.stopDrag();
    },
    stopDrag() {
      this._drag = null;
      document.removeEventListener('mousemove', this.onDragMove);
      document.removeEventListener('mouseup', this.onDragEnd);
    },
    onResizeStart(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      this._resize = { sx: e.clientX, sy: e.clientY, w: this.width, h: this.height };
      document.addEventListener('mousemove', this.onResizeMove);
      document.addEventListener('mouseup', this.onResizeEnd);
    },
    onResizeMove(e) {
      if (!this._resize) return;
      this.width = Math.max(320, Math.min(this._resize.w + e.clientX - this._resize.sx, window.innerWidth - this.posX - 8));
      this.height = Math.max(200, Math.min(this._resize.h + e.clientY - this._resize.sy, window.innerHeight - this.posY - 8));
    },
    onResizeEnd() {
      this.stopResize();
    },
    stopResize() {
      this._resize = null;
      document.removeEventListener('mousemove', this.onResizeMove);
      document.removeEventListener('mouseup', this.onResizeEnd);
    },
  },
};
</script>

<style scoped>
.ai-sel-pop {
  position: fixed;
  z-index: 3200;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  animation: ai-sel-in 0.16s ease-out;
}
@keyframes ai-sel-in {
  from { opacity: 0; transform: translateY(6px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
.ai-sel-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  border-radius: 12px 12px 0 0;
  cursor: grab;
  user-select: none;
}
.ai-sel-head:active { cursor: grabbing; }
.ai-sel-logo {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  flex: 0 0 auto;
  background: linear-gradient(135deg, var(--accent-soft), var(--think-soft));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--think);
}
.ai-sel-title { font-size: 13px; font-weight: 600; }
.ai-sel-close {
  margin-left: auto;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.ai-sel-close:hover { background: var(--bg-hover); color: var(--text); }
.ai-sel-close .el-icon { font-size: 13px; }
.ai-sel-quote {
  flex: 0 0 auto;
  max-height: 92px;
  margin: 10px 12px 0;
  padding: 7px 10px;
  border-left: 2px solid var(--think);
  background: var(--bg-panel);
  border-radius: 0 6px 6px 0;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-y: auto;
}
.ai-sel-quote::-webkit-scrollbar { width: 6px; height: 6px; }
.ai-sel-quote::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.ai-sel-quote::-webkit-scrollbar-thumb:hover { background: var(--text-3); }
.ai-sel-quote::-webkit-scrollbar-track { background: transparent; }
.ai-sel-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px;
  overflow: auto;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-sel-body::-webkit-scrollbar { width: 6px; height: 6px; }
.ai-sel-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.ai-sel-body::-webkit-scrollbar-thumb:hover { background: var(--text-3); }
.ai-sel-body::-webkit-scrollbar-track { background: transparent; }
.ai-sel-loading { display: flex; align-items: center; gap: 10px; color: var(--text-2); font-size: 12px; }
.ai-sel-spinner {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid var(--think-soft);
  border-top-color: var(--think);
  animation: ai-sel-spin 0.7s linear infinite;
}
@keyframes ai-sel-spin { to { transform: rotate(360deg); } }
.ai-sel-dots::after { content: ''; animation: ai-sel-dots 1.2s steps(4, end) infinite; }
@keyframes ai-sel-dots {
  0% { content: ''; }
  25% { content: '·'; }
  50% { content: '··'; }
  75% { content: '···'; }
  100% { content: ''; }
}
.ai-sel-cursor {
  display: inline-block;
  width: 6px;
  height: 13px;
  vertical-align: -2px;
  background: var(--think);
  margin-left: 1px;
  border-radius: 1px;
  animation: ai-sel-blink 0.9s steps(1) infinite;
}
@keyframes ai-sel-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
.ai-sel-error { margin-top: 8px; color: var(--danger); font-size: 12px; }
.ai-sel-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  z-index: 2;
}
.ai-sel-resize::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--text-3);
  border-bottom: 2px solid var(--text-3);
  border-radius: 0 0 2px 0;
}
</style>
