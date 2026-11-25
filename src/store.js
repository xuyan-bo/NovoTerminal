import { reactive } from 'vue';
import { api, unwrap } from './api';
import { applySettings, t } from './i18n';
import { resolveAdvanced } from './constants';
import { getProtocol } from './protocols';

export const store = reactive({
  snapshot: { groups: [], credentials: [], recent: [], settings: { theme: 'system', lang: 'zh', dataPath: '', zoom: 100, font: 'default' } },
  activeTab: 'home',
  tabs: [{ id: 'home', title: '首页', closable: false, icon: 'HomeFilled', titleKey: 'nav.home' }],
  activeAssetId: null,
  activeGroupId: null,
  settingsDialog: false,
  credentialDialog: false,
  /** 更新检查结果 { current, latest, notes, url }；弹窗开关独立，关闭结果仍保留 */
  update: null,
  updateDialog: false,
  /** 备份弹窗模式：'' 关闭，'export' 导出，'import' 导入 */
  backupDialog: '',
  logDialog: false,
  assetDialog: { visible: false, editId: null, gid: null, cloneId: null, viewId: null },
  groupDialog: { visible: false, editId: null },
  methodAdvancedDialog: {
    visible: false,
    methodId: null,
    methodName: '',
    advanced: {},
    context: null,
  },
  methodAdvancedResult: null,
  /** 方式级凭证子表单：与高级设置同一套「草稿进、结果出」的嵌套弹窗约定 */
  methodAuthDialog: {
    visible: false,
    methodId: '',
    methodName: '',
    auth: null,
    main: { mode: 'none', kind: '' },
    authKinds: [],
    context: null,
  },
  methodAuthResult: null,
  localeTick: 0,
  /** 跟随系统主题被 OS 翻转时由 App.vue 递增；只改 DOM 类不会惊动任何渲染依赖 */
  themeTick: 0,
  tabRefreshKeys: {},
  /** 分屏布局树（主窗口与独立窗口共用同一模型）：split 节点带方向比例，叶子区域持有一组页签 */
  layout: null,
});

/**
 * 页签拖拽的窗口内共享状态：起手（TabBar）、落点（TabBar 或 PaneLayout 的区域）与 dragend
 * 可能在不同组件实例上发生，必须共用同一份才不会丢。
 */
export const tabDrag = reactive({
  tabId: '',
  handled: false,
  detachable: false,
  prepared: false,
  title: '',
  show: false,
  left: 0,
  top: 0,
});

/** 当前渲染进程是不是独立会话窗口（主窗口返回 false）。 */
export function hostedInGroup() {
  return !!hostedGroupId;
}

