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
  /** 更新检查结果 { current, latest, notes, url }；弹窗开关独立，关闭结果仍保留 */
  update: null,
  updateDialog: false,
  /** 备份弹窗模式：'' 关闭，'export' 导出，'import' 导入 */
  backupDialog: '',
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
  /** 跟随系统主题被 OS 翻转时由 App.vue 递增；只改 DOM 类不会惊动任何渲染依赖 */
  themeTick: 0,
  tabRefreshKeys: {},
});

export async function refresh() {
  const snap = await api.getSnapshot();
  // recent 等无关变更也会广播刷新；groups 未变时沿用旧引用，避免侧边栏资产树整棵重建
  if (snap && JSON.stringify(snap.groups) === JSON.stringify(store.snapshot.groups)) {
    snap.groups = store.snapshot.groups;
  }
  store.snapshot = snap;
  if (snap && snap.settings) applySettings(snap.settings);
  store.localeTick++;
}

/** 有新版本才落状态并开弹窗；无更新与失败都交给调用方决定要不要提示用户。
 *  silent 用于启动时的自动检查：用户忽略过的版本不再打扰，手动检查仍照常弹窗。 */
export async function checkForUpdates(silent = false) {
  const r = unwrap(await api.checkUpdate());
  if (r.hasUpdate && !(silent && r.ignored)) {
    store.update = r;
    store.updateDialog = true;
  }
  return r;
}

