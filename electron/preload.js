const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getSnapshot: () => ipcRenderer.invoke('store:snapshot'),
  createGroup: (payload) => ipcRenderer.invoke('store:create-group', payload),
  updateGroup: (gid, payload) => ipcRenderer.invoke('store:update-group', gid, payload),
  deleteGroup: (gid) => ipcRenderer.invoke('store:delete-group', gid),
  createAsset: (gid, payload) => ipcRenderer.invoke('store:create-asset', gid, payload),
  updateAsset: (aid, payload) => ipcRenderer.invoke('store:update-asset', aid, payload),
  deleteAsset: (aid) => ipcRenderer.invoke('store:delete-asset', aid),
  cloneAsset: (aid) => ipcRenderer.invoke('store:clone-asset', aid),
  getSettings: () => ipcRenderer.invoke('store:settings'),
  updateSettings: (patch) => ipcRenderer.invoke('store:update-settings', patch),
  exportGroups: () => ipcRenderer.invoke('store:export'),
  importGroups: (json) => ipcRenderer.invoke('store:import', json),
  browseDataPath: () => ipcRenderer.invoke('app:browse-data-path'),

  sessionCapabilities: (protocol) => ipcRenderer.invoke('session:capabilities', protocol),
  sessionTest: (req) => ipcRenderer.invoke('session:test', req),
  sessionConnect: (req) => ipcRenderer.invoke('session:connect', req),
  sessionDisconnect: (sessionId) => ipcRenderer.invoke('session:disconnect', sessionId),
  sessionList: () => ipcRenderer.invoke('session:list'),

  onSessionState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:state', handler);
    return () => ipcRenderer.removeListener('session:state', handler);
  },

  platform: process.platform,
};

contextBridge.exposeInMainWorld('omniDesk', api);
