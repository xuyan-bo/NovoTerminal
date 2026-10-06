<template>
  <div v-if="asset" class="asset-detail-view">
    <div class="asset-detail">
      <div class="ad-head">
        <div class="ad-os" :class="asset.os" v-html="osSvg(asset.os)"></div>
        <div class="ad-title">
          <h3>
            {{ asset.name }}
            <span class="pill">{{ osName }}</span>
            <span v-if="primaryName" class="badge-primary">{{ $t('asset.primary') }} {{ primaryName }}</span>
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
            <div class="ad-field-wide">
              <dt>{{ $t('detail.note') }}</dt>
              <dd class="ad-note">{{ asset.note || '-' }}</dd>
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
                  {{ $t(m.nameKey) }}
                  <span v-if="m.primary" class="badge-primary">{{ $t('asset.primary') }}</span>
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
                  <svg-icon name="gear" />
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
        </div>
      </div>
    </div>
  </div>
  <div v-else class="asset-detail-view">
    <div class="empty">{{ $t('detail.empty') }}</div>
  </div>
</template>

<script>
import { store, findAsset, enabledMethods, openMethodAdvanced, connectAsset, connectionErrorMessage } from '../store';
import { OS_SVG, OS_NAME, methodPillClass } from '../constants';
import { protocolLabel } from '../protocols';
import { folderPathText } from '../assetTree';

export default {
  name: 'AssetDetailView',
  props: { assetId: { type: String, required: true } },
  data() {
    return {
      loadingId: null,
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
      return p ? this.$t(p.nameKey) : '';
    },
    folderPath() {
      const g = this.hit && this.hit.group;
      if (!g) return '';
      return folderPathText(store.snapshot.groups || [], g.id) || g.name || '';
    },
    fields() {
      const a = this.asset;
      if (!a) return [];
      return [
        [this.$t('detail.osKind'), this.osName],
        [this.$t('asset.host'), a.host || '-'],
        [this.$t('asset.user'), a.user || '-'],
        [this.$t('asset.group'), this.folderPath || '-'],
        [this.$t('detail.methodCount'), this.$t('detail.kindCount', { count: this.methods.length })],
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
    short: protocolLabel,
    hasCustomAdv(m) {
      return !!(m.advanced && Object.keys(m.advanced).length);
    },
    openAdvanced(m) {
      openMethodAdvanced({
        methodId: m.id,
        methodName: this.$t(m.nameKey),
        advanced: m.advanced || {},
        context: { type: 'detail', assetId: this.assetId },
      });
    },
    async connect(m) {
      this.loadingId = m.id;
      try {
        await connectAsset(this.asset, m);
      } catch (e) {
        this.$message.error(connectionErrorMessage(e));
      } finally {
        this.loadingId = null;
      }
    },
  },
};
</script>
