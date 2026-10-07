<template>
  <div ref="rootEl" class="monitor-panel">
    <div class="panel-head">
      <svg-icon name="monitor-pulse" :size="14" class="head-logo" />
      <span class="panel-title">{{ $t('monitor.title') }}</span>
      <span class="panel-host mono">{{ hostText }}</span>
      <span class="refresh-set">
        <span class="refresh-label">{{ $t('monitor.refreshSec') }}</span>
        <el-input-number
          :value="intervalSec || 3"
          size="mini"
          :min="1"
          :max="60"
          :step="1"
          controls-position="right"
          @change="$emit('interval-change', $event)"
        />
      </span>
      <button type="button" class="panel-close" :title="$t('monitor.closeTip')" @click="$emit('close')">
        <i class="el-icon-close"></i>
      </button>
    </div>
    <div class="panel-body">
      <div v-if="state === 'unsupported'" class="panel-note warn">
        <i class="el-icon-warning-outline"></i> {{ $t('monitor.unsupported') }}
      </div>
      <div v-else-if="state === 'error'" class="panel-note warn">
        <i class="el-icon-warning-outline"></i> {{ $t('monitor.error') }}
      </div>
      <div v-else-if="state === 'offline'" class="panel-note">
        <i class="el-icon-warning-outline"></i> {{ $t('monitor.offline') }}
      </div>
      <template v-else>
        <!-- 系统信息 -->
        <section class="card">
          <div v-if="loading" class="card-mask"><i class="el-icon-loading"></i></div>
          <div class="sys-line">
            <span v-if="osShort" class="os-badge">{{ osShort }}</span>
            <span class="sys-main mono">{{ sysMain }}</span>
          </div>
          <div class="sys-grid">
            <div class="sys-kv"><span class="k">{{ $t('monitor.hostname') }}</span><span class="v" :title="meta && meta.hostname">{{ meta && meta.hostname }}</span></div>
            <div class="sys-kv"><span class="k">{{ $t('monitor.timezone') }}</span><span class="v" :title="meta && meta.tz">{{ (meta && meta.tz) || '—' }}</span></div>
            <div class="sys-kv"><span class="k">CPU</span><span class="v" :title="cpuMetaText">{{ cpuMetaText }}</span></div>
            <div class="sys-kv"><span class="k">{{ $t('monitor.memory') }}</span><span class="v">{{ memTotalText }}</span></div>
            <div class="sys-kv"><span class="k">{{ $t('monitor.disk') }}</span><span class="v">{{ diskMetaText }}</span></div>
            <div class="sys-kv"><span class="k">{{ $t('monitor.uptime') }}</span><span class="v up mono">{{ uptimeText }}</span></div>
          </div>
        </section>

        <!-- CPU -->
        <section class="card">
          <div v-if="loading" class="card-mask"><i class="el-icon-loading"></i></div>
          <div class="sec-head">
            <i class="el-icon-cpu sec-icon"></i>
            <span class="sec-name">CPU</span>
            <span class="sec-badge mono">{{ cpuNowText }}</span>
          </div>
          <div class="mem-flex">
            <div class="mem-legend">
              <div v-for="item in cpuLegend" :key="item.label" class="mem-item">
                <span class="dot" :style="{ background: item.color }"></span>
                <span class="lbl">{{ item.label }}</span>
                <span class="val mono">{{ item.value }}</span>
              </div>
            </div>
            <div ref="cpuDonut" class="mem-donut"></div>
          </div>
          <div class="spark-wrap"><div ref="cpuSpark" class="chart" style="height: 64px"></div></div>
        </section>

        <!-- 内存 -->
        <section class="card">
          <div v-if="loading" class="card-mask"><i class="el-icon-loading"></i></div>
          <div class="sec-head">
            <i class="el-icon-coin sec-icon"></i>
            <span class="sec-name">{{ $t('monitor.memory') }}</span>
            <span class="sec-note">/ {{ snap.mem.totalGB || 0 }} GB</span>
            <span class="sec-badge mono">{{ memPctText }}</span>
          </div>
          <div class="mem-flex">
            <div class="mem-legend">
              <div v-for="item in memLegend" :key="item.label" class="mem-item">
                <span class="dot" :style="{ background: item.color }"></span>
                <span class="lbl">{{ item.label }}</span>
                <span class="val mono">{{ item.value }}</span>
                <span class="pct mono">{{ item.pct }}</span>
              </div>
            </div>
            <div ref="memDonut" class="mem-donut"></div>
          </div>
        </section>

        <!-- 网络 -->
        <section class="card">
          <div v-if="loading" class="card-mask"><i class="el-icon-loading"></i></div>
          <div class="sec-head">
            <i class="el-icon-connection sec-icon"></i>
            <span class="sec-name">{{ $t('monitor.network') }}</span>
            <span class="sec-note mono">{{ (snap.net && snap.net.dev) || '' }}</span>
            <span class="sec-badge mono">{{ netNowText }}</span>
          </div>
          <div ref="netChart" class="chart" style="height: 120px"></div>
        </section>

        <!-- 硬盘 -->
        <section class="card">
          <div v-if="loading" class="card-mask"><i class="el-icon-loading"></i></div>
          <div class="sec-head">
            <i class="el-icon-postcard sec-icon"></i>
            <span class="sec-name">{{ $t('monitor.disk') }}</span>
            <span class="sec-note">{{ $t('monitor.partitions', { n: snap.disks.length }) }}</span>
            <span class="sec-badge mono">{{ diskTotalsText }}</span>
          </div>
          <div class="disk-list">
            <div v-for="d in snap.disks" :key="d.dev + d.mount" class="disk-row" :title="diskTitle(d)">
              <div class="disk-main">
                <div class="disk-id">
                  <span class="disk-mount mono">{{ d.mount }}</span>
                  <span v-if="d.fs" class="disk-fs mono">{{ d.fs }}</span>
                </div>
                <span class="io-line"><span class="dot" style="background: var(--accent)"></span><span>{{ $t('monitor.read') }}</span><b>{{ d.readKBs == null ? '—' : fmtRate(d.readKBs) }}</b></span>
                <span class="io-line"><span class="dot" style="background: var(--success)"></span><span>{{ $t('monitor.write') }}</span><b>{{ d.writeKBs == null ? '—' : fmtRate(d.writeKBs) }}</b></span>
              </div>
              <div class="disk-side">
                <span class="disk-pct mono">{{ diskPct(d).toFixed(0) }}%</span>
                <span class="disk-cap mono">{{ diskCapText(d) }}</span>
              </div>
              <span class="disk-tank"><span class="fill" :style="{ height: diskPct(d) + '%', background: tone(diskPct(d)) }"></span></span>
            </div>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<script>
