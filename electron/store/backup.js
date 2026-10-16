/**
 * 备份包：把「应用设置 / 资产数据 / AI 会话」整理成 zip，再整包加密为一个可跨机器搬运的文件。
 *
 * 不能复用 AssetStore 的 safeStorage：DPAPI/Keychain 与机器绑定，换台机器解不开。
 * 这里用密码派生密钥（scrypt）+ AES-256-GCM，同一密码在任何平台都能解。
 * zip 只用 Node 内置 zlib 手写最小实现——现有 7zip-bin/extract-zip 都是 electron 的间接
 * devDependency，打包时不会随生产依赖进入安装包，运行时并不可用，因此不引依赖。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { normalize: normalizeAi } = require('../ai/aiSettings');
const {
  RECENT_LIMIT_DEFAULT,
  RECENT_LIMIT_MAX,
  LOG_TOTAL_DEFAULT_MB,
  LOG_TOTAL_MIN_MB,
  LOG_TOTAL_MAX_MB,
} = require('./assetStore');

/** 包格式标识（同时作为 GCM 的 AAD，被认证，防止换头） */
const MAGIC = Buffer.from('NTBK1', 'ascii');
const FORMAT = 'novoterminal-backup';
const FORMAT_VERSION = 1;
const AI_DIR = 'ai-sessions';
const AI_INDEX = 'index.list';
const MANIFEST = 'manifest.json';
const SETTINGS_ENTRY = 'settings.json';
const ASSETS_ENTRY = 'assets.json';
const CREDENTIALS_ENTRY = 'credentials.json';
const AI_PREFIX = 'ai-sessions/';
/** scrypt 参数：N=2^14 时内存约 16MB，单次派生几十毫秒，适合交互式备份 */
const SCRYPT = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 256;
/** 凭证单独成类：资产里的 credentialId 只有跟凭证库一起搬运才不会在还原后指空 */
const CATEGORIES = ['settings', 'assets', 'credentials', 'ai'];
/** 允许从备份包还原的设置项；dataPath 不在其中（由本机决定），其余未知键一并丢弃，避免备份包注入任意设置 */
const RESTORE_SETTINGS_KEYS = [
  'theme',
  'lang',
  'zoom',
  'font',
  'closeAction',
  'homeWelcome',
  'autoUpdateCheck',
  'skippedUpdateVersion',
  'recentLimit',
  'logTotalMb',
  'ai',
];

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function bufferize(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from(data);
}

/* ------------------------------- minimal zip ------------------------------- */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    CRC_TABLE = t;
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** 写出一个标准 zip（条目用 deflate，UTF-8 文件名）；条目名一律用 '/' 分隔。 */
function writeZip(entries) {
  const { time, date } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = bufferize(entry.data);
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, eocd]);
}

/** 读回 zip（支持 store/deflate 两种压缩方法）。 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw fail('BACKUP_BAD_FORMAT', 'not a zip');
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail('BACKUP_BAD_FORMAT', 'zip end record not found');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw fail('BACKUP_BAD_FORMAT', 'corrupt central directory');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    // 数据起点按本地头的名字/扩展长度算，可能与中央目录不同
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw fail('BACKUP_BAD_FORMAT', 'unsupported compression method ' + method);
    out.push({ name, data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ------------------------------- crypto ------------------------------- */

function deriveKey(password, salt) {
  return crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt, KEY_LEN, SCRYPT);
}

function encrypt(zipBuf, password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(zipBuf), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decrypt(buf, password) {
  const head = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (!Buffer.isBuffer(buf) || buf.length <= head || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw fail('BACKUP_BAD_FORMAT', 'not a NovoTerminal backup');
  }
  const salt = buf.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = buf.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const tag = buf.subarray(MAGIC.length + SALT_LEN + IV_LEN, head);
  const body = buf.subarray(head);
  const key = deriveKey(password, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (_) {
    throw fail('BACKUP_PASSWORD', 'wrong password or corrupted file');
  }
}

/* ------------------------------- collect / restore ------------------------------- */

/** 递归列出目录下的文件（相对路径，'/' 分隔），无目录或读取失败返回空数组。 */
function listFiles(root, rel = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    const next = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, next));
    else if (e.isFile()) out.push(next);
  }
  return out;
}

function normalizeInclude(include) {
  const wanted = Array.isArray(include) ? include.filter((c) => CATEGORIES.includes(c)) : [];
  return CATEGORIES.filter((c) => wanted.includes(c));
}

