<template>
  <div class="home-scroll">
    <div class="home-top">
      <h2>{{ $t('home.title') }}</h2>
      <p>{{ $t('home.sub') }}</p>
    </div>

    <div class="dash-grid">
      <!-- left: assets + backup -->
      <div class="dash-card dash-assets">
        <h3>{{ $t('home.total') }} <span class="tag">{{ $t('home.groupSummary') }}</span></h3>
        <div class="stat-big">
          <span class="num">{{ assetCount }}</span>
          <span class="unit">{{ $t('home.assets') }} · {{ groups.length }} {{ $t('home.groups') }}</span>
        </div>
        <div class="stat-chips">
          <span class="chip os-chip">
            <span class="os-icon os-win" v-html="osSvg('win')"></span>
            {{ $t('os.win') }} <b>{{ osCount.win }}</b>
          </span>
          <span class="chip os-chip">
            <span class="os-icon os-mac" v-html="osSvg('mac')"></span>
            {{ $t('os.mac') }} <b>{{ osCount.mac }}</b>
          </span>
          <span class="chip os-chip">
            <span class="os-icon os-linux" v-html="osSvg('linux')"></span>
            {{ $t('os.linux') }} <b>{{ osCount.linux }}</b>
          </span>
        </div>
        <div class="pie-wrap">
          <div ref="pieEl" class="os-pie-chart"></div>
        </div>
      </div>

      <div class="dash-card dash-backup">
        <h3>{{ $t('home.quick') }}</h3>
        <div class="quick-grid">
          <button class="quick-btn" @click="exportJson"><img src="/icons/export.svg" class="btn-icon" /> {{ $t('home.exportCfg') }}</button>
          <button class="quick-btn" @click="importJson"><img src="/icons/import.svg" class="btn-icon" /> {{ $t('home.importCfg') }}</button>
        </div>
      </div>

      <!-- right: recent connections (taller) -->
      <div class="dash-card dash-recent">
        <h3>{{ $t('home.recent') }} <span class="tag">{{ recent.length }}</span></h3>
        <div v-if="recent.length" class="recent-wrap">
          <el-scrollbar class="recent-scroll-wrap">
          <div class="recent-list">
          <div
            v-for="r in recent"
            :key="r.id + '-' + (r.method || '')"
            class="recent-item"
          >
            <span class="os-icon" :class="'os-' + r.os" v-html="osSvg(r.os)"></span>
            <div style="flex:1;min-width:0">
              <div class="ri-name">{{ r.name }}</div>
              <div class="ri-sub">{{ r.host }}:{{ r.port }} · {{ protoLabel(r) }}</div>
            </div>
            <span class="ri-time">{{ formatTime(r.time) }}</span>
            <el-tooltip :content="$t('detail.connect')" placement="top">
              <button
                type="button"
                class="recent-connect-btn"
                @click.stop="connectRecent(r)"
              >
                <svg viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M454.6048 328.8576a25.344 25.344 0 1 1-35.84-35.84l203.8784-203.9808c82.1248-82.176 212.992-84.992 292.352-5.632 79.36 79.4112 76.544 210.432-5.632 292.5568l-203.8272 203.9808c-82.1248 82.1248-212.992 84.992-292.352 5.632a25.344 25.344 0 0 1 35.84-35.8912c59.1872 59.2384 158.0032 57.088 220.672-5.632l203.8784-203.9808c62.6176-62.6688 64.8192-161.536 5.632-220.7744-59.2384-59.2384-158.0544-57.088-220.7232 5.632L454.6048 328.8064z m114.7904 366.2848a25.344 25.344 0 1 1 35.84 35.84L401.408 934.9632c-82.1248 82.176-212.992 84.992-292.352 5.632-79.36-79.4112-76.544-210.432 5.632-292.5568L318.464 444.0576c82.1248-82.1248 212.992-84.992 292.352-5.632a25.344 25.344 0 0 1-35.84 35.8912c-59.1872-59.2384-158.0032-57.088-220.672 5.632l-203.8784 203.9808c-62.6176 62.6688-64.8192 161.536-5.632 220.7744 59.2384 59.2384 158.0544 57.088 220.7232-5.632l203.8784-203.9296z"/>
                </svg>
              </button>
            </el-tooltip>
            <el-tooltip :content="$t('home.removeRecent')" placement="top">
              <button
                type="button"
                class="recent-delete-btn"
                @click.stop="removeRecentRecord(r)"
              ><i class="el-icon-delete"></i></button>
            </el-tooltip>
          </div>
          </div>
          <div class="recent-foot">{{ $t('home.recentLimit') }}</div>
          </el-scrollbar>
        </div>
        <div v-else class="empty">{{ $t('home.recentEmpty') }}</div>
      </div>
    </div>
  </div>
