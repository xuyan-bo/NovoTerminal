const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { AssetStore } = require('./store/assetStore');
const { SessionManager } = require('./session/SessionManager');

/** Advanced defaults mirrored from renderer constants — used when method.advanced is missing */
const ADVANCED_DEFAULTS = {
  rdp: {
    quality: 'auto',
    resolution: 'auto',
    screenMode: 'window',
    monitors: 'single',
    colorDepth: '32',
    clipboard: true,
    drives: false,
    printers: false,
    audio: 'local',
    promptCredentials: false,
    adminSession: false,
    autoReconnect: true,
  },
  ssh: {
    charset: 'UTF-8',
    term: 'xterm-256color',
    keepAlive: 30,
    compression: false,
    authType: 'password',
    privateKeyPath: '',
    proxyJump: '',
    x11Forward: false,
    hostKeyPolicy: 'ask',
  },
  vnc: {
    quality: 'auto',
    colorDepth: 'auto',
    compressLevel: 6,
    jpegQuality: 6,
    shared: true,
    viewOnly: false,
    screenMode: 'window',
    scale: 'fit',
    clipboard: true,
    localCursor: true,
  },
};

function protocolKey(id) {
  const s = String(id || '').toLowerCase();
  if (s === 'rdp') return 'rdp';
  if (s === 'ssh') return 'ssh';
  return 'vnc';
}

function resolveAdvanced(methodId, saved) {
  const key = protocolKey(methodId);
  const base = { ...(ADVANCED_DEFAULTS[key] || {}) };
  if (!saved || typeof saved !== 'object') return base;
  Object.keys(base).forEach((k) => {
    const v = saved[k];
    if (v === undefined || v === null) return;
    if (typeof base[k] === 'string' && String(v).trim() === '') return;
    if (typeof base[k] === 'number') {
      const n = Number(v);
      if (Number.isNaN(n) || String(v).trim() === '') return;
      base[k] = n;
      return;
    }
    if (typeof base[k] === 'boolean') {
      base[k] = !!v;
      return;
    }
    if (v !== '') base[k] = v;
  });
  return base;
}

function mapRdpDisplay(advanced) {
  const adv = advanced || ADVANCED_DEFAULTS.rdp;
  const mode = adv.screenMode === 'fullscreen' ? 'fullscreen' : 'window';
  const display = {
    mode,
    multimon: adv.monitors === 'multi',
    promptCredentials: !!adv.promptCredentials,
  };
  if (adv.resolution && adv.resolution !== 'auto') {
    const [w, h] = String(adv.resolution).split('x').map(Number);
    if (w > 0 && h > 0) {
      display.width = w;
      display.height = h;
    }
  }
  if (adv.colorDepth && adv.colorDepth !== 'auto') {
    display.colorDepth = Number(adv.colorDepth) || undefined;
  }
  return display;
}

function mapRdpRedirect(advanced) {
  const adv = advanced || ADVANCED_DEFAULTS.rdp;
  return {
    clipboard: adv.clipboard !== false,
    drives: !!adv.drives,
    printers: !!adv.printers,
    audio: adv.audio || 'local',
  };
}

let win = null;
let store = null;
let sessions = null;

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'OmniDesk',
    backgroundColor: '#0f1419',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[load-fail]', code, desc, url);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { __error: true, message: err.message, code: err.code || 'ERROR' };
    }
  });
}

function unwrap(result) {
  if (result && result.__error) {
    const e = new Error(result.message);
    e.code = result.code;
    throw e;
  }
  return result;
}

function registerIpc() {
  handle('store:snapshot', () => store.snapshot());
  handle('store:create-group', (p) => unwrap(store.createGroup(p)));
  handle('store:update-group', (gid, p) => unwrap(store.updateGroup(gid, p)));
  handle('store:delete-group', (gid) => unwrap(store.deleteGroup(gid)));
  handle('store:create-asset', (gid, p) => unwrap(store.createAsset(gid, p)));
  handle('store:update-asset', (aid, p) => unwrap(store.updateAsset(aid, p)));
  handle('store:delete-asset', (aid) => unwrap(store.deleteAsset(aid)));
  handle('store:clone-asset', (aid) => unwrap(store.cloneAsset(aid)));
  handle('store:settings', () => store.getSettings());
  handle('store:update-settings', (patch) => unwrap(store.updateSettings(patch)));
  handle('store:export', () => store.exportJson());
  handle('store:import', (text) => unwrap(store.importGroups(text)));
  handle('app:browse-data-path', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择数据文件存储位置',
    });
    if (r.canceled || !r.filePaths[0]) return null;
    store.setCustomPath(r.filePaths[0]);
    store.persist();
    return store.snapshot().settings;
  });

  handle('session:capabilities', (protocol) => sessions.capabilities(protocol));
  handle('session:test', (req) => sessions.testConnection(req));
  handle('session:connect', async (req) => {
    const hit = store.findAsset(req.assetId);
    if (!hit) throw new Error('asset not found');
    const method = hit.asset.methods && hit.asset.methods[req.methodId];
    if (!method || !method.enabled) throw new Error('method not enabled');
    const advanced = resolveAdvanced(req.methodId, method.advanced);
    const meta = {
      id: req.methodId,
      protocol: req.methodId === 'rdp' ? 'rdp' : req.methodId === 'vnc' ? 'vnc' : 'ssh',
      port: method.port,
      primary: !!method.primary,
      advanced,
    };
    return sessions.connect({
      assetId: hit.asset.id,
      asset: hit.asset,
      method: meta,
      display: mapRdpDisplay(advanced),
      redirect: mapRdpRedirect(advanced),
      auth: { mode: 'keytar' },
    });
  });
  handle('session:disconnect', (sid) => sessions.disconnect(sid));
  handle('session:list', () => sessions.listActive());
}

app.whenReady().then(() => {
  store = new AssetStore();
  sessions = new SessionManager({ store, send });
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
