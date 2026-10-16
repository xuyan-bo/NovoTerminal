<template>
  <section class="main group-root">
    <tab-bar scope="group" />
    <div class="views">
      <div
        v-for="t in tabs"
        :key="t.id + ':' + (refreshKeys[t.id] || 0)"
        class="view"
        :class="[t.kind + '-view', { show: activeTab === t.id }]"
      >
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
</template>

<script>
import TabBar from '../panels/TabBar.vue';
import {
  store,
  api,
  unwrap,
  setHostedGroup,
  applyGroupTabs,
  reportTabState,
  reportActiveTab,
  markSessionHandover,
  focusSessionTab,
} from '../../store';
import { t } from '../../i18n';
import { getProtocol } from '../../protocols';

/**
 * 独立窗口也是页签宿主：它用同一个 store、同一个页签栏组件管自己那几条页签，
 * 成员与顺序由主进程下发的组快照决定，所以外观与交互和主窗口天然一致。
 */
export default {
  name: 'SessionWindow',
  components: { TabBar },
  props: {
    groupId: { type: String, default: '' },
  },
  computed: {
    tabs() {
      return store.tabs;
    },
    activeTab() {
      return store.activeTab;
    },
    refreshKeys() {
      return store.tabRefreshKeys;
    },
    // 协议视图直接写 tab.connState，这里只观察结果，不改它们的写法。
    states() {
      return store.tabs.map((tab) => tab.id + '|' + (tab.connState || '') + '|' + (tab.liveSessionId || '')).join(',');
    },
  },
  watch: {
    activeTab(id) {
      reportActiveTab(id);
    },
    states() {
      store.tabs.forEach((tab) => reportTabState(tab.id));
    },
  },
  created() {
    setHostedGroup(this.groupId);
    this._offGroup = null;
    this._offHandover = null;
    this._offConfirm = null;
    this._offTabFocus = null;
    if (api.onSessionGroup) {
      this._offGroup = api.onSessionGroup((payload) => {
        if (payload && String(payload.groupId || '') === this.groupId) applyGroupTabs(payload.tabs);
      });
    }
    // 页签交给别的窗口时，本侧销毁视图不能断开那条连接。
    if (api.onSessionHandover) {
      this._offHandover = api.onSessionHandover((payload) => {
        if (payload && payload.tabId) markSessionHandover(payload.tabId);
      });
    }
    if (api.onSessionConfirmClose) {
      this._offConfirm = api.onSessionConfirmClose((payload) => this.confirmClose(payload));
    }
    // 主窗口的连接入口点到本窗口宿主的那条页签：激活它，断开过就重建视图重连。
    if (api.onSessionTabFocus) {
      this._offTabFocus = api.onSessionTabFocus((payload) => {
        if (payload && payload.tabId) focusSessionTab(payload.tabId);
      });
    }
    this.loadGroup();
  },
  beforeDestroy() {
    if (this._offGroup) this._offGroup();
    if (this._offHandover) this._offHandover();
    if (this._offConfirm) this._offConfirm();
    if (this._offTabFocus) this._offTabFocus();
    setHostedGroup('');
  },
  methods: {
    async loadGroup() {
      if (!api.sessionGroupTabs) return;
      try {
        applyGroupTabs(unwrap(await api.sessionGroupTabs({ groupId: this.groupId })).tabs);
      } catch (e) {
        this.logFailure('group tabs failed', e);
      }
    },
    sessionComponent(tab) {
      const protocol = getProtocol(tab.kind);
      return protocol && protocol.component ? protocol.component : null;
    },
    // 只有 SSH 会把活连接跨窗口带走，其余视图总是重新连。
    attachSessionIdOf(tab) {
      return tab.kind === 'ssh' ? tab.liveSessionId || undefined : undefined;
    },
    onViewSession(tab, sessionId) {
      tab.liveSessionId = sessionId || null;
    },
    /**
     * 关窗＝关掉这个窗口里的全部页签，问法和主窗口的批量关闭一模一样：
     * 说清有几条活动会话、断开后内容丢失，确认后由主进程关窗，会话随该窗口的 webContents 一起释放。
     */
    confirmClose(payload) {
      const wanted = payload && Array.isArray(payload.tabIds) ? payload.tabIds : [];
      const live = store.tabs.filter(
        (tab) => wanted.includes(tab.id) && (tab.connState === 'connecting' || tab.connState === 'ready')
      ).length;
      if (!live) {
        this.answerClose(true, 0);
        return;
      }
      this.$confirm(
        t('tab.closeBulkConfirmMsg', { count: live }),
        t('tab.closeConfirmTitle'),
        { confirmButtonText: t('msg.confirm'), cancelButtonText: t('msg.cancel'), type: 'warning' }
      ).then(
        () => this.answerClose(true, live),
        () => this.answerClose(false, live)
      );
    },
    // 答复失败不能被当成"不关"，否则窗口再也关不掉。
    answerClose(confirmed, liveCount) {
      if (!api.sessionCloseAnswer) return;
      api.sessionCloseAnswer({ groupId: this.groupId, confirmed }).catch((e) => {
        this.logFailure('detached window close answer failed', e, { confirmed, liveCount });
      });
    },
    logFailure(message, e, extra) {
      if (!api.logWrite) return;
      api
        .logWrite({
          level: 'warn',
          source: 'session',
          message,
          meta: { groupId: this.groupId, message: e && e.message, ...(extra || {}) },
        })
        .catch(() => {});
    },
  },
};
</script>

<style scoped>
.group-root {
  height: 100%;
}
</style>
