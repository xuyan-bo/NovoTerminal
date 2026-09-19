import Vue from 'vue';
import { api, unwrap } from './api';
import { applySettings } from './i18n';

export const store = Vue.observable({
  snapshot: { groups: [], recent: [], settings: { theme: 'dark', lang: 'zh', dataPath: '' } },
  activeTab: 'home',
  tabs: [{ id: 'home', title: '首页', closable: false, icon: '⌂', titleKey: 'nav.home' }],
  activeAssetId: null,
  activeGroupId: null,
  sessionMap: {},
  settingsDialog: false,
  assetDialog: { visible: false, editId: null, gid: null },
  groupDialog: { visible: false, editId: null },
  methodAdvancedDialog: {
    visible: false,
    methodId: null,
    methodName: '',
    advanced: {},
    context: null,
  },
  methodAdvancedResult: null,
  localeTick: 0,
});

export async function refresh() {
  const snap = await api.getSnapshot();
  store.snapshot = snap;
  if (snap && snap.settings) applySettings(snap.settings);
  store.localeTick++;
}

export function switchTab(id) {
  store.activeTab = id;
}

export function openTab(tab) {
  const found = store.tabs.find((t) => t.id === tab.id);
  if (found) {
    store.activeTab = tab.id;
    return;
  }
  store.tabs.push(tab);
  store.activeTab = tab.id;
}

export function closeTab(id) {
  const i = store.tabs.findIndex((t) => t.id === id);
  if (i < 0 || !store.tabs[i].closable) return;
  store.tabs.splice(i, 1);
  if (store.activeTab === id) {
    store.activeTab = store.tabs[Math.max(0, i - 1)].id;
  }
}

export async function createGroup(payload) {
  unwrap(await api.createGroup(payload));
  await refresh();
}

export async function updateGroup(gid, payload) {
  unwrap(await api.updateGroup(gid, payload));
  await refresh();
}

export async function reorderGroups(fromId, toId) {
  if (api.reorderGroups) {
    unwrap(await api.reorderGroups({ fromId, toId }));
  } else {
    // browser mock: local array swap
    const gs = store.snapshot.groups || [];
    const from = gs.findIndex((g) => g.id === fromId);
    const to = gs.findIndex((g) => g.id === toId);
    if (from >= 0 && to >= 0 && from !== to) {
      const list = gs.slice();
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      store.snapshot = { ...store.snapshot, groups: list };
    }
  }
  await refresh();
}

export async function reorderAsset({ assetId, fromGid, toGid, beforeAssetId }) {
  if (api.reorderAsset) {
    unwrap(await api.reorderAsset({ assetId, fromGid, toGid, beforeAssetId }));
  }
  await refresh();
}

export async function deleteGroup(gid) {
  unwrap(await api.deleteGroup(gid));
  await refresh();
}

export async function createAsset(gid, payload) {
  unwrap(await api.createAsset(gid, payload));
  await refresh();
}

export async function updateAsset(aid, payload) {
  unwrap(await api.updateAsset(aid, payload));
  await refresh();
}

export async function deleteAsset(aid) {
  unwrap(await api.deleteAsset(aid));
  await refresh();
}

export async function cloneAsset(aid) {
  unwrap(await api.cloneAsset(aid));
  await refresh();
}

export function findAsset(aid) {
  for (const g of store.snapshot.groups || []) {
    const n = g.nodes.find((x) => x.id === aid);
    if (n) return { group: g, asset: n };
  }
  return null;
}

export function enabledMethods(asset) {
  if (!asset || !asset.methods) return [];
  const catalog = {
    win: [
      { id: 'rdp', name: 'RDP', proto: 'RDP', defaultPort: 3389, rec: true },
      { id: 'ssh', name: 'SSH', proto: 'SSH', defaultPort: 22, rec: false },
      { id: 'vnc', name: 'VNC', proto: 'VNC', defaultPort: 5900, rec: false },
    ],
    mac: [
      { id: 'vnc', name: 'VNC 屏幕共享', proto: 'VNC', defaultPort: 5900, rec: true },
      { id: 'ssh', name: 'SSH', proto: 'SSH', defaultPort: 22, rec: false },
    ],
    linux: [
      { id: 'ssh', name: 'SSH', proto: 'SSH', defaultPort: 22, rec: true },
      { id: 'vnc', name: 'VNC', proto: 'VNC', defaultPort: 5900, rec: false },
      { id: 'rdp', name: 'RDP (xrdp)', proto: 'RDP', defaultPort: 3389, rec: false },
    ],
  };
  const cat = catalog[asset.os] || catalog.win;
  const out = [];
  for (const meta of cat) {
    const conf = asset.methods[meta.id];
    if (conf && conf.enabled) {
      out.push({
        ...meta,
        port: conf.port || meta.defaultPort,
        primary: !!conf.primary,
        enabled: true,
        advanced: conf.advanced || null,
      });
    }
  }
  out.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || (b.rec ? 1 : 0) - (a.rec ? 1 : 0));
  return out;
}

export function openMethodAdvanced({ methodId, methodName, advanced, context }) {
  store.methodAdvancedResult = null;
  store.methodAdvancedDialog = {
    visible: true,
    methodId,
    methodName: methodName || methodId,
    advanced: advanced || {},
    context: context || null,
  };
}

export function openAssetDetail(asset) {
  store.activeAssetId = asset.id;
  store.activeGroupId = (findAsset(asset.id) || {}).group?.id || null;
  openTab({
    id: 'asset-' + asset.id,
    title: asset.name,
    closable: true,
    icon: '▣',
    os: asset.os,
    assetId: asset.id,
  });
}

/** Open an embedded SSH terminal tab (Xshell-style) */
export function openSshSession({ assetId, assetName, host, port, methodId }) {
  const mid = methodId || 'ssh';
  const id = `ssh-${assetId}-${mid}`;
  const existing = store.tabs.find((t) => t.id === id);
  if (existing) {
    store.activeTab = id;
    return id;
  }
  store.tabs.push({
    id,
    title: `SSH · ${assetName || host || assetId}`,
    closable: true,
    icon: '⌘',
    kind: 'ssh',
    assetId,
    methodId: mid,
    host: host || '',
    port: port || 22,
    assetName: assetName || host || assetId,
  });
  store.activeTab = id;
  return id;
}

export function removeTabView(id) {
  if (id.startsWith('asset-')) {
    const aid = id.slice(6);
    if (store.activeAssetId === aid) store.activeAssetId = null;
  }
}

export { api, unwrap };
