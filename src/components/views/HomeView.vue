<template>
  <div class="home-scroll">
    <div v-show="showWelcome" class="home-top">
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
            <span class="os-icon os-win" v-html="iconSvg('win')"></span>
            {{ $t('os.win') }} <b>{{ osCount.win }}</b>
          </span>
          <span class="chip os-chip">
            <span class="os-icon os-mac" v-html="iconSvg('mac')"></span>
            {{ $t('os.mac') }} <b>{{ osCount.mac }}</b>
          </span>
          <span class="chip os-chip">
            <span class="os-icon os-linux" v-html="iconSvg('linux')"></span>
            {{ $t('os.linux') }} <b>{{ osCount.linux }}</b>
          </span>
        </div>
        <div class="pie-wrap">
          <div ref="pieEl" class="os-pie-chart"></div>
        </div>
      </div>

      <!-- right: recent connections (taller) -->
      <div class="dash-card dash-recent">
        <h3>{{ $t('home.recent') }} <span class="tag">{{ recentRows.length }}</span></h3>
        <div v-if="recentRows.length" class="recent-wrap">
          <el-scrollbar class="recent-scroll-wrap">
            <div class="recent-list">
              <div v-for="row in recentRows" :key="row.key" class="recent-item">
                <i v-if="iconGlyph(row.icon)" class="os-icon" :class="iconGlyph(row.icon)"></i>
                <span v-else class="os-icon" :class="'os-' + row.icon" v-html="iconSvg(row.icon)"></span>
                <div class="ri-main">
                  <div class="ri-name">{{ row.name }}</div>
                  <div class="ri-sub">{{ row.host }}:{{ row.port }} · {{ row.protoText }}</div>
                </div>
                <span class="ri-time" :title="row.timeFull">{{ row.timeText }}</span>
                <el-tooltip :content="$t('detail.connect')" placement="top">
                  <button
                    type="button"
                    class="recent-connect-btn"
                    :disabled="busyKey === row.key || !row.method"
                    @click="connectRecent(row)"
                  >
                    <svg-icon name="link" />
                  </button>
                </el-tooltip>
                <el-tooltip :content="$t('home.removeRecent')" placement="top">
                  <button type="button" class="recent-delete-btn" @click="removeRecentRecord(row)">
                    <i class="el-icon-delete"></i>
                  </button>
                </el-tooltip>
              </div>
            </div>
            <div class="recent-foot">{{ $t('home.recentLimit', { n: recentLimit }) }}</div>
          </el-scrollbar>
        </div>
        <div v-else class="empty">{{ $t('home.recentEmpty') }}</div>
      </div>
    </div>
  </div>
</template>

<script>
import * as echarts from 'echarts/core';
import { PieChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { store, findAsset, enabledMethods, connectAsset, connectionErrorMessage, removeRecent } from '../../store';
import { protocolLabel } from '../../protocols';
import { assetIcon, assetIconGlyph, RECENT_LIMIT_DEFAULT, RECENT_LIMIT_MAX } from '../../constants';
import { t, formatTime } from '../../i18n';

echarts.use([PieChart, LegendComponent, TooltipComponent, CanvasRenderer]);

export default {
  name: 'HomeView',
  data() {
    return {
      nowMs: Date.now(),
      busyKey: null,
    };
  },
  computed: {
    groups() {
      return store.snapshot.groups || [];
    },
    recent() {
      return store.snapshot.recent || [];
    },
    showWelcome() {
      const s = store.snapshot.settings || {};
      return s.homeWelcome !== false;
    },
    recentLimit() {
      const n = Number((store.snapshot.settings || {}).recentLimit);
      return n > 0 ? Math.min(RECENT_LIMIT_MAX, Math.floor(n)) : RECENT_LIMIT_DEFAULT;
    },
    assetCount() {
      return this.groups.reduce((s, g) => s + g.nodes.length, 0);
    },
    osCount() {
      const c = { win: 0, mac: 0, linux: 0 };
      this.groups.forEach((g) =>
        g.nodes.forEach((n) => {
          if (c[n.icon] != null) c[n.icon]++;
        })
      );
      return c;
    },
    localeTick() {
      return store.localeTick;
    },
    themeTick() {
      return store.themeTick;
    },
    /** 名称、主机、端口与系统都取资产现值：连接当时存下的快照会随改名、改端口一起过期 */
    recentRows() {
      const index = new Map();
      this.groups.forEach((g) => g.nodes.forEach((n) => index.set(n.id, n)));
      return this.recent.map((r) => {
        const asset = index.get(r.id);
        const method = asset ? enabledMethods(asset).find((m) => m.id === r.method) : null;
        return {
          key: r.id + '-' + (r.method || ''),
          id: r.id,
          methodId: r.method,
          method,
          name: (asset && asset.name) || r.name,
          icon: (asset && asset.icon) || r.icon,
          host: (asset && asset.host) || r.host,
          port: (method && method.port) || r.port,
          protoText: protocolLabel(r.method),
          timeText: formatTime(r.time, this.nowMs),
          timeFull: r.time ? new Date(r.time).toLocaleString() : '',
        };
      });
    },
    pieSignature() {
      const c = this.osCount;
      return [this.assetCount, c.win, c.mac, c.linux, this.localeTick, this.themeTick].join('|');
    },
  },
  watch: {
    pieSignature() {
      this.renderPie();
    },
  },
  mounted() {
    this.$nextTick(() => {
      this.initPie();
    });
    window.addEventListener('resize', this.resizePie);
    // 相对时间只到分钟粒度，不自己走就会一直停在渲染那一刻
    this._timeTimer = setInterval(() => {
      this.nowMs = Date.now();
    }, 60000);
  },
  beforeDestroy() {
    clearInterval(this._timeTimer);
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
    iconSvg(icon) {
      return assetIcon(icon);
    },
    iconGlyph(icon) {
      return assetIconGlyph(icon);
    },
    /** 主题类写在 DOM 上，必须是每次现读的方法：computed 没有响应依赖，会被永久缓存 */
    isLight() {
      return (
        typeof document !== 'undefined' &&
        (document.documentElement.classList.contains('theme-light') ||
          (document.getElementById('app') &&
            document.getElementById('app').classList.contains('theme-light')))
      );
    },
    themeTokens() {
      const light = this.isLight();
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
        // 0 值传 NaN 而不是删掉数据项：删项会让图例点掉色并报 series not exists，NaN 只跳过扇区
        const raw = [
          { name: names.win, value: this.osCount.win || NaN, itemStyle: { color: th.win } },
          { name: names.mac, value: this.osCount.mac || NaN, itemStyle: { color: th.mac } },
          { name: names.linux, value: this.osCount.linux || NaN, itemStyle: { color: th.linux } },
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
    /** Click the connect icon on a recent item → connect through the asset's current method config */
    async connectRecent(row) {
      const hit = findAsset(row.id);
      if (!hit || !row.method) return;
      this.busyKey = row.key;
      try {
        await connectAsset(hit.asset, row.method);
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      } finally {
        this.busyKey = null;
      }
    },
    async removeRecentRecord(row) {
      try {
        await removeRecent(row.id, row.methodId);
      } catch (e) {
        this.$message.error(e.message || String(e));
      }
    },
  },
};
</script>
