const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { AI_DEFAULTS } = require('../ai/aiSettings');

const UNGROUPED_ID = 'g-ungrouped';
const UNGROUPED_NAME = '未分组';

function isUngroupedGroup(g) {
  return !!(g && (g.id === UNGROUPED_ID || g.id === 'g-default'));
}

function ungroupedGroup() {
  return {
    id: UNGROUPED_ID,
    name: UNGROUPED_NAME,
    color: '#909399',
    open: true,
    nodes: [],
    locked: true,
  };
}

function defaultData() {
  return {
    version: 1,
    groups: [ungroupedGroup()],
    recent: [],
    settings: {
      theme: 'system',
      lang: 'zh',
      dataPath: '',
      zoom: 100,
      font: 'default',
      closeAction: 'ask', // 'ask' = 每次询问, 'minimize' = 直接最小化, 'quit' = 直接退出
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
  constructor() {
    this.file = this.resolveActiveFile();
    this.backupFile = this.file + '.bak';
    this.data = defaultData();
    this.load();
  }

  resolveActiveFile() {
    const defaultFile = path.join(defaultDataDir(), 'omnidesk.json');
    let dir;
    try {
      dir = fs.readFileSync(pointerFile(), 'utf8').trim();
    } catch (_) {
      return defaultFile;
    }
    const target = dir && path.join(dir, 'omnidesk.json');
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
    const target = path.join(dir, 'omnidesk.json');
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

  load() {
    try {
      if (!fs.existsSync(this.file)) {
        this.data = defaultData();
        this.ensureUngrouped();
        this.persist();
        return;
      }
      const raw = fs.readFileSync(this.file, 'utf8');
      let parsed;
      if (raw.startsWith('omni1:')) {
        const buf = Buffer.from(raw.slice(6), 'base64');
        const plain = safeStorage.decryptString(buf);
        parsed = JSON.parse(plain);
      } else {
        parsed = JSON.parse(raw);
      }
      this.data = Object.assign(defaultData(), parsed);
      this.data.settings = Object.assign(defaultData().settings, parsed.settings || {});
      if (!this.data.groups || !this.data.groups.length) {
        this.data.groups = defaultData().groups;
      }
      this.ensureUngrouped();
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
      this.ensureUngrouped();
    }
  }

  /** Keep a reserved ungrouped bucket in the tree; migrate legacy g-default */
  ensureUngrouped() {
    if (!Array.isArray(this.data.groups)) this.data.groups = [];
    let ug = this.data.groups.find((g) => g.id === UNGROUPED_ID);
    const legacy = this.data.groups.find((g) => g.id === 'g-default');
    if (!ug && legacy) {
      legacy.id = UNGROUPED_ID;
      legacy.name = UNGROUPED_NAME;
      legacy.locked = true;
      ug = legacy;
    }
    if (!ug) {
      ug = ungroupedGroup();
      this.data.groups.push(ug);
    } else {
      ug.name = UNGROUPED_NAME;
      ug.locked = true;
      if (!ug.color) ug.color = '#909399';
      if (!Array.isArray(ug.nodes)) ug.nodes = [];
    }
    // assets that somehow lost their group land here
    return ug;
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
        fs.writeFileSync(this.file, 'omni1:' + enc.toString('base64'), 'utf8');
      } else {
        fs.writeFileSync(this.file, json, 'utf8');
      }
    } catch (e) {
      console.error('[store] persist enc failed, fallback plain', e);
      fs.writeFileSync(this.file, json, 'utf8');
    }
  }

  snapshot() {
    this.ensureUngrouped();
    this.data.settings.dataPath = path.dirname(this.file);
    return JSON.parse(JSON.stringify(this.data));
  }

  getGroups() {
    return this.snapshot().groups;
  }

  L(zh, en) {
    return this.data.settings && this.data.settings.lang === 'en' ? en : zh;
  }

  findGroup(gid) {
    return this.data.groups.find((g) => g.id === gid);
  }

  findAsset(aid) {
    for (const g of this.data.groups) {
      const n = g.nodes.find((x) => x.id === aid);
      if (n) return { group: g, asset: n };
    }
    return null;
  }

  createGroup(payload) {
    const g = {
      id: 'g-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name: payload.name || this.L('未命名分组', 'Unnamed group'),
      color: payload.color || '#409EFF',
      open: true,
      nodes: [],
    };
    this.data.groups.push(g);
    this.persist();
    return this.snapshot();
  }

  updateGroup(gid, payload) {
    const g = this.findGroup(gid);
    if (!g) throw new Error('group not found');
    if (isUngroupedGroup(g)) {
      // default group: only color is mutable
      if (payload.color) g.color = payload.color;
      if (typeof payload.open === 'boolean') g.open = payload.open;
      g.name = UNGROUPED_NAME;
      this.persist();
      return this.snapshot();
    }
    if (payload.name) g.name = payload.name;
    if (payload.color) g.color = payload.color;
    if (typeof payload.open === 'boolean') g.open = payload.open;
    this.persist();
    return this.snapshot();
  }

  /** Drag-sort groups: move fromId to toId's position */
  reorderGroups(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return this.snapshot();
    const groups = this.data.groups;
    const from = groups.findIndex((g) => g.id === fromId);
    const to = groups.findIndex((g) => g.id === toId);
    if (from < 0 || to < 0) throw new Error('group not found');
    const [item] = groups.splice(from, 1);
    groups.splice(to, 0, item);
    this.persist();
    return this.snapshot();
  }

  /**
   * Drag-sort assets.
   * @param {object} p { assetId, fromGid, toGid, beforeAssetId? }
   *   beforeAssetId null/absent → append to end of target group
   */
  reorderAsset(p) {
    const assetId = p && p.assetId;
    if (!assetId) throw new Error('asset not found');
    const hit = this.findAsset(assetId);
    if (!hit) throw new Error('asset not found');
    const fromG = hit.group;
    const asset = hit.asset;
    const toG = (p.toGid && this.findGroup(p.toGid)) || fromG;
    if (!toG) throw new Error('group not found');

    fromG.nodes = fromG.nodes.filter((n) => n.id !== assetId);
    let insertAt = toG.nodes.length;
    if (p.beforeAssetId) {
      const bi = toG.nodes.findIndex((n) => n.id === p.beforeAssetId);
      if (bi >= 0) insertAt = bi;
    }
    // clamp when moving within same list after removal shifted indices
    if (insertAt > toG.nodes.length) insertAt = toG.nodes.length;
    toG.nodes.splice(insertAt, 0, asset);
    toG.open = true;
    this.persist();
    return this.snapshot();
  }

  deleteGroup(gid) {
    const i = this.data.groups.findIndex((g) => g.id === gid);
    if (i < 0) throw new Error('group not found');
    const g = this.data.groups[i];
    if (isUngroupedGroup(g)) {
      throw new Error(this.L('默认分组「未分组」不可删除', 'The default “Ungrouped” group cannot be deleted'));
    }
    if (this.data.groups.length <= 1) {
      throw new Error(this.L('至少保留一个分组', 'Keep at least one group'));
    }
    const ug = this.ensureUngrouped();
    // move assets into ungrouped instead of dropping them
    if (ug && ug.id !== g.id && Array.isArray(g.nodes) && g.nodes.length) {
      ug.nodes = ug.nodes.concat(g.nodes);
      ug.open = true;
    }
    this.data.groups.splice(i, 1);
    this.ensureUngrouped();
    this.persist();
    return this.snapshot();
  }

  createAsset(gid, payload) {
    this.ensureUngrouped();
    let g = null;
    if (gid) g = this.findGroup(gid);
    if (!g) {
      g =
        this.data.groups.find((x) => x.id === UNGROUPED_ID) ||
        this.data.groups.find((x) => !isUngroupedGroup(x)) ||
        this.data.groups[0];
    }
    if (!g) {
      g = ungroupedGroup();
      this.data.groups.push(g);
    }
    const asset = {
      id: 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
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
      const ng = this.findGroup(targetGid);
      if (ng) {
        group.nodes = group.nodes.filter((n) => n.id !== aid);
        ng.nodes.push(asset);
        if (isUngroupedGroup(ng)) ng.open = true;
        group = ng;
      }
    }
    this.persist();
    return this.snapshot();
  }

  deleteAsset(aid) {
    const hit = this.findAsset(aid);
    if (!hit) throw new Error('asset not found');
    hit.group.nodes = hit.group.nodes.filter((n) => n.id !== aid);
    this.persist();
    return this.snapshot();
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
    this.data.recent = this.data.recent.slice(0, 20);
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

  updateSettings(patch) {
    this.data.settings = Object.assign({}, this.data.settings, patch);
    if (patch.dataPath && patch.dataPath !== path.dirname(this.file)) {
      this.setCustomPath(patch.dataPath);
      this.persist();
    } else {
      this.persist();
    }
    return this.snapshot().settings;
  }

  exportJson() {
    return JSON.stringify(this.snapshot().groups, null, 2);
  }

  importGroups(jsonText) {
    const groups = JSON.parse(jsonText);
    if (!Array.isArray(groups)) throw new Error('invalid format');
    this.data.groups = groups;
    this.persist();
    return this.snapshot();
  }
}

module.exports = { AssetStore };
