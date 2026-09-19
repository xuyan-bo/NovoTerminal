<template>
  <div class="app-root">
    <div class="body-row">
      <side-bar />
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
            v-for="t in sshTabs"
            :key="t.id"
            class="view ssh-view"
            :class="{ show: activeTab === t.id }"
          >
            <!-- v-show keeps the xterm instance (and SSH session) alive across tab switches -->
            <terminal-view
              v-show="activeTab === t.id"
              :session-id="t.id"
              :asset-id="t.assetId"
              :method-id="t.methodId || 'ssh'"
              :title="(t.host || '') + (t.port ? ':' + t.port : '')"
              :active="activeTab === t.id"
            />
          </div>
        </div>

        <div class="statusbar">
          <span>{{ $t('status.assets') }} <b>{{ assetCount }}</b> · {{ platformLabel }}</span>
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
    <div class="ctx-menu" ref="ctxRoot"></div>
  </div>
</template>

<script>
import SideBar from './components/SideBar.vue';
import HomeView from './components/HomeView.vue';
import AssetDetailView from './components/AssetDetailView.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import AssetDialog from './components/AssetDialog.vue';
import GroupDialog from './components/GroupDialog.vue';
import MethodAdvancedDialog from './components/MethodAdvancedDialog.vue';
import TerminalView from './components/TerminalView.vue';
import { store, closeTab, api, refresh } from './store';
import { t, applySettings } from './i18n';
import { OS_SVG } from './constants';

export default {
  name: 'App',
  components: {
    SideBar,
    HomeView,
    AssetDetailView,
    SettingsDialog,
    AssetDialog,
    GroupDialog,
    MethodAdvancedDialog,
    TerminalView,
  },
  data() {
    return {
      clock: '',
      platformLabel: (api && api.platform) || 'browser',
    };
  },
  computed: {
    tabs() {
      return store.tabs;
    },
    activeTab() {
      return store.activeTab;
    },
    assetTabs() {
      return store.tabs.filter((t) => t.assetId && t.kind !== 'ssh');
    },
    sshTabs() {
      return store.tabs.filter((t) => t.kind === 'ssh');
    },
    assetCount() {
      return (store.snapshot.groups || []).reduce((s, g) => s + g.nodes.length, 0);
    },
    localeTick() {
      return store.localeTick;
    },
  },
  created() {
    if (store.snapshot.settings) applySettings(store.snapshot.settings);
    this.tick();
    this._timer = setInterval(this.tick, 20000);
    this._off = api.onSessionState && api.onSessionState((payload) => this.onSession(payload));
    this._offStore =
      api.onStoreChanged &&
      api.onStoreChanged(() => {
        refresh().catch(() => {});
      });
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
    clearInterval(this._timer);
    if (this._off) this._off();
    if (this._offStore) this._offStore();
    if (this._mq && this._mqHandler && this._mq.removeEventListener) {
      this._mq.removeEventListener('change', this._mqHandler);
    }
  },
  methods: {
    $t: t,
    osSvg(os) {
      return OS_SVG[os] || '';
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
      closeTab(id);
      // TerminalView beforeDestroy handles ssh disconnect
    },
    tick() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      this.clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
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
