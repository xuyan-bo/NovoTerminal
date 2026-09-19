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
      async getSnapshot() {
        return JSON.parse(JSON.stringify(mockState));
      },
      async getSettings() {
        return mockState.settings;
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
      onSessionState() {
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
