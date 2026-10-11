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
  removeRecent: (payload) => ipcRenderer.invoke('store:remove-recent', payload),
  getSettings: () => ipcRenderer.invoke('store:settings'),
  updateSettings: (patch) => ipcRenderer.invoke('store:update-settings', patch),
  resolveClose: (action, remember) => ipcRenderer.invoke('app:resolve-close', { action, remember }),
  onClosePrompt: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:close-prompt', handler);
    return () => ipcRenderer.removeListener('app:close-prompt', handler);
  },
  backupExport: (req) => ipcRenderer.invoke('backup:export', req),
  backupImport: (req) => ipcRenderer.invoke('backup:import', req),
  verifySystemAuth: (reason) => ipcRenderer.invoke('app:verify-system-auth', reason),
  browseDataPath: () => ipcRenderer.invoke('app:browse-data-path'),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  checkUpdate: () => ipcRenderer.invoke('update:check'),

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
  rdpProbeClient: (clientId) => ipcRenderer.invoke('rdp:probe-client', clientId),
  rdpPickClientBinary: (clientId) => ipcRenderer.invoke('rdp:pick-client-binary', clientId),

  // SSH terminal sessions (xterm)
  sshConnect: (req) => ipcRenderer.invoke('ssh:connect', req),
  sshWrite: (sessionId, data) => ipcRenderer.invoke('ssh:write', sessionId, data),
  sshWriteBinary: (sessionId, data) => ipcRenderer.invoke('ssh:write-binary', sessionId, data),
  sshAuthReply: (requestId, answers) => ipcRenderer.invoke('ssh:auth-reply', requestId, answers),
  onSshAuthPrompt: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('ssh:auth-prompt', handler);
    return () => ipcRenderer.removeListener('ssh:auth-prompt', handler);
  },
  onSshAuthCancel: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('ssh:auth-cancel', handler);
    return () => ipcRenderer.removeListener('ssh:auth-cancel', handler);
  },
  sshResize: (sessionId, cols, rows) => ipcRenderer.invoke('ssh:resize', sessionId, cols, rows),
  sshDisconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
  sshList: () => ipcRenderer.invoke('ssh:list'),
  sshAttach: (req) => ipcRenderer.invoke('ssh:attach', req),
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

  // SSH server monitor (per-session stats pushed to the owning window)
  monitorStart: (sessionId, intervalSec) => ipcRenderer.invoke('monitor:start', sessionId, intervalSec),
  monitorStop: (sessionId) => ipcRenderer.invoke('monitor:stop', sessionId),
  monitorUiGet: (tabId) => ipcRenderer.invoke('monitor:ui-get', tabId),
  monitorUiSet: (tabId, ui) => ipcRenderer.invoke('monitor:ui-set', tabId, ui),
  monitorUiDrop: (tabId) => ipcRenderer.invoke('monitor:ui-drop', tabId),
  onMonitorSnapshot: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('monitor:snapshot', handler);
    return () => ipcRenderer.removeListener('monitor:snapshot', handler);
  },
  onMonitorEnd: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('monitor:end', handler);
    return () => ipcRenderer.removeListener('monitor:end', handler);
  },

  // AI assistant (always bound to one SSH terminal session)
  aiSend: (req) => ipcRenderer.invoke('ai:send', req),
  aiApprove: (req) => ipcRenderer.invoke('ai:approve', req),
  aiCancel: (req) => ipcRenderer.invoke('ai:cancel', req),
  aiArchiveSession: (req) => ipcRenderer.invoke('ai:session-archive', req),
  aiSessionList: (req) => ipcRenderer.invoke('ai:sessions', req),
  aiSessionOpen: (req) => ipcRenderer.invoke('ai:session-open', req),
  aiSessionRename: (req) => ipcRenderer.invoke('ai:session-rename', req),
  aiSessionDelete: (req) => ipcRenderer.invoke('ai:session-delete', req),
  aiSetPermission: (req) => ipcRenderer.invoke('ai:permission', req),
  aiHistory: (req) => ipcRenderer.invoke('ai:history', req),
  aiScreenReply: (req) => ipcRenderer.invoke('ai:screen-reply', req),
  aiTest: (req) => ipcRenderer.invoke('ai:test', req),
  aiModels: (req) => ipcRenderer.invoke('ai:models', req),
  onAiEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ai:event', handler);
    return () => ipcRenderer.removeListener('ai:event', handler);
  },

  // VNC sessions (noVNC via WebSocket proxy)
  vncConnect: (req) => ipcRenderer.invoke('vnc:connect', req),
  vncDisconnect: (sessionId) => ipcRenderer.invoke('vnc:disconnect', sessionId),
  onVncState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('vnc:state', handler);
    return () => ipcRenderer.removeListener('vnc:state', handler);
  },

  // RDP embedded sessions (IronRDP-WASM via RDCleanPath WebSocket proxy)
  rdpConnect: (req) => ipcRenderer.invoke('rdp:connect', req),
  rdpDisconnect: (sessionId) => ipcRenderer.invoke('rdp:disconnect', sessionId),
  onRdpState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('rdp:state', handler);
    return () => ipcRenderer.removeListener('rdp:state', handler);
  },

  // SFTP
  sftpOpenWindow: (req) => ipcRenderer.invoke('sftp:open-window', req),
  sftpOpen: (req) => ipcRenderer.invoke('sftp:open', req),
  sftpList: (connId, remotePath) => ipcRenderer.invoke('sftp:list', connId, remotePath),
  sftpStat: (connId, remotePath) => ipcRenderer.invoke('sftp:stat', connId, remotePath),
  sftpLocalExists: (p) => ipcRenderer.invoke('sftp:local-exists', p),
  sftpLocalList: (p) => ipcRenderer.invoke('sftp:local-list', p),
  sftpDrives: () => ipcRenderer.invoke('sftp:drives'),
  sftpMkdir: (connId, remotePath) => ipcRenderer.invoke('sftp:mkdir', connId, remotePath),
  sftpMkdirp: (connId, remotePath) => ipcRenderer.invoke('sftp:mkdirp', connId, remotePath),
  sftpRename: (connId, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', connId, oldPath, newPath),
  sftpUnlink: (connId, remotePath, isDir) => ipcRenderer.invoke('sftp:unlink', connId, remotePath, isDir),
  sftpLocalMkdir: (dirPath, name) => ipcRenderer.invoke('sftp:local-mkdir', dirPath, name),
  sftpLocalRename: (oldPath, newPath) => ipcRenderer.invoke('sftp:local-rename', oldPath, newPath),
  sftpLocalUnlink: (p, isDir) => ipcRenderer.invoke('sftp:local-unlink', p, isDir),
  sftpUpload: (req) => ipcRenderer.invoke('sftp:upload', req),
  sftpDownload: (req) => ipcRenderer.invoke('sftp:download', req),
  sftpPause: (taskId, pause) => ipcRenderer.invoke('sftp:pause', taskId, pause),
  sftpCancel: (taskId) => ipcRenderer.invoke('sftp:cancel', taskId),
  sftpPauseBatch: (ids, pause) => ipcRenderer.invoke('sftp:pause-batch', ids, pause),
  sftpCancelBatch: (ids) => ipcRenderer.invoke('sftp:cancel-batch', ids),
  sftpTasks: (connId) => ipcRenderer.invoke('sftp:tasks', connId),
  sftpSessionsReady: () => ipcRenderer.invoke('sftp:sessions-ready'),
  sftpClose: (connId) => ipcRenderer.invoke('sftp:close', connId),
  sftpCloseAnswer: (req) => ipcRenderer.invoke('sftp:close-answer', req),
  onSftpConfirmClose: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sftp:confirm-close', handler);
    return () => ipcRenderer.removeListener('sftp:confirm-close', handler);
  },
  sftpPickLocalDir: () => ipcRenderer.invoke('sftp:pick-local-dir'),
  sftpClipboardFiles: (fullList) => ipcRenderer.invoke('sftp:clipboard-files', !!fullList),
  sftpLocalCopy: (src, destDir) => ipcRenderer.invoke('sftp:local-copy', src, destDir),
  /** 会话级状态（当前只有连接被断开）：面板据此把页签标记为已断开 */
  onSftpState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sftp:state', handler);
    return () => ipcRenderer.removeListener('sftp:state', handler);
  },
  onSftpAddSession: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sftp:add-session', handler);
    return () => ipcRenderer.removeListener('sftp:add-session', handler);
  },
  onSftpProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sftp:progress', handler);
    return () => ipcRenderer.removeListener('sftp:progress', handler);
  },

  // Detached session windows
  sessionDetach: (req) => ipcRenderer.invoke('session:detach', req),
  sessionCloseAnswer: (req) => ipcRenderer.invoke('session:close-answer', req),
  sessionTabbarBounds: (req) => ipcRenderer.invoke('session:tabbar-bounds', req),
  sessionDockPrepare: (req) => ipcRenderer.invoke('session:dock-prepare', req),
  sessionDockAbort: (req) => ipcRenderer.invoke('session:dock-abort', req),
  sessionTabMove: (req) => ipcRenderer.invoke('session:tab-move', req),
  sessionGroupTabs: (req) => ipcRenderer.invoke('session:group-tabs', req),
  sessionGroupOrder: (req) => ipcRenderer.invoke('session:group-order', req),
  sessionTabState: (req) => ipcRenderer.invoke('session:tab-state', req),
  sessionTabCopy: (req) => ipcRenderer.invoke('session:tab-copy', req),
  sessionTabClose: (req) => ipcRenderer.invoke('session:tab-close', req),
  sessionTabActive: (req) => ipcRenderer.invoke('session:tab-active', req),
  onSessionConfirmClose: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:confirm-close', handler);
    return () => ipcRenderer.removeListener('session:confirm-close', handler);
  },
  onSessionDetached: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:detached', handler);
    return () => ipcRenderer.removeListener('session:detached', handler);
  },
  onSessionGroup: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:group', handler);
    return () => ipcRenderer.removeListener('session:group', handler);
  },
  onSessionTabCopyRequest: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:tab-copy-request', handler);
    return () => ipcRenderer.removeListener('session:tab-copy-request', handler);
  },
  onSessionTabState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:tab-state', handler);
    return () => ipcRenderer.removeListener('session:tab-state', handler);
  },
  onSessionDockClear: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:dock-clear', handler);
    return () => ipcRenderer.removeListener('session:dock-clear', handler);
  },
  onSessionClosed: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:closed', handler);
    return () => ipcRenderer.removeListener('session:closed', handler);
  },
  onSessionHandover: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:handover', handler);
    return () => ipcRenderer.removeListener('session:handover', handler);
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

contextBridge.exposeInMainWorld('novoTerminal', api);