const HISTORY = 45;

export default {
  name: 'SshMonitorPanel',
  props: {
    /** probing | live | unsupported | error | offline */
    state: { type: String, default: 'probing' },
    meta: { type: Object, default: null },
    snapshot: { type: Object, default: null },
    intervalSec: { type: Number, default: null },
  },
  data() {
    return {
      tick: 0,
    };
  },
  computed: {
    loading() {
      return this.state === 'probing';
    },
    snap() {
      const s = this.snapshot || {};
      return { cpu: s.cpu || {}, mem: s.mem || {}, net: s.net || {}, disks: s.disks || [], uptimeSec: s.uptimeSec || 0 };
    },
    hostText() {
      const m = this.meta;
      if (!m) return '';
      return [m.hostname, m.ip].filter(Boolean).join(' · ');
    },
    osShort() {
      const d = (this.meta && this.meta.distro) || '';
      return d ? d.split(/\s+/)[0] : '';
    },
    sysMain() {
      const m = this.meta;
      if (!m) return '';
      return [m.distro, m.kernel].filter(Boolean).join(' · ');
    },
    uptimeText() {
      void this.tick;
      const snap = this.snapshot;
      if (!snap || !snap.uptimeSec) return '';
      // Extrapolate between server snapshots so the clock visibly advances every second.
      const elapsed = Math.max(0, (Date.now() - (snap.ts || Date.now())) / 1000);
      const total = Math.floor(snap.uptimeSec + elapsed);
      const d = Math.floor(total / 86400);
      const clock = String(Math.floor((total % 86400) / 3600)).padStart(2, '0')
        + ':' + String(Math.floor((total % 3600) / 60)).padStart(2, '0')
        + ':' + String(total % 60).padStart(2, '0');
      return (d ? this.$t('monitor.uptimeDays', { n: d }) + ' ' : '') + clock;
    },
    cpuMetaText() {
      const m = this.meta;
      if (!m) return '';
      const parts = [m.cpuModel];
      if (m.sockets > 1) parts.push(this.$t('monitor.sockets', { n: m.sockets }));
      parts.push(this.$t('monitor.cores', { n: m.cores }));
      return parts.filter(Boolean).join(' · ');
    },
    memTotalText() {
      const total = this.snap.mem && this.snap.mem.totalGB;
      return total ? total + ' GB' : '';
    },
    diskMetaText() {
      const disks = this.snap.disks || [];
      if (!disks.length) return '';
      const totalGB = disks.reduce((a, d) => a + (d.totalGB || 0), 0);
      const totalText = totalGB >= 1024 ? (totalGB / 1024).toFixed(1) + ' TB' : totalGB.toFixed(0) + ' GB';
      return disks.length + ' · ' + totalText;
    },
    cpuNowText() {
      const v = this.snap.cpu && this.snap.cpu.overall;
      return v == null ? '--%' : v.toFixed(1) + '%';
    },
    cpuLegend() {
      void this.tick;
      const cpu = this.snap.cpu || {};
      const pct = cpu.overall == null ? 0 : cpu.overall;
      return [
        { label: this.$t('monitor.coreCount'), value: cpu.cores || '—', color: this.palette().success },
        { label: this.$t('monitor.load'), value: this.cpuNowText, color: this.tone(pct) },
      ];
    },
    memPctText() {
      const mem = this.snap.mem;
      if (!mem || !mem.totalGB) return '--%';
      return (((mem.usedGB || 0) / mem.totalGB) * 100).toFixed(1) + '%';
    },
    memLegend() {
      const c = this.palette();
      const mem = this.snap.mem || {};
      const free = Math.max(0, (mem.totalGB || 0) - (mem.usedGB || 0) - (mem.cacheGB || 0));
      const pctOf = (v) => (mem.totalGB ? ((v / mem.totalGB) * 100).toFixed(0) + '%' : '');
      const usedPct = mem.totalGB ? ((mem.usedGB || 0) / mem.totalGB) * 100 : 0;
      return [
        { label: this.$t('monitor.used'), value: (mem.usedGB || 0).toFixed(1) + 'G', pct: pctOf(mem.usedGB || 0), color: this.tone(usedPct) },
        { label: this.$t('monitor.cache'), value: (mem.cacheGB || 0).toFixed(1) + 'G', pct: pctOf(mem.cacheGB || 0), color: c.success },
        { label: this.$t('monitor.free'), value: free.toFixed(1) + 'G', pct: pctOf(free), color: c.border },
      ];
    },
    netNowText() {
      const net = this.snap.net;
      if (!net) return '';
      return '↓' + this.fmtRate(net.rxKBs) + ' ↑' + this.fmtRate(net.txKBs);
    },
    diskTotalsText() {
      const disks = this.snap.disks || [];
      if (!disks.length) return '';
      const used = disks.reduce((a, d) => a + (d.usedGB || 0), 0);
      const total = disks.reduce((a, d) => a + (d.totalGB || 0), 0);
      return this.fmtGB(used) + ' / ' + this.fmtGB(total);
    },
  },
  watch: {
    snapshot(val) {
      if (!val) return;
      this.pushHistory(val);
      this.$nextTick(() => this.renderCharts());
    },
    state(val) {
      if (val === 'live') this.$nextTick(() => this.renderCharts());
    },
  },
  created() {
    this._charts = {};
    this._ro = null;
    this._tickTimer = null;
    this._hist = { cpu: [], rx: [], tx: [] };
  },
  mounted() {
    this._tickTimer = setInterval(() => {
      if (this.state === 'live') this.tick += 1;
    }, 1000);
    if (window.ResizeObserver && this.$refs.rootEl) {
      this._ro = new ResizeObserver(() => {
        this.$nextTick(() => this.renderCharts());
      });
      this._ro.observe(this.$refs.rootEl);
    }
    if (this.snapshot) {
      this.pushHistory(this.snapshot);
      this.$nextTick(() => this.renderCharts());
    }
  },
  beforeDestroy() {
    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    for (const chart of Object.values(this._charts)) {
      try {
        chart.dispose();
      } catch (_) {}
    }
    this._charts = {};
  },
  methods: {
    palette() {
      const read = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      return {
        text: read('--text'), text2: read('--text-2'), text3: read('--text-3'),
        border: read('--border'), elevated: read('--bg-elevated'),
        accent: read('--accent'), success: read('--success'), warning: read('--warning'), danger: read('--danger'),
      };
    },
    fmtRate(kbs) {
      if (kbs == null) return '—';
      if (kbs >= 1024) return (kbs / 1024).toFixed(1) + ' M/s';
      return kbs.toFixed(1) + ' K/s';
    },
    /** 使用率统一取色：环形图色块与图例点必须同源，否则同一指标会出现两种颜色。 */
    tone(pct) {
      const c = this.palette();
      return pct > 85 ? c.danger : pct > 70 ? c.warning : c.accent;
    },
    diskPct(d) {
      return d.totalGB ? Math.min(100, ((d.usedGB || 0) / d.totalGB) * 100) : 0;
    },
    fmtGB(gb) {
      return gb >= 1024 ? (gb / 1024).toFixed(1) + 'T' : gb.toFixed(1) + 'G';
    },
    diskCapText(d) {
      return this.fmtGB(d.usedGB || 0) + '/' + this.fmtGB(d.totalGB || 0);
    },
    diskTitle(d) {
      return (d.dev || '') + ' ' + d.mount + ' ' + (d.usedGB || 0) + ' / ' + (d.totalGB || 0) + ' GB';
    },
    pushHistory(snap) {
      const h = this._hist;
      const cpu = snap.cpu && snap.cpu.overall;
      h.cpu.push(cpu == null ? (h.cpu.length ? h.cpu[h.cpu.length - 1] : 0) : cpu);
      h.rx.push((snap.net && snap.net.rxKBs) || 0);
      h.tx.push((snap.net && snap.net.txKBs) || 0);
      const lists = [h.cpu, h.rx, h.tx];
      for (const list of lists) {
        while (list.length > HISTORY) list.shift();
      }
    },
    ensureChart(refName, el) {
      if (!el || !el.clientWidth) return null;
      const existing = this._charts[refName];
      if (existing) {
        // v-if 重建 DOM 后旧实例指向已移除的节点，必须重建而不是继续 setOption
        if (existing.getDom() === el) return existing;
        try {
          existing.dispose();
        } catch (_) {}
      }
      this._charts[refName] = this._echarts.init(el);
      return this._charts[refName];
    },
    async renderCharts() {
      if (this.state !== 'live' || !this.snapshot) return;
      if (!this._echarts) {
        try {
          this._echarts = await import('echarts');
        } catch (_) {
          return;
        }
      }
      const c = this.palette();
      const axis = (formatter) => ({
        type: 'value',
        splitLine: { lineStyle: { color: c.border, type: 'dashed' } },
        axisLabel: { color: c.text3, fontSize: 8, formatter },
      });
      const catAxis = {
        type: 'category', boundaryGap: false,
        data: this._hist.cpu.map((_, i) => i),
        axisLine: { lineStyle: { color: c.border } }, axisTick: { show: false }, axisLabel: { show: false },
      };
      const spark = (data, color, max) => ({
        animation: false,
        grid: { left: 30, right: 6, top: 6, bottom: 16 },
        tooltip: {
          trigger: 'axis',
          confine: true,
          backgroundColor: c.elevated,
          borderColor: c.border,
          textStyle: { color: c.text, fontSize: 11 },
          axisPointer: { type: 'line', lineStyle: { color: c.text3, type: 'dashed' } },
          formatter: (params) => params
            .map((p) => p.marker + ' ' + p.seriesName + '&nbsp;&nbsp;' + Number(p.value).toFixed(1) + '%')
            .join('<br>'),
        },
        xAxis: catAxis,
        yAxis: Object.assign(axis('{value}%'), { max }),
        series: [{ name: 'CPU', type: 'line', data, symbol: 'none', itemStyle: { color }, lineStyle: { color, width: 1.4 }, areaStyle: { color, opacity: 0.12 } }],
      });

      const cpuChart = this.ensureChart('cpuSpark', this.$refs.cpuSpark);
      if (cpuChart) cpuChart.setOption(spark(this._hist.cpu.map((v) => +v.toFixed(1)), c.accent, 100));

      const cpu = this.snap.cpu || {};
      const cpuPct = cpu.overall == null ? 0 : cpu.overall;
      const cpuColor = this.tone(cpuPct);
      const cpuDonut = this.ensureChart('cpuDonut', this.$refs.cpuDonut);
      if (cpuDonut) {
        cpuDonut.setOption({
          animation: false,
          series: [{
            type: 'pie', radius: ['64%', '84%'], center: ['50%', '50%'],
            label: { show: false }, labelLine: { show: false },
            itemStyle: { borderColor: c.elevated, borderWidth: 2 },
            data: [
              { value: cpuPct, itemStyle: { color: cpuColor } },
              { value: Math.max(0, 100 - cpuPct), itemStyle: { color: c.border } },
            ],
          }],
          graphic: [{
            type: 'text', left: 'center', top: 'center',
            style: { text: cpuPct.toFixed(0) + '%', fill: c.text, fontSize: 15, fontWeight: 700, fontFamily: 'Consolas' },
          }],
        });
      }

      const mem = this.snap.mem || {};
      const donut = this.ensureChart('memDonut', this.$refs.memDonut);
      if (donut) {
        const pct = mem.totalGB ? ((mem.usedGB || 0) / mem.totalGB) * 100 : 0;
        const free = Math.max(0, (mem.totalGB || 0) - (mem.usedGB || 0) - (mem.cacheGB || 0));
        donut.setOption({
          animation: false,
          series: [{
            type: 'pie', radius: ['64%', '84%'], center: ['50%', '50%'],
            label: { show: false }, labelLine: { show: false },
            itemStyle: { borderColor: c.elevated, borderWidth: 2 },
            data: [
              { value: +(mem.usedGB || 0).toFixed(1), itemStyle: { color: this.tone(pct) } },
              { value: +(mem.cacheGB || 0).toFixed(1), itemStyle: { color: c.success } },
              { value: +free.toFixed(1), itemStyle: { color: c.border } },
            ],
          }],
          graphic: [{
            type: 'text', left: 'center', top: 'center',
            style: { text: pct.toFixed(0) + '%', fill: c.text, fontSize: 15, fontWeight: 700, fontFamily: 'Consolas' },
          }],
        });
      }

      const netChart = this.ensureChart('netChart', this.$refs.netChart);
      if (netChart) {
        netChart.setOption({
          animation: false,
          grid: { left: 38, right: 6, top: 8, bottom: 18 },
          tooltip: {
            trigger: 'axis',
            confine: true,
            backgroundColor: c.elevated,
            borderColor: c.border,
            textStyle: { color: c.text, fontSize: 11 },
            axisPointer: { type: 'line', lineStyle: { color: c.text3, type: 'dashed' } },
            formatter: (params) => params
              .map((p) => p.marker + ' ' + p.seriesName + '&nbsp;&nbsp;' + this.fmtRate(p.value))
              .join('<br>'),
          },
          xAxis: Object.assign({}, catAxis, { data: this._hist.rx.map((_, i) => i) }),
          yAxis: axis((v) => (v >= 1024 ? (v / 1024).toFixed(0) + 'M' : v + 'K')),
          series: [
            { name: this.$t('monitor.download'), type: 'line', data: this._hist.rx.map((v) => +v.toFixed(1)), symbol: 'none', itemStyle: { color: c.accent }, lineStyle: { color: c.accent, width: 1.4 }, areaStyle: { color: c.accent, opacity: 0.14 } },
            { name: this.$t('monitor.upload'), type: 'line', data: this._hist.tx.map((v) => +v.toFixed(1)), symbol: 'none', itemStyle: { color: c.success }, lineStyle: { color: c.success, width: 1.4 }, areaStyle: { color: c.success, opacity: 0.1 } },
          ],
        });
      }

      for (const chart of Object.values(this._charts)) {
        try {
          chart.resize();
        } catch (_) {}
      }
    },
    resetHistory() {
      this._hist = { cpu: [], rx: [], tx: [] };
    },
  },
};
</script>

