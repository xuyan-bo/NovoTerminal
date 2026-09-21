// Serialize native requests and keep CSS fallback ownership local to one view.
let pendingOwner = null;
let exitingOwner = null;
let fallbackOwner = null;

function fullscreenElement(el) {
  const doc = el.ownerDocument;
  return doc.fullscreenElement || doc.webkitFullscreenElement;
}

async function exitOwnedFullscreen(el) {
  if (!el || fullscreenElement(el) !== el || exitingOwner) return;
  const doc = el.ownerDocument;
  const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
  if (exit) {
    exitingOwner = el;
    try { await exit.call(doc); } catch (_) {}
    finally { exitingOwner = null; }
  }
}

export default function createFullscreenMixin({ fallbackClass, onResize, resizeOnNextTick = false }) {
  function clearHint(vm) {
    clearTimeout(vm._fullscreen.hintTimer);
    vm._fullscreen.hintTimer = null;
    vm.fsHint = false;
  }

  function update(vm, now, fallback = false) {
    const state = vm._fullscreen;
    if (state.disposed) return;
    const changed = vm.isFullscreen !== now || state.fallback !== fallback;
    if (fallbackOwner === state) fallbackOwner = null;
    state.fallback = fallback;
    if (fallback) fallbackOwner = state;
    state.el.classList.toggle(fallbackClass, fallback);
    vm.isFullscreen = now;
    if (now) vm.showFsHint();
    else clearHint(vm);
    if (changed) {
      const resize = () => {
        if (!state.disposed) onResize.call(vm);
      };
      if (resizeOnNextTick) vm.$nextTick(resize);
      else resize();
    }
  }

  return {
    data() {
      return { isFullscreen: false, fsHint: false };
    },
    created() {
      // Non-reactive, per-instance lifecycle state; never shared between mixin users.
      this._fullscreen = {
        el: null,
        disposed: false,
        pending: false,
        cancelled: false,
        fallback: false,
        hintTimer: null,
      };
    },
    mounted() {
      const el = this.$refs.wrapEl;
      this._fullscreen.el = el;
      if (!el) return;
      const doc = el.ownerDocument;
      doc.addEventListener('fullscreenchange', this.onFsChange);
      doc.addEventListener('webkitfullscreenchange', this.onFsChange);
      // Capture before xterm/noVNC, which can consume key events at the target.
      doc.addEventListener('keydown', this.onFallbackEscape, true);
    },
    beforeDestroy() {
      const state = this._fullscreen;
      state.disposed = true;
      state.cancelled = true;
      clearHint(this);
      const el = state.el;
      if (el) {
        const doc = el.ownerDocument;
        doc.removeEventListener('fullscreenchange', this.onFsChange);
        doc.removeEventListener('webkitfullscreenchange', this.onFsChange);
        doc.removeEventListener('keydown', this.onFallbackEscape, true);
        el.classList.remove(fallbackClass);
      }
      if (fallbackOwner === state) fallbackOwner = null;
      state.fallback = false;
      this.isFullscreen = false;
      // No resize on destruction. A pending request also checks disposal when it settles.
      exitOwnedFullscreen(el);
    },
    methods: {
      async onToggleFullscreen() {
        const state = this._fullscreen;
        if (state.disposed) return;
        if (this.isFullscreen || state.pending) await this.exitFullscreen();
        else await this.enterFullscreen();
      },

      async enterFullscreen() {
        const state = this._fullscreen;
        const el = state.el;
        if (state.disposed || !el || pendingOwner || exitingOwner) return;
        const current = fullscreenElement(el);
        if ((current && current !== el) || (fallbackOwner && fallbackOwner !== state)) return;
        if (this.isFullscreen || current === el) {
          this.onFsChange();
          return;
        }
        pendingOwner = state;
        state.pending = true;
        state.cancelled = false;
        try {
          const request = el.requestFullscreen || el.webkitRequestFullscreen;
          try {
            if (request) await request.call(el);
          } catch (_) {}
          if (state.disposed || state.cancelled) {
            // Requests cannot be cancelled; only undo a late success belonging to this view.
            await exitOwnedFullscreen(el);
            return;
          }
          const current = fullscreenElement(el);
          if (!current) update(this, true, true);
          else this.onFsChange();
        } finally {
          state.pending = false;
          if (pendingOwner === state) pendingOwner = null;
        }
      },

      showFsHint() {
        const state = this._fullscreen;
        if (state.disposed || !this.isFullscreen) return;
        clearTimeout(state.hintTimer);
        this.fsHint = true;
        state.hintTimer = setTimeout(() => {
          state.hintTimer = null;
          if (!state.disposed) this.fsHint = false;
        }, 3000);
      },

      async exitFullscreen() {
        const state = this._fullscreen;
        if (state.disposed || !state.el) return;
        state.cancelled = true;
        clearHint(this);
        if (state.fallback) update(this, false);
        await exitOwnedFullscreen(state.el);
        if (!state.disposed) this.onFsChange();
      },

      onFsChange() {
        const state = this._fullscreen;
        if (state.disposed || !state.el) return;
        const current = fullscreenElement(state.el);
        // Legacy WebKit can report success after its non-Promise request has returned.
        if (current === state.el && state.cancelled) {
          exitOwnedFullscreen(state.el);
          return;
        }
        if (state.pending && this.isFullscreen && !state.fallback && current !== state.el) {
          state.cancelled = true;
        }
        // Unrelated native events must neither claim another view nor clear our fallback.
        const fallback = !current && state.fallback;
        update(this, current === state.el || fallback, fallback);
      },

      onFallbackEscape(event) {
        const state = this._fullscreen;
        if (state.disposed || this.active === false || fallbackOwner !== state || !state.fallback) return;
        const current = fullscreenElement(state.el);
        if (current || (event.key !== 'Escape' && event.key !== 'Esc')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.exitFullscreen();
      },
    },
  };
}
