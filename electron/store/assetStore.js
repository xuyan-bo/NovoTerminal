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

function defaultData() {
  return {
    version: 2,
    groups: [],
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
        this.persist();
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
      this.data = Object.assign(defaultData(), parsed);
      this.data.settings = Object.assign(defaultData().settings, parsed.settings || {});
      this.normalizeTree();
      this.data.settings.dataPath = path.dirname(this.file);
    } catch (e) {
      console.error('[store] load failed', e);
      try {
        if (fs.existsSync(this.backupFile)) {
          this.data = JSON.parse(fs.readFileSync(this.backupFile, 'utf8'));
        }
      } catch (_) {
        this.data = defaultData();
      }
      this.normalizeTree();
    }
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
      delete g.locked;
      if (typeof g.pid !== 'string') g.pid = '';
      if (g.pid && g.pid === g.id) g.pid = '';
      ids.add(g.id);
    });
    // 父级不存在的节点回落到根，避免断链分支从界面上消失
    this.data.groups.forEach((g) => {
      if (g.pid && !ids.has(g.pid)) g.pid = '';
    });
    this.breakParentCycles();
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

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const json = JSON.stringify(this.data, null, 2);
    try {
      if (fs.existsSync(this.file)) {
        fs.copyFileSync(this.file, this.backupFile);
      }
    } catch (_) {}
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const enc = safeStorage.encryptString(json);
        fs.writeFileSync(this.file, CIPHER_PREFIX + enc.toString('base64'), 'utf8');
      } else {
        fs.writeFileSync(this.file, json, 'utf8');
      }
    } catch (e) {
      console.error('[store] persist enc failed, fallback plain', e);
      fs.writeFileSync(this.file, json, 'utf8');
    }
  }

  snapshot() {
    this.data.settings.dataPath = path.dirname(this.file);
    return JSON.parse(JSON.stringify(this.data));
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
    this.persist();
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
      os: payload.os || 'win',
      host: payload.host || '',
      user: payload.user || '',
      pass: payload.pass || '',
      tags: payload.tags || '',
      note: payload.note || '',
      ping: payload.ping || '—',
      pclass: payload.pclass || 'ok',
      methods: payload.methods || {},
      display: payload.display || { layout: 'extend' },
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
      os: payload.os != null ? payload.os : asset.os,
      host: payload.host != null ? payload.host : asset.host,
      user: payload.user != null ? payload.user : asset.user,
      pass: payload.pass != null ? payload.pass : asset.pass,
      tags: payload.tags != null ? payload.tags : asset.tags,
      note: payload.note != null ? payload.note : asset.note,
      methods: payload.methods != null ? payload.methods : asset.methods,
      display: payload.display != null ? payload.display : asset.display,
    });
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
    return this.snapshot();
  }

  deleteAsset(aid) {
    const hit = this.findAsset(aid);
    if (!hit) throw new Error('asset not found');
    hit.group.nodes = hit.group.nodes.filter((n) => n.id !== aid);
    this.persist();
    this.logEvent('info', 'asset deleted', { assetId: aid, gid: hit.group.id, name: hit.asset.name });
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
    const mid = (method && (method.id || method.protocol)) || 'rdp';
    const proto =
      (method && (method.proto || method.protocol)) ||
      String(mid).toUpperCase();
    const defaultPort = mid === 'ssh' || mid === 'sftp' ? 22 : mid === 'vnc' ? 5900 : 3389;
    const item = {
      id: asset.id,
      name: asset.name,
      os: asset.os,
      host: asset.host,
      method: mid,
      proto: String(proto).toUpperCase(),
      port: (method && method.port) || defaultPort,
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

  updateSettings(patch) {
    this.data.settings = Object.assign({}, this.data.settings, patch);
    if ('recentLimit' in patch) this.data.recent = (this.data.recent || []).slice(0, this.recentCap());
    if (patch.dataPath && patch.dataPath !== path.dirname(this.file)) {
      this.setCustomPath(patch.dataPath);
      this.persist();
    } else {
      this.persist();
    }
    return this.snapshot().settings;
  }

  importGroups(jsonText) {
    const groups = JSON.parse(jsonText);
    if (!Array.isArray(groups) || groups.some((g) => !g || typeof g !== 'object' || !g.id)) {
      throw new Error(this.L('导入内容不是有效的分组列表', 'Not a valid group list'));
    }
    this.data.groups = groups;
    // 导出的扁平分组可能没有 pid，重新补默认值并修断链/成环
    this.normalizeTree();
    this.persist();
    return this.snapshot();
  }
}

module.exports = {
  AssetStore,
  RECENT_LIMIT_DEFAULT,
  RECENT_LIMIT_MAX,
  LOG_TOTAL_DEFAULT_MB,
  LOG_TOTAL_MIN_MB,
  LOG_TOTAL_MAX_MB,
};
