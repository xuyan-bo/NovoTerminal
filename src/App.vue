<template>
  <div class="app-root" :class="{ 'is-sftp': isSftpRoute }">
    <sftp-page
      v-if="isSftpRoute"
      :asset-id="sftpQuery.assetId || ''"
      :host="sftpQuery.host || ''"
      :port="Number(sftpQuery.port) || 22"
      :asset-name="sftpQuery.name || ''"
    />
    <template v-else>
    <div class="body-row">
      <side-bar :style="sidebarStyle" />
      <div
        class="sidebar-resizer"
        :class="{ active: resizing }"
        :style="{ left: sidebarWidth + 'px' }"
        @mousedown="startResize"
      ></div>
      <section class="main">
        <div class="tabbar">
          <div
            v-for="t in tabs"
            :key="t.id"
            class="tab"
            :class="{ active: activeTab === t.id }"
            @click="onTabClick(t)"
          >
            <span
              v-if="t.os"
              class="tab-os"
              :class="'os-' + t.os"
              v-html="osSvg(t.os)"
            ></span>
            <span v-else class="tab-glyph">{{ t.icon }}</span>
            <span>{{ tabTitle(t) }}</span>
            <span
              v-if="t.closable"
              class="x"
              @click.stop="closeTabById(t.id)"
            >✕</span>
          </div>
        </div>

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
            :key="t.id"
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
            />
          </div>
        </div>

        <div class="statusbar">
          <span>Hello OmniDesk</span>
          <span class="sp">
            <span>{{ clock }}</span>
            <span>v0.1.0</span>
          </span>
        </div>
      </section>
    </div>

    <settings-dialog />
    <asset-dialog />
    <group-dialog />
    <method-advanced-dialog />
    <close-prompt-dialog />
    </template>
  </div>
</template>

<script>
import SideBar from './components/SideBar.vue';
import AssetDetailView from './components/AssetDetailView.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import AssetDialog from './components/AssetDialog.vue';
import GroupDialog from './components/GroupDialog.vue';
import MethodAdvancedDialog from './components/MethodAdvancedDialog.vue';
import ClosePromptDialog from './components/ClosePromptDialog.vue';
import { store, closeTab, api, refresh } from './store';
import { t, applySettings } from './i18n';
import { OS_SVG } from './constants';
import { getProtocol } from './protocols';

const MIN_SIDEBAR_W = 180;
const MAX_SIDEBAR_W = 640;
const SIDEBAR_W_KEY = 'omnidesk.sidebarWidth';

function parseSftpHash() {
  const h = String((typeof location !== 'undefined' && location.hash) || '').replace(/^#\/?/, '');
  if (!h.startsWith('sftp')) return null;
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
    HomeView: () => import('./components/HomeView.vue'),
    AssetDetailView,
    SettingsDialog,
    AssetDialog,
    GroupDialog,
    MethodAdvancedDialog,
    ClosePromptDialog,
    SftpPage: () => import('./components/SftpPage.vue'),
  },
  data() {
    return {
      clock: '',
      sidebarWidth: 268,
      resizing: false,
      sftpQuery: parseSftpHash() || {},
      isSftpRoute: !!parseSftpHash(),
    };
  },
  computed: {
    sidebarStyle() {
      return {
        width: this.sidebarWidth + 'px',
        flex: '0 0 ' + this.sidebarWidth + 'px',
      };
    },
    tabs() {
      return store.tabs;
    },
    activeTab() {
      return store.activeTab;
    },
    assetTabs() {
      return store.tabs.filter((t) => t.kind === 'asset');
    },
    sessionTabs() {
      return store.tabs.filter((t) => {
        const protocol = getProtocol(t.kind);
        return protocol && protocol.component;
      });
    },
    localeTick() {
      return store.localeTick;
    },
  },
  created() {
    this._onHash = () => {
      const q = parseSftpHash();
      this.sftpQuery = q || {};
      this.isSftpRoute = !!q;
    };
    window.addEventListener('hashchange', this._onHash);
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
      if (saved >= MIN_SIDEBAR_W && saved <= MAX_SIDEBAR_W) this.sidebarWidth = saved;
    } catch (_) {}
    if (!this.isSftpRoute) {
      if (store.snapshot.settings) applySettings(store.snapshot.settings);
      this.tick();
      this._timer = setInterval(this.tick, 1000);
      this._off = api.onSessionState && api.onSessionState((payload) => this.onSession(payload));
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
    if (this._timer) clearInterval(this._timer);
    if (this._off) this._off();
    if (this._offStore) this._offStore();
    if (this._mq && this._mqHandler && this._mq.removeEventListener) {
      this._mq.removeEventListener('change', this._mqHandler);
    }
  },
  methods: {
    sessionComponent(tab) {
      return getProtocol(tab.kind).component;
    },
    osSvg(os) {
      return OS_SVG[os] || '';
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
    tabTitle(tab) {
      // touch localeTick so the home tab label follows language switches
      void this.localeTick;
      if (tab.id === 'home') return this.$t('nav.home');
      return tab.title;
    },
    onTabClick(tab) {
      store.activeTab = tab.id;
    },
    closeTabById(id) {
      const tab = store.tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.connected) {
        this.$confirm(
          t('tab.closeConfirmMsg', { name: tab.title }),
          t('tab.closeConfirmTitle'),
          { confirmButtonText: t('msg.confirm'), cancelButtonText: t('msg.cancel'), type: 'warning' }
        ).then(() => {
          closeTab(id);
        }).catch(() => {});
      } else {
        closeTab(id);
      }
    },
    tick() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      this.clock = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    },
    async onSession(payload) {
      if (payload && payload.type === 'ended') {
        await refresh();
        this.$message.info(t('msg.sessionEnded'));
      }
      if (payload && payload.type === 'error') {
        this.$message.error(payload.message || payload.code || t('err.connect'));
      }
    },
  },
};
</script>
