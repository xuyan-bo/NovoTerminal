const { app, BrowserWindow, ipcMain, dialog, clipboard, Tray, Menu, nativeImage, shell, screen, net } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
/** Bump when shipping renderer changes — source-only marker, not surfaced in the UI */
const APP_BUILD = 'rd2-1647';
const {
  AssetStore,
  RECENT_LIMIT_DEFAULT,
  RECENT_LIMIT_MAX,
  LOG_TOTAL_DEFAULT_MB,
  LOG_TOTAL_MIN_MB,
  LOG_TOTAL_MAX_MB,
} = require('./store/assetStore');
const { migrateSideData } = require('./store/dataMigration');
const { packBackup, unpackBackup, restoreBackup, MIN_PASSWORD, MAX_PASSWORD } = require('./store/backup');
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
const pkg = require('../package.json');

// 更新检查同时探测 Gitee 与 GitHub（两平台同步开源发布）；发行版对象没有 html_url，发布页地址由仓库地址拼出
const repoUrl = new URL(pkg.homepage);
const repoPath = repoUrl.pathname.replace(/\/+$/, '');
const RELEASES_PAGE = repoUrl.origin + repoPath + '/releases';
const RELEASES_API = repoUrl.origin + '/api/v5/repos' + repoPath + '/releases?per_page=10&direction=desc';
// GitHub 仓库地址由 githubHomepage 提供，缺失时只走 Gitee 单路；发行列表固定走 api.github.com
const githubUrl = pkg.githubHomepage ? new URL(pkg.githubHomepage) : null;
const githubPath = githubUrl && githubUrl.pathname.replace(/\/+$/, '');
const GITHUB_RELEASES_PAGE = githubUrl ? githubUrl.origin + githubPath + '/releases' : '';
const GITHUB_RELEASES_API = githubUrl ? 'https://api.github.com/repos' + githubPath + '/releases?per_page=10' : '';
// 两路各自独立的超时：实测两路热连接都在 400ms 内，留出弱网余量即可，不能让慢的一路拖住整次检查
const GITEE_TIMEOUT_MS = 4000;
const GITHUB_TIMEOUT_MS = 6000;

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
const MB = 1024 * 1024;
/** 日志总量设置以 MB 表示，越界或非数字都回落到默认值 */
function clampedLogTotalMb(v) {
  return Math.min(LOG_TOTAL_MAX_MB, Math.max(LOG_TOTAL_MIN_MB, Math.floor(Number(v)) || LOG_TOTAL_DEFAULT_MB));
}
/** 页面缩放百分比，与渲染端设置页滑块的 50–200 一致；非数字回落 100 */
function clampedZoom(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(200, Math.max(50, n)) : 100;
}
/**
 * 设置项的取值集合。字体不在这里收敛：可选项在渲染端 src/constants.js 的 UI_FONTS，
 * 主进程复制一份 id 列表会变成第二处真相，而 i18n 的 applyFont 认不出 id 时本来就回落系统字体。
 */
const SETTING_THEMES = ['dark', 'light', 'system'];
const SETTING_CLOSE_ACTIONS = ['ask', 'minimize', 'quit'];

