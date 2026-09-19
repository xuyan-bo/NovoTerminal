<template>
  <div class="home-scroll">
    <div class="home-top">
      <h2>{{ $t('home.title') }}</h2>
      <p>{{ $t('home.sub') }}</p>
    </div>

    <div class="dash-grid">
      <div class="dash-card">
        <h3>{{ $t('home.recent') }} <span class="tag">{{ recent.length }}</span></h3>
        <div v-if="recent.length" class="recent-list">
          <div
            v-for="r in recent"
            :key="r.id"
            class="recent-item"
            @click="openRecent(r)"
          >
            <span class="os-icon" :class="'os-' + r.os" v-html="osSvg(r.os)"></span>
            <div style="flex:1;min-width:0">
              <div class="ri-name">{{ r.name }}</div>
              <div class="ri-sub">{{ r.proto }}:{{ r.port }} · {{ r.host }}</div>
            </div>
            <span class="ri-time">{{ formatTime(r.time) }}</span>
          </div>
        </div>
        <div v-else class="empty">{{ $t('home.recentEmpty') }}</div>
      </div>

      <div class="dash-card">
        <h3>{{ $t('home.total') }} <span class="tag">{{ $t('home.groupSummary') }}</span></h3>
        <div class="stat-big">
          <span class="num">{{ assetCount }}</span>
          <span class="unit">{{ $t('home.assets') }} · {{ groups.length }} {{ $t('home.groups') }}</span>
        </div>
        <div class="stat-chips">
          <span class="chip">{{ $t('os.win') }} <b>{{ osCount.win }}</b></span>
          <span class="chip">{{ $t('os.mac') }} <b>{{ osCount.mac }}</b></span>
          <span class="chip">{{ $t('os.linux') }} <b>{{ osCount.linux }}</b></span>
        </div>
      </div>

      <div class="dash-card">
        <h3>{{ $t('home.sessions') }} <span class="tag">{{ $t('home.placeholder') }}</span></h3>
        <div class="empty" style="white-space:pre-line">{{ $t('home.sessionsEmpty') }}</div>
      </div>

      <div class="dash-card">
        <h3>{{ $t('home.quick') }} <span class="tag">{{ $t('home.placeholder') }}</span></h3>
        <div class="quick-grid" style="grid-template-columns:1fr 1fr">
          <button class="quick-btn" @click="$root.$emit('open-settings')">⚙ {{ $t('nav.settings') }}</button>
          <button class="quick-btn" @click="exportJson">⇪ {{ $t('nav.export') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { store, findAsset, openAssetDetail, api } from '../store';
import { OS_SVG, formatTime } from '../constants';

export default {
  name: 'HomeView',
  computed: {
    groups() {
      return store.snapshot.groups || [];
    },
    recent() {
      return store.snapshot.recent || [];
    },
    assetCount() {
      return this.groups.reduce((s, g) => s + g.nodes.length, 0);
    },
    osCount() {
      const c = { win: 0, mac: 0, linux: 0 };
      this.groups.forEach((g) =>
        g.nodes.forEach((n) => {
          if (c[n.os] != null) c[n.os]++;
        })
      );
      return c;
    },
  },
  methods: {
    formatTime,
    osSvg(os) {
      return OS_SVG[os] || '';
    },
    openRecent(r) {
      const hit = findAsset(r.id);
      if (hit) openAssetDetail(hit.asset);
    },
    async exportJson() {
      try {
        const text = await api.exportGroups();
        const blob = new Blob([text], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'omnidesk-groups.json';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        this.$message.error(e.message);
      }
    },
  },
};
</script>
