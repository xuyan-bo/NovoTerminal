const { contextBridge, ipcRenderer, webUtils } = require('electron');

const api = {
  /** Electron 32+: File.path may be empty; use webUtils.getPathForFile */
  getPathForFile: (file) => {
    try {
      if (file && webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file) || '';
      }
    } catch (_) {}
    try {
      return (file && file.path) || '';
    } catch (_) {
      return '';
    }
  },
  getSnapshot: () => ipcRenderer.invoke('store:snapshot'),
  createGroup: (payload) => ipcRenderer.invoke('store:create-group', payload),
  updateGroup: (gid, payload) => ipcRenderer.invoke('store:update-group', gid, payload),
  reorderGroups: (payload) => ipcRenderer.invoke('store:reorder-groups', payload),
  reorderAsset: (payload) => ipcRenderer.invoke('store:reorder-asset', payload),
  deleteGroup: (gid) => ipcRenderer.invoke('store:delete-group', gid),
  createAsset: (gid, payload) => ipcRenderer.invoke('store:create-asset', gid, payload),
  updateAsset: (aid, payload) => ipcRenderer.invoke('store:update-asset', aid, payload),
  deleteAsset: (aid) => ipcRenderer.invoke('store:delete-asset', aid),
  cloneAsset: (aid) => ipcRenderer.invoke('store:clone-asset', aid),
  getSettings: () => ipcRenderer.invoke('store:settings'),
  updateSettings: (patch) => ipcRenderer.invoke('store:update-settings', patch),
  resolveClose: (action, remember) => ipcRenderer.invoke('app:resolve-close', { action, remember }),
  onClosePrompt: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:close-prompt', handler);
    return () => ipcRenderer.removeListener('app:close-prompt', handler);
  },
  exportGroups: () => ipcRenderer.invoke('store:export'),
  importGroups: (json) => ipcRenderer.invoke('store:import', json),
  verifySystemAuth: (reason) => ipcRenderer.invoke('app:verify-system-auth', reason),
  browseDataPath: () => ipcRenderer.invoke('app:browse-data-path'),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:write-text', text),

  // Logs
  logList: (filter) => ipcRenderer.invoke('log:list', filter),
  logClear: () => ipcRenderer.invoke('log:clear'),
  logWrite: (payload) => ipcRenderer.invoke('log:write', payload),
  onLog: (cb) => {
    const handler = (_e, entry) => cb(entry);
    ipcRenderer.on('log:new', handler);
    return () => ipcRenderer.removeListener('log:new', handler);
  },

  sessionTest: (req) => ipcRenderer.invoke('session:test', req),
  sessionConnect: (req) => ipcRenderer.invoke('session:connect', req),
  sessionDisconnect: (sessionId) => ipcRenderer.invoke('session:disconnect', sessionId),
  sessionList: () => ipcRenderer.invoke('session:list'),

  // SSH terminal sessions (xterm)
  sshConnect: (req) => ipcRenderer.invoke('ssh:connect', req),
  sshWrite: (sessionId, data) => ipcRenderer.invoke('ssh:write', sessionId, data),
  sshResize: (sessionId, cols, rows) => ipcRenderer.invoke('ssh:resize', sessionId, cols, rows),
  sshDisconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
  sshList: () => ipcRenderer.invoke('ssh:list'),
  onSshData: (sessionId, cb) => {
    const ch = 'ssh:data:' + sessionId;
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  },
  onSshState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:state', handler);
    return () => ipcRenderer.removeListener('ssh:state', handler);
  },

  // VNC sessions (noVNC via WebSocket proxy)
  vncConnect: (req) => ipcRenderer.invoke('vnc:connect', req),
  vncDisconnect: (sessionId) => ipcRenderer.invoke('vnc:disconnect', sessionId),
  vncList: () => ipcRenderer.invoke('vnc:list'),
  onVncState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('vnc:state', handler);
    return () => ipcRenderer.removeListener('vnc:state', handler);
  },

  // SFTP
  sftpOpenWindow: (req) => ipcRenderer.invoke('sftp:open-window', req),
  sftpOpen: (req) => ipcRenderer.invoke('sftp:open', req),
  sftpList: (connId, remotePath) => ipcRenderer.invoke('sftp:list', connId, remotePath),
  sftpStat: (connId, remotePath) => ipcRenderer.invoke('sftp:stat', connId, remotePath),
  sftpLocalExists: (p) => ipcRenderer.invoke('sftp:local-exists', p),
  sftpLocalList: (p) => ipcRenderer.invoke('sftp:local-list', p),
  sftpMkdir: (connId, remotePath) => ipcRenderer.invoke('sftp:mkdir', connId, remotePath),
  sftpMkdirp: (connId, remotePath) => ipcRenderer.invoke('sftp:mkdirp', connId, remotePath),
  sftpRename: (connId, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', connId, oldPath, newPath),
  sftpUnlink: (connId, remotePath, isDir) => ipcRenderer.invoke('sftp:unlink', connId, remotePath, isDir),
  sftpLocalMkdir: (dirPath, name) => ipcRenderer.invoke('sftp:local-mkdir', dirPath, name),
  sftpLocalRename: (oldPath, newPath) => ipcRenderer.invoke('sftp:local-rename', oldPath, newPath),
  sftpLocalUnlink: (p, isDir) => ipcRenderer.invoke('sftp:local-unlink', p, isDir),
  sftpWalkLocal: (localDir, remoteDir) => ipcRenderer.invoke('sftp:walk-local', localDir, remoteDir),
  sftpUpload: (req) => ipcRenderer.invoke('sftp:upload', req),
  sftpDownload: (req) => ipcRenderer.invoke('sftp:download', req),
  sftpPause: (taskId, pause) => ipcRenderer.invoke('sftp:pause', taskId, pause),
  sftpCancel: (taskId) => ipcRenderer.invoke('sftp:cancel', taskId),
  sftpTasks: () => ipcRenderer.invoke('sftp:tasks'),
  sftpClose: (connId) => ipcRenderer.invoke('sftp:close', connId),
  sftpPickLocalFiles: () => ipcRenderer.invoke('sftp:pick-local-files'),
  sftpPickLocalDir: () => ipcRenderer.invoke('sftp:pick-local-dir'),
  sftpLocalHome: () => ipcRenderer.invoke('sftp:local-home'),
  sftpClipboardFiles: () => ipcRenderer.invoke('sftp:clipboard-files'),
  sftpLocalCopy: (src, destDir) => ipcRenderer.invoke('sftp:local-copy', src, destDir),
  /** Native drag out to Explorer: main downloads remote → temp then startDrag */
  sftpStartDrag: (payload) => ipcRenderer.send('sftp:start-drag', payload),
  onSftpDragReady: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sftp:drag-ready', handler);
    return () => ipcRenderer.removeListener('sftp:drag-ready', handler);
  },
  onSftpProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sftp:progress', handler);
    return () => ipcRenderer.removeListener('sftp:progress', handler);
  },

  onSessionState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:state', handler);
    return () => ipcRenderer.removeListener('session:state', handler);
  },
  onStoreChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('store:changed', handler);
    return () => ipcRenderer.removeListener('store:changed', handler);
  },

  platform: process.platform,
};

contextBridge.exposeInMainWorld('omniDesk', api);