<style scoped>
.monitor-panel {
  height: 100%;
  width: 100%;
  min-width: 280px;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
  color: var(--text);
  overflow: hidden;
}
.mono { font-family: Consolas, "Courier New", monospace; }
.panel-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.head-logo { color: var(--accent); }
.panel-title { font-size: 13px; font-weight: 700; letter-spacing: .5px; white-space: nowrap; }
.panel-host {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.refresh-set { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }
.refresh-label { font-size: 10.5px; color: var(--text-3); white-space: nowrap; }
.refresh-set :deep(.el-input-number--mini) { width: 78px; }
.panel-close {
  flex: 0 0 auto;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;
}
.panel-close:hover { background: var(--bg-hover); color: var(--text); }
.panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.panel-body::-webkit-scrollbar { width: 6px; }
.panel-body::-webkit-scrollbar-track { background: transparent; }
.panel-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.panel-body::-webkit-scrollbar-thumb:hover { background: var(--text-3); }
.panel-note { padding: 18px 8px; text-align: center; font-size: 12px; color: var(--text-2); }
.panel-note.warn { color: var(--warning); }

.card {
  flex: 0 0 auto;
  position: relative;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
}
.card-mask {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-elevated) 62%, transparent);
  color: var(--accent);
  font-size: 20px;
}
.card-mask .el-icon-loading { animation: monitor-spin 1s linear infinite; }
@keyframes monitor-spin { to { transform: rotate(360deg); } }

