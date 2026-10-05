const { app, BrowserWindow, ipcMain, dialog, clipboard, Tray, Menu, nativeImage, shell, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
/** Bump when shipping renderer changes — shown in every window title */
const APP_BUILD = 'rd2-1647';
const { AssetStore } = require('./store/assetStore');
const { SessionManager } = require('./session/SessionManager');
const { SshSessionManager } = require('./ssh/SshSessionManager');
const { SshMonitorManager } = require('./ssh/SshMonitorManager');
const { AiManager } = require('./ai/aiManager');
const { AiSessionStore } = require('./ai/sessionStore');
const { testConnection, listModels } = require('./ai/aiClient');
const { normalize: normalizeAi } = require('./ai/aiSettings');
const { SSH_DEFAULTS } = require('./ssh/connection');
const { createHostKeyVerifier } = require('./ssh/hostKeys');
const { SshPrompts } = require('./ssh/SshPrompts');
const { probeRemoteCwd, sanitizeRemotePath } = require('./ssh/cwdProbe');
const { fileURLToPath } = require('url');
const { VncSessionManager } = require('./vnc/VncSessionManager');
const { RdpSessionManager } = require('./rdp/RdpSessionManager');
const { SftpManager } = require('./sftp/SftpManager');
const { LogStore } = require('./logs/logStore');
const { verifySystemAuth, resetAuthCache } = require('./auth/systemAuth');

/** Advanced defaults mirrored from renderer constants — used when method.advanced is missing */
const ADVANCED_DEFAULTS = {
  rdp: {
    engine: 'ironrdp',
    client: '',
    clientPath: '',
    resolution: 'auto',
    screenMode: 'fullscreen',
    monitors: 'single',
    promptCredentials: false,
    adminSession: false,
    clipboard: true,
    nla: true,
  },
  ssh: SSH_DEFAULTS,
};

function protocolKey(id) {
  return String(id || '').toLowerCase();
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
  return display;
}

let win = null;
let store = null;
let sessions = null;
let sshSessions = null;
let sshMonitor = null;
let aiAssistant = null;
let vncSessions = null;
let rdpSessions = null;
let sftpManager = null;
let tray = null;
let trayDestroying = false;
let logStore = null;

/** Logger facade handed to managers; no-op until logStore is created. */
const logger = {
  info: (source, message, meta) => logStore && logStore.info(source, message, meta),
  warn: (source, message, meta) => logStore && logStore.warn(source, message, meta),
  error: (source, message, meta) => logStore && logStore.error(source, message, meta),
};
const detachedWindows = new Map(); // tabId -> { window, kind, reason }
/** SFTP 面板是单实例窗口，多个远端会话作为面板内页签共存。 */
let sftpPanel = null;
/** 面板渲染层完成订阅后置位；此前到达的会话先排队，由 sftp:sessions-ready 一次交出。 */
let sftpPanelReady = false;
/** 关闭拦截已解除（用户确认过关窗、应用正在退出、渲染进程已死）与正在等待面板答复。 */
const sftpCloseGuard = { bypass: false, asking: false };
const sftpPendingSessions = [];

/** 面板就绪前只排队（同一资产可以有多个会话），否则会丢掉在渲染层订阅前到达的会话。 */
function deliverSftpSession(meta) {
  if (!sftpPanelReady) {
    sftpPendingSessions.push(meta);
    return;
  }
  if (sftpPanel && !sftpPanel.isDestroyed() && !sftpPanel.webContents.isDestroyed()) {
    sftpPanel.webContents.send('sftp:add-session', meta);
  }
}

/** 目录探测整体上限：远端 exec 全部卡住时也不能让面板干等。 */
const SFTP_CWD_DEADLINE_MS = 4000;

/**
 * 从 SSH 终端打开 SFTP 时，让远端面板落在终端当前所在的目录。
 * 渲染层的 OSC 7 结果优先（shell 自带集成时零开销），否则用同一条会话反查交互 shell 的 cwd。
 * 两者都拿不到就返回 null，由面板回退到家目录。路径本身不进日志。
 */
async function resolveSftpInitialPath(sender, req, assetId) {
  const fromRenderer = sanitizeRemotePath(req && req.remotePath);
  if (fromRenderer) return fromRenderer;
  const sessionId = req && req.sshSessionId;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const target = sshSessions.execTarget(sessionId);
  // 只认本窗口自己、且属于同一资产的会话，避免跨窗口或跨资产读目录
  if (!target || target.ownerId !== sender.id || target.assetId !== assetId) return null;
  const started = Date.now();
  const meta = { sessionId, host: target.host, port: target.port };
  let timer;
  try {
    const cwd = await Promise.race([
      probeRemoteCwd(target).finally(() => clearTimeout(timer)),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), SFTP_CWD_DEADLINE_MS); }),
    ]);
    logger.info('ssh', 'sftp initial cwd probe', { ...meta, found: !!cwd, ms: Date.now() - started });
    return cwd;
  } catch (error) {
    logger.warn('ssh', 'sftp initial cwd probe failed', {
      ...meta, code: error.code || 'SSH_CWD', message: error.message, ms: Date.now() - started,
    });
    return null;
  }
}

/** Page-space rect of the main window's tab bar, resolved to screen px on each drop hit test. */
let tabbarDropRect = null;
/** Last drop-hint state, so we only broadcast when the highlight should change. */
let dropHintActive = false;
const sshPrompts = new SshPrompts();
const sshOwners = new Set();
const sshTests = new Map();

function closeSshOwner(ownerId) {
  if (aiAssistant) aiAssistant.stopOwner(ownerId);
  if (sshSessions) sshSessions.closeOwner(ownerId);
  if (sshMonitor) sshMonitor.stopOwner(ownerId);
  if (sftpManager) sftpManager.closeOwner(ownerId);
  const tests = sshTests.get(ownerId);
  if (tests) for (const connection of tests) connection.close();
  sshTests.delete(ownerId);
  sshPrompts.closeOwner(ownerId);
}

function trackSshOwner(sender) {
  if (sshOwners.has(sender.id)) return;
  const ownerId = sender.id;
  sshOwners.add(ownerId);
  sender.once('destroyed', () => {
    closeSshOwner(ownerId);
    sshOwners.delete(ownerId);
  });
  sender.on('render-process-gone', () => closeSshOwner(ownerId));
  sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) closeSshOwner(ownerId);
  });
}

