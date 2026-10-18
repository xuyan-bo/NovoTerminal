const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { AI_DEFAULTS } = require('../ai/aiSettings');

const CIPHER_PREFIX = 'novoterminal1:';

function newId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

const RECENT_LIMIT_DEFAULT = 20;
const RECENT_LIMIT_MAX = 100;
const LOG_TOTAL_DEFAULT_MB = 20;
const LOG_TOTAL_MIN_MB = 10;
const LOG_TOTAL_MAX_MB = 200;

/** 凭证库的取值边界：秘密字段整库密文落盘，这里只收类型与长度，不做字段级加密。 */
const CREDENTIAL_KINDS = ['password', 'key'];
const CREDENTIAL_NAME_MAX = 128;
const CREDENTIAL_USER_MAX = 256;
const CREDENTIAL_NOTE_MAX = 512;
const CREDENTIAL_SECRET_MAX = 8192;
const CREDENTIAL_PASSPHRASE_MAX = 512;

/** 最近连接缺端口时的回落值；只登记主进程真正支持的协议 */
const RECENT_DEFAULT_PORTS = new Map([
  ['ssh', 22],
  ['sftp', 22],
  ['vnc', 5900],
  ['rdp', 3389],
]);

/** 系统自带编辑器的默认值：只有主进程知道真实平台与 SystemRoot，渲染端拿不到。 */
function defaultFileEditor() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
  }
  if (process.platform === 'darwin') return '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit';
  return 'xdg-open';
}

/** 文本型凭证字段的边界收敛：脏值、非字符串都回落到空串。 */
function credText(value, max) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  return s.slice(0, max);
}

/** 快照会下发到每个窗口，凭证只带摘要；秘密字段留在主进程，取用走 credential:reveal。 */
function credentialSummary(c) {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    user: c.user || '',
    note: c.note || '',
    createdAt: c.createdAt || 0,
    updatedAt: c.updatedAt || 0,
  };
}

/** 表单提交与持久化记录共用同一套归一化，只保留当前类型用到的秘密。 */
function normalizeCredential(input, base) {
  const src = input && typeof input === 'object' ? input : {};
  const kind = CREDENTIAL_KINDS.includes(src.kind) ? src.kind : 'password';
  const out = {
    id: base && base.id ? base.id : newId('c'),
    kind,
    name: credText(src.name, CREDENTIAL_NAME_MAX).trim(),
    user: credText(src.user, CREDENTIAL_USER_MAX),
    note: credText(src.note, CREDENTIAL_NOTE_MAX),
    createdAt: base && base.createdAt ? base.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
  if (kind === 'key') {
    out.privateKey = credText(src.privateKey, CREDENTIAL_SECRET_MAX);
    out.passphrase = credText(src.passphrase, CREDENTIAL_PASSPHRASE_MAX);
  } else {
    out.pass = credText(src.pass, CREDENTIAL_SECRET_MAX);
  }
  return out;
}

// 与 src/constants.js 的 ASSET_ICONS 保持一致，缺项会在保存时被回落成 generic
const ASSET_ICONS = ['win', 'mac', 'linux', 'router', 'nas', 'firewall', 'generic'];
/** 主凭证三选一；方式级自定义只有两档，两边都没配凭证时由连接入口当场询问。 */
const MAIN_AUTH_MODES = ['none', 'inline', 'credential'];
const METHOD_AUTH_MODES = ['inline', 'credential'];
const ID_MAX = 64;

/**
 * 各访问方式能消费的凭证类型；与 src/protocols.js 的 authKinds 同义，
 * 主进程不 import 渲染端注册表（那份带 .vue 的动态 import）。
 */
const AUTH_KINDS_BY_METHOD = {
  ssh: ['password', 'key'],
  sftp: ['password', 'key'],
  rdp: ['password'],
  vnc: ['password'],
};

function authKindsFor(methodId) {
  return Object.prototype.hasOwnProperty.call(AUTH_KINDS_BY_METHOD, methodId)
    ? AUTH_KINDS_BY_METHOD[methodId]
    : ['password'];
}

function idText(value) {
  return String(value == null ? '' : value).slice(0, ID_MAX);
}

/** 主凭证：用户名与口令同属一份凭证，换模式即清掉另一模式的残留。 */
function normalizeMainAuth(input) {
  const src = input && typeof input === 'object' ? input : {};
  const mode = MAIN_AUTH_MODES.includes(src.mode) ? src.mode : 'none';
  if (mode === 'inline') {
    return {
      mode,
      user: credText(src.user, CREDENTIAL_USER_MAX),
      pass: credText(src.pass, CREDENTIAL_SECRET_MAX),
    };
  }
  if (mode === 'credential') return { mode, credentialId: idText(src.credentialId) };
  return { mode: 'none' };
}

/** 方式级凭证：返回 null 表示沿用主凭证，界面上就是那颗「主凭证」胶囊。 */
function normalizeMethodAuth(input) {
  const src = input && typeof input === 'object' ? input : null;
  if (!src || src.use !== 'custom') return null;
  const mode = METHOD_AUTH_MODES.includes(src.mode) ? src.mode : 'inline';
  if (mode === 'credential') {
    const credentialId = idText(src.credentialId);
    return credentialId ? { use: 'custom', mode: 'credential', credentialId } : null;
  }
  return {
    use: 'custom',
    mode: 'inline',
    user: credText(src.user, CREDENTIAL_USER_MAX),
    pass: credText(src.pass, CREDENTIAL_SECRET_MAX),
  };
}

/** 行存在即启用；高级参数原样保留，取值由所属方式在使用时按 schema 收敛。 */
function normalizeAssetMethods(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const id of Object.keys(src)) {
    const conf = src[id] && typeof src[id] === 'object' ? src[id] : null;
    if (!conf) continue;
    const port = Number(conf.port);
    const row = { port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0 };
    const advanced =
      conf.advanced && typeof conf.advanced === 'object' && !Array.isArray(conf.advanced)
        ? conf.advanced
        : null;
    if (advanced && Object.keys(advanced).length) row.advanced = advanced;
    const auth = normalizeMethodAuth(conf.auth);
    if (auth) row.auth = auth;
    out[id] = row;
  }
  return out;
}

