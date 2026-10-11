/** Renderer API wrapper with local mock fallback when preload missing. */
import { t } from './i18n';
import { AI_DEFAULTS } from './constants';

const hasBridge = typeof window !== 'undefined' && !!window.novoTerminal;

const mockState = {
  groups: [
    { id: 'g-prod', pid: '', name: '生产环境', color: '#409EFF', open: true, nodes: [] },
    { id: 'g-east', pid: 'g-prod', name: '华东区', color: '#67C23A', open: true, nodes: [] },
    { id: 'g-office', pid: '', name: '办公室', color: '#E6A23C', open: true, nodes: [] },
  ],
  recent: [],
};

function mockSettings() {
  return {
    theme: 'system',
    lang: 'zh',
    dataPath: t('settings.previewDataPath'),
    zoom: 100,
    font: 'default',
    closeAction: 'ask',
    homeWelcome: true,
    autoUpdateCheck: true,
    skippedUpdateVersion: '',
    recentLimit: 20,
    logTotalMb: 20,
    ai: { ...AI_DEFAULTS, services: [], defaultRef: null },
  };
}

export const api = hasBridge
  ? window.novoTerminal
  : {
      getPathForFile(file) {
        return (file && file.path) || '';
      },
      async clipboardReadText() {
        return '';
      },
      async clipboardWriteText() {
        return false;
      },
      async getSnapshot() {
        return JSON.parse(JSON.stringify({ ...mockState, settings: mockSettings() }));
      },
      async getSettings() {
        return mockSettings();
      },
      async backupExport() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async checkUpdate() {
        return { __error: true, message: t('msg.needElectron'), code: 'NO_BRIDGE' };
      },
      async verifySystemAuth() {
        return { ok: false, code: 'NO_BRIDGE', message: t('auth.needElectron') };
      },
      async backupImport() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async reorderGroups() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async reorderAsset() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async removeRecent() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async sessionDetach() {
        return { __error: true, message: t('msg.previewDetach'), code: 'NO_BRIDGE' };
      },
      async sessionCloseAnswer() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      onSessionConfirmClose() {
        return () => {};
      },
      async sessionTabbarBounds() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      async sessionDockPrepare() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      async sessionDockAbort() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      async sessionTabMove() {
        return { __error: true, message: t('msg.previewDetach'), code: 'NO_BRIDGE' };
      },
      async sessionGroupTabs() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async sessionGroupOrder() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      async sessionTabState() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      async sessionTabCopy() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async sessionTabClose() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async sessionTabActive() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      onSessionGroup() {
        return () => {};
      },
      onSessionTabCopyRequest() {
        return () => {};
      },
      onSessionTabState() {
        return () => {};
      },
      onSessionDockClear() {
        return () => {};
      },
      onSessionDetached() {
        return () => {};
      },
      onSessionClosed() {
        return () => {};
      },
      onSessionHandover() {
        return () => {};
      },
      async sessionConnect() {
        throw Object.assign(new Error(t('msg.previewConnect')), { code: 'NO_BRIDGE' });
      },
      async sessionTest() {
        return { ok: false, error: t('msg.previewMode') };
      },
      async sessionDisconnect() {
        return { ok: true };
      },
      async rdpProbeClient() {
        return { ok: false, code: 'NO_BRIDGE', message: t('msg.needElectron') };
      },
      async rdpPickClientBinary() {
        return { ok: false, code: 'NO_BRIDGE', message: t('msg.needElectron') };
      },
      async sshConnect() {
        throw Object.assign(new Error(t('msg.previewSsh')), { code: 'NO_BRIDGE' });
      },
      async sshWrite() {
        return false;
      },
      async sshWriteBinary() {
        return false;
      },
      async sshAuthReply() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      onSshAuthPrompt() {
        return () => {};
      },
      onSshAuthCancel() {
        return () => {};
      },
      async sshResize() {
        return false;
      },
      async sshAttach() {
        throw Object.assign(new Error(t('msg.previewAttach')), { code: 'NO_BRIDGE' });
      },
      async sshDisconnect() {
        return { ok: true };
      },
      onSshData() {
        return () => {};
      },
      onSshState() {
        return () => {};
      },
      async monitorStart() {
        return { ok: true, supported: false, reason: 'no-bridge' };
      },
      async monitorStop() {
        return { ok: true, existed: false };
      },
      async monitorUiGet() {
        return null;
      },
      async monitorUiSet() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      async monitorUiDrop() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      onMonitorSnapshot() {
        return () => {};
      },
      onMonitorEnd() {
        return () => {};
      },
      async aiSend() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async aiApprove() {
        return { ok: false, reason: 'stale' };
      },
      async aiCancel() {
        return { ok: true, running: false };
      },
      async aiSetPermission() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async aiHistory() {
        return { ok: true, running: false, permissionOverride: '', modelOverride: null, title: '', recordId: '', record: [] };
      },
      async aiScreenReply() {
        return { ok: false };
      },
      async aiTest() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async aiModels() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      onAiEvent() {
        return () => {};
      },
      async rdpConnect() {
        throw Object.assign(new Error(t('msg.previewRdp')), { code: 'NO_BRIDGE' });
      },
      async rdpDisconnect() {
        return { ok: true };
      },
      onRdpState() {
        return () => {};
      },
      async sftpOpenWindow() {
        throw Object.assign(new Error(t('msg.previewSftp')), { code: 'NO_BRIDGE' });
      },
      async sftpOpen() {
        throw Object.assign(new Error(t('msg.previewMode')), { code: 'NO_BRIDGE' });
      },
      async sftpList() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      async sftpLocalExists() {
        return { exists: false };
      },
      async sftpLocalCopy() {
        return { __error: true, message: t('msg.previewMode'), code: 'NO_BRIDGE' };
      },
      onSftpState() {
        return () => {};
      },
      onSftpConfirmClose() {
        return () => {};
      },
      async sftpCloseAnswer() {
        return { ok: false, code: 'NO_BRIDGE' };
      },
      async sftpLocalList() {
        return { path: '', items: [], home: '' };
      },
      async sftpDrives() {
        return [];
      },
      onSftpProgress() {
        return () => {};
      },
      onSessionState() {
        return () => {};
      },
      onStoreChanged() {
        return () => {};
      },
      platform: 'browser',
    };

export function unwrap(res) {
  if (res && res.__error) {
    const e = new Error(res.message || 'error');
    e.code = res.code;
    throw e;
  }
  return res;
}