/** 记住被忽略的版本：主进程按数值比较，同版本启动时不再提示。 */
export async function ignoreUpdateVersion(version) {
  const v = String(version || '').trim();
  if (!v) return;
  await api.updateSettings({ skippedUpdateVersion: v });
  await refresh();
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
  // 独立窗口里的页签归主进程记账：主窗口那份副本要靠这条广播一起消失。
  if (hostedGroupId && api.sessionTabClose) api.sessionTabClose({ tabId: id }).catch(() => {});
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
 * Insertion slot recorded when a detached tab is dropped on the bar. The merge broadcast that
 * re-hosts the session consumes it once, so a cancelled drag leaves nothing behind.
 */
let dockTarget = null;

export function setDockTarget(tabId, beforeId) {
  dockTarget = { tabId, beforeId };
}

/** A rejected dock request must not leave a slot behind for some later merge to consume. */
export function clearDockTarget(tabId) {
  if (dockTarget && dockTarget.tabId === tabId) dockTarget = null;
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

/**
 * 独立窗口也是页签宿主：主进程按组保存成员与顺序，窗口用下面这组动作读写自己那一份。
 * hostedGroupId 为空表示当前渲染进程是主窗口（它持有全量页签，拆出去的那些只是停在那儿）。
 */
let hostedGroupId = '';

export function setHostedGroup(gid) {
  hostedGroupId = String(gid || '');
  if (!hostedGroupId) return;
  // 组快照到达前，本地那份（含主窗口的首页）必须先清空，否则独立窗口会先闪出一条"首页"页签。
  store.tabs = [];
  store.activeTab = '';
}

/** 跨窗口搬运只带这几个字段，视图重建够用即可，不把整个页签对象灌进 IPC。 */
export function tabPayload(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    kind: tab.kind,
    title: tab.title || '',
    icon: tab.icon || '',
    os: tab.os || '',
    assetId: tab.assetId || '',
    methodId: tab.methodId || tab.kind,
    host: tab.host || '',
    port: tab.port === undefined || tab.port === null ? '' : String(tab.port),
    connState: tab.connState || 'idle',
    liveSessionId: tab.liveSessionId || null,
  };
}

/**
 * 主进程发来的组快照就是本窗口的页签真相。已经在本窗口承载的页签保留本地实时状态：
 * 快照里那份要等一次回灌才会更新，直接覆盖会让小圆点倒退，也会把刚拿到的 liveSessionId 冲掉。
 * 新来的那一条（复制或拖进来）成为当前页签，和浏览器一致；原来的活动页签被搬走才退回第一枚。
 */
export function applyGroupTabs(tabs) {
  const previous = new Map(store.tabs.map((tab) => [tab.id, tab]));
  const list = (Array.isArray(tabs) ? tabs : []).map((tab) => {
    const held = previous.get(tab.id);
    return {
      ...tab,
      closable: true,
      detached: false,
      port: tab.port === '' ? undefined : tab.port,
      connState: held ? held.connState : tab.connState || 'idle',
      liveSessionId: held ? held.liveSessionId || null : tab.liveSessionId || null,
    };
  });
  store.tabs = list;
  const added = list.filter((tab) => !previous.has(tab.id));
  if (added.length === 1 && previous.has(store.activeTab)) store.activeTab = added[0].id;
  else if (!list.some((tab) => tab.id === store.activeTab)) store.activeTab = list.length ? list[0].id : '';
}

export function reportTabState(tabId) {
  if (!hostedGroupId || !api.sessionTabState) return;
  const tab = findTab(tabId);
  if (!tab) return;
  api.sessionTabState({ tabId, connState: tab.connState, liveSessionId: tab.liveSessionId || null }).catch(() => {});
}

/** 组内顺序只有主进程记着才在下一次搬入时不跑偏；只由本模块的 moveTab 触发。 */
function reportGroupOrder() {
  if (!hostedGroupId || !api.sessionGroupOrder) return;
  api.sessionGroupOrder({ tabIds: store.tabs.map((tab) => tab.id) }).catch(() => {});
}

export function reportActiveTab(tabId) {
  if (!hostedGroupId || !api.sessionTabActive || !tabId) return;
  api.sessionTabActive({ tabId }).catch(() => {});
}

/** 独立窗口里的"复制会话"：本窗口只提请求，页签由主窗口代建后再交回来。 */
export async function copySessionToGroup(tabId) {
  unwrap(await api.sessionTabCopy({ tabId }));
}

/**
 * 主窗口替某个独立窗口建一条会话页签。页签 id 只能在这里分配（本窗口看得见全部页签，含停放的那些），
 * 但连接必须交给最终宿主发起：建好就立刻标成停放，本窗口既不显示它也不挂载视图，
 * 那个窗口拿到的是一条「连接中」的新页签，与在主窗口里点复制的动作完全一致。
 */
export async function openCopyForGroup(source, groupId) {
  const gid = String(groupId || '');
  if (!gid) return;
  const hit = findAsset(source && source.assetId);
  if (!hit) return;
  const method = enabledMethods(hit.asset).find((m) => m.id === (source.methodId || source.kind));
  if (!method) return;
  const protocol = getProtocol(method.id);
  if (!protocol || !protocol.component) return;
  const tab = buildSessionTab(hit.asset, method, protocol);
  tab.detached = true;
  store.tabs.push(tab);
  try {
    unwrap(await api.sessionDetach({ tab: tabPayload(tab), fromDrag: false, groupId: gid }));
  } catch (e) {
    // 交不出去就当场撤销这条代建页签：它没连过任何东西，留着只会是一条谁都看不见的记录。
    const i = store.tabs.findIndex((t) => t.id === tab.id);
    if (i >= 0) store.tabs.splice(i, 1);
    if (api.logWrite) {
      api
        .logWrite({
          level: 'warn',
          source: 'session',
          message: 'copy session handoff failed',
          meta: { tabId: tab.id, groupId: gid, message: e.message },
        })
        .catch(() => {});
    }
  }
}

/** 页签归哪个窗口由主进程定；这里只发请求，本窗口的落位靠回推的组快照。 */
export async function detachTab(tabId, fromDrag, groupId) {
  const tab = findTab(tabId);
  if (!tab || !isDetachable(tab) || tab.detached) return;
  unwrap(
    await api.sessionDetach({
      tab: tabPayload(tab),
      fromDrag: !!fromDrag,
      groupId: groupId ? String(groupId) : undefined,
    })
  );
}

/** 丢到主窗口页签栏＝收回；丢到另一个独立窗口页签栏＝换宿主，beforeTabId 只对新宿主有意义。 */
export async function moveTabToWindow(tabId, beforeTabId, toHost) {
  unwrap(
    await api.sessionTabMove({
      tabId,
      beforeTabId: beforeTabId === null || beforeTabId === undefined ? null : String(beforeTabId),
      to: toHost ? 'host' : 'self',
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

/** 连接状态只存在于当前宿主窗口，回灌给主窗口的副本，否则收回后小圆点与关闭确认都是旧的。 */
export function applyTabState(payload) {
  if (!payload || !payload.tabId) return;
  const tab = findTab(payload.tabId);
  if (!tab || !tab.detached) return;
  tab.connState = payload.connState || 'idle';
  if (payload.liveSessionId !== undefined) tab.liveSessionId = payload.liveSessionId || null;
}

export function moveTab(id, beforeId) {
  const from = store.tabs.findIndex((tab) => tab.id === id);
  const before = beforeId === null ? store.tabs.length : store.tabs.findIndex((tab) => tab.id === beforeId);
  if (from < 0 || !store.tabs[from].closable || before < 0 || id === beforeId) return;
  // 主窗口首页恒在首位；独立窗口没有首页，第一条就可以被插到它前面。
  const floor = store.tabs[0] && store.tabs[0].id === 'home' ? 1 : 0;
  const to = Math.max(floor, before > from ? before - 1 : before);
  if (from === to) return;
  const tabs = store.tabs.slice();
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  store.tabs = tabs;
  reportGroupOrder();
}

export async function createGroup(payload) {
  unwrap(await api.createGroup(payload));
  await refresh();
}

export async function updateGroup(gid, payload) {
  unwrap(await api.updateGroup(gid, payload));
  await refresh();
}

/** Move a folder in the tree: new parent `toGid` plus optional sibling anchor `beforeId`. */
export async function reorderGroups({ fromId, toGid, beforeId }) {
  unwrap(await api.reorderGroups({ fromId, toGid, beforeId }));
  await refresh();
}

/** Move an asset within the tree; beforeAssetId null means append to the end of toGid. */
export async function reorderAsset({ assetId, toGid, beforeAssetId }) {
  unwrap(await api.reorderAsset({ assetId, toGid, beforeAssetId }));
  await refresh();
}

export async function deleteGroup(gid) {
  unwrap(await api.deleteGroup(gid));
  await refresh();
}

export async function createAsset(gid, payload) {
  const res = unwrap(await api.createAsset(gid, payload));
  await refresh();
  return res.asset;
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

/**
 * SSH keeps one tab id per instance so the same asset can have several sessions; the other
 * embedded protocols keep their historical stable id, which is what makes a repeat connect
 * activate the existing tab instead of opening a second one. The instance number comes from the
 * id so two tabs of the same asset can never render the same title.
 */
function sessionTabInstance(methodId, assetId) {
  const base = `${methodId}-${assetId}-${methodId}`;
  if (methodId !== 'ssh') return { id: base, seq: 1 };
  let seq = 1;
  let id = base;
  while (store.tabs.some((tab) => tab.id === id)) {
    seq += 1;
    id = `${base}-${seq}`;
  }
  return { id, seq };
}

function buildSessionTab(asset, method, protocol) {
  const assetName = asset.name || asset.host || asset.id;
  const { id, seq } = sessionTabInstance(method.id, asset.id);
  const label = `${protocol.label} · ${assetName}`;
  return {
    id,
    title: seq > 1 ? `${label} (${seq})` : label,
    closable: true,
    icon: protocol.icon,
    kind: method.id,
    assetId: asset.id,
    methodId: method.id,
    host: asset.host || '',
    port: method.port || protocol.defaultPort,
    assetName,
    connState: 'idle',
    detached: false,
    liveSessionId: null,
  };
}

export async function connectAsset(asset, method) {
  const protocol = getProtocol(method.id);
  if (!protocol) {
    throw Object.assign(new Error(t('msg.notImpl', { name: method.nameKey ? t(method.nameKey) : method.id })), {
      code: 'NOT_IMPLEMENTED',
    });
  }
  // RDP 引擎分流：IronRDP-WASM 用内嵌会话；external 用外部客户端（mstsc）流程
  const _rdpEngine = resolveAdvanced('rdp', method.advanced || {}).engine;
  // 注意：协议对象并无 id 字段，须用 method.id 判断是否为 RDP
  const useEmbedded =
    !!protocol.component && (method.id !== 'rdp' || _rdpEngine === 'ironrdp');
  if (useEmbedded) {
    // SSH opens a fresh session on every connect; the other embedded protocols keep a stable tab id,
    // so openTab's dedupe just activates the one session they allow per asset.
    openTab(buildSessionTab(asset, method, protocol));
    return;
  }
  // SFTP 不占页签栏：单实例控制面板窗口，重复打开只是在面板里追加或激活对应会话页签
  if (method.id === 'sftp') {
    unwrap(await api.sftpOpenWindow({ assetId: asset.id }));
    return;
  }
  unwrap(await api.sessionConnect({ assetId: asset.id, methodId: method.id }));
  refresh().catch(() => {});
}

/** Opens another SSH session tab for the asset; the sessions in other tabs are untouched. */
export function openSshSession(asset, method) {
  const protocol = getProtocol(method.id);
  if (!protocol || !protocol.component) return;
  openTab(buildSessionTab(asset, method, protocol));
}

export function connectionErrorMessage(error) {
  if (error.code === 'TCP_TIMEOUT') return t('msg.tcpFail');
  if (error.code === 'MSTSC_NOT_FOUND') return t('err.mstscNotFound');
  if (error.code === 'XFREERDP_NOT_FOUND') return t('err.xfreerdpNotFound');
  if (error.code === 'WFREERDP_NOT_FOUND') return t('err.wfreerdpNotFound');
  if (error.code === 'PLATFORM') return t('err.rdpWindowsOnly');
  if (error.code === 'XFREERDP_PLATFORM') return t('err.rdpXfreerdpPlatform');
  if (error.code === 'WFREERDP_PLATFORM') return t('err.rdpWfreerdpPlatform');
  if (error.code === 'RDP_CLIENT_UNKNOWN') return error.message || t('err.connect');
  return error.message || t('err.connect');
}

export { api, unwrap };