/** 读库与导入共用的收敛：脏值、越界端口回落到默认，消费端只见到一种形状。 */
function normalizeAssets(nodes) {
  if (!Array.isArray(nodes)) return;
  nodes.forEach((node) => {
    if (!node || typeof node !== 'object') return;
    node.icon = ASSET_ICONS.includes(node.icon) ? node.icon : 'generic';
    node.auth = normalizeMainAuth(node.auth);
    node.methods = normalizeAssetMethods(node.methods);
  });
}

function defaultData() {
  return {
    version: 3,
    groups: [],
    credentials: [],
    recent: [],
    settings: {
      theme: 'system',
      lang: 'zh',
      dataPath: '',
      zoom: 100,
      font: 'default',
      closeAction: 'ask', // 'ask' = 每次询问, 'minimize' = 直接最小化, 'quit' = 直接退出
      homeWelcome: true,
      autoUpdateCheck: true,
      // SFTP「编辑文件」调用的程序；清空即视为无可用编辑器，不再回落到系统默认
      fileEditor: defaultFileEditor(),
      // 用户勾选「忽略此版本」后记住的发行版标签；同版本不再提示更新
      skippedUpdateVersion: '',
      recentLimit: RECENT_LIMIT_DEFAULT,
      logTotalMb: LOG_TOTAL_DEFAULT_MB,
      // AI 助手配置：结构与取值范围由 electron/ai/aiSettings.js 收敛，这里只给持久化默认值
      ai: { ...AI_DEFAULTS, services: [], defaultRef: null },
    },
  };
}

function defaultDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

// Sidecar in the default dir recording the active data directory, so a custom
// location survives restarts (the real DB may live elsewhere).
function pointerFile() {
  return path.join(defaultDataDir(), 'location');
}

class AssetStore {
  constructor(log) {
    this.log = log || null;
    this.file = this.resolveActiveFile();
    this.backupFile = this.file + '.bak';
    this.data = defaultData();
    this.archiveBeforeOverwrite = false;
    this.load();
  }

  resolveActiveFile() {
    const defaultFile = path.join(defaultDataDir(), 'novoterminal.json');
    let dir;
    try {
      dir = fs.readFileSync(pointerFile(), 'utf8').trim();
    } catch (_) {
      return defaultFile;
    }
    const target = dir && path.join(dir, 'novoterminal.json');
    return target && target !== defaultFile && fs.existsSync(target) ? target : defaultFile;
  }

  writePointer() {
    const dir = defaultDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const ptr = pointerFile();
    try {
      if (path.dirname(this.file) === dir) fs.rmSync(ptr, { force: true });
      else fs.writeFileSync(ptr, path.dirname(this.file), 'utf8');
    } catch (_) {}
  }

  setCustomPath(dir) {
    if (!dir) return this.file;
    const target = path.join(dir, 'novoterminal.json');
    if (target === this.file) return this.file;
    this.file = target;
    this.backupFile = target + '.bak';
    if (fs.existsSync(target)) {
      // an existing database already lives here → switch to it
      this.load();
    } else {
      // empty location → move the current data there instead of resetting
      this.data.settings.dataPath = dir;
      this.persist();
    }
    this.writePointer();
    return this.file;
  }

