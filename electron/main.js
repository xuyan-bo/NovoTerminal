const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
/** Bump when shipping renderer changes — shown in every window title */
const APP_BUILD = 'rd2-1647';
const { AssetStore } = require('./store/assetStore');
const { SessionManager } = require('./session/SessionManager');
const { SshSessionManager } = require('./ssh/SshSessionManager');
const { SftpManager } = require('./sftp/SftpManager');

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
let sshSessions = null;
let sftpManager = null;
const sftpWindows = new Map(); // assetId -> BrowserWindow

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function send(channel, payload) {
  // Broadcast to all windows so SFTP child windows receive progress events
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  });
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
    if (level >= 2) console.error('[renderer]', message);
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
      return '';
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

  // ---- SSH terminal ----
  handle('ssh:connect', async (req) => {
    const hit = store.findAsset(req.assetId);
    if (!hit) throw new Error('asset not found');
    const method = hit.asset.methods && hit.asset.methods[req.methodId];
    if (!method || !method.enabled) throw new Error('method not enabled');
    const result = await sshSessions.connect({
      assetId: hit.asset.id,
      asset: { host: hit.asset.host, user: hit.asset.user, pass: hit.asset.pass },
      method: { id: req.methodId, port: method.port || 22, advanced: method.advanced },
      advanced: method.advanced,
      cols: req.cols,
      rows: req.rows,
    });
    store.pushRecent(hit.asset, {
      id: 'ssh',
      proto: 'SSH',
      port: method.port || 22,
    });
    send('store:changed', { reason: 'recent' });
    return result;
  });
  handle('ssh:write', (sessionId, data) => sshSessions.write(sessionId, data));
  handle('ssh:resize', (sessionId, cols, rows) => sshSessions.resize(sessionId, cols, rows));
  handle('ssh:disconnect', (sid) => sshSessions.disconnect(sid));
  handle('ssh:list', () => sshSessions.list());

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
  store = new AssetStore();
  sessions = new SessionManager({ store, send });
  sshSessions = new SshSessionManager({ send });
  sftpManager = new SftpManager({ send, store });
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
