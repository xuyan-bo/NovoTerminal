/** Renderer API wrapper with local mock fallback when preload missing. */
import { t } from './i18n';

const hasBridge = typeof window !== 'undefined' && !!window.omniDesk;

const mockState = {
  groups: [
    {
      id: 'g-default',
      name: '未分组',
      color: '#409EFF',
      open: true,
      nodes: [],
    },
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
  };
}

async function local(method, ...args) {
  // browser-only prototype fallback for vite dev without electron
  if (method === 'store:snapshot') return { ...mockState, settings: mockSettings() };
  if (method === 'store:settings') return mockSettings();
  return { __error: true, message: t('msg.needElectron'), code: 'NO_BRIDGE' };
}

export const api = hasBridge
  ? window.omniDesk
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
      async exportGroups() {
        return JSON.stringify(mockState.groups, null, 2);
      },
      async verifySystemAuth() {
        return { ok: false, code: 'NO_BRIDGE', message: t('auth.needElectron') };
      },
      async importGroups() {
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
      onSessionDetached() {
        return () => {};
      },
      onSessionClosed() {
        return () => {};
      },
      onSessionDropHint() {
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
      async rdpConnect() {
        throw Object.assign(new Error(t('msg.previewRdp')), { code: 'NO_BRIDGE' });
      },
      async rdpDisconnect() {
        return { ok: true };
      },
      async rdpList() {
        return [];
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
      sftpStartDrag() {},
      onSftpDragReady() {
        return () => {};
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
