<template>
  <div class="app-root" :class="{ 'is-sftp': isSftpRoute, 'is-session': isSessionRoute }">
    <sftp-page v-if="isSftpRoute" />
    <session-window v-else-if="isSessionRoute" :query="sessionQuery" />
    <template v-else>
    <div class="body-row">
      <side-bar v-show="!treeHidden" :style="sidebarStyle" />
      <div
        v-show="!treeHidden"
        class="sidebar-resizer"
        :class="{ active: resizing }"
        :style="{ left: sidebarWidth + 'px' }"
        @mousedown="startResize"
      ></div>
      <section class="main">
        <tab-bar :tree-hidden="treeHidden" @toggle-tree="treeHidden = !treeHidden" />

        <div class="views">
          <div class="view" :class="{ show: activeTab === 'home' }">
            <home-view />
          </div>
          <div
            v-for="t in assetTabs"
            :key="t.id"
            class="view"
            :class="{ show: activeTab === t.id }"
          >
            <asset-detail-view :asset-id="t.assetId" />
          </div>
          <div
            v-for="t in sessionTabs"
            :key="t.id + ':' + (tabRefreshKeys[t.id] || 0)"
            class="view"
            :class="[t.kind + '-view', { show: activeTab === t.id }]"
          >
            <!-- Keep protocol instances alive when switching tabs. -->
            <component
              :is="sessionComponent(t)"
              v-show="activeTab === t.id"
              :session-id="t.id"
              :asset-id="t.assetId"
              :method-id="t.methodId"
              :title="(t.host || '') + (t.port ? ':' + t.port : '')"
              :active="activeTab === t.id"
              :attach-session-id="attachSessionIdOf(t)"
              @session="onViewSession(t, $event)"
            />
          </div>
        </div>
      </section>
    </div>

    <settings-dialog />
    <log-dialog />
    <asset-dialog />
    <group-dialog />
    <method-advanced-dialog />
    <close-prompt-dialog />
    </template>
    <ssh-auth-dialog />
  </div>
</template>

<script>
import SideBar from './components/SideBar.vue';
import TabBar from './components/TabBar.vue';
import AssetDetailView from './components/AssetDetailView.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import LogDialog from './components/LogDialog.vue';
import AssetDialog from './components/AssetDialog.vue';
import GroupDialog from './components/GroupDialog.vue';
import MethodAdvancedDialog from './components/MethodAdvancedDialog.vue';
import ClosePromptDialog from './components/ClosePromptDialog.vue';
import SshAuthDialog from './components/SshAuthDialog.vue';
import { store, api, refresh, applyDetached, dropDetachedTab } from './store';
import { t, applySettings } from './i18n';
import { getProtocol } from './protocols';

const MIN_SIDEBAR_W = 180;
const MAX_SIDEBAR_W = 640;
const SIDEBAR_W_KEY = 'novoterminal.sidebarWidth';
const DEFAULT_SIDEBAR_RATIO = 0.18;
const DEFAULT_SIDEBAR_MIN = 220;
const DEFAULT_SIDEBAR_MAX = 400;

function defaultSidebarWidth() {
  const w = Math.round(window.innerWidth * DEFAULT_SIDEBAR_RATIO);
  return Math.min(DEFAULT_SIDEBAR_MAX, Math.max(DEFAULT_SIDEBAR_MIN, w));
}
// 适配器 id → 客户端可执行文件名，用于会话结束提示；专有名词，不翻译
const RDP_CLIENT_NAMES = {
  'rdp-windows-mstsc': 'mstsc',
  'rdp-xfreerdp': 'xfreerdp',
  'rdp-wfreerdp': 'wfreerdp',
};