</template>

<script>
import * as echarts from 'echarts';
import { store, findAsset, connectAsset, connectionErrorMessage, removeRecent, api, unwrap, refresh } from '../store';
import { OS_SVG, formatTime } from '../constants';
import { t } from '../i18n';

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
    localeTick() {
      return store.localeTick;
    },
    isLight() {
      return (
        typeof document !== 'undefined' &&
        (document.documentElement.classList.contains('theme-light') ||
          (document.getElementById('app') &&
            document.getElementById('app').classList.contains('theme-light')))
      );
    },
  },
  watch: {
    osCount: {
      deep: true,
      handler() {
        this.renderPie();
      },
    },
    assetCount() {
      this.renderPie();
    },
    localeTick() {
      this.renderPie();
    },
  },
  mounted() {
    this.$nextTick(() => {
      this.initPie();
    });
    window.addEventListener('resize', this.resizePie);
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.resizePie);
    if (this._pieRO) {
      try {
        this._pieRO.disconnect();
      } catch (_) {}
      this._pieRO = null;
    }
    if (this._pie) {
      try {
        this._pie.dispose();
      } catch (_) {}
      this._pie = null;
    }
  },
  methods: {
    formatTime,
    osSvg(os) {
      return OS_SVG[os] || '';
    },
    protoLabel(r) {
      const p = r.proto || r.method || '';
      return String(p).toUpperCase();
    },
    themeTokens() {
      const light = this.isLight;
      return {
        text: light ? '#303133' : '#e6edf3',
        text2: light ? '#606266' : '#8b9bb0',
        text3: light ? '#909399' : '#5c6b80',
        track: light ? 'rgba(144,147,153,0.2)' : 'rgba(148,163,184,0.18)',
        win: '#3b82f6',
        mac: light ? '#111111' : '#1a1a1a',
        linux: '#34d399',
      };
    },
    initPie() {
      const el = this.$refs.pieEl;
      if (!el) return;
      if (this._pie) {
        try {
          this._pie.dispose();
        } catch (_) {}
      }
      this.fitPieSquare();
      this._pie = echarts.init(el);
      this.renderPie();
      if (window.ResizeObserver) {
        try {
          if (this._pieRO) this._pieRO.disconnect();
        } catch (_) {}
        this._pieRO = new ResizeObserver(() => this.resizePie());
        this._pieRO.observe(el.parentElement || el);
      }
    },
    /** Force a square plot box so the donut never stretches into an ellipse */
    fitPieSquare() {
      const el = this.$refs.pieEl;
      if (!el) return 168;
      const host = el.parentElement || el;
      const availW = host.clientWidth || 200;
      const availH = host.clientHeight || 200;
      const size = Math.max(140, Math.min(200, Math.min(availW, availH)));
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      return size;
    },
    renderPie() {
      this.$nextTick(() => {
        if (!this._pie) {
          this.initPie();
          return;
        }
        const th = this.themeTokens();
        const names = {
          win: t('os.win'),
          mac: t('os.mac'),
          linux: t('os.linux'),
        };
        const assetsLabel = t('home.assets');
        const total = this.assetCount;
        const raw = [
          { name: names.win, value: this.osCount.win, itemStyle: { color: th.win } },
          { name: names.mac, value: this.osCount.mac, itemStyle: { color: th.mac } },
          { name: names.linux, value: this.osCount.linux, itemStyle: { color: th.linux } },
        ];
        const pieData = total
          ? raw
          : [{ name: '—', value: 1, itemStyle: { color: th.track } }, ...raw];

        const size = this.fitPieSquare();
        this._pie.resize({ width: size, height: size });
        this._pie.setOption(
          {
            backgroundColor: 'transparent',
            tooltip: {
              trigger: 'item',
              backgroundColor: th.text === '#303133' ? '#fff' : '#1c2430',
              borderColor: th.text === '#303133' ? '#dcdfe6' : '#2a3544',
              textStyle: { color: th.text, fontSize: 12 },
              formatter(p) {
                if (!total) return '—';
                return `${p.name}<br/>${p.value} · ${p.percent}%`;
              },
            },
            legend: {
              bottom: 0,
              left: 'center',
              icon: 'circle',
              itemWidth: 8,
              itemHeight: 8,
              itemGap: 10,
              itemMargin: 0,
              padding: [0, 0, 0, 0],
              textStyle: { color: th.text2, fontSize: 10 },
              data: [names.win, names.mac, names.linux],
            },
            title: { show: false },
            series: [
              {
                type: 'pie',
                radius: ['48%', '68%'],
                center: ['50%', '42%'],
                minAngle: 6,
                avoidLabelOverlap: true,
                label: {
                  show: true,
                  position: 'center',
                  formatter: `{a|${total}}\n{b|${assetsLabel}}`,
                  rich: {
                    a: {
                      fontSize: 18,
                      fontWeight: 700,
                      color: th.text,
                      fontFamily: 'Consolas, monospace',
                      lineHeight: 22,
                    },
                    b: {
                      fontSize: 10,
                      color: th.text3,
                      lineHeight: 14,
                    },
                  },
                },
                labelLine: { show: false },
                emphasis: {
                  scale: true,
                  scaleSize: 3,
                  itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.25)' },
                },
                data: pieData,
              },
            ],
          },
          true,
        );
        this._pie.resize({ width: size, height: size });
      });
    },
    resizePie() {
      const size = this.fitPieSquare();
      if (this._pie) this._pie.resize({ width: size, height: size });
    },
    /** Click the connect icon on a recent item → connect directly by its recorded method */
    async connectRecent(r) {
      const hit = findAsset(r.id);
      if (!hit) return;
      const method = String(r.method || 'rdp').toLowerCase();
      // 从资产读取真实方法配置，确保 RDP advanced.engine（ironrdp/external）随最近入口一起生效
      const conf = (hit.asset.methods && hit.asset.methods[method]) || {};
      try {
        await connectAsset(hit.asset, {
          id: method,
          name: this.protoLabel(r),
          port: conf.port || r.port,
          advanced: conf.advanced || null,
        });
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      }
    },
    async removeRecentRecord(r) {
      try {
        await removeRecent(r.id, r.method);
      } catch (e) {
        this.$message.error(e.message || String(e));
      }
    },
    async exportJson() {
      try {
        // OS identity is enforced in main (store:export); surface friendly errors here
        const text = unwrap(await api.exportGroups());
        const blob = new Blob([text], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'omnidesk-groups.json';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        const code = (e && e.code) || '';
        let msg = e.message || String(e);
        if (/Canceled|UserCanceled/i.test(code) || /已取消|Canceled/i.test(msg)) {
          msg = t('auth.canceled');
        } else if (/NotConfigured/i.test(code) || /未配置身份验证|Hello/i.test(msg)) {
          msg = t('auth.notConfigured');
        }
        this.$message.error(msg);
      }
    },
    importJson() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          if (api.importGroups) {
            // OS identity is enforced in main (store:import); surface friendly errors here
            unwrap(await api.importGroups(text));
          } else {
            throw new Error(t('msg.needElectron'));
          }
          await refresh();
          this.$message.success(t('home.importDone'));
        } catch (e) {
          const code = (e && e.code) || '';
          let msg = e.message || String(e);
          if (/Canceled|UserCanceled/i.test(code) || /已取消|Canceled/i.test(msg)) {
            msg = t('auth.canceled');
          } else if (/NotConfigured/i.test(code) || /未配置身份验证|Hello/i.test(msg)) {
            msg = t('auth.notConfigured');
          }
          this.$message.error(msg);
        }
      };
      input.click();
    },
  },
};
</script>
