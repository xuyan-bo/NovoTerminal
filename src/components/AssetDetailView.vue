<template>
  <div v-if="asset" class="asset-detail-view">
    <div class="asset-detail">
      <div class="ad-head">
        <div class="ad-os" :class="asset.os" v-html="osSvg(asset.os)"></div>
        <div class="ad-title">
          <h3>
            {{ asset.name }}
            <span class="pill">{{ osName }}</span>
            <span v-if="primaryName" class="badge-primary">主 {{ primaryName }}</span>
          </h3>
          <div class="sub">{{ asset.user || '-' }} @ {{ asset.host }}</div>
        </div>
      </div>

      <div class="ad-stack">
        <div class="ad-block">
          <h4>{{ $t('detail.assets') }} <span class="hint" style="font-weight:400;margin-left:8px">{{ $t('detail.shared') }}</span></h4>
          <dl class="ad-fields">
            <div v-for="row in fields" :key="row[0]">
              <dt>{{ row[0] }}</dt>
              <dd>{{ row[1] }}</dd>
            </div>
          </dl>
        </div>

        <div class="ad-block">
          <h4>{{ $t('detail.methods') }} <span class="hint" style="font-weight:400;margin-left:8px">{{ $t('detail.methodHint') }}</span></h4>
          <div class="method-connect-list">
            <div
              v-for="m in methods"
              :key="m.id"
              class="method-connect"
              :class="{ primary: m.primary }"
            >
              <span class="pill" :class="pillClass(m.id)">{{ short(m.id) }}</span>
              <div class="mc-info">
                <div class="mc-name">
                  {{ m.name }}
                  <span v-if="m.primary" class="badge-primary">主</span>
                </div>
                <div class="mc-meta">{{ asset.host }}:{{ m.port }} · {{ asset.user || '-' }}</div>
              </div>
              <el-tooltip :content="$t('adv.gearTip')" placement="top">
                <button
                  type="button"
                  class="gear-icon-btn"
                  :class="{ customized: hasCustomAdv(m) }"
                  @click="openAdvanced(m)"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7.05 7.05 0 00-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84a.48.48 0 00-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.48.48 0 00.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z"/>
                  </svg>
                </button>
              </el-tooltip>
              <el-button
                type="primary"
                size="mini"
                :loading="loadingId === m.id"
                @click="connect(m)"
              >{{ $t('detail.connect') }}</el-button>
            </div>
            <div v-if="!methods.length" class="empty" style="min-height:80px">
              {{ $t('detail.noMethods') }}
            </div>
          </div>
          <div v-if="sessionNote" class="session-note">{{ sessionNote }}</div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="asset-detail-view">
    <div class="empty">{{ $t('detail.empty') }}</div>
  </div>
</template>

<script>
import { store, findAsset, enabledMethods, api, unwrap, openMethodAdvanced } from '../store';
import { OS_SVG, OS_NAME, methodPillClass } from '../constants';
import { t } from '../i18n';

export default {
  name: 'AssetDetailView',
  props: { assetId: { type: String, required: true } },
  data() {
    return {
      loadingId: null,
      sessionNote: '',
    };
  },
  computed: {
    hit() {
      // depend on snapshot version
      const _ = store.snapshot;
      return findAsset(this.assetId);
    },
    asset() {
      return this.hit ? this.hit.asset : null;
    },
    methods() {
      return this.asset ? enabledMethods(this.asset) : [];
    },
    osName() {
      return this.asset ? OS_NAME[this.asset.os] || this.asset.os : '';
    },
    primaryName() {
      const p = this.methods.find((m) => m.primary);
      return p ? p.name : '';
    },
    fields() {
      const a = this.asset;
      if (!a) return [];
      const layoutMap = {
        single: '单屏',
        extend: '横向扩展',
        stack: '纵向扩展',
        mirror: '镜像',
      };
      return [
        ['OS 类型', this.osName],
        ['IP / 主机', a.host || '-'],
        ['用户名', a.user || '-'],
        ['分组', this.hit && this.hit.group ? this.hit.group.name : '-'],
        ['标签', a.tags || '-'],
        ['备注', a.note || '-'],
        ['访问方式数', this.methods.length + ' 种'],
        ['显示布局', (a.display && layoutMap[a.display.layout]) || (a.display && a.display.layout) || '-'],
      ];
    },
  },
  methods: {
    osSvg(os) {
      return OS_SVG[os] || '';
    },
    pillClass(id) {
      return methodPillClass(id);
    },
    short(id) {
      return id === 'rdp' ? 'RDP' : id === 'vnc' ? 'VNC' : 'SSH';
    },
    hasCustomAdv(m) {
      return !!(m.advanced && Object.keys(m.advanced).length);
    },
    openAdvanced(m) {
      openMethodAdvanced({
        methodId: m.id,
        methodName: m.name,
        advanced: m.advanced || {},
        context: { type: 'detail', assetId: this.assetId },
      });
    },
    async connect(m) {
      this.loadingId = m.id;
      this.sessionNote = '';
      try {
        unwrap(
          await api.sessionConnect({
            assetId: this.assetId,
            methodId: m.id,
          })
        );
        if (m.id === 'rdp') {
          // mstsc launched — no toast
        } else {
          this.sessionNote = t('detail.stubNote', { name: m.name });
          this.$message.warning(t('msg.notImpl', { name: m.name }));
        }
      } catch (e) {
        const map = {
          TCP_TIMEOUT: t('msg.tcpFail'),
          NOT_IMPLEMENTED: e.message,
          NO_BRIDGE: e.message,
          PLATFORM: e.message,
        };
        this.$message.error(map[e.code] || e.message || t('err.connect'));
      } finally {
        this.loadingId = null;
      }
    },
  },
};
</script>