export async function refresh() {
  // 主进程出错时返回的是 {__error}，不 unwrap 会把错误对象当成快照写进去，资产树静默变空
  const snap = unwrap(await api.getSnapshot());
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

export function openTab(tab, anchorTabId) {
  const found = store.tabs.find((t) => t.id === tab.id);
  if (found) {
    focusSessionTab(found.id);
    return;
  }
  store.tabs.push(tab);
  store.activeTab = tab.id;
  // 新页签默认进主栏（左上角第一个区域），与「右键资产新建连接落主栏」的约定一致；
  // 带锚点（页签右键"复制会话"）时改落锚点所在区域、紧跟锚点之后。
  reconcileLayout();
  if (anchorTabId) placeTabAfterAnchor(tab.id, anchorTabId);
}

export function closeTab(id) {
  const i = store.tabs.findIndex((t) => t.id === id);
  if (i < 0 || !store.tabs[i].closable) return;
  const tab = store.tabs[i];
  // Close ends the session now, in the same click; waiting for the view to be destroyed would keep
  // a connection that no longer has any tab running.
  if ((tab.kind === 'ssh' || tab.kind === 'telnet') && tab.liveSessionId && api.sshDisconnect) {
    api.sshDisconnect(tab.liveSessionId).catch(() => {});
    tab.liveSessionId = null;
  }
  store.tabs.splice(i, 1);
  // 分屏布局同步摘除：区域空了就地收拢，视图立刻卸载而不是等下一帧快照。
  removeTabFromLayout(id);
  if (store.activeTab === id) {
    // 独立窗口里 store.tabs 只含本组页签，关掉最后一条后会变空：此时没有可激活的邻位，
    // activeTab 置空即可（主窗口始终留着首页，不会走到这里）。直接索引 [0].id 会抛错。
    const next = store.tabs[Math.max(0, i - 1)];
    store.activeTab = next ? next.id : '';
  }
  // 独立窗口里的页签归主进程记账：主窗口那份副本要靠这条广播一起消失。
  if (hostedGroupId && api.sessionTabClose) api.sessionTabClose({ tabId: id }).catch(() => {});
  // 主窗口自己关页签时要清掉主进程按 tabId 记账的搬运描述符与监控偏好，独立窗口那份由上面的广播顺带清理。
  if (!hostedGroupId && api.sessionTabForget) api.sessionTabForget({ tabId: id }).catch(() => {});
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
 * 再次连接命中已有页签时复用而不是新开：激活它，断开或失败的连接靠重建视图重新握手，
 * 与页签右键「刷新」走同一条路径。连接中或已连上只激活，不打断正在跑的会话。
 */
export function focusSessionTab(tabId) {
  const tab = findTab(tabId);
  if (!tab) return;
  store.activeTab = tabId;
  // 分屏窗口里让页签所在区域切到它，否则视图停在别的页签上看不见。
  if (store.layout) {
    const g = regionOfTab(store.layout, tabId);
    if (g) g.active = tabId;
  }
  if (tab.connState === 'connecting' || tab.connState === 'ready') return;
  refreshSessionTab(tabId);
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
 * Insertion slot recorded when a detached tab is dropped on a region bar in the main window. The
 * merge broadcast that re-hosts the session consumes it once, so a cancelled drag leaves nothing
 * behind. regionId 让收回的页签落进拖放时瞄准的那个区域，而不是总回主栏。
 */
let dockTarget = null;

export function setDockTarget(tabId, beforeId, regionId) {
  dockTarget = { tabId, beforeId, regionId: regionId || '' };
}

/** A rejected dock request must not leave a slot behind for some later merge to consume. */
export function clearDockTarget(tabId) {
  if (dockTarget && dockTarget.tabId === tabId) dockTarget = null;
}

/**
 * 独立窗口接收外来页签的落点：快照回推把新页签先放进主栏，这里记下拖放瞄准的区域与位置，
 * 下一帧快照消费一次把它挪过去；拖放取消（主进程拒绝）时由调用方清除。
 */
let pendingRegionDrop = null;

export function setPendingRegionDrop(tabId, regionId, beforeId) {
  pendingRegionDrop = { tabId, regionId: regionId || '', beforeId: beforeId || null };
}

export function clearPendingRegionDrop(tabId) {
  if (pendingRegionDrop && pendingRegionDrop.tabId === tabId) pendingRegionDrop = null;
}

/**
 * 独立窗口"复制会话"的锚点：页签 id 由主窗口代分，请求前只记源页签，快照回来若恰好
 * 新增一枚就把复制页签落进源页签所在区域、紧跟其后（与主窗口的复制行为一致）。
 */
let pendingCopyAnchor = null;

/**
 * Apply the authoritative detached state broadcast by the main process. A detached session leaves
 * the tab bar entirely, so the active tab has to move to a visible neighbour, and merging back is
 * what brings it into focus again.
 */
export function applyDetached(tabId, detached) {
  const tab = findTab(tabId);
  if (!tab || tab.detached === detached) return;
  if (detached && (tab.kind === 'ssh' || tab.kind === 'telnet') && tab.liveSessionId) markSessionHandover(tabId);
  tab.detached = detached;
  if (!detached) {
    if (dockTarget && dockTarget.tabId === tabId) {
      const { beforeId, regionId } = dockTarget;
      dockTarget = null;
      moveTab(tabId, beforeId);
      if (regionId && store.layout) layoutMoveTab(tabId, regionId, beforeId);
      else reconcileLayout();
    }
    store.activeTab = tabId;
    return;
  }
  // 拆出后立即从布局树摘除：区域空了就地收拢，停放副本不再占任何区域。
  removeTabFromLayout(tabId);
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
  store.layout = null;
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
  // 一次消费：快照到达时若记着拖放落点，把新页签从主栏挪进瞄准的区域与位置；
  // 记着复制锚点且恰好新增一枚时，把复制页签落进源页签所在区域紧跟其后。
  const drop = pendingRegionDrop;
  pendingRegionDrop = null;
  const anchor = pendingCopyAnchor;
  reconcileLayout();
  if (drop && list.some((tab) => tab.id === drop.tabId) && store.layout) {
    layoutMoveTab(drop.tabId, drop.regionId || layoutMainRegionId(), drop.beforeId);
  } else if (anchor && added.length === 1 && list.some((tab) => tab.id === anchor)) {
    placeTabAfterAnchor(added[0].id, anchor);
    pendingCopyAnchor = null;
  } else if (anchor && (added.length > 1 || !list.some((tab) => tab.id === anchor))) {
    // 锚点已消失或一次来了多枚新页签，无法确定复制对象：放弃锚定，避免滞留影响以后的快照。
    pendingCopyAnchor = null;
  }
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

/** 独立窗口里的"复制会话"：本窗口只提请求，页签由主窗口代建后再交回来；源页签记为落位锚点。 */
export async function copySessionToGroup(tabId) {
  pendingCopyAnchor = tabId;
  try {
    unwrap(await api.sessionTabCopy({ tabId }));
  } catch (e) {
    pendingCopyAnchor = null;
    throw e;
  }
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
  if (tab.detached && (tab.kind === 'ssh' || tab.kind === 'telnet') && tab.liveSessionId && api.sshDisconnect) {
    api.sshDisconnect(tab.liveSessionId).catch(() => {});
  }
  if (store.activeTab === tabId) {
    // 独立窗口收回的最后一条页签可能让列表变空，直接索引会抛错；主窗口恒有首页兜底
    const next = store.tabs[Math.max(0, i - 1)];
    store.activeTab = next ? next.id : '';
  }
}

/** 连接状态只存在于当前宿主窗口，回灌给主窗口的副本，否则收回后小圆点与关闭确认都是旧的。 */
export function applyTabState(payload) {
  if (!payload || !payload.tabId) return;
  const tab = findTab(payload.tabId);
  if (!tab || !tab.detached) return;
  tab.connState = payload.connState || 'idle';
  if (payload.liveSessionId !== undefined) tab.liveSessionId = payload.liveSessionId || null;
}

/* ---- 分屏布局 ----
 * 树在每个宿主窗口的渲染进程里维护（主窗口与独立窗口同一套模型，不做持久化）：
 * split 节点带方向与比例，叶子区域持有一组页签和它的活动页签。
 * 独立窗口的页签成员与顺序仍由主进程组快照决定；主窗口以 store.tabs 里未拆出的页签为准。
 * reconcileLayout 负责双向对齐：消失（关闭/拆出）的摘除收拢，新来的按 store.tabs 顺序
 * 插进主栏（左上角第一个区域）——没有已落位的邻居时排在主栏末尾，首页恒在主栏首位。 */

let regionSeq = 0;

function newRegion(tabs, active) {
  regionSeq += 1;
  return { type: 'group', id: 'r' + regionSeq, tabs: tabs.slice(), active: active || tabs[0] || null };
}

function layoutLeaves(node, out) {
  out = out || [];
  if (!node) return out;
  if (node.type === 'group') out.push(node);
  else {
    layoutLeaves(node.a, out);
    layoutLeaves(node.b, out);
  }
  return out;
}

function findRegion(node, id) {
  if (!node) return null;
  if (node.type === 'group') return node.id === id ? node : null;
  return findRegion(node.a, id) || findRegion(node.b, id);
}

function regionOfTab(node, tabId) {
  if (!node) return null;
  if (node.type === 'group') return node.tabs.indexOf(tabId) >= 0 ? node : null;
  return regionOfTab(node.a, tabId) || regionOfTab(node.b, tabId);
}

function collectRegionTabs(node, out) {
  out = out || new Set();
  if (!node) return out;
  if (node.type === 'group') node.tabs.forEach((id) => out.add(id));
  else {
    collectRegionTabs(node.a, out);
    collectRegionTabs(node.b, out);
  }
  return out;
}

function pruneLayout() {
  const walk = (node) => {
    if (!node) return null;
    if (node.type === 'group') return node.tabs.length ? node : null;
    node.a = walk(node.a);
    node.b = walk(node.b);
    if (!node.a) return node.b;
    if (!node.b) return node.a;
    return node;
  };
  store.layout = walk(store.layout) || null;
}

/** 区域间搬动会重建 ssh/telnet 视图：先登记交接，卸载侧不断开主进程连接，重挂载时按 tail 回放画面。 */
function handoverIfLive(tabId) {
  const tab = findTab(tabId);
  if (tab && (tab.kind === 'ssh' || tab.kind === 'telnet') && tab.liveSessionId) markSessionHandover(tabId);
}

/**
 * 结构性布局变化（分屏翻转叶子为 split、prune 收拢 subtree、快照对齐）会重建受影响子树里的
 * 全部视图，不只是被拖的那一枚：把所有活会话的字符终端统一登记交接，否则同区域的其它页签
 * 卸载时会 disconnectNow 把连接断掉（实测表现为"第一个页签断开"）。重复登记无害——
 * 交接标志只让卸载侧改走 releaseHost，真正的关闭仍由 closeTab 显式断开。
 */
function handoverAllLive() {
  if (!store.layout) return;
  for (const g of layoutLeaves(store.layout)) {
    for (const id of g.tabs) handoverIfLive(id);
  }
}

/** 摘除一枚页签后区域的回退活动页签：取被摘位置上的下一枚（否则末枚），而不是总回首页——
 * 否则把第二条会话拆出去时，左边剩下的第一条会话会被首页顶掉。 */
function activeAfterRemoval(g, removedId) {
  const idx = g.tabs.indexOf(removedId);
  const at = idx >= 0 ? Math.min(idx, g.tabs.length - 1) : g.tabs.length - 1;
  return g.tabs[at] || null;
}

export function removeTabFromLayout(tabId) {
  if (!store.layout) return;
  handoverAllLive();
  const g = regionOfTab(store.layout, tabId);
  if (!g) return;
  g.tabs.splice(g.tabs.indexOf(tabId), 1);
  if (g.active === tabId) g.active = activeAfterRemoval(g, tabId);
  pruneLayout();
}

export function reconcileLayout() {
  const ids = store.tabs.filter((tab) => !tab.detached).map((tab) => tab.id);
  if (!ids.length) {
    store.layout = null;
    return;
  }
  if (!store.layout) {
    store.layout = newRegion(ids, ids.includes(store.activeTab) ? store.activeTab : ids[0]);
    return;
  }
  const alive = new Set(ids);
  handoverAllLive();
  for (const g of layoutLeaves(store.layout)) {
    g.tabs = g.tabs.filter((id) => alive.has(id));
    if (!g.tabs.includes(g.active)) g.active = g.tabs[0] || null;
  }
  pruneLayout();
  const placed = collectRegionTabs(store.layout);
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (placed.has(id)) continue;
    const main = layoutLeaves(store.layout)[0];
    if (!main) {
      store.layout = newRegion([id], store.activeTab === id ? id : null);
      placed.add(id);
      continue;
    }
    // 插在主栏里最近的已落位邻居之后；首页（ids[0]）没有邻居时回主栏首位。
    let at = main.tabs.length;
    if (i === 0) at = 0;
    else {
      for (let j = i - 1; j >= 0; j -= 1) {
        const k = main.tabs.indexOf(ids[j]);
        if (k >= 0) {
          at = k + 1;
          break;
        }
      }
    }
    main.tabs.splice(at, 0, id);
    placed.add(id);
    if (store.activeTab === id) main.active = id;
  }
}

/** 把页签插到锚点所在区域、紧跟锚点之后；锚点不在布局里（如停放副本）时不动。 */
function placeTabAfterAnchor(tabId, anchorId) {
  const g = store.layout && regionOfTab(store.layout, anchorId);
  if (!g) return;
  layoutMoveTab(tabId, g.id, g.tabs[g.tabs.indexOf(anchorId) + 1] || null);
}

/** 区域平铺顺序同步给主进程（仅独立窗口）：下一次搬入的 beforeTabId 落位才不跑偏。 */
export function reportRegionOrder() {
  if (!hostedGroupId || !api.sessionGroupOrder) return;
  const ids = [];
  (function walk(node) {
    if (!node) return;
    if (node.type === 'group') ids.push(...node.tabs);
    else {
      walk(node.a);
      walk(node.b);
    }
  })(store.layout);
  api.sessionGroupOrder({ tabIds: ids }).catch(() => {});
}

/** 左上角第一个区域＝主栏：新会话与从别的窗口拖进来的页签都落这里。 */
export function layoutMainRegionId() {
  const first = layoutLeaves(store.layout)[0];
  return first ? first.id : '';
}

/** 栏内落位或跨区移入；beforeTabId 为空表示放到末尾。 */
export function layoutMoveTab(tabId, toRegionId, beforeTabId) {
  if (!store.layout) return;
  handoverAllLive();
  const from = regionOfTab(store.layout, tabId);
  const target = findRegion(store.layout, toRegionId);
  if (!target) return;
  if (from && from.id !== toRegionId) {
    from.tabs.splice(from.tabs.indexOf(tabId), 1);
    if (from.active === tabId) from.active = activeAfterRemoval(from, tabId);
    pruneLayout();
  }
  const to = findRegion(store.layout, toRegionId);
  if (!to) return;
  const i = to.tabs.indexOf(tabId);
  if (i >= 0) to.tabs.splice(i, 1);
  let at = beforeTabId ? to.tabs.indexOf(beforeTabId) : to.tabs.length;
  if (at < 0) at = to.tabs.length;
  to.tabs.splice(at, 0, tabId);
  to.active = tabId;
  store.activeTab = tabId;
}

/** 四边落点：目标区域按方向对半分，被拖页签住进新区域。 */
export function layoutSplitTab(tabId, regionId, zone) {
  if (!store.layout) return;
  handoverAllLive();
  const from = regionOfTab(store.layout, tabId);
  if (from && from.id === regionId && from.tabs.length === 1) return;
  if (from) {
    from.tabs.splice(from.tabs.indexOf(tabId), 1);
    if (from.active === tabId) from.active = activeAfterRemoval(from, tabId);
    pruneLayout();
  }
  const target = findRegion(store.layout, regionId);
  if (!target) return;
  const ng = newRegion([tabId], tabId);
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const first = zone === 'left' || zone === 'top';
  const piece = { type: 'split', dir, ratio: 0.5, a: first ? ng : target, b: first ? target : ng };
  const repl = (node) => {
    if (node.type === 'group' && node.id === regionId) return piece;
    if (node.type === 'split') {
      node.a = repl(node.a);
      node.b = repl(node.b);
    }
    return node;
  };
  store.layout = repl(store.layout);
  store.activeTab = tabId;
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

export async function createCredential(payload) {
  unwrap(await api.createCredential(payload));
  await refresh();
}

export async function updateCredential(cid, payload) {
  unwrap(await api.updateCredential(cid, payload));
  await refresh();
}

export async function deleteCredential(cid) {
  unwrap(await api.deleteCredential(cid));
  await refresh();
}

export async function reorderCredential(payload) {
  unwrap(await api.reorderCredential(payload));
  await refresh();
}

export function findAsset(aid) {
  for (const g of store.snapshot.groups || []) {
    const n = g.nodes.find((x) => x.id === aid);
    if (n) return { group: g, asset: n };
  }
  return null;
}

/**
 * 资产已配置的访问方式，按用户添加的先后排列（方式不再由资产图标决定）。
 * 未登记的协议 id 直接忽略，不会被当成任何一种已知协议。
 */
export function enabledMethods(asset) {
  if (!asset || !asset.methods) return [];
  const out = [];
  for (const id of Object.keys(asset.methods)) {
    const protocol = getProtocol(id);
    const conf = asset.methods[id];
    if (!protocol || !conf) continue;
    out.push({
      id,
      nameKey: protocol.nameKey,
      descKey: protocol.descKey,
      defaultPort: protocol.defaultPort,
      port: conf.port || protocol.defaultPort,
      advanced: conf.advanced || null,
      auth: conf.auth || null,
    });
  }
  return out;
}

/**
 * 树上显示的登录名：用户名属于凭证，所以按主凭证的取法回查——手填取 auth.user，
 * 引用凭证取库里那条的 user；没配凭证时没有可显示的登录名。
 */
export function assetDisplayUser(asset, credentials) {
  const auth = asset && asset.auth;
  if (!auth) return '';
  if (auth.mode === 'inline') return auth.user || '';
  if (auth.mode !== 'credential') return '';
  const hit = (credentials || []).find((c) => c.id === auth.credentialId);
  return hit ? hit.user || '' : '';
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

/** main 带 mode 与 kind：私钥型主凭证对只吃口令的方式不可用，子弹窗据此置灰选项 */
export function openMethodAuth({ methodId, methodName, auth, main, authKinds, context }) {
  store.methodAuthResult = null;
  store.methodAuthDialog = {
    visible: true,
    methodId,
    methodName: methodName || methodId,
    auth: auth || null,
    main: main || { mode: 'none', kind: '' },
    authKinds: authKinds || ['password'],
    context: context || null,
  };
}

export function openAssetDetail(asset) {
  store.activeAssetId = asset.id;
  store.activeGroupId = (findAsset(asset.id) || {}).group?.id || null;
  store.assetDialog = { visible: true, editId: null, gid: null, cloneId: null, viewId: asset.id };
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
    // SSH 每次连接都开一条新页签；其余内嵌协议每个资产只有一条，id 稳定所以能命中已有页签。
    const tab = buildSessionTab(asset, method, protocol);
    // 页签在独立窗口里时本窗口这份只是停放副本：抬到最前，重连由那个窗口的视图自己做。
    const parked = store.tabs.find((t) => t.id === tab.id && t.detached);
    if (parked && unwrap(await api.sessionFocusTab({ tabId: tab.id })).ok) return;
    openTab(tab);
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

/** Opens another SSH session tab for the asset; the sessions in other tabs are untouched.
 *  anchorTabId：页签右键"复制会话"时传源页签，新页签落进它所在区域紧跟其后；不传则落主栏。 */
export function openSshSession(asset, method, anchorTabId) {
  const protocol = getProtocol(method.id);
  if (!protocol || !protocol.component) return;
  openTab(buildSessionTab(asset, method, protocol), anchorTabId);
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
  // 主进程把原因放在 code 里，界面按 err.<CODE> 取译文，英文原文只进日志
  const coded = error && error.code ? 'err.' + error.code : '';
  if (coded) {
    const mapped = t(coded);
    if (mapped !== coded) return mapped;
  }
  return error.message || t('err.connect');
}

export { api, unwrap };

// 主窗口启动时先把首页放进主栏，独立窗口随后被 setHostedGroup 清掉重建。
reconcileLayout();
