<template>
  <section class="main group-root">
    <pane-layout v-if="layout" :node="layout" root />
  </section>
</template>

<script>
import PaneLayout from '../session/PaneLayout.vue';
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

/**
 * 独立窗口也是页签宿主：页签一律住在分屏区域里（左上角第一个区域是主栏，
 * 新会话默认落到它那里）。区域成员是窗口内部的布局树，页签成员与顺序仍由主进程
 * 组快照决定，外观与交互和主窗口页签一致。
 */
export default {
  name: 'SessionWindow',
  components: { PaneLayout },
  props: {
    groupId: { type: String, default: '' },
  },
  computed: {
    layout() {
      return store.layout;
    },
    activeTab() {
      return store.activeTab;
    },
    // 协议视图直接写 tab.connState，这里只观察结果，不改它们的写法。
    states() {
      return store.tabs.map((tab) => tab.id + '|' + (tab.connState || '') + '|' + (tab.liveSessionId || '')).join(',');
    },
  },
  watch: {
    activeTab(id) {
      // 活动页签决定独立窗口的标题，和浏览器一样跟着切。
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
    // 主窗口的连接入口点到本窗口宿主的那条页签：聚焦它所在区域，断开过就重建视图重连。
    if (api.onSessionTabFocus) {
      this._offTabFocus = api.onSessionTabFocus((payload) => {
        if (payload && payload.tabId) focusSessionTab(payload.tabId);
      });
    }
    this.loadGroup();
  },
  beforeUnmount() {
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
