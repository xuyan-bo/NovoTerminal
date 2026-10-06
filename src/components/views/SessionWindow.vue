<template>
  <div class="detached-root">
    <component
      :is="viewComponent"
      v-if="viewComponent"
      :session-id="tabId"
      :asset-id="assetId"
      :method-id="methodId"
      :title="hostLabel"
      :active="true"
      :attach-session-id="attachSessionId || undefined"
      @session="onSession"
      @connection="connected = $event"
    />
    <div v-else class="detached-empty">{{ emptyText }}</div>
  </div>
</template>

<script>
import { api, markSessionHandover } from '../../store';
import { t } from '../../i18n';
import { getProtocol } from '../../protocols';

/**
 * Host of one session tab that was dragged out into its own window. The window keeps the native
 * title bar, so moving it, closing it and the drag back onto the tab bar are all main process
 * concerns; this page only renders the protocol view and releases it without dropping the main
 * process connection when the host asks for it back.
 */
export default {
  name: 'SessionWindow',
  props: {
    query: { type: Object, default: () => ({}) },
  },
  data() {
    return {
      attachSessionId: '',
      connected: false,
    };
  },
  computed: {
    kind() {
      return String(this.query.kind || '');
    },
    tabId() {
      return String(this.query.tabId || '');
    },
    assetId() {
      return String(this.query.assetId || '');
    },
    methodId() {
      return String(this.query.methodId || this.kind || '');
    },
    hostLabel() {
      const host = this.query.host || '';
      return host ? host + (this.query.port ? ':' + this.query.port : '') : '';
    },
    confirmName() {
      return this.query.name || this.hostLabel || this.tabId;
    },
    viewComponent() {
      const protocol = getProtocol(this.kind);
      return protocol && protocol.component ? protocol.component : null;
    },
    emptyText() {
      return this.kind ? t('msg.notImpl', { name: this.kind }) : t('tab.detachBadKind');
    },
  },
  created() {
    this._offHandover = null;
    this._offConfirm = null;
    // The main window can ask for the session back at any time, and this instance must then
    // release its view without tearing the main-process connection down.
    if (api.onSessionHandover) {
      this._offHandover = api.onSessionHandover((payload) => {
        if (this.kind === 'ssh' && payload && payload.tabId === this.tabId) markSessionHandover(this.tabId);
      });
    }
    // The native close button ends the session, so the main process defers the decision to us.
    if (api.onSessionConfirmClose) {
      this._offConfirm = api.onSessionConfirmClose((payload) => {
        if (payload && payload.tabId === this.tabId) this.confirmClose();
      });
    }
  },
  mounted() {
    this.attachSessionId = this.kind === 'ssh' ? String(this.query.sid || '') : '';
  },
  beforeDestroy() {
    if (this._offHandover) this._offHandover();
    if (this._offConfirm) this._offConfirm();
  },
  methods: {
    onSession(sid) {
      if (this.kind === 'ssh') this.attachSessionId = sid || '';
    },
    /** Same prompt the tab bar shows for a live session; declining keeps the window open. */
    confirmClose() {
      if (!this.connected) {
        this.answerClose(true);
        return;
      }
      this.$confirm(
        t('tab.closeConfirmMsg', { name: this.confirmName }),
        t('tab.closeConfirmTitle'),
        { confirmButtonText: t('msg.confirm'), cancelButtonText: t('msg.cancel'), type: 'warning' }
      ).then(
        () => this.endSession(),
        () => this.answerClose(false)
      );
    },
    /** Ends the session in the same click, exactly like the tab bar's close button, then closes. */
    endSession() {
      if (this.kind === 'ssh' && this.attachSessionId && api.sshDisconnect) {
        api.sshDisconnect(this.attachSessionId).catch(() => {});
      }
      this.answerClose(true);
    },
    /** A failed reply must not be read as a decline, so the decision is never taken from the chain. */
    answerClose(confirmed) {
      api.sessionCloseAnswer({ tabId: this.tabId, confirmed }).catch((e) => {
        if (api.logWrite) {
          api.logWrite({
            level: 'warn', source: 'session', message: 'detached window close answer failed',
            meta: { tabId: this.tabId, confirmed, message: e.message },
          }).catch(() => {});
        }
      });
    },
  },
};
</script>

<style scoped>
.detached-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-app);
  color: var(--text);
}

.detached-root > * {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.detached-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 13px;
}
</style>