  /** 主动读回当前库（解密 + 解析），用于搬迁后确认新位置可用再清理旧副本 */
  verifyActiveFile() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const plain = raw.startsWith(CIPHER_PREFIX)
        ? safeStorage.decryptString(Buffer.from(raw.slice(CIPHER_PREFIX.length), 'base64'))
        : raw;
      return !!JSON.parse(plain);
    } catch (_) {
      return false;
    }
  }

  /** 数据已经写到新位置后，删掉原目录里遗留的库文件；只碰主库与它的备份 */
  discardMovedFiles(fromDir) {
    const removed = [];
    for (const name of ['novoterminal.json', 'novoterminal.json.bak']) {
      const p = path.join(fromDir, name);
      if (path.resolve(p) === path.resolve(this.file) || path.resolve(p) === path.resolve(this.backupFile)) continue;
      try {
        fs.rmSync(p, { force: true });
        removed.push(name);
      } catch (_) {}
    }
    return removed;
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) {
        this.data = defaultData();
        // 首次建库时若加密不可用会抛错：不能因落盘失败拦死启动，日志记录后以内存默认值继续
        try {
          this.persist();
        } catch (e) {
          console.error('[store] initial persist failed', e);
        }
        return;
      }
      const raw = fs.readFileSync(this.file, 'utf8');
      let parsed;
      if (raw.startsWith(CIPHER_PREFIX)) {
        const buf = Buffer.from(raw.slice(CIPHER_PREFIX.length), 'base64');
        const plain = safeStorage.decryptString(buf);
        parsed = JSON.parse(plain);
      } else {
        parsed = JSON.parse(raw);
      }
      this.data = this.mergeParsed(parsed);
      this.normalizeTree();
      this.data.settings.dataPath = path.dirname(this.file);
    } catch (e) {
      console.error('[store] load failed', e);
      let recovered = false;
      try {
        if (fs.existsSync(this.backupFile)) {
          // 备份是上一份主库的副本，与主库同为密文，必须按 CIPHER_PREFIX 解密后再解析
          const braw = fs.readFileSync(this.backupFile, 'utf8');
          const bplain = braw.startsWith(CIPHER_PREFIX)
            ? safeStorage.decryptString(Buffer.from(braw.slice(CIPHER_PREFIX.length), 'base64'))
            : braw;
          this.data = this.mergeParsed(JSON.parse(bplain));
          recovered = true;
        }
      } catch (_) {}
      if (!recovered) {
        this.data = defaultData();
        // 主库与备份都读不出来：磁盘上那份可能是唯一还有救的密文，落盘前先留档再覆盖
        this.archiveBeforeOverwrite = true;
        this.logEvent('error', 'asset store unreadable, started from defaults', {
          file: this.file,
          message: e.message,
          code: e.code,
        });
      }
      this.normalizeTree();
    }
  }

  /** 解析出的记录按默认值补齐，settings 单独合并，避免缺字段时 snapshot 直接崩 */
  mergeParsed(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('asset store content is not an object'), { code: 'STORE_FORMAT' });
    }
    const data = Object.assign(defaultData(), parsed);
    data.settings = Object.assign(defaultData().settings, parsed.settings || {});
    // 手改过的凭证段可能缺项/带脏值，一律按表单同一套边界收敛
    data.credentials = (Array.isArray(parsed.credentials) ? parsed.credentials : [])
      .filter((c) => c && typeof c === 'object' && c.id)
      .map((c) => normalizeCredential(c, c));
    (Array.isArray(data.groups) ? data.groups : []).forEach((g) => normalizeAssets(g && g.nodes));
    return data;
  }

  /**
   * 把持久化的 groups[] 收敛成可用的分组树：groups 仍是扁平数组，层级由 pid 表达。
   */
  normalizeTree() {
    if (!Array.isArray(this.data.groups)) this.data.groups = [];
    const ids = new Set();
    this.data.groups.forEach((g) => {
      if (!g || typeof g !== 'object') return;
      if (!Array.isArray(g.nodes)) g.nodes = [];
      if (typeof g.open !== 'boolean') g.open = true;
      if (typeof g.pid !== 'string') g.pid = '';
      if (g.pid && g.pid === g.id) g.pid = '';
      ids.add(g.id);
    });
    // 父级不存在的节点回落到根，避免断链分支从界面上消失
    this.data.groups.forEach((g) => {
      if (g.pid && !ids.has(g.pid)) g.pid = '';
    });
    this.breakParentCycles();
    // 记录只在资产存在时才有意义：还原备份或手改数据后，指向已消失资产的记录一并收敛掉
    const alive = new Set();
    this.data.groups.forEach((g) => g.nodes.forEach((n) => alive.add(n.id)));
    this.data.recent = (this.data.recent || []).filter((r) => alive.has(r.id));
  }

  /** pid 链成环（手改数据或导入异常）时断掉成环的那一条 */
  breakParentCycles() {
    this.data.groups.forEach((g) => {
      const seen = new Set([g.id]);
      let cur = g;
      while (cur.pid) {
        if (seen.has(cur.pid)) {
          g.pid = '';
          break;
        }
        seen.add(cur.pid);
        cur = this.data.groups.find((x) => x.id === cur.pid);
        if (!cur) break;
      }
    });
  }

  /**
   * 加密落盘：库文件只允许以 safeStorage 密文写入，加密不可用或被拒时抛错，
   * 绝不退回明文，也不覆盖已存在的库（失败时保持磁盘现状）。
   */
  encrypt(json) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw Object.assign(new Error('safeStorage encryption unavailable'), {
        code: 'STORE_ENCRYPT_UNAVAILABLE',
      });
    }
    try {
      return safeStorage.encryptString(json);
    } catch (e) {
      throw Object.assign(new Error('safeStorage encryption failed: ' + (e && e.message ? e.message : e)), {
        code: 'STORE_ENCRYPT_UNAVAILABLE',
      });
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const json = JSON.stringify(this.data, null, 2);
    // 先加密再落盘：加密失败时这一步就抛，下面不会碰任何文件
    const enc = this.encrypt(json);
    if (this.archiveBeforeOverwrite) this.archiveUnreadableFiles();
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, CIPHER_PREFIX + enc.toString('base64'), 'utf8');
      // 两阶段写：主库要么是上一版完整密文、要么是这一版，不会留半截；备份因此永远是好的
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backupFile);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (_) {}
      throw e;
    } finally {
      this.archiveBeforeOverwrite = false;
    }
  }

  /** 把读不出来的库文件留档（含备份），覆盖写之前保住磁盘上原有的密文 */
  archiveUnreadableFiles() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '');
    const kept = [];
    for (const p of [this.file, this.backupFile]) {
      try {
        if (!fs.existsSync(p)) continue;
        const dest = `${p}.unreadable-${stamp}`;
        fs.renameSync(p, dest);
        kept.push(path.basename(dest));
      } catch (_) {}
    }
    this.logEvent('error', 'asset store archived before overwrite', { files: kept.join(', ') });
  }

  snapshot() {
    this.data.settings.dataPath = path.dirname(this.file);
    const data = JSON.parse(JSON.stringify(this.data));
    data.credentials = (data.credentials || []).map(credentialSummary);
    return data;
  }

  /** 展开/折叠这类高频小改动合并落盘，避免每次点击都同步重写整个数据文件 */
  persistSoon() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      // 定时落盘没有调用方能接住异常，这里必须兜住，否则加密不可用会变成未捕获异常
      try {
        this.persist();
      } catch (e) {
        console.error('[store] deferred persist failed', e);
      }
    }, 300);
  }

  flushPersist() {
    if (!this._persistTimer) return;
    clearTimeout(this._persistTimer);
    this._persistTimer = null;
    this.persist();
  }

  /** 高级设置里的数据存储目录：附件类数据（AI 会话记录）都以此为根。 */
  dataDir() {
    return path.dirname(this.file);
  }

  getGroups() {
    return this.snapshot().groups;
  }

  L(zh, en) {
    return this.data.settings && this.data.settings.lang === 'en' ? en : zh;
  }

  findGroup(gid) {
    return gid ? this.data.groups.find((g) => g.id === gid) : null;
  }

  childFolders(pid) {
    const parent = pid || '';
    return this.data.groups.filter((g) => (g.pid || '') === parent);
  }

  /** 从根到该节点父级的 id 列表，不含自己 */
  ancestorsOf(gid) {
    const out = [];
    const seen = new Set([gid]);
    let cur = this.findGroup(gid);
    while (cur && cur.pid) {
      if (seen.has(cur.pid)) break;
      seen.add(cur.pid);
      out.unshift(cur.pid);
      cur = this.findGroup(cur.pid);
    }
    return out;
  }

  isDescendantOf(gid, ancestorId) {
    if (!gid || !ancestorId) return false;
    return this.ancestorsOf(gid).includes(ancestorId);
  }

  findAsset(aid) {
    for (const g of this.data.groups) {
      const n = g.nodes.find((x) => x.id === aid);
      if (n) return { group: g, asset: n };
    }
    return null;
  }

  requireGroup(gid) {
    const g = this.findGroup(gid);
    if (!g) throw new Error(this.L('分组不存在', 'Group not found'));
    return g;
  }

  logEvent(level, message, meta) {
    if (this.log) this.log[level]('assets', message, meta);
  }

  /** 把分组放到同一父级的兄弟之后；根级则接到数组末尾 */
  placeFolder(g) {
    const cur = this.data.groups.indexOf(g);
    if (cur >= 0) this.data.groups.splice(cur, 1);
    const sibs = this.childFolders(g.pid);
    const last = sibs[sibs.length - 1];
    const parent = this.findGroup(g.pid);
    let at = this.data.groups.length;
    if (last) at = this.data.groups.indexOf(last) + 1;
    else if (parent) at = this.data.groups.indexOf(parent) + 1;
    this.data.groups.splice(at, 0, g);
  }

  createGroup(payload) {
    const input = payload || {};
    const pid = input.pid || '';
    if (pid) this.requireGroup(pid);
    const g = {
      id: newId('g'),
      pid,
      name: (input.name || '').trim() || this.L('未命名分组', 'Unnamed group'),
      color: input.color || '#409EFF',
      open: true,
      nodes: [],
    };
    this.placeFolder(g);
    this.persist();
    this.logEvent('info', 'group created', { gid: g.id, pid, name: g.name });
    return this.snapshot();
  }

  updateGroup(gid, payload) {
    const g = this.requireGroup(gid);
    const input = payload || {};
    if ('pid' in input) {
      const pid = input.pid || '';
      if (pid === g.id) throw new Error(this.L('分组不能挂到自己下面', 'A group cannot contain itself'));
      if (pid) {
        this.requireGroup(pid);
        if (this.isDescendantOf(pid, g.id)) {
          throw new Error(this.L('不能把分组移动到它自己的子分组里', 'Cannot move a group into its own descendant'));
        }
      }
      if (pid !== (g.pid || '')) {
        g.pid = pid;
        this.placeFolder(g);
        this.logEvent('info', 'group moved', { gid: g.id, pid, name: g.name });
      }
    }
    if (input.name) g.name = input.name;
    if (input.color) g.color = input.color;
    if (typeof input.open === 'boolean') g.open = input.open;
    const openOnly = typeof input.open === 'boolean' && Object.keys(input).length === 1;
    if (openOnly) this.persistSoon();
    else this.persist();
    return this.snapshot();
  }

  /**
   * 拖动分组：改从属并排序。
   * @param {object} p { fromId, toGid, beforeId? } — beforeId 为同级的参考分组，null 表示排到末尾
   */
  reorderGroups(p) {
    const input = p || {};
    const g = this.requireGroup(input.fromId);
    const toGid = input.toGid || '';
    if (toGid) {
      this.requireGroup(toGid);
      if (toGid === g.id || this.isDescendantOf(toGid, g.id)) {
        throw new Error(this.L('不能把分组移动到它自己的子分组里', 'Cannot move a group into its own descendant'));
      }
    }
    // 参考点是自己就没有排序意义，按「排到末尾」处理，否则摘掉自己后 indexOf 会指到数组末尾
    const beforeId = input.beforeId && input.beforeId !== input.fromId ? input.beforeId : null;
    const before = beforeId ? this.requireGroup(beforeId) : null;
    if (before && (before.pid || '') !== toGid) {
      throw new Error(this.L('参考分组不在同一层级', 'The reference group is not a sibling'));
    }
    g.pid = toGid;
    if (before) {
      this.data.groups.splice(this.data.groups.indexOf(g), 1);
      this.data.groups.splice(this.data.groups.indexOf(before), 0, g);
    } else {
      this.placeFolder(g);
    }
    const parent = this.findGroup(toGid);
    if (parent) parent.open = true;
    this.persist();
    this.logEvent('info', 'group moved', { gid: g.id, toGid, beforeId });
    return this.snapshot();
  }

  /**
   * Drag-sort assets, optionally across groups.
   * @param {object} p { assetId, toGid, beforeAssetId? }
   *   beforeAssetId null/absent → append to end of target group
   */
  reorderAsset(p) {
    const assetId = p && p.assetId;
    const hit = assetId ? this.findAsset(assetId) : null;
    if (!hit) throw new Error(this.L('资产不存在', 'Asset not found'));
    const fromG = hit.group;
    const asset = hit.asset;
    const toG = p.toGid ? this.requireGroup(p.toGid) : fromG;

    fromG.nodes = fromG.nodes.filter((n) => n.id !== assetId);
    let insertAt = toG.nodes.length;
    if (p.beforeAssetId) {
      const bi = toG.nodes.findIndex((n) => n.id === p.beforeAssetId);
      if (bi >= 0) insertAt = bi;
    }
    toG.nodes.splice(insertAt, 0, asset);
    toG.open = true;
    this.persist();
    this.logEvent('info', 'asset moved', {
      assetId,
      fromGid: fromG.id,
      toGid: toG.id,
      beforeAssetId: p.beforeAssetId || null,
    });
    return this.snapshot();
  }

  deleteGroup(gid) {
    const g = this.requireGroup(gid);
    const kids = this.childFolders(gid);
    if (kids.length) {
      throw new Error(
        this.L(
          `分组「${g.name}」下还有 ${kids.length} 个子分组，请先移出或删除它们`,
          `Group “${g.name}” still has ${kids.length} subgroup(s); move or delete them first`
        )
      );
    }
    if (g.nodes.length) {
      throw new Error(
        this.L(
          `分组「${g.name}」下还有 ${g.nodes.length} 个资产，请先移出或删除它们`,
          `Group “${g.name}” still has ${g.nodes.length} asset(s); move or delete them first`
        )
      );
    }
    this.data.groups = this.data.groups.filter((x) => x.id !== gid);
    this.persist();
    this.logEvent('info', 'group deleted', { gid, name: g.name });
    return this.snapshot();
  }

  createAsset(gid, payload) {
    if (!this.data.groups.length) {
      throw new Error(this.L('还没有分组，请先新建一个分组', 'No group yet; create a group first'));
    }
    const g = this.requireGroup(gid);
    const asset = {
      id: newId('a'),
      name: payload.name || this.L('未命名资产', 'Unnamed asset'),
      icon: ASSET_ICONS.includes(payload.icon) ? payload.icon : 'generic',
      host: payload.host || '',
      auth: normalizeMainAuth(payload.auth),
      tags: payload.tags || '',
      note: payload.note || '',
      ping: payload.ping || '—',
      pclass: payload.pclass || 'ok',
      methods: normalizeAssetMethods(payload.methods),
    };
    g.nodes.push(asset);
    this.persist();
    this.logEvent('info', 'asset created', { assetId: asset.id, gid: g.id, name: asset.name, host: asset.host });
    return { snapshot: this.snapshot(), asset };
  }

  updateAsset(aid, payload) {
    const hit = this.findAsset(aid);
    if (!hit) throw new Error('asset not found');
    const targetGid = payload.gid;
    let { group, asset } = hit;
    Object.assign(asset, {
      name: payload.name != null ? payload.name : asset.name,
      icon:
        payload.icon != null
          ? ASSET_ICONS.includes(payload.icon)
            ? payload.icon
            : 'generic'
          : asset.icon,
      host: payload.host != null ? payload.host : asset.host,
      tags: payload.tags != null ? payload.tags : asset.tags,
      note: payload.note != null ? payload.note : asset.note,
      methods: payload.methods != null ? normalizeAssetMethods(payload.methods) : asset.methods,
    });
    if (payload.auth != null) asset.auth = normalizeMainAuth(payload.auth);
    if (targetGid && targetGid !== group.id) {
      const ng = this.requireGroup(targetGid);
      const fromGid = group.id;
      group.nodes = group.nodes.filter((n) => n.id !== aid);
      ng.nodes.push(asset);
      ng.open = true;
      group = ng;
      this.logEvent('info', 'asset moved', { assetId: aid, fromGid, toGid: ng.id });
    }
    this.persist();
    this.logEvent('info', 'asset updated', {
      assetId: aid,
      gid: group.id,
      name: asset.name,
      host: asset.host,
    });
    return this.snapshot();
  }

  deleteAsset(aid) {
    const hit = this.findAsset(aid);
    if (!hit) throw new Error('asset not found');
    hit.group.nodes = hit.group.nodes.filter((n) => n.id !== aid);
    this.data.recent = (this.data.recent || []).filter((r) => r.id !== aid);
    this.persist();
    this.logEvent('info', 'asset deleted', { assetId: aid, gid: hit.group.id, name: hit.asset.name });
    return this.snapshot();
  }

  findCredential(cid) {
    return cid ? this.data.credentials.find((c) => c.id === cid) || null : null;
  }

  requireCredential(cid) {
    const c = this.findCredential(cid);
    if (!c) {
      throw new Error(this.L('凭证不存在或已被删除', 'Credential not found'));
    }
    return c;
  }

  /**
   * 连接用凭证的唯一收敛点：主凭证设了就用主凭证，方式自己选了自定义才覆盖它。
   * 引用凭证的秘密只在这里取，不因为它进快照；口令为空时 needsPrompt 为真，由连接入口询问。
   */
  resolveAssetAuth(asset, methodId) {
    const method = asset && asset.methods ? asset.methods[methodId] : null;
    const custom = method && method.auth && method.auth.use === 'custom' ? method.auth : null;
    const main = normalizeMainAuth(asset && asset.auth);
    const cfg = custom || main;
    const resolved = {
      username: '',
      password: '',
      privateKey: '',
      passphrase: '',
      source: custom ? 'custom' : 'main',
    };
    if (cfg.mode === 'inline') {
      resolved.username = String(cfg.user || '');
      resolved.password = String(cfg.pass || '');
    } else if (cfg.mode === 'credential') {
      const credential = this.requireCredential(cfg.credentialId);
      resolved.username = credential.user || '';
      if (credential.kind === 'key') {
        resolved.privateKey = credential.privateKey || '';
        resolved.passphrase = credential.passphrase || '';
      } else {
        resolved.password = credential.pass || '';
      }
      resolved.source = 'credential';
    } else {
      resolved.source = 'none';
    }
    resolved.kind = resolved.privateKey ? 'key' : 'password';
    // 本方式消费不了这个类型（例如私钥主凭证接到只吃口令的 RDP/VNC）等同没配凭证：
    // 交给连接入口询问，不能带着空口令去握手（撞服务器失败黑名单，也看不出是没配凭证）。
    resolved.needsPrompt =
      !authKindsFor(methodId).includes(resolved.kind) ||
      (resolved.kind === 'password' && !resolved.password);
    return resolved;
  }

  /**
   * 连接时勾了「记住凭证」：把这次的答案写进该访问方式的凭证设置，之后这条方式不再询问。
   * 只写方式级，不动资产级主凭证；日志只记模式，不记账号与口令。
   */
  rememberMethodAuth(aid, methodId, answer) {
    const hit = this.findAsset(aid);
    if (!hit) throw new Error('asset not found');
    const methods = { ...(hit.asset.methods || {}) };
    const row = { ...(methods[methodId] || {}) };
    const auth = normalizeMethodAuth(
      answer.mode === 'credential'
        ? { use: 'custom', mode: 'credential', credentialId: answer.credentialId }
        : { use: 'custom', mode: 'inline', user: answer.user, pass: answer.pass }
    );
    if (!auth) throw new Error(this.L('凭证信息不完整，无法记住', 'Credential is incomplete; nothing was saved'));
    row.auth = auth;
    methods[methodId] = row;
    hit.asset.methods = methods;
    this.persist();
    this.logEvent('info', 'method credential remembered', {
      assetId: aid,
      methodId,
      mode: auth.mode,
    });
    return this.snapshot();
  }

  createCredential(payload) {
    const credential = normalizeCredential(this.assertCredentialSecrets(payload), null);
    credential.name = credential.name || this.L('未命名凭证', 'Unnamed credential');
    this.data.credentials.push(credential);
    this.persist();
    this.logEvent('info', 'credential created', {
      credentialId: credential.id,
      name: credential.name,
      kind: credential.kind,
    });
    return this.snapshot();
  }

  /** 换类型即换字段：normalizeCredential 只保留当前 kind 用到的秘密，另一类的旧值自然消失。 */
  updateCredential(cid, payload) {
    const current = this.requireCredential(cid);
    const index = this.data.credentials.indexOf(current);
    const credential = normalizeCredential(this.assertCredentialSecrets(payload), current);
    credential.name = credential.name || this.L('未命名凭证', 'Unnamed credential');
    this.data.credentials[index] = credential;
    this.persist();
    this.logEvent('info', 'credential updated', {
      credentialId: cid,
      name: credential.name,
      kind: credential.kind,
    });
    return this.snapshot();
  }

  /**
   * 秘密字段超长一律报错，不像名称那样静默截断：粘贴进来的私钥被剪掉只能等到连接时
   * 报「无法解析私钥」，用户在界面上完全看不出内容已经被改过。落库读取仍走归一化回落。
   */
  assertCredentialSecrets(payload) {
    const src = payload && typeof payload === 'object' ? payload : {};
    const labels = {
      pass: [this.L('口令', 'The password'), CREDENTIAL_SECRET_MAX],
      privateKey: [this.L('私钥内容', 'The private key'), CREDENTIAL_SECRET_MAX],
      passphrase: [this.L('私钥口令', 'The private key passphrase'), CREDENTIAL_PASSPHRASE_MAX],
    };
    for (const field of Object.keys(labels)) {
      const value = src[field];
      const [label, max] = labels[field];
      if (typeof value === 'string' && value.length > max) {
        throw Object.assign(
          new Error(this.L(`${label}过长，最多 ${max} 个字符`, `${label} is too long — ${max} characters at most`)),
          { code: 'CREDENTIAL_TOO_LONG', field, limit: max }
        );
      }
    }
    return src;
  }

  /** 引用这条凭证的资产数：主凭证与方式级自定义都算。 */
  credentialRefCount(cid) {
    if (!cid) return 0;
    let count = 0;
    (this.data.groups || []).forEach((g) => {
      ((g && g.nodes) || []).forEach((a) => {
        if (!a || typeof a !== 'object') return;
        const methods = a.methods && typeof a.methods === 'object' ? a.methods : {};
        const usedByMethod = Object.keys(methods).some((id) => {
          const auth = methods[id] && methods[id].auth;
          return auth && auth.mode === 'credential' && auth.credentialId === cid;
        });
        const usedByMain = a.auth && a.auth.mode === 'credential' && a.auth.credentialId === cid;
        if (usedByMain || usedByMethod) count += 1;
      });
    });
    return count;
  }

  deleteCredential(cid) {
    const current = this.requireCredential(cid);
    // 引用不检查就会留下打不开的资产：连接时才炸在「凭证不存在或已被删除」，界面上毫无预兆
    const refs = this.credentialRefCount(cid);
    if (refs) {
      throw Object.assign(
        new Error(this.L(
          `还有 ${refs} 个资产在引用这条凭证，请先在资产里改选其它凭证或改为手填`,
          `${refs} asset(s) still reference this credential; point them at another one or use inline credentials first`
        )),
        { code: 'CREDENTIAL_IN_USE', refs }
      );
    }
    this.data.credentials = this.data.credentials.filter((c) => c !== current);
    this.persist();
    this.logEvent('info', 'credential deleted', { credentialId: cid, name: current.name });
    return this.snapshot();
  }

  /** 凭证列表是扁平数组，排序只按参考点插入；beforeId 为空表示移到末尾。 */
  reorderCredential(p) {
    const fromId = p && p.fromId;
    const moved = this.requireCredential(fromId);
    const beforeId = p && p.beforeId && p.beforeId !== fromId ? p.beforeId : null;
    const before = beforeId ? this.requireCredential(beforeId) : null;
    this.data.credentials.splice(this.data.credentials.indexOf(moved), 1);
    this.data.credentials.splice(
      before ? this.data.credentials.indexOf(before) : this.data.credentials.length,
      0,
      moved
    );
    this.persist();
    this.logEvent('info', 'credential moved', { credentialId: fromId, beforeId });
    return this.snapshot();
  }

  /** 最近连接上限：设置值越界或缺失都回落到默认 20。 */
  recentCap() {
    const n = Number(this.data.settings && this.data.settings.recentLimit);
    if (!Number.isFinite(n) || n <= 0) return RECENT_LIMIT_DEFAULT;
    return Math.min(RECENT_LIMIT_MAX, Math.floor(n));
  }

  pushRecent(asset, method) {
    if (!asset || !asset.id) return this.snapshot();
    const mid = method && (method.id || method.protocol);
    if (!mid) return this.snapshot();
    // 未登记的访问方式不写最近连接：过去一律回落 3389，等于把未知协议当成 RDP
    const port = (method && method.port) || RECENT_DEFAULT_PORTS.get(mid);
    if (!port) return this.snapshot();
    const item = {
      id: asset.id,
      name: asset.name,
      icon: asset.icon,
      host: asset.host,
      method: mid,
      port,
      time: Date.now(),
    };
    // One entry per asset+method so SSH/RDP on the same host can both appear
    this.data.recent = (this.data.recent || []).filter(
      (r) => !(r.id === asset.id && r.method === item.method)
    );
    this.data.recent.unshift(item);
    this.data.recent = this.data.recent.slice(0, this.recentCap());
    this.persist();
    return this.snapshot();
  }

  removeRecent(id, method) {
    this.data.recent = (this.data.recent || []).filter(
      (r) => !(r.id === id && r.method === method)
    );
    this.persist();
    return this.snapshot();
  }

  getSettings() {
    return this.snapshot().settings;
  }

  /** 日志跟随「存储位置」：与数据文件同级的 logs 目录 */
  logsDir() {
    return path.join(path.dirname(this.file), 'logs');
  }

  /** 存储位置不在这里改：换路径必须走主进程的 switchDataPath，它同时搬日志与 AI 会话目录 */
  updateSettings(patch) {
    this.data.settings = Object.assign({}, this.data.settings, patch);
    if ('recentLimit' in patch) this.data.recent = (this.data.recent || []).slice(0, this.recentCap());
    this.persist();
    return this.snapshot().settings;
  }

  importGroups(jsonText) {
    const groups = JSON.parse(jsonText);
    if (!Array.isArray(groups) || groups.some((g) => !g || typeof g !== 'object' || !g.id)) {
      throw new Error(this.L('导入内容不是有效的分组列表', 'Not a valid group list'));
    }
    this.data.groups = groups;
    // 导入内容是外部输入，与读库走同一条收敛，脏值不能绕过校验直接进运行时
    this.data.groups.forEach((g) => normalizeAssets(g && g.nodes));
    // 导出的扁平分组可能没有 pid，重新补默认值并修断链/成环
    this.normalizeTree();
    this.persist();
    return this.snapshot();
  }

  /** 备份用的凭证导出：带秘密字段，只在加密包内出现，绝不进快照。 */
  exportCredentials() {
    return (this.data.credentials || []).map((c) => normalizeCredential(c, c));
  }

  importCredentials(jsonText) {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed) || parsed.some((c) => !c || typeof c !== 'object' || !c.id)) {
      throw new Error(this.L('导入内容不是有效的凭证列表', 'Not a valid credential list'));
    }
    // 保留原 id：资产里的 credentialId 只有在不换主键的情况下才还指得上
    this.data.credentials = parsed.map((c) => normalizeCredential(c, c));
    this.persist();
    return this.snapshot();
  }
}

module.exports = {
  AssetStore,
  authKindsFor,
  CREDENTIAL_SECRET_MAX,
  RECENT_LIMIT_DEFAULT,
  RECENT_LIMIT_MAX,
  LOG_TOTAL_DEFAULT_MB,
  LOG_TOTAL_MIN_MB,
  LOG_TOTAL_MAX_MB,
};