/** 发行版标签只认数字版本前缀，V/v 前缀均可且缺位补 0（V1.0.0 与 1.0 等价），杂字符（v3.9.2last 之类）按可比部分处理 */
function parseVersion(tag) {
  const m = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(tag == null ? '' : tag).trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

function isNewerVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * 取单个源的最新正式版本：不依赖接口的默认排序，在返回的这页里挑可解析出的最高版本；
 * GitHub 还要排除 draft，其发布页用自身的 html_url，Gitee 没有该字段只能回到 releases 页。
 */
async function fetchLatestRelease(source) {
  const github = source === 'github';
  const res = await net.fetch(github ? GITHUB_RELEASES_API : RELEASES_API, {
    headers: { Accept: 'application/json', ...(github ? { 'User-Agent': pkg.name } : null) },
    signal: AbortSignal.timeout(github ? GITHUB_TIMEOUT_MS : GITEE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error((github ? 'GitHub' : 'Gitee') + ' releases HTTP ' + res.status);
  }
  const list = await res.json();
  const items = Array.isArray(list) ? list : [];
  let hit = null;
  let version = null;
  for (const r of items) {
    if (!r || r.prerelease || (github && r.draft)) continue;
    const v = parseVersion(r.tag_name);
    if (v && (!version || isNewerVersion(v, version))) {
      hit = r;
      version = v;
    }
  }
  if (!hit) return null;
  return {
    source,
    tag: String(hit.tag_name).trim(),
    version,
    notes: String(hit.body || ''),
    url: github ? hit.html_url || GITHUB_RELEASES_PAGE : RELEASES_PAGE,
  };
}

/**
 * 以 Gitee 为准：用户配了 Gitee 自动同步到 GitHub，两边发行版一致，所以主源一旦拿到发行版就立刻出结论，
 * 不为兜底再等 GitHub（它可能慢几秒）。GitHub 那一路仍然并发发出，只在主源失败或还没有任何发行版时接管。
 * 未 await 的那一路自带异常吞掉，避免晚到的 reject 变成未处理拒绝。
 */
async function probeReleases(sources) {
  const jobs = sources.map((source) => ({
    source,
    promise: fetchLatestRelease(source).then(
      (hit) => ({ hit }),
      (e) => ({ error: e && e.message ? e.message : String(e) }),
    ),
  }));
  const failures = [];
  const timings = [];
  const startedAt = Date.now();
  for (const job of jobs) {
    const r = await job.promise;
    timings.push(job.source + ':' + (Date.now() - startedAt) + 'ms');
    if (r.error) {
      failures.push(job.source + ': ' + r.error);
      continue;
    }
    // 该源还没有任何发行版就继续问下一路，拿到发行版即可出结论
    if (r.hit) return { best: r.hit, failures, timings };
  }
  return { best: null, failures, timings };
}

/**
 * 切换「存储位置」：数据文件由 AssetStore 落位，附带数据（AI 会话记录、日志）随之搬走。
 * 目标目录原本就有数据文件时属于「切到另一个库」，此时不搬附带数据，免得把两套数据混在一起。
 */
async function switchDataPath(dir) {
  const fromDir = store.dataDir();
  const switchedLibrary = fs.existsSync(path.join(dir, 'novoterminal.json'));
  store.setCustomPath(dir);
  const toDir = store.dataDir();
  logStore.setDir(store.logsDir());
  const moved = { aiSessions: null, logs: null };
  const moving = !switchedLibrary && path.resolve(fromDir) !== path.resolve(toDir);
  if (moving) {
    try {
      Object.assign(moved, await migrateSideData({ fromDir, toDir, logFiles: 1 + logStore.keepBackups, log: logger }));
    } catch (e) {
      logger.error('settings', 'side data migration failed', { from: fromDir, to: toDir, message: e.message });
    }
  }
  // 新库确实能读回才清掉原目录的库文件；读不回就全部保留，宁可留残留也不能丢数据
  let discarded = [];
  if (moving) {
    if (store.verifyActiveFile()) discarded = store.discardMovedFiles(fromDir);
    else logger.warn('settings', 'kept old data files, new copy unreadable', { from: fromDir, to: toDir });
  }
  logger.info('settings', 'data path changed', {
    dataPath: store.getSettings().dataPath,
    logDir: logStore.dir,
    switchedLibrary,
    aiFiles: moved.aiSessions ? moved.aiSessions.files : 0,
    logFiles: moved.logs ? moved.logs.files : 0,
    discarded,
  });
  return moved;
}
/**
 * 会话页签的宿主模型：主窗口之外，每个独立窗口可以承载多个会话页签。
 * groupId 只在主进程内有意义；页签归属查 groupOfTab，描述符查 detachedTabs，
 * 二者合起来足够让任意窗口重建自己该显示哪些页签、按什么顺序。
 */
const detachedGroups = new Map(); // gid -> { id, window, tabIds, ready, confirming, dead, reason }
const tabGroup = new Map(); // tabId -> gid
const detachedTabs = new Map(); // tabId -> 页签描述符（跨窗口搬运与重建页签栏的唯一来源）
/** 各窗口自己上报的页签栏矩形（页面 CSS px）；"拖出栏外"的落点裁决按上报方查表。 */
const tabbarRects = new Map(); // webContents id -> { window, rect }
let detachedGroupSeq = 0;
/** 应用正在退出：独立窗口的关窗确认必须让路，否则带着活动会话的子窗口会把退出卡在确认上。 */
let appQuitting = false;
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

/** The detached group hosting a session tab, or null while it lives in the main window. */
function groupOf(tabId) {
  const group = detachedGroups.get(tabGroup.get(tabId));
  return group && !group.window.isDestroyed() ? group : null;
}

/** Which window hosts a session tab's view: its detached group window, else the main window. */
function sessionHostWindow(tabId) {
  const group = groupOf(tabId);
  return group ? group.window : win;
}

/**
 * A drag-detach resolves the release point from the live OS cursor here: Chromium delivers no
 * usable coordinates once the pointer has left the window, but dragend still reaches the renderer.
 * A release over the bar of the window the drag started from is a reorder/cancel, never a detach,
 * and every host window has a bar now — so each window publishes its own rect and hit tests use it.
 */
function tabbarScreenRect(wcId) {
  const held = tabbarRects.get(wcId);
  if (!held) return null;
  const w = held.window;
  if (!w || w.isDestroyed() || w.isMinimized() || !w.isVisible()) return null;
  const content = w.getContentBounds();
  const zoom = w.webContents.isDestroyed() ? 1 : w.webContents.getZoomFactor();
  const rect = held.rect;
  return {
    x: content.x + Math.round(rect.x * zoom),
    y: content.y + Math.round(rect.y * zoom),
    width: Math.round(rect.width * zoom),
    height: Math.round(rect.height * zoom),
  };
}

/**
 * Chromium hands a drag to whichever window is on top under the cursor, so a bar can only accept a
 * tab from another window while that window sits forward. Bringing *every* other host window forward
 * at dragstart made in-window reordering drop onto whoever happened to cover the bar, so the drag
 * instead polls the OS cursor and moves forward only the window whose bar the cursor is over — the
 * bar it started from counts too, so pulling back re-localises the reorder. Only moveTop is used:
 * toggling always-on-top would leave the window below the rest of the OS after the drag.
 */
const DOCK_POLL_MS = 90;
let dockRaise = null;

const hostWindows = () =>
  [win, ...Array.from(detachedGroups.values()).map((group) => group.window)].filter((w) => w && !w.isDestroyed());

const overBar = (w, point) => {
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return false;
  const rect = tabbarScreenRect(w.webContents.id);
  return !!rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
};

function pollDockTarget() {
  if (!dockRaise) return;
  const source = dockRaise.source;
  if (source.isDestroyed()) { restoreDockTargets(); return; }
  const point = screen.getCursorScreenPoint();
  const hit = overBar(source, point)
    ? source
    : hostWindows().find((w) => w !== source && overBar(w, point));
  if (!hit || hit === dockRaise.forward) return;
  hit.moveTop();
  dockRaise.forward = hit;
}

function raiseDockTargets(source) {
  if (dockRaise || !source) return;
  if (hostWindows().length < 2) return;
  dockRaise = { source, forward: null, focusBack: BrowserWindow.getFocusedWindow(), timer: setInterval(pollDockTarget, DOCK_POLL_MS) };
}

/** 把窗口提到最前并交给它焦点——投放成功后用户要看的正是接收方。 */
function raiseWindow(w) {
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.moveTop();
  w.focus();
}

/** 拖放结束时所有宿主窗口都可能还留着落点提示，统一收回（源窗口没了就不会发 dragleave）。 */
function clearDockGhosts() {
  for (const w of hostWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('session:dock-clear', {});
  }
}

function restoreDockTargets(keepTop) {
  if (!dockRaise) return;
  const held = dockRaise;
  dockRaise = null;
  clearInterval(held.timer);
  if (keepTop && !keepTop.isDestroyed()) {
    raiseWindow(keepTop);
    return;
  }
  if (held.source && !held.source.isDestroyed()) held.source.moveTop();
  // 抬层不能把键盘从正在拖的窗口抢走。
  const back = held.focusBack;
  if (back && !back.isDestroyed() && !back.isFocused()) back.focus();
}

/** 主窗口可能正在关闭，回灌与广播都要先确认它还在。 */
function sendToHost(channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

/** Snapshot of one group's tabs, in bar order, for the window that hosts them. */
function groupSnapshot(group) {
  const tabs = group.tabIds.map((tabId) => detachedTabs.get(tabId)).filter(Boolean);
  return { groupId: group.id, tabs: tabs.map((tab) => ({ ...tab })) };
}

function sendGroup(group) {
  if (!group || group.window.isDestroyed()) return;
  group.window.webContents.send('session:group', groupSnapshot(group));
}

function sendHostTabState(tab) {
  sendToHost('session:tab-state', {
    tabId: tab.id,
    connState: tab.connState,
    liveSessionId: tab.liveSessionId,
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
    tray.setToolTip('NovoTerminal');
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
    { label: en ? 'Quit NovoTerminal' : '退出 NovoTerminal', click: () => { trayDestroying = true; app.quit(); } },
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

/** 默认窗口尺寸取工作区比例；floor 只在小屏上兜底，不会超出工作区。workAreaSize 是 DIP，已含系统缩放。 */
function sizedToWorkArea(ratioW, ratioH, floorW, floorH, area) {
  const a = area || screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(a.width, Math.max(floorW, Math.round(a.width * ratioW))),
    height: Math.min(a.height, Math.max(floorH, Math.round(a.height * ratioH))),
  };
}

function createWindow() {
  const size = sizedToWorkArea(0.7, 0.78, 1100, 700);
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 960,
    minHeight: 600,
    title: 'NovoTerminal',
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

function untrustedSenderError() {
  return Object.assign(new Error('Untrusted SSH IPC sender'), { code: 'SSH_OWNER' });
}

/** IPC 入口的信任门：只允许本应用自己的页面、由主框架发起，且必须挂在某个窗口上。 */
function assertTrustedSender(event) {
  const sender = event.sender;
  if (!sender || sender.isDestroyed()) throw untrustedSenderError();
  const url = new URL(sender.getURL());
  const trusted = isDev
    ? url.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin
    : url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(__dirname, '..', 'dist', 'index.html');
  if (!trusted || !BrowserWindow.fromWebContents(sender) || event.senderFrame !== sender.mainFrame) {
    throw untrustedSenderError();
  }
}

function handle(channel, fn, withSender = false) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (withSender) {
        assertTrustedSender(event);
        trackSshOwner(event.sender);
        return await fn(event.sender, ...args);
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

/** 去掉 AI 服务里的 API Key，其余字段原样保留。 */
function withoutAiKeys(settings) {
  const ai = settings && settings.ai;
  if (!ai || !Array.isArray(ai.services)) return settings;
  return { ...settings, ai: { ...ai, services: ai.services.map((s) => ({ ...s, apiKey: '' })) } };
}

/** Key 只有设置页用得上，所以只交给宿主窗口；拆分窗与 SFTP 窗拿到的副本一律去掉 Key。 */
function isMainWindow(sender) {
  return !!win && !win.isDestroyed() && BrowserWindow.fromWebContents(sender) === win;
}

function registerIpc() {
  // 快照会进每个窗口的 store，AI 配置里的凭据不能跟着扩散
  handle('store:snapshot', () => {
    const snap = store.snapshot();
    return snap && snap.settings ? { ...snap, settings: withoutAiKeys(snap.settings) } : snap;
  });
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
  handle('update:check', async () => {
    const current = app.getVersion();
    const cur = parseVersion(current);
    const sources = githubUrl ? ['gitee', 'github'] : ['gitee'];
    const probed = await probeReleases(sources);
    if (probed.failures.length === sources.length) {
      logger.warn('update', 'update check failed', {
        current,
        sources: sources.join(','),
        timings: probed.timings.join(' '),
        failures: probed.failures.join(' | '),
      });
      throw Object.assign(new Error(probed.failures.join('; ') || 'no releases found'), { code: 'UPDATE_UNAVAILABLE' });
    }
    const best = probed.best;
    // 被忽略的版本按数值比较，避免标签大小写/前缀差异（V1.0.0 与 1.0.0 视为同一版本）
    const skipped = String((store.getSettings() || {}).skippedUpdateVersion || '').trim();
    const skippedVer = parseVersion(skipped);
    const ignored = !!(best && skippedVer && skippedVer.every((n, i) => n === best.version[i]));
    // hasUpdate 只看版本是否更新；是否因忽略而不打扰用户交给渲染端按启动/手动区分
    const hasUpdate = !!(cur && best && isNewerVersion(best.version, cur));
    logger.info('update', 'update checked', {
      current,
      latest: best ? best.tag : '',
      source: best ? best.source : '',
      skipped,
      ignored,
      probed: sources.join(','),
      timings: probed.timings.join(' '),
      failures: probed.failures.join(' | '),
      hasUpdate,
    });
    return {
      current,
      hasUpdate,
      ignored,
      latest: hasUpdate ? best.tag : '',
      notes: hasUpdate ? best.notes : '',
      url: best ? best.url : RELEASES_PAGE,
      // 「还没有发行版」和「已是最新」两种情况给不同反馈；ignored 由渲染端决定是否打扰
      reason: hasUpdate ? '' : best ? 'up_to_date' : 'no_release',
    };
  });
  handle('store:create-group', (p) => unwrap(store.createGroup(p)));
  handle('store:update-group', (gid, p) => unwrap(store.updateGroup(gid, p)));
  handle('store:reorder-groups', (p) => unwrap(store.reorderGroups(p)));
  handle('store:reorder-asset', (p) => unwrap(store.reorderAsset(p)));
  handle('store:delete-group', (gid) => unwrap(store.deleteGroup(gid)));
  handle('store:create-asset', (gid, p) => unwrap(store.createAsset(gid, p)));
  handle('store:update-asset', (aid, p) => unwrap(store.updateAsset(aid, p)));
  handle('store:delete-asset', (aid) => unwrap(store.deleteAsset(aid)));
  handle('store:remove-recent', (p) => unwrap(store.removeRecent(p && p.id, p && p.method)));
  handle('store:settings', (sender) => {
    const s = store.getSettings();
    return isMainWindow(sender) ? s : withoutAiKeys(s);
  }, true);
  handle('store:update-settings', (patch) => {
    const clean = patch && typeof patch === 'object' ? { ...patch } : {};
    // 存储位置只经 app:browse-data-path 走 switchDataPath 生效，那里会一起搬日志与 AI 会话；
    // 从这条通道写 dataPath 会让指针文件、日志目录和数据文件三者分家，一律拒收。
    delete clean.dataPath;
    // AI 配置由主进程收敛类型与取值范围，渲染端递来的对象不直接落盘
    if ('ai' in clean) clean.ai = normalizeAi(clean.ai);
    if ('recentLimit' in clean) {
      clean.recentLimit = Math.min(
        RECENT_LIMIT_MAX,
        Math.max(1, Math.floor(Number(clean.recentLimit)) || RECENT_LIMIT_DEFAULT)
      );
    }
    if ('logTotalMb' in clean) clean.logTotalMb = clampedLogTotalMb(clean.logTotalMb);
    if ('zoom' in clean) clean.zoom = clampedZoom(clean.zoom);
    if ('theme' in clean && !SETTING_THEMES.includes(clean.theme)) clean.theme = 'system';
    if ('lang' in clean) clean.lang = clean.lang === 'en' ? 'en' : 'zh';
    if ('closeAction' in clean && !SETTING_CLOSE_ACTIONS.includes(clean.closeAction)) clean.closeAction = 'ask';
    if ('homeWelcome' in clean) clean.homeWelcome = !!clean.homeWelcome;
    if ('autoUpdateCheck' in clean) clean.autoUpdateCheck = !!clean.autoUpdateCheck;
    if ('skippedUpdateVersion' in clean) clean.skippedUpdateVersion = String(clean.skippedUpdateVersion || '').trim().slice(0, 60);
    const s = unwrap(store.updateSettings(clean));
    if ('logTotalMb' in clean) logStore.setTotalBytes(clean.logTotalMb * MB);
    applyZoom();
    rebuildTrayMenu();
    // AI 只记汇总，服务清单里有 baseUrl 与凭据，不进日志
    const ai = clean.ai;
    logger.info('settings', 'settings updated', {
      keys: Object.keys(clean).sort().join(','),
      theme: clean.theme,
      lang: clean.lang,
      zoom: clean.zoom,
      font: clean.font,
      closeAction: clean.closeAction,
      recentLimit: clean.recentLimit,
      logTotalMb: clean.logTotalMb,
      logDir: logStore.dir,
      aiEnabled: ai ? ai.enabled : undefined,
      aiPermission: ai ? ai.permission : undefined,
      aiServices: ai ? ai.services.length : undefined,
      aiModels: ai ? ai.services.reduce((n, sv) => n + sv.models.length, 0) : undefined,
    });
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
  /** 备份操作前的本机身份验证；导出与导入沿用同一道门槛。 */
  async function requireSystemAuth(reason) {
    const lang = store.getSettings().lang;
    const auth = await verifySystemAuth(reason, mainWindowHwnd(), {
      force: process.platform === 'darwin', lang, log: logger,
    });
    if (!auth.ok) {
      const e = new Error(auth.message || (lang === 'en' ? 'System identity verification failed' : '系统身份验证失败'));
      e.code = auth.code || 'AUTH_FAILED';
      throw e;
    }
  }

  /** 密码长度是主进程边界：渲染端表单校验不构成安全保证。 */
  function checkBackupPassword(password) {
    const pw = typeof password === 'string' ? password : '';
    if (pw.length < MIN_PASSWORD || pw.length > MAX_PASSWORD) {
      const en = store.getSettings().lang === 'en';
      throw Object.assign(
        new Error(en ? `Backup password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters` : `备份密码长度需为 ${MIN_PASSWORD}-${MAX_PASSWORD} 位`),
        { code: 'BACKUP_PASSWORD_LEN' }
      );
    }
    return pw;
  }

  handle('backup:export', async (payload) => {
    const en = store.getSettings().lang === 'en';
    const include = payload && Array.isArray(payload.include) ? payload.include : [];
    const password = checkBackupPassword(payload && payload.password);
    await requireSystemAuth(en ? 'Export NovoTerminal backup (includes sensitive information)' : '导出 NovoTerminal 备份（包含敏感信息）');
    let buffer;
    try {
      buffer = packBackup({ store, include, password, appVersion: app.getVersion() });
    } catch (e) {
      logger.error('backup', 'backup pack failed', { include, code: e.code, message: e.message });
      throw e;
    }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const parent = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
    const r = await dialog.showSaveDialog(parent, {
      title: en ? 'Save backup file' : '保存备份文件',
      defaultPath: path.join(app.getPath('documents'), 'novoterminal-backup-' + stamp + '.ntbak'),
      filters: [{ name: 'NovoTerminal Backup', extensions: ['ntbak'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, buffer);
    } catch (e) {
      logger.error('backup', 'backup write failed', { file: path.basename(r.filePath), code: e.code, message: e.message });
      throw e;
    }
    logger.info('backup', 'backup exported', { include, bytes: buffer.length, file: path.basename(r.filePath) });
    return { ok: true, path: r.filePath, bytes: buffer.length };
  });

  handle('backup:import', async (payload) => {
    const en = store.getSettings().lang === 'en';
    const password = checkBackupPassword(payload && payload.password);
    // 先解密校验密码，再要求身份验证：密码错时不必先过一道生物识别
    let parsed;
    try {
      parsed = unpackBackup({ data: payload && payload.data, password });
    } catch (e) {
      logger.warn('backup', 'backup open failed', { code: e.code, message: e.message });
      throw e;
    }
    await requireSystemAuth(en ? 'Import NovoTerminal backup (replaces current data)' : '导入 NovoTerminal 备份（将覆盖当前数据）');
    const summary = restoreBackup({ store, entries: parsed.entries });
    logStore.setTotalBytes(clampedLogTotalMb(store.getSettings().logTotalMb) * MB);
    applyZoom();
    rebuildTrayMenu();
    send('store:changed', { reason: 'backup-import' });
    logger.info('backup', 'backup imported', {
      categories: (parsed.manifest && parsed.manifest.categories) || [],
      settings: summary.settings,
      assets: summary.assets,
      aiSessions: summary.aiSessions,
    });
    return { ok: true, summary, manifest: parsed.manifest };
  });
  handle('app:browse-data-path', async () => {
    const en = store.getSettings().lang === 'en';
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: en ? 'Select application data path' : '选择应用数据存储路径',
    });
    if (r.canceled || !r.filePaths[0]) return null;
    await switchDataPath(r.filePaths[0]);
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
    /**
     * 只有发起方窗口已经没了才收回这条连接：那时没人接手。所有权在握手中被 `ssh:attach` 转走
     * 是正常交接（页签被搬到另一个窗口），不能当成取消——否则刚接手的窗口只会拿到一条已断开的会话。
     * 渲染端自己丢弃结果时（重连、关页签）都按 liveSessionId 显式断开，不需要这里兜底。
     */
    if (sender.isDestroyed()) {
      sshSessions.disconnect(result.sessionId);
      throw Object.assign(new Error('SSH connection canceled'), { code: 'SSH_CANCELED' });
    }
    store.pushRecent(hit.asset, { id: 'ssh', port: method.port || 22 });
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
  /**
   * 监控面板的开合、刷新间隔与宽度是界面偏好，但页签在宿主窗口之间移动时视图实例会被重建；
   * 存在主进程、按 tabId 取，拆分与合并就都不要求用户重开一次面板。
   * 两个入口都走 handle 的来源校验（自有窗口的主框架）；状态本身只按形状校验，不含凭据也不触发远端动作。
   */
  const monitorUi = new Map();
  handle('monitor:ui-get', (sender, tabId) => (typeof tabId === 'string' ? monitorUi.get(tabId) || null : null), true);
  handle('monitor:ui-set', (sender, tabId, ui) => {
    if (typeof tabId !== 'string' || !tabId || tabId.length > 128 || !ui || typeof ui !== 'object') {
      return { ok: false, code: 'BAD_REQUEST' };
    }
    const next = monitorUi.get(tabId) || { open: false, intervalSec: null, width: null };
    if (typeof ui.open === 'boolean') next.open = ui.open;
    if (ui.intervalSec === null || (Number.isInteger(ui.intervalSec) && ui.intervalSec >= 1 && ui.intervalSec <= 60)) {
      next.intervalSec = ui.intervalSec;
    }
    if (ui.width === null || (typeof ui.width === 'number' && ui.width >= 18 && ui.width <= 60)) next.width = ui.width;
    monitorUi.set(tabId, next);
    return { ok: true };
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
    return aiAssistant.history(req);
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
  /** 日志只留协议+主机+端口+路径：有人把凭据写进 URL（userinfo 或 query）时不能跟着进日志文件。 */
  function safeBaseUrl(baseUrl) {
    try {
      const u = new URL(baseUrl);
      u.username = '';
      u.password = '';
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch (_) {
      return '';
    }
  }
  // 这两条通道带着用户填的 baseUrl 与 Key 出网，和其他 AI 通道一样只接受可信渲染来源
  handle('ai:test', async (sender, req) => {
    const probe = aiProbe(req);
    try {
      const r = await testConnection(probe);
      logger.info('ai', 'ai service test ok', { baseUrl: safeBaseUrl(probe.baseUrl), via: r.via, ms: r.ms });
      return r;
    } catch (e) {
      logger.warn('ai', 'ai service test failed', { baseUrl: safeBaseUrl(probe.baseUrl), code: e.code || 'AI_REQUEST', message: e.message });
      throw e;
    }
  }, true);
  handle('ai:models', async (sender, req) => {
    const probe = aiProbe(req);
    try {
      const r = await listModels(probe);
      logger.info('ai', 'ai model list fetched', { baseUrl: safeBaseUrl(probe.baseUrl), ms: r.ms, models: r.models.length });
      return r;
    } catch (e) {
      logger.warn('ai', 'ai model list failed', { baseUrl: safeBaseUrl(probe.baseUrl), code: e.code || 'AI_REQUEST', message: e.message });
      throw e;
    }
  }, true);

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
    logger.info('ssh', 'ssh session re-hosted', { sessionId: sid, tabId, detached: groupOf(tabId) !== null, tailChunks: tail.chunks.length });
    return { ok: true, sessionId: sid, ready: tail.ready, tail: tail.chunks };
  }, true);

  // ---- VNC terminal (noVNC via WebSocket proxy) ----
  handle('vnc:connect', async (sender, req) => {
    const hit = store.findAsset(req.assetId);
    if (!hit) throw new Error('asset not found');
    const method = hit.asset.methods && hit.asset.methods[req.methodId];
    if (!method || !method.enabled) throw new Error('method not enabled');
    const host = String(hit.asset.host || '').trim();
    if (!host) throw Object.assign(new Error('asset host is required'), { code: 'HOST_MISSING' });
    const result = await vncSessions.connect({
      assetId: hit.asset.id,
      asset: { host },
      method: { id: req.methodId, port: method.port || 5900, advanced: method.advanced },
      advanced: method.advanced,
      ownerId: sender.id,
    });
    // 与 ssh:connect 一致：失败的握手不留「最近连接」
    store.pushRecent(hit.asset, {
      id: 'vnc',
      port: method.port || 5900,
    });
    send('store:changed', { reason: 'recent' });
    return result;
  }, true);
  handle('vnc:disconnect', (sender, sid) => vncSessions.disconnect(sid, sender.id), true);

  // ---- RDP embedded sessions (IronRDP-WASM via RDCleanPath proxy) ----
  handle('rdp:connect', async (sender, req) => {
    const hit = store.findAsset(req.assetId);
    if (!hit) throw new Error('asset not found');
    const method = hit.asset.methods && hit.asset.methods[req.methodId];
    if (!method || !method.enabled) throw new Error('method not enabled');
    const host = String(hit.asset.host || '').trim();
    if (!host) throw Object.assign(new Error('asset host is required'), { code: 'HOST_MISSING' });
    const result = await rdpSessions.connect({
      assetId: hit.asset.id,
      asset: { host },
      method: { id: req.methodId, port: method.port || 3389, advanced: method.advanced },
      advanced: method.advanced,
      ownerId: sender.id,
    });
    store.pushRecent(hit.asset, {
      id: 'rdp',
      port: method.port || 3389,
    });
    send('store:changed', { reason: 'recent' });
    return result;
  }, true);
  handle('rdp:disconnect', (sender, sid) => rdpSessions.disconnect(sid, sender.id), true);

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

  /**
   * 页签描述符是跨窗口搬运的唯一载体：只认白名单字段，其余一概不收。
   * liveSessionId / connState 由宿主窗口通过 session:tab-state 现报现存。
   */
  const readTab = (req) => {
    const id = String((req && req.id) || '');
    const kind = String((req && req.kind) || '');
    if (!id || !DETACHABLE_KINDS.includes(kind)) {
      throw Object.assign(new Error('Not a detachable session tab'), { code: 'DETACH_KIND' });
    }
    return {
      id,
      kind,
      title: String(req.title || ''),
      icon: String(req.icon || ''),
      os: String(req.os || ''),
      assetId: String(req.assetId || ''),
      methodId: String(req.methodId || kind),
      host: String(req.host || ''),
      port: req.port === undefined || req.port === null ? '' : String(req.port),
      connState: String(req.connState || 'idle'),
      liveSessionId: req.liveSessionId ? String(req.liveSessionId) : null,
    };
  };

  const senderGroup = (sender) => {
    for (const group of detachedGroups.values()) {
      if (!group.window.isDestroyed() && group.window.webContents === sender) return group;
    }
    return null;
  };

  /** 独立窗口为空即关闭；页签全部搬走后不留空壳，和浏览器一致。 */
  function closeGroupIfEmpty(group) {
    if (!group || group.tabIds.length || group.window.isDestroyed()) return;
    group.reason = 'emptied';
    group.window.close();
  }

  /** SSH 连接跟着页签走：换宿主只转移该页签那条会话的所有权，其余会话不受影响。 */
  function handoverTab(tab, fromWindow, toWindow) {
    const sid = tab.kind === 'ssh' ? tab.liveSessionId : null;
    if (sid && sshSessions && sshSessions.sessions.has(sid)) {
      sshSessions.transferOwner(sid, toWindow.webContents.id);
    }
    if (fromWindow && !fromWindow.isDestroyed() && fromWindow !== toWindow) {
      // 交出的那一侧销毁视图时必须不断开连接，VNC/RDP 由新宿主重新握手。
      fromWindow.webContents.send('session:handover', { tabId: tab.id });
    }
    return sid;
  }

  /**
   * 页签回到主窗口页签栏。落点位置由主窗口自己在 drop 时记下（store.setDockTarget），
   * 收回广播到达时消费一次；主窗口不需要主进程再告诉它顺序。
   */
  function dockToHost(tabId) {
    const tab = detachedTabs.get(tabId);
    if (!tab) throw Object.assign(new Error('Unknown session tab'), { code: 'DOCK_TAB' });
    const group = groupOf(tabId);
    if (!group) return { ok: true, same: true };
    const sid = handoverTab(tab, group.window, win);
    group.tabIds = group.tabIds.filter((id) => id !== tabId);
    tabGroup.delete(tabId);
    detachedTabs.delete(tabId);
    sendGroup(group);
    closeGroupIfEmpty(group);
    sendToHost('session:detached', { tabId, detached: false });
    logger.info('session', 'session tab rehosted to host window', { tabId, kind: tab.kind, sessionId: sid || '' });
    return { ok: true };
  }

  async function createGroup(tab, dropAt, dropArea) {
    const { width, height } = sizedToWorkArea(0.55, 0.65, 900, 560, dropArea);
    const options = {
      width,
      height,
      minWidth: 520,
      minHeight: 320,
      title: tab.title || tab.host || tab.id,
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
    if (dropAt && dropArea) {
      options.x = Math.max(dropArea.x, Math.min(dropAt.x - width / 2, dropArea.x + dropArea.width - width));
      options.y = Math.max(dropArea.y, Math.min(dropAt.y - height / 2, dropArea.y + dropArea.height - height));
    }
    const gid = 'w' + (++detachedGroupSeq);
    const group = { id: gid, window: new BrowserWindow(options), tabIds: [tab.id], ready: false, confirming: false, dead: false, reason: '' };
    detachedGroups.set(gid, group);
    tabGroup.set(tab.id, gid);
    detachedTabs.set(tab.id, tab);

    const detached = group.window;
    const wcId = detached.webContents.id;
    detached.on('page-title-updated', (e) => {
      e.preventDefault();
    });
    detached.on('closed', () => {
      if (detachedGroups.get(gid) !== group) return;
      detachedGroups.delete(gid);
      // closed 之后 webContents 已经没了，只能用创建时记下的 id 摘掉它上报的页签栏矩形。
      tabbarRects.delete(wcId);
      restoreDockTargets();
      clearDockGhosts();
      // 还留在这里的页签是跟着窗口一起没的；搬走的页签早已从 tabIds 里摘掉。
      for (const tabId of group.tabIds) {
        tabGroup.delete(tabId);
        detachedTabs.delete(tabId);
        monitorUi.delete(tabId);
        sendToHost('session:closed', { tabId });
      }
      logger.info('session', 'detached window closed', { groupId: gid, reason: group.reason || 'window', tabs: group.tabIds.length });
    });
    /**
     * 关窗先问该窗口：只有它知道每个页签的连接状态，所以拦截 close 并把页签清单交给页面答复；
     * 页面确认后由这里真关，留下的会话随该窗口 webContents 一起释放。
     * 渲染进程已死、尚未就绪或应用正在退出时不能弹这个确认，否则窗口永远关不掉。
     */
    detached.on('close', (e) => {
      if (!group.ready || group.reason || group.confirming || group.dead || appQuitting) return;
      e.preventDefault();
      group.confirming = true;
      detached.webContents.send('session:confirm-close', { tabIds: group.tabIds.slice() });
    });
    detached.webContents.on('render-process-gone', () => {
      // 渲染进程死了就没人能答复关闭确认，也没人能报告拖放结束，三件事都在这里收尾。
      group.dead = true;
      restoreDockTargets();
      clearDockGhosts();
    });
    try {
      await loadSessionRoute(detached, 'window?gid=' + gid);
    } catch (e) {
      detachedGroups.delete(gid);
      tabGroup.delete(tab.id);
      detachedTabs.delete(tab.id);
      if (!detached.isDestroyed()) detached.destroy();
      logger.error('session', 'detach window load failed', { groupId: gid, tabId: tab.id, message: e.message, code: e.code });
      throw e;
    }
    group.ready = true;
    return group;
  }

  /**
   * 拖出栏外＝把页签交给新建的独立窗口。请求方可以是主窗口，也可以是某个独立窗口
   * （从它的页签栏再拆出去），所以只校验"请求方当前确实持有这个页签"。
   */
  handle('session:detach', async (sender, req) => {
    const fromWindow = BrowserWindow.fromWebContents(sender);
    if (!fromWindow) throw Object.assign(new Error('Untrusted detach request'), { code: 'SSH_OWNER' });
    const tab = readTab(req && req.tab);
    const ownGroup = senderGroup(sender);
    if (ownGroup && !ownGroup.tabIds.includes(tab.id)) {
      // 这个窗口已经不再持有它了（刚被别的窗口接走）：想要的结果已经成立，不再报错。
      return { ok: true, cancelled: true };
    }
    if (!ownGroup) {
      const existing = groupOf(tab.id);
      if (existing) {
        existing.window.focus();
        return { ok: true, reused: true };
      }
    }

    let dropAt = null;
    let dropArea = null;
    if (req && req.fromDrag) {
      const point = screen.getCursorScreenPoint();
      const bar = tabbarScreenRect(sender.id);
      const overOwnBar =
        bar &&
        point.x >= bar.x &&
        point.x <= bar.x + bar.width &&
        point.y >= bar.y &&
        point.y <= bar.y + bar.height;
      if (overOwnBar) return { ok: true, cancelled: true };
      dropAt = point;
      // getDisplayMatching requires a full rect (x/y/width/height) in Electron 33.
      dropArea = screen.getDisplayMatching({ x: point.x, y: point.y, width: 1, height: 1 }).workArea;
    }

    const dropInto = req && req.groupId ? String(req.groupId) : '';
    const group = dropInto
      ? detachedGroups.get(dropInto)
      : await createGroup(tab, dropAt, dropArea);
    if (dropInto && (!group || group.window.isDestroyed())) {
      throw Object.assign(new Error('Unknown target group'), { code: 'SSH_OWNER' });
    }
    if (ownGroup) {
      ownGroup.tabIds = ownGroup.tabIds.filter((id) => id !== tab.id);
      // createGroup 已经把这条页签记到新组名下了，只有归属还指向旧组时才需要摘掉。
      if (tabGroup.get(tab.id) === ownGroup.id) tabGroup.delete(tab.id);
      sendGroup(ownGroup);
      closeGroupIfEmpty(ownGroup);
    }
    if (dropInto) {
      const at = req.beforeTabId ? group.tabIds.indexOf(String(req.beforeTabId)) : -1;
      if (at >= 0) group.tabIds.splice(at, 0, tab.id);
      else group.tabIds.push(tab.id);
      tabGroup.set(tab.id, group.id);
      detachedTabs.set(tab.id, tab);
      sendGroup(group);
    }
    if (!ownGroup) sendToHost('session:detached', { tabId: tab.id, detached: true });
    logger.info('session', 'session tab handed to a detached window', {
      groupId: group.id, tabId: tab.id, kind: tab.kind, host: tab.host, port: tab.port, from: ownGroup ? ownGroup.id : 'host',
    });
    return { ok: true, reused: false, groupId: group.id };
  }, true);

  /** 独立窗口启动时领取自己该显示哪些页签；主窗口不需要（它持有全量 store.tabs）。 */
  handle('session:group-tabs', (sender, req) => {
    const group = senderGroup(sender);
    if (!group || String((req && req.groupId) || '') !== group.id) {
      throw Object.assign(new Error('No group for this window'), { code: 'SSH_OWNER' });
    }
    return groupSnapshot(group);
  }, true);

  /** 独立窗口内部重排：顺序只有主进程记着才在下一次搬入时不跑偏。 */
  handle('session:group-order', (sender, req) => {
    const group = senderGroup(sender);
    if (!group) throw Object.assign(new Error('Not a detached window'), { code: 'SSH_OWNER' });
    const ids = Array.isArray(req && req.tabIds) ? req.tabIds.map(String) : [];
    if (ids.length !== group.tabIds.length || ids.some((id) => !group.tabIds.includes(id))) return { ok: false };
    group.tabIds = ids;
    return { ok: true };
  }, true);

  /**
   * 连接状态与实际会话 id 只存在于当前宿主窗口。回灌给主进程缓存，再转给主窗口那份副本，
   * 否则页签收回后小圆点是旧的、关闭确认也会判错。
   */
  handle('session:tab-state', (sender, req) => {
    const tabId = String((req && req.tabId) || '');
    const group = senderGroup(sender);
    const cached = detachedTabs.get(tabId);
    // 状态回灌是 fire-and-forget：页签刚被别的窗口接走时这条会晚到，静默丢弃即可。
    if (!group || !cached || !group.tabIds.includes(tabId)) return { ok: false };
    const connState = String(req.connState || 'idle');
    cached.connState = ['connecting', 'ready', 'error', 'idle'].includes(connState) ? connState : 'idle';
    if (req.liveSessionId !== undefined) cached.liveSessionId = req.liveSessionId ? String(req.liveSessionId) : null;
    sendHostTabState(cached);
    return { ok: true };
  }, true);

  /**
   * 独立窗口里的"复制会话"：页签 id 只能由主窗口分配（它看得见全部页签，含停放的那些），
   * 主进程只把请求转给它。主窗口建好这条页签后立刻按 groupId 交回本窗口，连接由本窗口的视图发起，
   * 所以点下去就能看到一条「连接中」的新页签，和在主窗口里复制一模一样。
   */
  handle('session:tab-copy', (sender, req) => {
    const group = senderGroup(sender);
    const tabId = String((req && req.tabId) || '');
    const source = detachedTabs.get(tabId);
    if (!group || !group.tabIds.includes(tabId) || !source) {
      throw Object.assign(new Error('This window does not host that tab'), { code: 'SSH_OWNER' });
    }
    sendToHost('session:tab-copy-request', { tab: { ...source }, groupId: group.id });
    logger.info('session', 'session copy requested', { groupId: group.id, tabId, kind: source.kind });
    return { ok: true };
  }, true);

  /** 独立窗口里关掉一个页签：会话随该窗口的 webContents 结束，主窗口那份副本也要删除。 */
  handle('session:tab-close', (sender, req) => {
    const group = senderGroup(sender);
    const tabId = String((req && req.tabId) || '');
    // 页签刚被别的窗口接走时这条会晚到，重复关闭按已完成处理。
    if (!group || !group.tabIds.includes(tabId)) return { ok: true, same: true };
    group.tabIds = group.tabIds.filter((id) => id !== tabId);
    tabGroup.delete(tabId);
    detachedTabs.delete(tabId);
    monitorUi.delete(tabId);
    sendGroup(group);
    sendToHost('session:closed', { tabId });
    closeGroupIfEmpty(group);
    logger.info('session', 'session tab closed inside a detached window', { groupId: group.id, tabId });
    return { ok: true };
  }, true);

  /** 活动页签决定独立窗口的标题，和浏览器一样跟着切。 */
  handle('session:tab-active', (sender, req) => {
    const group = senderGroup(sender);
    const tab = detachedTabs.get(String((req && req.tabId) || ''));
    if (!group || !tab || !group.tabIds.includes(tab.id)) return { ok: false };
    if (!group.window.isDestroyed()) group.window.setTitle(tab.title || tab.host || tab.id);
    return { ok: true };
  }, true);

  /** 该窗口的答复：confirmed 为真才真关；页面取消确认时只解除这次拦截。 */
  handle('session:close-answer', (sender, req) => {
    const group = senderGroup(sender);
    if (!group) throw Object.assign(new Error('Not a detached window'), { code: 'SSH_OWNER' });
    if (!group.confirming) return { ok: true, closed: false };
    group.confirming = false;
    if (req && req.confirmed === true) {
      group.reason = 'window';
      group.window.close();
      logger.info('session', 'detached window closed after confirm', { groupId: group.id, tabs: group.tabIds.length });
      return { ok: true, closed: true };
    }
    logger.info('session', 'detached window close refused', { groupId: group.id, live: (req && req.liveCount) || 0 });
    return { ok: true, closed: false };
  }, true);

  /** 每个宿主窗口都上报自己的页签栏矩形，"拖出栏外"只跟自己那条栏比。 */
  handle('session:tabbar-bounds', (sender, req) => {
    const w = BrowserWindow.fromWebContents(sender);
    if (!w || (w !== win && !senderGroup(sender))) {
      throw Object.assign(new Error('Untrusted tab bar bounds'), { code: 'SSH_OWNER' });
    }
    const width = Number(req && req.width);
    const height = Number(req && req.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      tabbarRects.delete(sender.id);
      return { ok: true };
    }
    // 页面 CSS px 在缩放 1 时与屏幕 px 一比一；窗口偏移每次命中判定现取，搬动主窗口不会让落点过期。
    tabbarRects.set(sender.id, {
      window: w,
      rect: {
        x: Math.round(Number(req.x || 0)),
        y: Math.round(Number(req.y || 0)),
        width: Math.round(width),
        height: Math.round(height),
      },
    });
    return { ok: true };
  }, true);

  /**
   * 页签拖放是唯一搬运入口：源窗口 dragstart 时交来描述符并抬起其他宿主窗口，
   * 目标窗口 drop 时发 tab-move，Chromium 才会把拖放判给它。
   */
  handle('session:dock-prepare', (sender, req) => {
    const fromWindow = BrowserWindow.fromWebContents(sender);
    if (!fromWindow) throw Object.assign(new Error('Untrusted dock request'), { code: 'SSH_OWNER' });
    const tab = readTab(req && req.tab);
    const group = senderGroup(sender);
    if (group && !group.tabIds.includes(tab.id)) {
      throw Object.assign(new Error('This window does not host that tab'), { code: 'SSH_OWNER' });
    }
    // 目标窗口只有描述符就能重建页签；宿主关系不变，取消拖放也不会留下任何痕迹。
    detachedTabs.set(tab.id, { ...(detachedTabs.get(tab.id) || {}), ...tab });
    raiseDockTargets(fromWindow);
    return { ok: true };
  }, true);

  handle('session:dock-abort', (sender) => {
    // 只有起手那个窗口的 dragend 才有权收回这次抬层。
    if (dockRaise && dockRaise.source === BrowserWindow.fromWebContents(sender)) {
      restoreDockTargets();
      clearDockGhosts();
    }
    // 描述符不在这里清：源窗口的 dragend 可能早于目标窗口的 drop 到达，清了会把一次正常投放
    // 误判成"未知页签"。它只会被下一次同 id 的 prepare 覆盖，留着不影响任何判定。
    return { ok: true };
  }, true);

  /** 落点在哪个窗口，哪个窗口来报；主窗口收到就是收回，独立窗口收到就是换宿主。 */
  handle('session:tab-move', (sender, req) => {
    const toWindow = req && req.to === 'host' ? win : BrowserWindow.fromWebContents(sender);
    // 投放成功就到此为止：停止轮询、把接收方抬到最前并交给它焦点，而不是把起手窗口放回去。
    restoreDockTargets(toWindow);
    const tabId = String((req && req.tabId) || '');
    const tab = detachedTabs.get(tabId);
    if (!toWindow || toWindow.isDestroyed()) throw Object.assign(new Error('Unknown target window'), { code: 'SSH_OWNER' });
    if (!tab) throw Object.assign(new Error('Unknown session tab'), { code: 'DOCK_TAB' });
    if (toWindow === win) return dockToHost(tabId);
    const toGroup = senderGroup(sender);
    if (!toGroup) throw Object.assign(new Error('Unknown target window'), { code: 'SSH_OWNER' });
    const fromGroup = groupOf(tabId);
    if (fromGroup === toGroup) return { ok: true, same: true };
    if (fromGroup) {
      handoverTab(tab, fromGroup.window, toWindow);
      fromGroup.tabIds = fromGroup.tabIds.filter((id) => id !== tabId);
      sendGroup(fromGroup);
      closeGroupIfEmpty(fromGroup);
    } else {
      // 从主窗口页签栏拖进来：主窗口那份副本要标成已拆出，否则同一条页签会出现在两处。
      handoverTab(tab, win, toWindow);
      sendToHost('session:detached', { tabId, detached: true });
    }
    const at = req && req.beforeTabId ? toGroup.tabIds.indexOf(String(req.beforeTabId)) : -1;
    if (at >= 0) toGroup.tabIds.splice(at, 0, tabId);
    else toGroup.tabIds.push(tabId);
    tabGroup.set(tabId, toGroup.id);
    sendGroup(toGroup);
    logger.info('session', 'session tab moved between windows', {
      tabId, kind: tab.kind, from: fromGroup ? fromGroup.id : 'host', to: toGroup.id,
    });
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
    if (!hit) throw Object.assign(new Error('asset not found'), { code: 'SFTP_NO_ASSET' });
    const meta = sftpManager.sessionMeta(hit.asset);
    store.pushRecent(hit.asset, { id: 'sftp', port: meta.port });
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
    const panelSize = sizedToWorkArea(0.6, 0.7, 1000, 640);
    const panel = new BrowserWindow({
      width: panelSize.width,
      height: panelSize.height,
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

  /**
   * SFTP 的通道全部按「调用来源 + 会话归属」放行：connId/taskId 只能操作发起窗口自己持有的会话，
   * 本机的删除/改名/复制只接受绝对路径，目录项名不得带分隔符。
   */
  const sftpNotOwner = () =>
    Object.assign(new Error('SFTP session is not owned by this window'), { code: 'SFTP_OWNER' });
  const sftpBadPath = () => Object.assign(new Error('invalid local path'), { code: 'LOCAL_PATH' });
  const sftpConnOwner = (sender, connId) => {
    const rec = sftpManager.conns.get(connId);
    // 会话不存在要说「已断开」，别报成「不属于本窗口」
    if (!rec) throw Object.assign(new Error('SFTP session not found'), { code: 'SFTP_NO_CONN' });
    if (rec.ownerId !== sender.id) throw sftpNotOwner();
    return connId;
  };
  const sftpTaskOwner = (sender, ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === 'string' && x.length > 0);
    list.forEach((id) => {
      const task = sftpManager.tasks.get(id);
      if (task) sftpConnOwner(sender, task.connId);
    });
    return list;
  };
  const sftpRemotePath = (p) => {
    if (p != null && typeof p !== 'string') throw sftpBadPath();
    return typeof p === 'string' ? p : '';
  };
  const sftpLocalPath = (p) => {
    if (typeof p !== 'string' || !p || !path.isAbsolute(p)) throw sftpBadPath();
    // Windows 下 '/x' 只是当前盘的根相对路径，不能当作绝对目录用
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(p) && p.indexOf('\\\\') !== 0) throw sftpBadPath();
    return p;
  };
  const sftpLocalPathOrHome = (p) => (p == null || p === '' ? p : sftpLocalPath(p));
  const sftpLocalName = (name) => {
    const s = String(name == null ? '' : name).trim();
    if (!s || s === '.' || s === '..') throw sftpBadPath();
    // 只有 Windows 需要挡分隔符；POSIX 文件名里反斜杠是合法字符
    if (process.platform === 'win32' && /[\\/]/.test(s)) throw sftpBadPath();
    return s;
  };

  handle('sftp:open', (sender, req) => sftpManager.openSession({ assetId: req && req.assetId, ...sshRequestContext(sender) }), true);
  handle('sftp:list', (sender, connId, remotePath) => sftpManager.list(sftpConnOwner(sender, connId), sftpRemotePath(remotePath)), true);
  handle('sftp:stat', (sender, connId, remotePath) => sftpManager.stat(sftpConnOwner(sender, connId), sftpRemotePath(remotePath)), true);
  handle('sftp:local-exists', (sender, p) => sftpManager.localExists(sftpLocalPath(p)), true);
  handle('sftp:local-list', (sender, p) => sftpManager.localList(sftpLocalPathOrHome(p)), true);
  handle('sftp:drives', () => sftpManager.drives());
  handle('sftp:mkdir', (sender, connId, remotePath) => sftpManager.mkdir(sftpConnOwner(sender, connId), sftpRemotePath(remotePath)), true);
  handle('sftp:mkdirp', (sender, connId, remotePath) => sftpManager.mkdirp(sftpConnOwner(sender, connId), sftpRemotePath(remotePath)), true);
  handle('sftp:rename', (sender, connId, oldPath, newPath) => sftpManager.rename(sftpConnOwner(sender, connId), sftpRemotePath(oldPath), sftpRemotePath(newPath)), true);
  handle('sftp:unlink', (sender, connId, remotePath, isDir) =>
    sftpManager.unlink(sftpConnOwner(sender, connId), sftpRemotePath(remotePath), !!isDir), true);
  handle('sftp:local-mkdir', (sender, dirPath, name) => sftpManager.localMkdir(sftpLocalPath(dirPath), sftpLocalName(name)), true);
  handle('sftp:local-rename', (sender, oldPath, newPath) => sftpManager.localRename(sftpLocalPath(oldPath), sftpLocalPath(newPath)), true);
  handle('sftp:local-unlink', (sender, p, isDir) => sftpManager.localUnlink(sftpLocalPath(p), !!isDir), true);
  handle('sftp:local-copy', (sender, src, destDir) => {
    const from = sftpLocalPath(src);
    const to = sftpLocalPath(destDir);
    const dest = path.join(to, path.basename(from));
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      fs.cpSync(from, dest, { recursive: true, force: true });
    } else {
      fs.copyFileSync(from, dest);
    }
    return { ok: true, path: dest };
  }, true);
  handle('sftp:upload', (sender, req) => {
    const connId = sftpConnOwner(sender, req && req.connId);
    return sftpManager.upload({ connId, localPath: sftpLocalPath(req.localPath), remotePath: sftpRemotePath(req.remotePath) });
  }, true);
  handle('sftp:download', (sender, req) => {
    const connId = sftpConnOwner(sender, req && req.connId);
    return sftpManager.download({ connId, remotePath: sftpRemotePath(req.remotePath), localPath: sftpLocalPath(req.localPath) });
  }, true);
  handle('sftp:pause', (sender, taskId, pause) => sftpManager.pauseTask(sftpTaskOwner(sender, taskId)[0], !!pause), true);
  handle('sftp:cancel', (sender, taskId) => sftpManager.markCanceled(sftpTaskOwner(sender, taskId)[0]), true);
  handle('sftp:pause-batch', (sender, ids, pause) => sftpManager.pauseTasks(sftpTaskOwner(sender, ids), !!pause), true);
  handle('sftp:cancel-batch', (sender, ids) => sftpManager.cancelTasks(sftpTaskOwner(sender, ids)), true);
  handle('sftp:tasks', (sender, connId) => sftpManager.listTasks(sftpConnOwner(sender, connId)), true);
  handle('sftp:close', (sender, connId) => {
    const rec = sftpManager.conns.get(connId);
    if (rec && rec.ownerId !== sender.id) throw sftpNotOwner();
    return sftpManager.closeSession(connId);
  }, true);
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
  handle('sftp:pick-local-dir', (sender) => {
    const en = store.getSettings().lang === 'en';
    const parent = BrowserWindow.fromWebContents(sender) || win;
    return dialog
      .showOpenDialog(parent, {
        properties: ['openDirectory', 'createDirectory'],
        title: en ? 'Select save folder' : '选择保存目录',
      })
      .then((r) => (r.canceled ? null : r.filePaths[0]));
  }, true);
}

app.whenReady().then(() => {
  // 日志目录跟随「存储位置」，因此数据仓库必须先于 LogStore 建立
  store = new AssetStore(logger);
  logStore = new LogStore({
    dir: store.logsDir(),
    totalBytes: clampedLogTotalMb(store.getSettings().logTotalMb) * MB,
    onNew: (entry) => send('log:new', entry),
  });
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
  // 独立窗口的关窗拦截在这里让路，否则带着活动会话的子窗口会把退出卡在确认上。
  appQuitting = true;
  // Clean up sessions always. Tray cleanup must happen so macOS doesn't leak it.
  resetAuthCache();
  if (store) store.flushPersist();
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
