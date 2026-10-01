import Vue from 'vue';
import { api, unwrap } from './api';
import { applySettings, t } from './i18n';
import { CATALOG, resolveAdvanced } from './constants';
import { getProtocol, protocolLabel } from './protocols';

export const store = Vue.observable({
  snapshot: { groups: [], recent: [], settings: { theme: 'system', lang: 'zh', dataPath: '', zoom: 100, font: 'default' } },
  activeTab: 'home',
  tabs: [{ id: 'home', title: '首页', closable: false, icon: 'el-icon-s-home', titleKey: 'nav.home' }],
  activeAssetId: null,
  activeGroupId: null,
  sessionMap: {},
  settingsDialog: false,
  logDialog: false,
  assetDialog: { visible: false, editId: null, gid: null, cloneId: null },
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
  tabRefreshKeys: {},
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
  const tab = store.tabs[i];
  // Close ends the session now, in the same click; waiting for the view to be destroyed would keep
  // a connection that no longer has any tab running.
  if (tab.kind === 'ssh' && tab.liveSessionId && api.sshDisconnect) {
    api.sshDisconnect(tab.liveSessionId).catch(() => {});
    tab.liveSessionId = null;
  }
  store.tabs.splice(i, 1);
  if (store.activeTab === id) {
    store.activeTab = store.tabs[Math.max(0, i - 1)].id;
  }
}

export async function removeRecent(id, method) {
  unwrap(await api.removeRecent({ id, method }));
  await refresh();
}

export function refreshSessionTab(id) {
  const tab = findTab(id);
  if (tab) tab.liveSessionId = null;
  store.tabRefreshKeys = { ...store.tabRefreshKeys, [id]: (store.tabRefreshKeys[id] || 0) + 1 };
}

/**
 * A session tab can live either in the tab bar or in its own window. SSH keeps the main-process
 * connection across that move, so the view instance being torn down must not disconnect it: the
 * side losing the instance registers a handover and the instance consumes it in its destroy path.
 */
const handoverTabIds = new Set();

function findTab(id) {
  return store.tabs.find((tab) => tab.id === id);
}

export function markSessionHandover(tabId) {
  handoverTabIds.add(tabId);
}

export function takeSessionHandover(tabId) {
  if (!handoverTabIds.has(tabId)) return false;
  handoverTabIds.delete(tabId);
  return true;
}

function isDetachable(tab) {
  const protocol = tab && getProtocol(tab.kind);
  return !!(protocol && protocol.component);
}

/**
 * Insertion slot captured while a detached window hovers the tab bar. The drop-hint clear event
 * arrives before the merge broadcast, so this survives it and is consumed once by applyDetached.
 */
let dockTarget = null;

export function setDockTarget(tabId, beforeId) {
  dockTarget = { tabId, beforeId };
}

/**
 * Apply the authoritative detached state broadcast by the main process. A detached session leaves
 * the tab bar entirely, so the active tab has to move to a visible neighbour, and merging back is
 * what brings it into focus again.
 */
export function applyDetached(tabId, detached) {
  const tab = findTab(tabId);
  if (!tab || tab.detached === detached) return;
  if (detached && tab.kind === 'ssh' && tab.liveSessionId) markSessionHandover(tabId);
  tab.detached = detached;
  if (!detached) {
    if (dockTarget && dockTarget.tabId === tabId) {
      moveTab(tabId, dockTarget.beforeId);
      dockTarget = null;
    }
    store.activeTab = tabId;
    return;
  }
  if (store.activeTab !== tabId) return;
  const i = store.tabs.indexOf(tab);
  const next =
    store.tabs.slice(i + 1).find((t) => !t.detached) ||
    store.tabs.slice(0, i).reverse().find((t) => !t.detached);
  store.activeTab = next ? next.id : 'home';
}

export async function detachTab(tabId, fromDrag) {
  const tab = findTab(tabId);
  if (!tab || !isDetachable(tab) || tab.detached) return;
  unwrap(
    await api.sessionDetach({
      tabId: tab.id,
      kind: tab.kind,
      assetId: tab.assetId,
      methodId: tab.methodId,
      host: tab.host,
      port: tab.port,
      title: tab.title,
      liveSessionId: tab.liveSessionId,
      fromDrag: !!fromDrag,
    })
  );
}

/**
 * The detached window is closed, so the session it hosted ended with it and the tab that was only
 * parked there has nothing left to show.
 */
export function dropDetachedTab(tabId) {
  const i = store.tabs.findIndex((tab) => tab.id === tabId);
  if (i < 0) return;
  const [tab] = store.tabs.splice(i, 1);
  // A window closed before it took the connection over leaves that session owned here with no view.
  if (tab.detached && tab.kind === 'ssh' && tab.liveSessionId && api.sshDisconnect) {
    api.sshDisconnect(tab.liveSessionId).catch(() => {});
  }
  if (store.activeTab === tabId) store.activeTab = store.tabs[Math.max(0, i - 1)].id;
}

export function moveTab(id, beforeId) {
  const from = store.tabs.findIndex((tab) => tab.id === id);
  const before = beforeId === null ? store.tabs.length : store.tabs.findIndex((tab) => tab.id === beforeId);
  if (from < 0 || !store.tabs[from].closable || before < 0 || id === beforeId) return;
  const to = Math.max(1, before > from ? before - 1 : before);
  if (from === to) return;
  const tabs = store.tabs.slice();
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  store.tabs = tabs;
  if (api.logWrite) {
    api.logWrite({
      level: 'info', source: 'tabs', message: 'tab reordered',
      meta: { kind: tab.kind, fromIndex: from, toIndex: to },
    }).catch((error) => console.warn('Tab reorder log failed', error.code));
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

export function findAsset(aid) {
  for (const g of store.snapshot.groups || []) {
    const n = g.nodes.find((x) => x.id === aid);
    if (n) return { group: g, asset: n };
  }
  return null;
}

export function enabledMethods(asset) {
  if (!asset || !asset.methods) return [];
  const cat = CATALOG[asset.os] || CATALOG.win;
  const out = [];
  for (const meta of cat) {
    const conf = asset.methods[meta.id];
    if (conf && conf.enabled) {
      out.push({
        ...meta,
        proto: protocolLabel(meta.id),
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
    icon: 'el-icon-postcard',
    kind: 'asset',
    os: asset.os,
    assetId: asset.id,
  });
}

export async function connectAsset(asset, method) {
  const protocol = getProtocol(method.id);
  if (!protocol) {
    throw Object.assign(new Error(t('msg.notImpl', { name: method.nameKey ? t(method.nameKey) : method.id })), {
      code: 'NOT_IMPLEMENTED',
    });
  }
  // RDP 引擎分流：IronRDP-WASM 用内嵌会话；external 用外部客户端（mstsc）流程
  const _rdpEngine = resolveAdvanced('rdp', (method.advanced && method.advanced) || {}).engine;
  // 注意：协议对象并无 id 字段，须用 method.id 判断是否为 RDP
  const useEmbedded =
    !!protocol.component && (method.id !== 'rdp' || _rdpEngine === 'ironrdp');
  if (useEmbedded) {
    const id = `${method.id}-${asset.id}-${method.id}`;
    const assetName = asset.name || asset.host || asset.id;
    openTab({
      id,
      title: `${protocol.label} · ${assetName}`,
      closable: true,
      icon: protocol.icon,
      kind: method.id,
      assetId: asset.id,
      methodId: method.id,
      host: asset.host || '',
      port: method.port || protocol.defaultPort,
      assetName,
      connected: false,
      detached: false,
      liveSessionId: null,
    });
    return;
  }
  unwrap(await api.sessionConnect({ assetId: asset.id, methodId: method.id }));
  refresh().catch(() => {});
}

export function connectionErrorMessage(error) {
  if (error.code === 'TCP_TIMEOUT') return t('msg.tcpFail');
  if (error.code === 'MSTSC_NOT_FOUND') return t('err.mstscNotFound');
  if (error.code === 'PLATFORM') return t('err.rdpWindowsOnly');
  return error.message || t('err.connect');
}

export { api, unwrap };
