/** Renderer API wrapper with local mock fallback when preload missing. */
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
  settings: { theme: 'dark', lang: 'zh', dataPath: '(预览模式，无 Electron）' },
};

async function local(method, ...args) {
  // browser-only prototype fallback for vite dev without electron
  if (method === 'store:snapshot' || method === 'store:settings') return JSON.parse(JSON.stringify(mockState.settings ? { ...mockState, settings: mockState.settings } : mockState));
  return { __error: true, message: '需要在 Electron 中运行以使用完整功能', code: 'NO_BRIDGE' };
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
        return JSON.parse(JSON.stringify(mockState));
      },
      async getSettings() {
        return mockState.settings;
      },
      async exportGroups() {
        return JSON.stringify(mockState.groups, null, 2);
      },
      async importGroups() {
        return { __error: true, message: '浏览器预览模式', code: 'NO_BRIDGE' };
      },
      async reorderGroups() {
        return { __error: true, message: '浏览器预览模式', code: 'NO_BRIDGE' };
      },
      async reorderAsset() {
        return { __error: true, message: '浏览器预览模式', code: 'NO_BRIDGE' };
      },
      async sessionCapabilities() {
        return { embeddable: false, resolution: 'partial', colorDepth: true, refreshRate: false, multimon: 'partial', clipboard: true, processTracked: true };
      },
      async sessionConnect() {
        throw Object.assign(new Error('浏览器预览模式无法连接，请用 npm run electron 启动'), { code: 'NO_BRIDGE' });
      },
      async sessionTest() {
        return { ok: false, error: '浏览器预览模式' };
      },
      async sessionDisconnect() {
        return { ok: true };
      },
      async sshConnect() {
        throw Object.assign(new Error('浏览器预览模式无法 SSH，请用 npm run electron 启动'), { code: 'NO_BRIDGE' });
      },
      async sshWrite() {
        return false;
      },
      async sshResize() {
        return false;
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
      async sftpOpenWindow() {
        throw Object.assign(new Error('浏览器预览模式无法打开 SFTP'), { code: 'NO_BRIDGE' });
      },
      async sftpOpen() {
        throw Object.assign(new Error('浏览器预览模式'), { code: 'NO_BRIDGE' });
      },
      async sftpList() {
        return { __error: true, message: '浏览器预览模式', code: 'NO_BRIDGE' };
      },
      async sftpLocalExists() {
        return { exists: false };
      },
      async sftpLocalCopy() {
        return { __error: true, message: '浏览器预览模式', code: 'NO_BRIDGE' };
      },
      sftpStartDrag() {},
      onSftpDragReady() {
        return () => {};
      },
      async sftpLocalList() {
        return { path: '', items: [], home: '' };
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