/** 整理所选类别 → zip → 加密，返回可直接落盘的 Buffer。 */
function packBackup({ store, include, password, appVersion }) {
  const cats = normalizeInclude(include);
  if (!cats.length) throw fail('BACKUP_EMPTY', 'nothing selected to export');
  const snap = store.snapshot();
  const entries = [];
  const counts = {};

  if (cats.includes('settings') && snap.settings) {
    // dataPath 是本机路径，带到另一台机器只会指向不存在的目录
    const settings = { ...snap.settings };
    delete settings.dataPath;
    entries.push({ name: SETTINGS_ENTRY, data: Buffer.from(JSON.stringify(settings, null, 2), 'utf8') });
  }
  if (cats.includes('assets')) {
    const groups = snap.groups || [];
    entries.push({ name: ASSETS_ENTRY, data: Buffer.from(JSON.stringify(groups, null, 2), 'utf8') });
    counts.groups = groups.length;
    counts.assets = groups.reduce((n, g) => n + ((g && g.nodes ? g.nodes.length : 0)), 0);
  }
  if (cats.includes('credentials')) {
    // 资产里的 credentialId 必须和凭证库一起搬运，否则还原后每条引用型资产都只能在连接时报「凭证不存在」
    const credentials = store.exportCredentials();
    entries.push({ name: CREDENTIALS_ENTRY, data: Buffer.from(JSON.stringify(credentials, null, 2), 'utf8') });
    counts.credentials = credentials.length;
  }
  if (cats.includes('ai')) {
    const root = path.join(store.dataDir(), AI_DIR);
    // index.list 是可重建的摘要缓存，不随包搬运（还原后 mtime 全变，带了也得重建），也不计入会话数
    const files = listFiles(root).filter((rel) => path.basename(rel) !== AI_INDEX);
    for (const rel of files) {
      entries.push({ name: AI_PREFIX + rel, data: fs.readFileSync(path.join(root, rel)) });
    }
    counts.sessions = files.length;
  }

  const manifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    appVersion: String(appVersion || ''),
    createdAt: Date.now(),
    categories: cats,
    counts,
  };
  entries.unshift({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  return encrypt(writeZip(entries), password);
}

/** 解密 + 解包，返回 manifest 与全部条目。 */
function unpackBackup({ data, password }) {
  const entries = readZip(decrypt(bufferize(data), password));
  const man = entries.find((e) => e.name === MANIFEST);
  if (!man) throw fail('BACKUP_BAD_FORMAT', 'manifest missing');
  let manifest;
  try {
    manifest = JSON.parse(man.data.toString('utf8'));
  } catch (_) {
    throw fail('BACKUP_BAD_FORMAT', 'manifest unreadable');
  }
  if (!manifest || manifest.format !== FORMAT) throw fail('BACKUP_BAD_FORMAT', 'unknown backup format');
  return { manifest, entries };
}

function clampRecentLimit(v) {
  return Math.min(RECENT_LIMIT_MAX, Math.max(1, Math.floor(Number(v)) || RECENT_LIMIT_DEFAULT));
}

function clampLogTotalMb(v) {
  return Math.min(LOG_TOTAL_MAX_MB, Math.max(LOG_TOTAL_MIN_MB, Math.floor(Number(v)) || LOG_TOTAL_DEFAULT_MB));
}

/**
 * 还原：只处理包里实际存在的类别。
 * 设置、资产与凭证为覆盖（dataPath 不动），AI 会话按文件叠加（同名覆盖、其余保留）。
 */
function restoreBackup({ store, entries }) {
  const summary = { settings: false, assets: false, credentials: false, aiSessions: 0 };
  const byName = new Map(entries.map((e) => [e.name, e]));

  const settingsEntry = byName.get(SETTINGS_ENTRY);
  if (settingsEntry) {
    let incoming;
    try {
      incoming = JSON.parse(settingsEntry.data.toString('utf8'));
    } catch (_) {
      throw fail('BACKUP_BAD_FORMAT', 'settings unreadable');
    }
    const clean = {};
    if (incoming && typeof incoming === 'object') {
      for (const key of RESTORE_SETTINGS_KEYS) {
        if (key in incoming) clean[key] = incoming[key];
      }
    }
    if ('ai' in clean) clean.ai = normalizeAi(clean.ai);
    if ('recentLimit' in clean) clean.recentLimit = clampRecentLimit(clean.recentLimit);
    if ('logTotalMb' in clean) clean.logTotalMb = clampLogTotalMb(clean.logTotalMb);
    store.updateSettings(clean);
    summary.settings = true;
  }

  const assetsEntry = byName.get(ASSETS_ENTRY);
  if (assetsEntry) {
    store.importGroups(assetsEntry.data.toString('utf8'));
    summary.assets = true;
  }

  const credentialsEntry = byName.get(CREDENTIALS_ENTRY);
  if (credentialsEntry) {
    store.importCredentials(credentialsEntry.data.toString('utf8'));
    summary.credentials = true;
  }

  const aiRoot = path.join(store.dataDir(), AI_DIR);
  for (const e of entries) {
    if (!e.name.startsWith(AI_PREFIX)) continue;
    const parts = e.name.slice(AI_PREFIX.length).split('/');
    // 拒绝空段与上跳，避免条目名把文件写到目录之外
    if (!parts.length || parts.some((p) => !p || p === '.' || p === '..')) continue;
    const dest = path.join(aiRoot, ...parts);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
    summary.aiSessions += 1;
  }
  return summary;
}

module.exports = {
  packBackup,
  unpackBackup,
  restoreBackup,
  MIN_PASSWORD,
  MAX_PASSWORD,
};