function sshRequestContext(sender) {
  return {
    ownerId: sender.id,
    verifyHostKey: createHostKeyVerifier({
      log: logger,
      confirm: async ({ host, port, fingerprint, keyType, signal }) => {
        if (sender.isDestroyed() || signal?.aborted) return false;
        const parent = BrowserWindow.fromWebContents(sender);
        if (!parent || parent.isDestroyed()) return false;
        const en = store.getSettings().lang === 'en';
        const response = await dialog.showMessageBox(parent, {
          type: 'warning', title: en ? 'SSH host identity' : 'SSH 主机身份确认',
          message: en ? 'Trust this new SSH host key?' : '是否信任此 SSH 主机的新密钥？',
          detail: `${host}:${port}\n${keyType}\nSHA256:${fingerprint}\n\n` + (en ? 'Verify this fingerprint with the server administrator before accepting.' : '请先与服务器管理员核对指纹，再接受并保存。'),
          buttons: en ? ['Cancel', 'Accept and save'] : ['取消', '接受并保存'],
          defaultId: 0, cancelId: 0, noLink: true, signal,
        });
        return !sender.isDestroyed() && !signal?.aborted && response.response === 1;
      },
    }),
    promptKeyboard: (details) => sshPrompts.request(sender, details),
    onConnection: (connection) => {
      if (!sshTests.has(sender.id)) sshTests.set(sender.id, new Set());
      sshTests.get(sender.id).add(connection);
      connection.once('closed', () => {
        const tests = sshTests.get(sender.id);
        if (tests) {
          tests.delete(connection);
          if (!tests.size) sshTests.delete(sender.id);
        }
      });
    },
  };
}

const isDev = !!process.env.VITE_DEV_SERVER_URL;

// ---------- Single instance lock ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}
app.on('second-instance', () => {
  showMainWindow();
});

function send(channel, payload) {
  // Broadcast to all windows so SFTP child windows receive progress events. During teardown the
  // webContents can already be gone while the BrowserWindow still reports itself as alive.
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  });
}

/** Targeted send used by SSH events: only the window currently hosting the session needs them. */
function sendToOwner(channel, payload, ownerId) {
  const owner = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.id === ownerId);
  if (!owner) return;
  try {
    owner.webContents.send(channel, payload);
  } catch (_) {}
}

/** Which window currently owns a session tab's view: its detached window, else the main window. */
function sessionHostWindow(tabId) {
  const entry = detachedWindows.get(tabId);
  return entry && !entry.window.isDestroyed() ? entry.window : win;
}

function tabbarScreenRect() {
  // A hidden or minimized main window has no visible drop target, even if its last rect is stale.
  if (!tabbarDropRect || !win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return null;
  const content = win.getContentBounds();
  const zoom = win.webContents.isDestroyed() ? 1 : win.webContents.getZoomFactor();
  return {
    x: content.x + Math.round(tabbarDropRect.x * zoom),
    y: content.y + Math.round(tabbarDropRect.y * zoom),
    width: Math.round(tabbarDropRect.width * zoom),
    height: Math.round(tabbarDropRect.height * zoom),
  };
}

/**
 * While a detached window is dragged, the cursor — not the window rect — is the drop point.
 * Returns the cursor's x inside the tab bar in page CSS px (so the renderer can show the landing
 * slot), or null when the cursor is outside the bar.
 */
function tabbarDropX() {
  const rect = tabbarScreenRect();
  if (!rect) return null;
  const point = screen.getCursorScreenPoint();
  if (
    point.x < rect.x ||
    point.x > rect.x + rect.width ||
    point.y < rect.y ||
    point.y > rect.y + rect.height
  ) {
    return null;
  }
  const zoom = win.webContents.isDestroyed() ? 1 : win.webContents.getZoomFactor();
  return (point.x - rect.x) / zoom;
}

function clearDropHint() {
  if (!dropHintActive) return;
  dropHintActive = false;
  send('session:drop-hint', { tabId: null, active: false });
}

function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setSkipTaskbar(false);
  win.focus();
}

function doMinimizeToTray() {
  if (win && !win.isDestroyed()) {
    win.setSkipTaskbar(true);
    win.hide();
  }
}

function doQuit() {
  trayDestroying = true;
  app.quit();
}

function handleCloseIntent() {
  const settings = store && store.getSettings ? store.getSettings() : {};
  const useTray = !!tray;
  const prefs = settings.closeAction || 'ask'; // 'ask' | 'minimize' | 'quit'

  // 明确偏好：直接走
  if (prefs === 'minimize' && useTray) {
    doMinimizeToTray();
    return;
  }
  if (prefs === 'quit' || !useTray) {
    doQuit();
    return;
  }

  // ask（默认）：通知渲染进程弹自定义对话框
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:close-prompt');
  } else {
    doMinimizeToTray();
  }
}

function createTray() {
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon-32.png';
  const iconPath = path.join(__dirname, 'assets', iconFile);
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (!trayIcon || trayIcon.isEmpty()) {
      trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    }
  } catch (_) {
    trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  }
  if (!trayIcon || trayIcon.isEmpty()) {
    trayIcon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    );
  }

  try {
    tray = new Tray(trayIcon);
    tray.setToolTip('OmniDesk');
    rebuildTrayMenu();
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch (e) {
    console.error('[tray] failed to create tray icon:', e.message);
    tray = null;
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const en = store.getSettings().lang === 'en';
  const menu = Menu.buildFromTemplate([
    { label: en ? 'Open Main Window' : '打开主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: en ? 'Quit OmniDesk' : '退出 OmniDesk', click: () => { trayDestroying = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function destroyTray() {
  if (tray) {
    try { tray.destroy(); } catch (_) {}
    tray = null;
  }
}

/** Settings zoom (percent) is applied to every window's webContents, incl. detached/sftp ones */
function applyZoom() {
  const z = Number(store.getSettings().zoom) || 100;
  const factor = Math.min(2, Math.max(0.5, z / 100));
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.setZoomFactor(factor);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: `OmniDesk ${APP_BUILD}`,
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
    if (level >= 2) {
      console.error('[renderer]', message);
      logStore && logStore.error('renderer', message);
    }
  });

  // Close → delegate to handleCloseIntent (prefs or renderer custom prompt)
  win.on('close', (e) => {
    if (trayDestroying) return; // tray-initiated quit → let it close
    e.preventDefault();
    handleCloseIntent();
  });
  win.on('closed', resetAuthCache);
  win.webContents.on('render-process-gone', resetAuthCache);
  win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) resetAuthCache();
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
    win.loadURL('file://' + htmlPath.replace(/\\/g, '/') + '?t=' + Date.now());
  }
}

/**
 * Explorer's CF_HDROP never reaches Electron — Chromium only surfaces formats it knows, so
 * readBuffer('CF_HDROP') is empty and FileNameW carries one item. Ask the shell for the list.
 */
