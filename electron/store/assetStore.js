const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

function defaultData() {
  return {
    version: 1,
    groups: [
      {
        id: 'g-default',
        name: '未分组',
        color: '#409EFF',
        open: true,
        nodes: [],
      },
    ],
    recent: [],
    settings: {
      theme: 'dark',
      lang: 'zh',
      dataPath: '',
    },
  };
}

function resolveDataFile() {
  const custom = this && this.customPath;
  const dir = custom || path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'omnidesk.json');
}

class AssetStore {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'data', 'omnidesk.json');
    this.backupFile = this.file + '.bak';
    this.data = defaultData();
    this.load();
  }

  setCustomPath(dir) {
    if (!dir) return this.file;
    this.file = path.join(dir, 'omnidesk.json');
    this.backupFile = this.file + '.bak';
    this.load();
    return this.file;
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) {
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
    }
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
    this.data.settings.dataPath = path.dirname(this.file);
    return JSON.parse(JSON.stringify(this.data));
  }

  getGroups() {
    return this.snapshot().groups;
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
      name: payload.name || '未命名分组',
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
    if (payload.name) g.name = payload.name;
    if (payload.color) g.color = payload.color;
    if (typeof payload.open === 'boolean') g.open = payload.open;
    this.persist();
    return this.snapshot();
  }

  deleteGroup(gid) {
    const i = this.data.groups.findIndex((g) => g.id === gid);
    if (i < 0) throw new Error('group not found');
    if (this.data.groups.length <= 1) {
      throw new Error('至少保留一个分组');
    }
    this.data.groups.splice(i, 1);
    this.persist();
    return this.snapshot();
  }

  createAsset(gid, payload) {
    const g = this.findGroup(gid) || this.data.groups[0];
    if (!g) throw new Error('no group');
    const asset = {
      id: 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name: payload.name || '未命名资产',
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

  cloneAsset(aid) {
    const hit = this.findAsset(aid);
    if (!hit) throw new Error('asset not found');
    const copy = JSON.parse(JSON.stringify(hit.asset));
    copy.id = 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    copy.name = hit.asset.name + ' (副本)';
    hit.group.nodes.push(copy);
    this.persist();
    return this.snapshot();
  }

  pushRecent(asset, method) {
    const item = {
      id: asset.id,
      name: asset.name,
      os: asset.os,
      host: asset.host,
      method: method.id,
      proto: method.proto,
      port: method.port,
      time: Date.now(),
    };
    this.data.recent = (this.data.recent || []).filter((r) => r.id !== asset.id);
    this.data.recent.unshift(item);
    this.data.recent = this.data.recent.slice(0, 8);
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