.sec-head { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
.sec-icon { color: var(--accent); font-size: 14px; }
.sec-name { font-size: 13px; font-weight: 700; letter-spacing: .5px; }
.sec-note { font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sec-badge {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 2px 9px;
  white-space: nowrap;
}

.sys-line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 8px; }
.os-badge { font-size: 10.5px; font-weight: 700; color: var(--accent); background: var(--accent-soft); border-radius: 4px; padding: 1px 7px; }
.sys-main { font-size: 11.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sys-grid { display: grid; grid-template-columns: 1fr; gap: 4px; }
.sys-kv { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; border-bottom: 1px dashed var(--border); padding-bottom: 3px; min-width: 0; }
.sys-kv .k { color: var(--text-3); flex: 0 0 auto; }
.sys-kv .v {
  font-family: Consolas, monospace;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.sys-kv .v.up { color: var(--success); }

.chart { width: 100%; min-height: 0; }
.spark-wrap { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 4px; }

.mem-flex { display: flex; align-items: center; gap: 10px; }
.mem-legend { flex: 1; display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.mem-item { display: flex; align-items: center; gap: 7px; font-size: 11px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.mem-item .lbl { color: var(--text-2); width: 36px; flex: 0 0 auto; }
.mem-item .val { color: var(--text); font-size: 12px; }
.mem-item .pct { margin-left: 3px; color: var(--text-3); font-size: 10px; }
.mem-donut { width: 118px; height: 118px; flex: 0 0 auto; }
.disk-list { display: flex; flex-direction: column; gap: 8px; }
.disk-row {
  display: flex; align-items: stretch; gap: 8px;
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  background: var(--bg-panel);
  min-width: 0;
}
.disk-main { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.disk-id { display: flex; align-items: center; gap: 6px; min-width: 0; }
.disk-mount { font-size: 12px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.disk-fs { font-size: 9.5px; color: var(--accent); background: var(--accent-soft); border-radius: 3px; padding: 1px 4px; flex: 0 0 auto; white-space: nowrap; }
.io-line { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); font-family: Consolas, monospace; min-width: 0; white-space: nowrap; }
.io-line > span { flex: 0 0 auto; }
.io-line b { color: var(--text); font-size: 12px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.disk-side { flex: 0 0 auto; min-width: 80px; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; gap: 2px; }
.disk-pct { font-size: 15px; font-weight: 600; color: var(--text); line-height: 1.1; white-space: nowrap; }
.disk-cap { font-size: 11px; color: var(--text-2); line-height: 1.2; white-space: nowrap; }
.disk-tank {
  width: 22px; flex: 0 0 auto; align-self: stretch; min-height: 46px;
  border: 1px solid var(--border); border-radius: 4px;
  position: relative; overflow: hidden; background: var(--bg-app);
}
.disk-tank .fill {
  position: absolute; bottom: 0; left: 0; right: 0;
  background: var(--accent);
  transition: height .5s ease, background .5s;
}
</style>