function readWinClipboardFiles() {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;(Get-Clipboard -Format FileDropList).FullName';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) {
        logger.warn('sftp', 'clipboard file list failed', { code: err.code, message: err.message });
        return resolve([]);
      }
      resolve(String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

function handle(channel, fn, withSender = false) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (withSender) {
        const sender = event.sender;
        const url = new URL(sender.getURL());
        const trusted = isDev
          ? url.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin
          : url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(__dirname, '..', 'dist', 'index.html');
        if (!trusted || !BrowserWindow.fromWebContents(sender) || event.senderFrame !== sender.mainFrame) {
          throw Object.assign(new Error('Untrusted SSH IPC sender'), { code: 'SSH_OWNER' });
        }
        trackSshOwner(sender);
        return await fn(sender, ...args);
      }
      return await fn(...args);
    } catch (err) {
      logStore &&
        logStore.error('ipc', channel, {
          message: err.message,
          code: err.code || 'ERROR',
        });
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
  handle('clipboard:read-text', () => {
    try {
      return clipboard.readText() || '';
    } catch (_) {
      return null;
    }
  });
  handle('clipboard:write-text', (text) => {
    try {
      clipboard.writeText(text == null ? '' : String(text));
      return true;
    } catch (_) {
      return false;
    }
  });
  handle('app:open-external', (url) => {
    if (url && typeof url === 'string') {
      shell.openExternal(url);
    }
    return true;
  });
  handle('store:create-group', (p) => unwrap(store.createGroup(p)));
  handle('store:update-group', (gid, p) => unwrap(store.updateGroup(gid, p)));
  handle('store:reorder-groups', (p) => unwrap(store.reorderGroups(p && p.fromId, p && p.toId)));
  handle('store:reorder-asset', (p) => unwrap(store.reorderAsset(p)));
  handle('store:delete-group', (gid) => unwrap(store.deleteGroup(gid)));
  handle('store:create-asset', (gid, p) => unwrap(store.createAsset(gid, p)));
  handle('store:update-asset', (aid, p) => unwrap(store.updateAsset(aid, p)));
  handle('store:delete-asset', (aid) => unwrap(store.deleteAsset(aid)));
  handle('store:remove-recent', (p) => unwrap(store.removeRecent(p && p.id, p && p.method)));
  handle('store:settings', () => store.getSettings());
  handle('store:update-settings', (patch) => {
    const clean = patch && typeof patch === 'object' ? { ...patch } : {};
    // AI 配置由主进程收敛类型与取值范围，渲染端递来的对象不直接落盘
    if ('ai' in clean) clean.ai = normalizeAi(clean.ai);
    const s = unwrap(store.updateSettings(clean));
    applyZoom();
    rebuildTrayMenu();
    return s;
  });
  /** Get the current main window HWND so the native auth dialog can be parented to it */
  function mainWindowHwnd() {
    if (process.platform !== 'win32') return 0;
    try {
      const bw = BrowserWindow.getFocusedWindow() || win;
      if (!bw || bw.isDestroyed()) return 0;
      const buf = bw.getNativeWindowHandle();
      return buf ? buf.readUInt32LE(0) : 0;
    } catch (_) {
      return 0;
    }
  }

  handle('app:verify-system-auth', async (reason) => verifySystemAuth(reason, mainWindowHwnd(), {
    lang: store.getSettings().lang, log: logger,
  }));

  // Renderer resolved the "close window" custom prompt
  handle('app:resolve-close', (payload) => {
    const action = payload && payload.action === 'quit' ? 'quit' : 'minimize';
    if (payload && payload.remember) {
      try { store.updateSettings({ closeAction: action }); } catch (_) {}
    }
    if (action === 'quit') {
      doQuit();
    } else {
      doMinimizeToTray();
    }
    return true;
  });
  handle('store:export', async () => {
    const lang = store.getSettings().lang;
    const reason = lang === 'en' ? 'Export OmniDesk settings (includes sensitive information)' : '导出 OmniDesk 配置（包含敏感信息）';
    const auth = await verifySystemAuth(reason, mainWindowHwnd(), {
      force: process.platform === 'darwin', lang, log: logger,
    });
    if (!auth.ok) {
      const e = new Error(auth.message || (lang === 'en' ? 'System identity verification failed' : '系统身份验证失败'));
      e.code = auth.code || 'AUTH_FAILED';
      throw e;
    }
    return store.exportJson();
  });
  handle('store:import', async (text) => {
    const lang = store.getSettings().lang;
    const reason = lang === 'en' ? 'Import OmniDesk settings (replaces current data)' : '导入 OmniDesk 配置（将覆盖当前数据）';
    const auth = await verifySystemAuth(reason, mainWindowHwnd(), {
      force: process.platform === 'darwin', lang, log: logger,
    });
    if (!auth.ok) {
      const e = new Error(auth.message || (lang === 'en' ? 'System identity verification failed' : '系统身份验证失败'));
      e.code = auth.code || 'AUTH_FAILED';
      throw e;
    }
    return unwrap(store.importGroups(text));
  });
  handle('app:browse-data-path', async () => {
    const en = store.getSettings().lang === 'en';
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: en ? 'Select storage location' : '选择存储位置',
    });
    if (r.canceled || !r.filePaths[0]) return null;
    store.setCustomPath(r.filePaths[0]);
    const s = store.snapshot().settings;
    logger.info('settings', 'data path changed', { dataPath: s.dataPath });
    return s;
  });

  // ---- Logs ----
  handle('log:list', (filter) => logStore.list(filter || {}));
  handle('log:clear', () => logStore.clear());
  handle('log:write', (p) => {
    const level =
      p && p.level && ['error', 'warn', 'info'].includes(p.level) ? p.level : 'info';
    return logStore.log(level, (p && p.source) || 'renderer', (p && p.message) || '', p && p.meta);
  });

  handle('session:test', (sender, req) => sessions.testConnection(req, sshRequestContext(sender)), true);
  handle('ssh:auth-reply', (sender, requestId, answers) => sshPrompts.reply(sender.id, requestId, answers), true);
  handle('session:connect', async (req) => {
    const hit = store.findAsset(req.assetId);
    if (!hit) throw new Error('asset not found');
    const method = hit.asset.methods && hit.asset.methods[req.methodId];
    if (!method || !method.enabled) throw new Error('method not enabled');
    const advanced = resolveAdvanced(req.methodId, method.advanced);
    const meta = {
      id: req.methodId,
      protocol: protocolKey(req.methodId),
      port: method.port,
      primary: !!method.primary,
      advanced,
    };
    return sessions.connect({
      assetId: hit.asset.id,
      asset: hit.asset,
      method: meta,
      display: mapRdpDisplay(advanced),
      auth: { mode: 'keytar' },
    });
  });
  handle('session:disconnect', (sid) => sessions.disconnect(sid));
  handle('session:list', () => sessions.listActive());
  handle('rdp:probe-client', (clientId) => sessions.probeClient(clientId));
  handle('rdp:pick-client-binary', async (clientId) => {
    const en = store.getSettings().lang === 'en';
    const parent = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(parent, {
      properties: ['openFile'],
      title: en ? 'Select RDP client executable' : '选择 RDP 客户端可执行文件',
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, code: 'CANCELED' };
    const check = sessions.verifyClientPath(clientId, r.filePaths[0]);
    if (!check.ok) return check;
    logger.info('rdp', 'client binary selected', { clientId: String(clientId || ''), path: check.path });
    return check;
  });

  // ---- SSH terminal ----
  handle('ssh:connect', async (sender, req) => {
    if (!req || req.methodId !== 'ssh') throw Object.assign(new Error('Invalid SSH method'), { code: 'SSH_METHOD' });
    const hit = store.findAsset(req.assetId);
    if (!hit) throw new Error('asset not found');
    const method = hit.asset.methods && hit.asset.methods.ssh;
    if (!method || !method.enabled) throw new Error('method not enabled');
    const result = await sshSessions.connect({
      ...sshRequestContext(sender), requestId: req.requestId,
      assetId: hit.asset.id,
      asset: { host: hit.asset.host, user: hit.asset.user, pass: hit.asset.pass },
      method: { id: 'ssh', port: method.port || 22, advanced: method.advanced },
      cols: req.cols, rows: req.rows,
    });
    if (sender.isDestroyed() || !sshSessions.owns(result.sessionId, sender.id)) {
      sshSessions.disconnect(result.sessionId);
      throw Object.assign(new Error('SSH connection canceled'), { code: 'SSH_CANCELED' });
    }
    store.pushRecent(hit.asset, { id: 'ssh', proto: 'SSH', port: method.port || 22 });
    send('store:changed', { reason: 'recent' });
    return result;
  }, true);
  const ownSsh = (sender, sessionId) => {
    if (!sshSessions.owns(sessionId, sender.id)) throw Object.assign(new Error('SSH session is not owned by this window'), { code: 'SSH_OWNER' });
  };
  handle('ssh:write', (sender, sessionId, data) => {
    ownSsh(sender, sessionId);
    return sshSessions.write(sessionId, data);
  }, true);
  handle('ssh:write-binary', (sender, sessionId, data) => {
    ownSsh(sender, sessionId);
    return sshSessions.write(sessionId, data, true);
  }, true);
  handle('ssh:resize', (sender, sessionId, cols, rows) => {
    ownSsh(sender, sessionId);
    return sshSessions.resize(sessionId, cols, rows);
  }, true);
  handle('ssh:disconnect', (sender, sid) => {
    if (!sshSessions.sessions.has(sid)) return { ok: true, existed: false };
    ownSsh(sender, sid);
    return sshSessions.disconnect(sid);
  }, true);
  handle('ssh:list', (sender) => sshSessions.list().filter((s) => sshSessions.owns(s.sessionId, sender.id)), true);
  handle('monitor:start', (sender, sessionId, intervalSec) => {
    ownSsh(sender, sessionId);
    return sshMonitor.start(sessionId, intervalSec);
  }, true);
  handle('monitor:stop', (sender, sessionId) => {
    ownSsh(sender, sessionId);
    return sshMonitor.stop(sessionId);
  }, true);

  // ---- AI 助手：一切动作都以「是否拥有这条 SSH 会话」为权限边界 ----
  handle('ai:send', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.turn(req);
  }, true);
  handle('ai:approve', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.approve(req);
  }, true);
  handle('ai:cancel', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.cancel(req.sessionId);
  }, true);
  /** 新建会话：把当前对话归档成一条会话记录，再开一条空的。 */
  handle('ai:session-archive', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.archiveSession(req);
  }, true);
  /** 历史列表、载入、重命名、删除都以「这条 SSH 会话属于哪个资产」为边界，渲染端拿不到别人的目录。 */
  handle('ai:sessions', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.listSessions(req);
  }, true);
  handle('ai:session-open', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.openSession(req);
  }, true);
  handle('ai:session-rename', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.renameSession(req);
  }, true);
  handle('ai:session-delete', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.removeSession(req);
  }, true);
  /** 审批级别只改这条会话，不回写设置里的默认值。 */
  handle('ai:permission', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.setPermission(req);
  }, true);
  handle('ai:history', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.history(req.sessionId);
  }, true);
  /** 模型中途要读屏幕时主进程会发 screen-request，渲染端取到 buffer 文本后回到这里。 */
  handle('ai:screen-reply', (sender, req) => {
    ownSsh(sender, req && req.sessionId);
    return aiAssistant.screenReply(req);
  }, true);
  /** 测试连接与拉取模型清单共用同一份入参校验，凭据只在进程内使用。 */
  function aiProbe(req) {
    const baseUrl = typeof (req && req.baseUrl) === 'string' ? req.baseUrl.trim().replace(/\/+$/, '') : '';
    if (!/^https?:\/\//i.test(baseUrl)) throw Object.assign(new Error('Invalid base URL'), { code: 'AI_URL' });
    const apiKey = typeof (req && req.apiKey) === 'string' ? req.apiKey.slice(0, 400) : '';
    if (!apiKey) throw Object.assign(new Error('Missing API key'), { code: 'AI_NO_KEY' });
    const model = typeof (req && req.model) === 'string' ? req.model.slice(0, 120) : '';
    return { baseUrl, apiKey, model };
  }
  handle('ai:test', async (req) => {
    const probe = aiProbe(req);
    try {
      const r = await testConnection(probe);
      logger.info('ai', 'ai service test ok', { baseUrl: probe.baseUrl, via: r.via, ms: r.ms });
      return r;
    } catch (e) {
      logger.warn('ai', 'ai service test failed', { baseUrl: probe.baseUrl, code: e.code || 'AI_REQUEST', message: e.message });
      throw e;
    }
  });
  handle('ai:models', async (req) => {
    const probe = aiProbe(req);
    try {
      const r = await listModels(probe);
      logger.info('ai', 'ai model list fetched', { baseUrl: probe.baseUrl, ms: r.ms, models: r.models.length });
      return r;
    } catch (e) {
      logger.warn('ai', 'ai model list failed', { baseUrl: probe.baseUrl, code: e.code || 'AI_REQUEST', message: e.message });
      throw e;
    }
  });

  /**
   * Re-host an existing SSH session in the window that currently owns the tab, without
   * touching the connection. Only the registered host window may claim it.
   */
  handle('ssh:attach', (sender, req) => {
    const tabId = req && req.tabId;
    const sid = req && req.sessionId;
    if (typeof tabId !== 'string' || !tabId) throw new Error('tabId required');
    if (typeof sid !== 'string' || !/^ssh-[a-zA-Z0-9-]{1,100}$/.test(sid)) {
      throw Object.assign(new Error('Invalid SSH session ID'), { code: 'SSH_REQUEST' });
    }
    const host = sessionHostWindow(tabId);
    if (!host || host.isDestroyed() || BrowserWindow.fromWebContents(sender) !== host) {
      throw Object.assign(new Error('SSH session is not hosted by this window'), { code: 'SSH_OWNER' });
    }
    if (!sshSessions.sessions.has(sid)) {
      throw Object.assign(new Error('SSH session no longer exists'), { code: 'SSH_GONE' });
    }
    sshSessions.transferOwner(sid, sender.id);
    const cols = Number(req.cols), rows = Number(req.rows);
    sshSessions.resize(sid, cols, rows);
    const tail = sshSessions.tail(sid);
    logger.info('ssh', 'ssh session re-hosted', { sessionId: sid, tabId, detached: detachedWindows.has(tabId), tailChunks: tail.chunks.length });
    return { ok: true, sessionId: sid, ready: tail.ready, tail: tail.chunks };
  }, true);

  // ---- VNC terminal (noVNC via WebSocket proxy) ----
  handle('vnc:connect', async (req) => {
    const hit = store.findAsset(req.assetId);
    if (!hit) throw new Error('asset not found');
    const method = hit.asset.methods && hit.asset.methods[req.methodId];
    if (!method || !method.enabled) throw new Error('method not enabled');
    store.pushRecent(hit.asset, {
      id: 'vnc',
      proto: 'VNC',
      port: method.port || 5900,
    });
    send('store:changed', { reason: 'recent' });
    const result = await vncSessions.connect({
      assetId: hit.asset.id,
      asset: { host: hit.asset.host, user: hit.asset.user, pass: hit.asset.pass },
      method: { id: req.methodId, port: method.port || 5900, advanced: method.advanced },
      advanced: method.advanced,
    });
    return result;
  });
  handle('vnc:disconnect', (sid) => vncSessions.disconnect(sid));
  handle('vnc:list', () => vncSessions.list());

  // ---- RDP embedded sessions (IronRDP-WASM via RDCleanPath proxy) ----
  handle('rdp:connect', async (req) => {
    const hit = store.findAsset(req.assetId);
    if (!hit) throw new Error('asset not found');
    const method = hit.asset.methods && hit.asset.methods[req.methodId];
    if (!method || !method.enabled) throw new Error('method not enabled');
    store.pushRecent(hit.asset, {
      id: 'rdp',
      proto: 'RDP',
      port: method.port || 3389,
    });
    send('store:changed', { reason: 'recent' });
    const result = await rdpSessions.connect({
      assetId: hit.asset.id,
      asset: { host: hit.asset.host, user: hit.asset.user, pass: hit.asset.pass },
      method: { id: req.methodId, port: method.port || 3389, advanced: method.advanced },
      advanced: method.advanced,
    });
    return result;
  });
  handle('rdp:disconnect', (sid) => rdpSessions.disconnect(sid));
  handle('rdp:list', () => rdpSessions.list());

  // ---- Detached session windows ----
  const DETACHABLE_KINDS = ['ssh', 'vnc', 'rdp'];

  const loadSessionRoute = async (target, hash) => {
    // bust HTTP/file cache so a rebuild is always picked up, same as the SFTP window
    try {
      await target.webContents.session.clearCache();
    } catch (_) {}
    const cacheQs = `t=${Date.now()}`;
    if (isDev && process.env.VITE_DEV_SERVER_URL) {
      await target.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${cacheQs}#/${hash}`);
    } else {
      const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
      await target.loadURL('file://' + htmlPath.replace(/\\/g, '/') + '?' + cacheQs + '#' + hash);
    }
  };

  handle('session:detach', async (sender, req) => {
    if (BrowserWindow.fromWebContents(sender) !== win) {
      throw Object.assign(new Error('Untrusted detach request'), { code: 'SSH_OWNER' });
    }
    const tabId = req && req.tabId;
    const kind = String((req && req.kind) || '');
    if (typeof tabId !== 'string' || !tabId) throw new Error('tabId required');
    if (!DETACHABLE_KINDS.includes(kind)) {
      throw Object.assign(new Error('Session kind cannot be detached'), { code: 'DETACH_KIND' });
    }
    const existing = detachedWindows.get(tabId);
    if (existing && existing.window && !existing.window.isDestroyed()) {
      existing.window.focus();
      return { ok: true, reused: true };
    }
    const assetId = String(req.assetId || '');
    const host = String(req.host || '');
    const port = req.port === undefined || req.port === null ? '' : String(req.port);
    const title = String(req.title || host || assetId);
    const parts = [
      'kind=' + kind,
      'tabId=' + encodeURIComponent(tabId),
      'assetId=' + encodeURIComponent(assetId),
      'methodId=' + encodeURIComponent(String(req.methodId || kind)),
      'host=' + encodeURIComponent(host),
      'port=' + encodeURIComponent(port),
      'name=' + encodeURIComponent(title),
    ];
    if (kind === 'ssh' && req.liveSessionId) parts.push('sid=' + encodeURIComponent(String(req.liveSessionId)));

    // A drag-detach resolves the release point from the live OS cursor here: Chromium delivers no
    // usable coordinates once the pointer has left the window, but dragend still reaches the
    // renderer. A release over the tab bar row is a reorder/cancel gesture, never a detach.
    let dropAt = null;
    if (req && req.fromDrag) {
      const point = screen.getCursorScreenPoint();
      const bar = tabbarScreenRect();
      const overBar =
        bar &&
        point.x >= bar.x &&
        point.x <= bar.x + bar.width &&
        point.y >= bar.y &&
        point.y <= bar.y + bar.height;
      if (overBar) return { ok: true, cancelled: true };
      dropAt = point;
    }
    const DETACHED_W = 1000;
    const DETACHED_H = 660;
    const detachedOptions = {
      width: DETACHED_W,
      height: DETACHED_H,
      minWidth: 520,
      minHeight: 320,
      title,
      autoHideMenuBar: true,
      backgroundColor: '#0f1419',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    };
    if (dropAt) {
      // getDisplayMatching requires a full rect (x/y/width/height) in Electron 33.
      const area = screen.getDisplayMatching({ x: dropAt.x, y: dropAt.y, width: 1, height: 1 }).workArea;
      detachedOptions.x = Math.max(area.x, Math.min(dropAt.x - DETACHED_W / 2, area.x + area.width - DETACHED_W));
      detachedOptions.y = Math.max(area.y, Math.min(dropAt.y - DETACHED_H / 2, area.y + area.height - DETACHED_H));
    }
    const detached = new BrowserWindow(detachedOptions);
    const entry = { window: detached, kind };
    detachedWindows.set(tabId, entry);
    detached.on('page-title-updated', (e) => {
      e.preventDefault();
    });
    detached.on('closed', () => {
      const current = detachedWindows.get(tabId);
      // Only this window's own registration; a retry may already have installed a newer one.
      if (!current || current.window !== detached) return;
      detachedWindows.delete(tabId);
      clearDropHint();
      logger.info('session', 'detached window closed', { tabId, kind, reason: current.reason || 'window' });
      // Only dragging the window back onto the tab bar re-hosts it; any other close ends the session.
      if (current.reason === 'merge') send('session:detached', { tabId, detached: false });
      else send('session:closed', { tabId });
    });
    /**
     * Closing this window ends the session, so it asks first with the same prompt the tab bar
     * shows. Only that window knows whether it still holds a live connection, so the decision
     * comes back over IPC instead of being guessed here. Until its page has loaded there is
     * nothing to confirm, and the prompt must not make that window unclosable.
     */
    detached.on('close', (e) => {
      if (!entry.ready || entry.reason || entry.confirming || entry.dead) return;
      e.preventDefault();
      entry.confirming = true;
      detached.webContents.send('session:confirm-close', { tabId });
    });
    detached.webContents.on('render-process-gone', () => {
      // A dead renderer can never answer, so its window must stay closable.
      entry.dead = true;
    });
    /**
     * The native title bar moves the window, so the merge-back gesture is detected here: the tab
     * bar highlights while the cursor is over it and releasing there re-hosts the session, while
     * the frame's own close button ends the session.
     */
    detached.on('move', () => {
      const x = tabbarDropX();
      if (x === null) {
        clearDropHint();
        return;
      }
      dropHintActive = true;
      send('session:drop-hint', { tabId, active: true, x: Math.round(x) });
    });
    detached.on('moved', () => {
      if (!dropHintActive) return;
      clearDropHint();
      rehostToTabbar(tabId);
    });
    try {
      await loadSessionRoute(detached, 'session?' + parts.join('&'));
    } catch (e) {
      detachedWindows.delete(tabId);
      if (!detached.isDestroyed()) detached.destroy();
      logger.error('session', 'detach window load failed', { tabId, kind, message: e.message, code: e.code });
      throw e;
    }
    entry.ready = true;
    send('session:detached', { tabId, detached: true });
    logger.info('session', 'session detached into its own window', { tabId, kind, host, port });
    return { ok: true, reused: false };
  }, true);

  /**
   * Hand hosting back to the main window before the detached window tears down. SSH must be
   * re-owned synchronously here: that window's destroy would otherwise close its owner sessions
   * before the main window gets a chance to re-attach. The host only learns the session is back
   * from the window's closed event, so VNC/RDP reconnect starts once that renderer, and with it
   * the old proxy client, is gone.
   */
  function rehostToTabbar(tabId) {
    const entry = detachedWindows.get(tabId);
    if (!entry || entry.reason || entry.window.isDestroyed()) return;
    entry.reason = 'merge';
    const host = entry.window;
    const detachedId = host.webContents.id;
    const transferred = [];
    for (const sid of sshSessions.sessions.keys()) {
      if (sshSessions.owns(sid, detachedId) && sshSessions.transferOwner(sid, win.webContents.id)) transferred.push(sid);
    }
    // Tell that window to keep its session alive while it tears down.
    host.webContents.send('session:handover', { tabId });
    clearDropHint();
    host.close();
    logger.info('session', 'session reattached to tab bar', { tabId, kind: entry.kind, sessionIds: transferred });
  }

  const detachedSenderWindow = (sender) => {
    for (const [tabId, entry] of detachedWindows) {
      if (!entry.window.isDestroyed() && entry.window.webContents === sender) return { tabId, entry };
    }
    return null;
  };

  /**
   * The detached window's own answer to its close prompt. Confirming only closes the window: the
   * session goes with its host webContents, exactly like closing the tab in the main window.
   */
  handle('session:close-answer', (sender, req) => {
    const owner = detachedSenderWindow(sender);
    if (!owner) throw Object.assign(new Error('Not a detached window'), { code: 'SSH_OWNER' });
    const entry = owner.entry;
    if (!entry.confirming) return { ok: true, closed: false };
    entry.confirming = false;
    if (req && req.confirmed === true) {
      entry.reason = 'window';
      entry.window.close();
      logger.info('session', 'detached window closed after confirm', { tabId: owner.tabId, kind: entry.kind });
      return { ok: true, closed: true };
    }
    logger.info('session', 'detached window close cancelled', { tabId: owner.tabId, kind: entry.kind });
    return { ok: true, closed: false };
  }, true);

  /** Main window publishes its tab bar rect so a dragged detached window can hit-test it. */
  handle('session:tabbar-bounds', (sender, req) => {
    if (!win || win.isDestroyed() || win.webContents !== sender) {
      throw Object.assign(new Error('Untrusted tab bar bounds'), { code: 'SSH_OWNER' });
    }
    const width = Number(req && req.width);
    const height = Number(req && req.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      tabbarDropRect = null;
      return { ok: true };
    }
    // Page CSS px map 1:1 to screen px at zoom 1; the window offset is resolved on every hit test
    // so moving the main window mid-drag does not stale the target.
    tabbarDropRect = {
      x: Math.round(Number(req.x || 0)),
      y: Math.round(Number(req.y || 0)),
      width: Math.round(width),
      height: Math.round(height),
    };
    return { ok: true };
  }, true);

  // ---- SFTP panel window & transfers ----
  const loadSftpPanel = async (panel) => {
    const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
    const cacheQs = `t=${Date.now()}`;
    // bust HTTP/file cache so a rebuild is always picked up
    try {
      await panel.webContents.session.clearCache();
    } catch (_) {}
    if (isDev && process.env.VITE_DEV_SERVER_URL) {
      await panel.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${cacheQs}#/sftp`);
    } else {
      await panel.loadURL('file://' + htmlPath.replace(/\\/g, '/') + '?' + cacheQs + '#sftp');
    }
  };

  handle('sftp:open-window', async (sender, req) => {
    const assetId = req && req.assetId;
    if (!assetId) throw new Error('assetId required');
    const hit = store.findAsset(assetId);
    if (!hit) throw new Error('asset not found');
    const meta = sftpManager.sessionMeta(hit.asset);
    store.pushRecent(hit.asset, { id: 'sftp', proto: 'SFTP', port: meta.port });
    send('store:changed', { reason: 'recent' });
    // 目录探测与建窗/加载并行；探测本身出任何问题都不能挡住面板打开
    const initialPath = resolveSftpInitialPath(sender, req, assetId).catch(() => null);

    if (sftpPanel && !sftpPanel.isDestroyed()) {
      // 复用面板时绝不重载页面：现有会话可能正在传输，重载会全部断开
      sftpPanel.show();
      sftpPanel.focus();
      meta.initialPath = await initialPath;
      deliverSftpSession(meta);
      return { ok: true, reused: true };
    }

    sftpPanelReady = false;
    sftpPendingSessions.length = 0;
    const panel = new BrowserWindow({
      // 与主窗口默认尺寸（1280x800）保持一致，略小 20px 以便和主窗口错开
      width: 1260,
      height: 780,
      minWidth: 800,
      minHeight: 520,
      title: 'SFTP',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      backgroundColor: '#0f1419',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    sftpPanel = panel;
    panel.on('page-title-updated', (e) => {
      e.preventDefault();
    });
    panel.on('closed', () => {
      if (sftpPanel === panel) {
        sftpPanel = null;
        sftpPanelReady = false;
        sftpPendingSessions.length = 0;
        sftpCloseGuard.bypass = false;
        sftpCloseGuard.asking = false;
      }
    });
    /**
     * 关窗会断开面板里的全部 SFTP 会话，而连接状态只有面板自己知道，所以把决定发过去问。
     * 页面还没加载完、渲染进程已死或应用正在退出时必须放行，否则窗口会关不掉。
     */
    panel.on('close', (e) => {
      if (trayDestroying || sftpCloseGuard.bypass || sftpCloseGuard.asking || !sftpPanelReady) return;
      e.preventDefault();
      sftpCloseGuard.asking = true;
      panel.webContents.send('sftp:confirm-close');
    });
    panel.webContents.on('render-process-gone', () => {
      // 渲染进程已死：既不会再答复关闭询问，也不能被 open-window 当作可复用面板
      sftpCloseGuard.bypass = true;
      if (!panel.isDestroyed()) panel.destroy();
    });
    let loadError = null;
    const loading = loadSftpPanel(panel).catch((error) => {
      loadError = error;
    });
    meta.initialPath = await initialPath;
    deliverSftpSession(meta);
    await loading;
    if (loadError) {
      // 留着一个空白面板会让后续打开一直复用它，会话就此丢失
      logger.error('sftp', 'panel load failed', { code: loadError.code || 'LOAD', message: loadError.message });
      if (!panel.isDestroyed()) panel.destroy();
      throw loadError;
    }
    return { ok: true, reused: false };
  }, true);

  /** 面板订阅完 sftp:add-session 后报到，交出排队期间的会话，避免订阅前丢事件。 */
  handle('sftp:sessions-ready', (sender) => {
    if (!sftpPanel || sftpPanel.isDestroyed() || sftpPanel.webContents !== sender) {
      throw Object.assign(new Error('Untrusted SFTP panel sender'), { code: 'SSH_OWNER' });
    }
    sftpPanelReady = true;
    const sessions = sftpPendingSessions.splice(0, sftpPendingSessions.length);
    return { ok: true, sessions };
  }, true);

  /** 面板对关窗询问的答复：确认后解除拦截并真正关窗，面板内会话随 webContents 一起结束。 */
  handle('sftp:close-answer', (sender, req) => {
    if (!sftpPanel || sftpPanel.isDestroyed() || sftpPanel.webContents !== sender) {
      throw Object.assign(new Error('Untrusted SFTP panel sender'), { code: 'SSH_OWNER' });
    }
    if (!sftpCloseGuard.asking) return { ok: true, closed: false };
    sftpCloseGuard.asking = false;
    if (!(req && req.confirmed === true)) {
      logger.info('sftp', 'panel close cancelled');
      return { ok: true, closed: false };
    }
    sftpCloseGuard.bypass = true;
    sftpPanel.close();
    logger.info('sftp', 'panel closed after confirm');
    return { ok: true, closed: true };
  }, true);

  handle('sftp:open', (sender, req) => sftpManager.openSession({ assetId: req && req.assetId, ...sshRequestContext(sender) }), true);
  handle('sftp:list', (connId, remotePath) => sftpManager.list(connId, remotePath));
  handle('sftp:stat', (connId, remotePath) => sftpManager.stat(connId, remotePath));
  handle('sftp:local-exists', (p) => sftpManager.localExists(p));
  handle('sftp:local-list', (p) => sftpManager.localList(p));
  handle('sftp:drives', () => sftpManager.drives());
  handle('sftp:mkdir', (connId, remotePath) => sftpManager.mkdir(connId, remotePath));
  handle('sftp:mkdirp', (connId, remotePath) => sftpManager.mkdirp(connId, remotePath));
  handle('sftp:rename', (connId, oldPath, newPath) => sftpManager.rename(connId, oldPath, newPath));
  handle('sftp:unlink', (connId, remotePath, isDir) =>
    sftpManager.unlink(connId, remotePath, !!isDir)
  );
  handle('sftp:local-mkdir', (dirPath, name) => sftpManager.localMkdir(dirPath, name));
  handle('sftp:local-rename', (oldPath, newPath) => sftpManager.localRename(oldPath, newPath));
  handle('sftp:local-unlink', (p, isDir) => sftpManager.localUnlink(p, !!isDir));
  handle('sftp:local-copy', (src, destDir) => {
    if (!src || !destDir) throw new Error('copy path required');
    const name = path.basename(src);
    const dest = path.join(destDir, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
    }
    return { ok: true, path: dest };
  });
  handle('sftp:upload', async (req) => {
    const r = await sftpManager.upload(req);
    console.log('[sftp] upload start', req && req.localPath, '->', req && req.remotePath, r);
    return r;
  });
  handle('sftp:download', async (req) => {
    const r = await sftpManager.download(req);
    console.log('[sftp] download start', req && req.remotePath, '->', req && req.localPath, r);
    return r;
  });
  handle('sftp:pause', (taskId, pause) => sftpManager.pauseTask(taskId, !!pause));
  handle('sftp:cancel', async (taskId) => sftpManager.cancelTask(taskId));
  const sftpTaskIds = (ids) =>
    (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x.length > 0);
  handle('sftp:pause-batch', (ids, pause) => sftpManager.pauseTasks(sftpTaskIds(ids), !!pause));
  handle('sftp:cancel-batch', async (ids) => sftpManager.cancelTasks(sftpTaskIds(ids)));
  handle('sftp:tasks', (connId) => sftpManager.listTasks(connId));
  handle('sftp:close', (sender, connId) => {
    const rec = sftpManager.conns.get(connId);
    if (rec && rec.ownerId !== sender.id) throw Object.assign(new Error('SFTP session is not owned by this window'), { code: 'SSH_OWNER' });
    return sftpManager.closeSession(connId);
  }, true);
  handle('sftp:pick-local-files', async () => {
    const en = store.getSettings().lang === 'en';
    const r = await dialog.showOpenDialog(win || BrowserWindow.getFocusedWindow(), {
      properties: ['openFile', 'multiSelections'],
      title: en ? 'Select files to upload' : '选择要上传的文件',
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('sftp:clipboard-files', async (fullList) => {
    const out = [];
    const pushFile = (p) => {
      if (!p) return;
      const s = String(p).trim();
      if (!s || out.includes(s)) return;
      try {
        if (fs.existsSync(s)) out.push(s);
      } catch (_) {}
    };
    // macOS Finder and Linux file managers publish file URLs rather than the Windows HDROP formats
    if (process.platform === 'darwin') {
      try {
        const bm = clipboard.readBookmark();
        if (bm && bm.data) pushFile(fileURLToPath(bm.data));
      } catch (_) {}
      if (!out.length) {
        try {
          const txt = clipboard.readText();
          if (txt && txt.trim().indexOf('file://') === 0) pushFile(fileURLToPath(txt.trim()));
        } catch (_) {}
      }
    } else if (process.platform === 'linux') {
      try {
        const uri = clipboard.readText('text/uri-list') || clipboard.readText();
        String(uri || '').split(/\r?\n/).forEach((line) => {
          const s = line.trim();
          if (s.indexOf('file://') === 0) {
            try {
              pushFile(fileURLToPath(s));
            } catch (_) {}
          } else if (s.charAt(0) === '/') pushFile(s);
        });
      } catch (_) {}
    }
    if (process.platform === 'win32') {
      // Only the real paste pays for the shell round trip; the menu just needs a yes/no.
      if (fullList) (await readWinClipboardFiles()).forEach(pushFile);
      if (!out.length) {
        try {
          const w = clipboard.readBuffer('FileNameW');
          if (w && w.length >= 2) pushFile(w.toString('ucs2').replace(/\0.*$/, '').trim());
        } catch (_) {}
      }
      if (!out.length) {
        try {
          const a = clipboard.readBuffer('FileName');
          if (a && a.length >= 1) pushFile(a.toString('utf8').replace(/\0.*$/, '').trim());
        } catch (_) {}
      }
    }
    return out;
  });
  handle('sftp:pick-local-dir', async () => {
    const en = store.getSettings().lang === 'en';
    const r = await dialog.showOpenDialog(win || BrowserWindow.getFocusedWindow(), {
      properties: ['openDirectory', 'createDirectory'],
      title: en ? 'Select save folder' : '选择保存目录',
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('sftp:local-home', () => os.homedir());

  // Native OS drag-out: download remote → temp, then startDrag (Explorer / local folders)
  ipcMain.on('sftp:start-drag', async (event, req) => {
    try {
      if (!req || !req.connId || !req.remotePath) return;
      send('sftp:state', { type: 'drag-preparing', message: req.name || req.remotePath });
      const prepared = await sftpManager.prepareDragOut({
        connId: req.connId,
        remotePath: req.remotePath,
        isDir: !!req.isDir,
        name: req.name,
      });
      const iconPath = path.join(__dirname, 'assets', 'icon.png');
      let icon;
      try {
        icon = require('electron').nativeImage.createFromPath(iconPath);
      } catch (_) {
        icon = null;
      }
      if (event.sender.isDestroyed()) return;
      event.sender.startDrag({
        file: prepared.localPath,
        icon: icon && !icon.isEmpty() ? icon : undefined,
      });
      send('sftp:drag-ready', prepared);
    } catch (e) {
      console.error('[sftp] start-drag failed', e);
      send('sftp:state', { type: 'drag-error', message: e.message || String(e) });
    }
  });
}

app.whenReady().then(() => {
  logStore = new LogStore({
    dir: path.join(app.getPath('userData'), 'logs'),
    onNew: (entry) => send('log:new', entry),
  });
  store = new AssetStore();
  sessions = new SessionManager({ store, send, log: logger });
  sshSessions = new SshSessionManager({
    log: logger,
    // Owner-targeted events fire while that window is already being torn down: closeSshOwner runs
    // from its own destroyed event, so the session's end state has no renderer left to receive it.
    send: sendToOwner,
    onEnded: (sessionId) => {
      if (aiAssistant) aiAssistant.stopSession(sessionId, 'session-ended');
    },
  });
  sshMonitor = new SshMonitorManager({ ssh: sshSessions, send: sendToOwner, log: logger });
  aiAssistant = new AiManager({
    ssh: sshSessions,
    store,
    sessions: new AiSessionStore({ store, log: logger }),
    send: sendToOwner,
    log: logger,
  });
  vncSessions = new VncSessionManager({ send, log: logger });
  rdpSessions = new RdpSessionManager({ send, log: logger });
  sftpManager = new SftpManager({ send, store, log: logger });
  registerIpc();
  app.on('browser-window-created', () => applyZoom());
  createWindow();
  createTray();

  // Reset auth cache on screen lock / suspend (Chrome-style: re-verify after lock)
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      const { powerMonitor } = require('electron');
      powerMonitor.on('lock-screen', resetAuthCache);
      powerMonitor.on('suspend', resetAuthCache);
    } catch (_) {}
  }

  app.on('activate', () => {
    if (!win || win.isDestroyed()) {
      createWindow();
      createTray();
    } else {
      showMainWindow();
    }
  });
});

app.on('before-quit', (e) => {
  // before-quit fires for both tray-initiated quit AND programmatic quit.
  // Clean up sessions always. Tray cleanup must happen so macOS doesn't leak it.
  resetAuthCache();
  if (vncSessions) vncSessions.destroyAll();
  if (rdpSessions) rdpSessions.destroyAll();
  if (sshSessions) sshSessions.destroyAll();
  if (sshMonitor) sshMonitor.destroyAll();
  if (aiAssistant) aiAssistant.destroyAll();
  if (sftpManager) sftpManager.destroyAll();
  for (const tests of sshTests.values()) for (const connection of tests) connection.close();
  sshTests.clear();
  sshPrompts.destroyAll();
  destroyTray();
});

app.on('window-all-closed', () => {
  if (trayDestroying) {
    // tray-initiated quit → definitely quit
    if (process.platform !== 'darwin') app.quit();
    return;
  }
  const useTray = !!tray;
  if (!useTray || process.platform === 'darwin') {
    if (process.platform !== 'darwin') app.quit();
  }
  // else: minimized to tray, keep running
});
