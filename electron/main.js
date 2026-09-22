const { app, BrowserWindow, ipcMain, dialog, clipboard, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
/** Bump when shipping renderer changes — shown in every window title */
const APP_BUILD = 'rd2-1647';
const { AssetStore } = require('./store/assetStore');
const { SessionManager } = require('./session/SessionManager');
const { SshSessionManager } = require('./ssh/SshSessionManager');
const { VncSessionManager } = require('./vnc/VncSessionManager');
const { RdpSessionManager } = require('./rdp/RdpSessionManager');
const { SftpManager } = require('./sftp/SftpManager');
const { LogStore } = require('./logs/logStore');
const { verifySystemAuth, resetAuthCache } = require('./auth/systemAuth');

/** Advanced defaults mirrored from renderer constants — used when method.advanced is missing */
const ADVANCED_DEFAULTS = {
  rdp: {
    resolution: 'auto',
    screenMode: 'window',
    monitors: 'single',
    promptCredentials: false,
    adminSession: false,
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
    compressLevel: 6,
    jpegQuality: 6,
    shared: true,
    viewOnly: false,
    scale: 'fit',
    clipboard: true,
    localCursor: true,
  },
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
const sftpWindows = new Map(); // assetId -> BrowserWindow

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
  // Broadcast to all windows so SFTP child windows receive progress events
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  });
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
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出 OmniDesk', click: () => { trayDestroying = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function destroyTray() {
  if (tray) {
    try { tray.destroy(); } catch (_) {}
    tray = null;
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

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
    win.loadURL('file://' + htmlPath.replace(/\\/g, '/') + '?t=' + Date.now());
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
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
  handle('store:clone-asset', (aid) => unwrap(store.cloneAsset(aid)));
  handle('store:settings', () => store.getSettings());
  handle('store:update-settings', (patch) => unwrap(store.updateSettings(patch)));
  /** Get the current main window HWND so the native auth dialog can be parented to it */
  function mainWindowHwnd() {
    try {
      const bw = BrowserWindow.getFocusedWindow() || win;
      if (!bw || bw.isDestroyed()) return 0;
      const buf = bw.getNativeWindowHandle();
      return buf ? buf.readUInt32LE(0) : 0;
    } catch (_) {
      return 0;
    }
  }

  handle('app:verify-system-auth', async (reason) => verifySystemAuth(reason, mainWindowHwnd()));

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
    // sensitive: require OS identity verification like Chrome password export
    const auth = await verifySystemAuth('导出 OmniDesk 配置（包含敏感信息）', mainWindowHwnd());
    if (!auth.ok) {
      const e = new Error(auth.message || '系统身份验证失败');
      e.code = auth.code || 'AUTH_FAILED';
      throw e;
    }
    return store.exportJson();
  });
  handle('store:import', async (text) => {
    // sensitive: require OS identity verification like export (overwrites data)
    const auth = await verifySystemAuth('导入 OmniDesk 配置（将覆盖当前数据）', mainWindowHwnd());
    if (!auth.ok) {
      const e = new Error(auth.message || '系统身份验证失败');
      e.code = auth.code || 'AUTH_FAILED';
      throw e;
    }
    return unwrap(store.importGroups(text));
  });
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

  // ---- Logs ----
  handle('log:list', (filter) => logStore.list(filter || {}));
  handle('log:clear', () => logStore.clear());
  handle('log:write', (p) => {
    const level =
      p && p.level && ['error', 'warn', 'info'].includes(p.level) ? p.level : 'info';
    return logStore.log(level, (p && p.source) || 'renderer', (p && p.message) || '', p && p.meta);
  });

  handle('session:test', (req) => sessions.testConnection(req));
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

  // ---- SSH terminal ----
  handle('ssh:connect', async (req) => {
    const hit = store.findAsset(req.assetId);
    if (!hit) throw new Error('asset not found');
    const method = hit.asset.methods && hit.asset.methods[req.methodId];
    if (!method || !method.enabled) throw new Error('method not enabled');
    store.pushRecent(hit.asset, {
      id: 'ssh',
      proto: 'SSH',
      port: method.port || 22,
    });
    send('store:changed', { reason: 'recent' });
    const result = await sshSessions.connect({
      assetId: hit.asset.id,
      asset: { host: hit.asset.host, user: hit.asset.user, pass: hit.asset.pass },
      method: { id: req.methodId, port: method.port || 22, advanced: method.advanced },
      advanced: method.advanced,
      cols: req.cols,
      rows: req.rows,
    });
    return result;
  });
  handle('ssh:write', (sessionId, data) => sshSessions.write(sessionId, data));
  handle('ssh:resize', (sessionId, cols, rows) => sshSessions.resize(sessionId, cols, rows));
  handle('ssh:disconnect', (sid) => sshSessions.disconnect(sid));
  handle('ssh:list', () => sshSessions.list());

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

  // ---- SFTP window & transfers ----
  handle('sftp:open-window', async (req) => {
    const assetId = req && req.assetId;
    if (!assetId) throw new Error('assetId required');
    const hit = store.findAsset(assetId);
    if (!hit) throw new Error('asset not found');
    const host = hit.asset.host || '';
    const port =
      (hit.asset.methods && hit.asset.methods.ssh && hit.asset.methods.ssh.port) || 22;

    const existing = sftpWindows.get(assetId);
    const hash = `sftp?assetId=${encodeURIComponent(assetId)}&host=${encodeURIComponent(host)}&port=${port}&name=${encodeURIComponent(hit.asset.name || '')}`;
    const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
    const cacheQs = `t=${Date.now()}`;

    const loadSftp = async (winRef) => {
      // bust HTTP/file cache so a rebuild is always picked up
      try {
        await winRef.webContents.session.clearCache();
      } catch (_) {}
      if (isDev && process.env.VITE_DEV_SERVER_URL) {
        await winRef.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${cacheQs}#/${hash}`);
      } else {
        await winRef.loadURL(
          'file://' + htmlPath.replace(/\\/g, '/') + '?' + cacheQs + '#' + hash
        );
      }
    };

    if (existing && !existing.isDestroyed()) {
      await loadSftp(existing);
      existing.focus();
      existing.setTitle(`${hit.asset.name || host} · SFTP · ${host}:${port}`);
      return { ok: true, reused: true };
    }

    const sftpWin = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 800,
      minHeight: 520,
      title: `${hit.asset.name || host} · SFTP · ${host}:${port}`,
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
    await loadSftp(sftpWin);
    sftpWindows.set(assetId, sftpWin);
    sftpWin.on('page-title-updated', (e) => {
      e.preventDefault();
    });
    sftpWin.setTitle(`${hit.asset.name || host} · SFTP · ${host}:${port}`);
    sftpWin.on('closed', () => {
      sftpWindows.delete(assetId);
    });
    return { ok: true, reused: false };
  });

  handle('sftp:open', (req) => sftpManager.openSession(req));
  handle('sftp:list', (connId, remotePath) => sftpManager.list(connId, remotePath));
  handle('sftp:stat', (connId, remotePath) => sftpManager.stat(connId, remotePath));
  handle('sftp:local-exists', (p) => sftpManager.localExists(p));
  handle('sftp:local-list', (p) => sftpManager.localList(p));
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
  handle('sftp:walk-local', (localDir, remoteDir) => sftpManager.walkLocal(localDir, remoteDir));
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
  handle('sftp:tasks', () => sftpManager.listTasks());
  handle('sftp:close', (connId) => sftpManager.closeSession(connId));
  handle('sftp:pick-local-files', async () => {
    const r = await dialog.showOpenDialog(win || BrowserWindow.getFocusedWindow(), {
      properties: ['openFile', 'multiSelections'],
      title: '选择要上传的文件',
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('sftp:clipboard-files', () => {
    const out = [];
    try {
      const w = clipboard.readBuffer('FileNameW');
      if (w && w.length >= 2) {
        const p = w.toString('ucs2').replace(/\0.*$/, '').trim();
        if (p && fs.existsSync(p)) out.push(p);
      }
    } catch (_) {}
    if (!out.length) {
      try {
        const a = clipboard.readBuffer('FileName');
        if (a && a.length >= 1) {
          const p = a.toString('utf8').replace(/\0.*$/, '').trim();
          if (p && fs.existsSync(p)) out.push(p);
        }
      } catch (_) {}
    }
    if (!out.length) {
      try {
        const buf = clipboard.readBuffer('CF_HDROP');
        if (buf && buf.length > 20) {
          const pFiles = buf.readUInt32LE(0);
          const fWide = buf.readUInt32LE(16);
          let offset = pFiles;
          if (fWide) {
            while (offset + 2 <= buf.length) {
              let end = offset;
              while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
              const s = buf.toString('ucs2', offset, end);
              offset = end + 2;
              if (!s) break;
              if (fs.existsSync(s)) out.push(s);
            }
          } else {
            while (offset < buf.length) {
              let end = offset;
              while (end < buf.length && buf[end] !== 0) end += 1;
              const s = buf.toString('utf8', offset, end);
              offset = end + 1;
              if (!s) break;
              if (fs.existsSync(s)) out.push(s);
            }
          }
        }
      } catch (_) {}
    }
    return out;
  });
  handle('sftp:pick-local-dir', async () => {
    const r = await dialog.showOpenDialog(win || BrowserWindow.getFocusedWindow(), {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择保存目录',
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
  sshSessions = new SshSessionManager({ send, log: logger });
  vncSessions = new VncSessionManager({ send, log: logger });
  rdpSessions = new RdpSessionManager({ send, log: logger });
  sftpManager = new SftpManager({ send, store, log: logger });
  registerIpc();
  createWindow();
  createTray();

  // Reset auth cache on screen lock / suspend (Chrome-style: re-verify after lock)
  if (process.platform === 'win32') {
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
  if (vncSessions) vncSessions.destroyAll();
  if (rdpSessions) rdpSessions.destroyAll();
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