function parseHashRoute(prefix) {
  const h = String((typeof location !== 'undefined' && location.hash) || '').replace(/^#\/?/, '');
  if (!h.startsWith(prefix)) return null;
  const qIdx = h.indexOf('?');
  const qs = qIdx >= 0 ? h.slice(qIdx + 1) : '';
  const out = {};
  qs.split('&').forEach((pair) => {
    if (!pair) return;
    const [k, v] = pair.split('=');
    out[decodeURIComponent(k || '')] = decodeURIComponent(v || '');
  });
  return out;
}

export default {
  name: 'App',
  components: {
    SideBar,
    TabBar,
    HomeView: () => import('./components/HomeView.vue'),
    AssetDetailView,
    SettingsDialog,
    LogDialog,
    AssetDialog,
    GroupDialog,
    MethodAdvancedDialog,
    ClosePromptDialog,
    SshAuthDialog,
    SftpPage: () => import('./components/SftpPage.vue'),
    SessionWindow: () => import('./components/SessionWindow.vue'),
  },
  data() {
    return {
      sidebarWidth: defaultSidebarWidth(),
      resizing: false,
      treeHidden: false,
      isSftpRoute: !!parseHashRoute('sftp'),
      sessionQuery: parseHashRoute('session') || {},
      isSessionRoute: !!parseHashRoute('session'),
    };
  },
  computed: {
    sidebarStyle() {
      return {
        width: this.sidebarWidth + 'px',
        flex: '0 0 ' + this.sidebarWidth + 'px',
      };
    },
    activeTab() {
      return store.activeTab;
    },
    tabRefreshKeys() {
      return store.tabRefreshKeys;
    },
    assetTabs() {
      return store.tabs.filter((t) => t.kind === 'asset');
    },
    sessionTabs() {
      return store.tabs.filter((t) => {
        if (t.detached) return false;
        const protocol = getProtocol(t.kind);
        return protocol && protocol.component;
      });
    },
  },
  created() {
    this._onHash = () => {
      const q = parseHashRoute('sftp');
      this.isSftpRoute = !!q;
      const s = parseHashRoute('session');
      this.sessionQuery = s || {};
      this.isSessionRoute = !!s;
    };
    window.addEventListener('hashchange', this._onHash);
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
      if (saved >= MIN_SIDEBAR_W && saved <= MAX_SIDEBAR_W) this.sidebarWidth = saved;
    } catch (_) {}
    if (!this.isSftpRoute && !this.isSessionRoute) {
      if (store.snapshot.settings) applySettings(store.snapshot.settings);
      this._off = api.onSessionState && api.onSessionState((payload) => this.onSession(payload));
      this._offDetached =
        api.onSessionDetached &&
        api.onSessionDetached((payload) => {
          if (!payload) return;
          applyDetached(payload.tabId, !!payload.detached);
        });
      this._offClosedWindow =
        api.onSessionClosed &&
        api.onSessionClosed((payload) => {
          if (payload && payload.tabId) dropDetachedTab(payload.tabId);
        });
      this._offStore =
        api.onStoreChanged &&
        api.onStoreChanged(() => {
          refresh().catch(() => {});
        });
    }
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => {
        const th = (store.snapshot.settings || {}).theme;
        if (th === 'system') applySettings({ ...store.snapshot.settings, theme: 'system' });
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      this._mq = mq;
      this._mqHandler = onChange;
    }
  },
  beforeDestroy() {
    if (this._onHash) window.removeEventListener('hashchange', this._onHash);
    if (this._off) this._off();
    if (this._offDetached) this._offDetached();
    if (this._offClosedWindow) this._offClosedWindow();
    if (this._offStore) this._offStore();
    if (this._mq && this._mqHandler && this._mq.removeEventListener) {
      this._mq.removeEventListener('change', this._mqHandler);
    }
  },
  methods: {
    sessionComponent(tab) {
      return getProtocol(tab.kind).component;
    },
    /** Only SSH re-hosts a live connection across windows; the other views always reconnect. */
    attachSessionIdOf(tab) {
      return tab.kind === 'ssh' ? tab.liveSessionId || undefined : undefined;
    },
    /**
     * The view owns its live connection id; record it so a detached window can re-host it. Views
     * never clear it on teardown: a refresh destroys the old instance after the new one connected,
     * and an id of a session that already ended is rejected by ssh:attach, which falls back to
     * connecting fresh.
     */
    onViewSession(tab, sessionId) {
      tab.liveSessionId = sessionId || null;
    },
    /** Drag the divider between the asset tree and the right pane */
    startResize(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      this.resizing = true;
      const startX = e.clientX;
      const startW = this.sidebarWidth;
      const onMove = (ev) => {
        const w = startW + (ev.clientX - startX);
        this.sidebarWidth = Math.max(MIN_SIDEBAR_W, Math.min(MAX_SIDEBAR_W, w));
      };
      const onUp = () => {
        this.resizing = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try {
          localStorage.setItem(SIDEBAR_W_KEY, String(this.sidebarWidth));
        } catch (_) {}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    async onSession(payload) {
      if (payload && payload.type === 'ended') {
        await refresh();
        const client = RDP_CLIENT_NAMES[payload.client] || 'RDP';
        this.$message.info(t('msg.sessionEnded', { client }));
      }
      if (payload && payload.type === 'error') {
        this.$message.error(payload.message || payload.code || t('err.connect'));
      }
    },
  },
};
</script>
