/**
 * AI 会话记录的落盘存储。
 *
 * 目录结构：<数据存储路径>/ai-sessions/<资产 ID>--<协议>/<会话 ID>.json，
 * 一个会话一个文件，所以「A 资产的 SSH」这类归属天然隔离，删资产也不会牵连别处。
 * version 1 只有展示记录（用户提问、思考、正文、命令、审批/选择、压缩行、整轮统计）；
 * version 2 另存 context——当时真正发给模型的那份序列与水位快照，加载会话才能原样接上。
 * 两个版本都不写 system 提示词与审批等待中的凭证。
 *
 * 同目录另有 index.list：该目录所有会话的摘要缓存（含每个文件的 mtime/大小）。
 * 列历史只读它，不再逐个打开会话文件；与目录对不上时按差异单个重读或删除条目并写回。
 * 它只是加速层，缺失/损坏都按「整目录重建」处理，删掉也不影响正确性。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT_DIR = 'ai-sessions';
const INDEX_FILE = 'index.list';
const INDEX_VERSION = 1;
const ASSET_KEY = /^a-[a-zA-Z0-9-]{1,64}$/;
const PROTOCOL_KEY = /^[a-z0-9-]{1,16}$/;
const SESSION_KEY = /^ais-[a-zA-Z0-9-]{1,64}$/;
const OUTPUT_CHARS = 4000;
const TEXT_CHARS = 8000;
/** 正文与思考的上限：远高于单次输出派生上限（`aiManager` 的 OUTPUT_MAX 8192 token）能产出的长度，否则长答案会在记录里被腰斩。 */
const ANSWER_CHARS = 200000;
const CONTEXT_ARGS_CHARS = 4000;
const CONTEXT_CALLS = 8;

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

function summaryOf(rec) {
  let preview = '';
  for (let i = rec.messages.length - 1; i >= 0; i -= 1) {
    const m = rec.messages[i];
    if (m.role === 'ai' || m.role === 'user') { preview = m.text; break; }
  }
  return {
    id: rec.id,
    title: rec.title,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    assetId: rec.assetId,
    assetName: rec.assetName,
    protocol: rec.protocol,
    host: rec.host,
    port: rec.port,
    // 与面板里「未归档」那一行同口径：提问与正文算消息，命令/审批/反问算步骤，否则同一段对话两处数字对不上
    messages: rec.messages.filter((m) => m.role === 'user' || m.role === 'ai').length,
    steps: rec.messages.filter((m) => m.role === 'step' || m.role === 'approval' || m.role === 'choice').length,
    preview: str(preview, 160),
  };
}

class AiSessionStore {
  constructor({ store, log } = {}) {
    this.store = store;
    this.log = log;
  }

  root() {
    return path.join(this.store.dataDir(), ROOT_DIR);
  }

  /** 归属目录；非法 assetId / protocol 直接拒绝，避免拼出越界路径。 */
  dirOf(assetId, protocol) {
    if (typeof assetId !== 'string' || !ASSET_KEY.test(assetId)) throw this.error('AI_REQUEST', 'invalid assetId');
    if (typeof protocol !== 'string' || !PROTOCOL_KEY.test(protocol)) throw this.error('AI_REQUEST', 'invalid protocol');
    return path.join(this.root(), assetId + '--' + protocol);
  }

  fileOf(assetId, protocol, id) {
    if (typeof id !== 'string' || !SESSION_KEY.test(id)) throw this.error('AI_REQUEST', 'invalid session id');
    return path.join(this.dirOf(assetId, protocol), id + '.json');
  }

  error(code, message) {
    return Object.assign(new Error(message), { code });
  }

  async list(assetId, protocol) {
    const dir = this.dirOf(assetId, protocol);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (_) {
      return [];
    }
    const onDisk = new Set();
    for (const name of names) {
      if (name.endsWith('.json')) onDisk.add(name);
    }
    const cached = this._readIndex(dir);
    const files = cached ? { ...cached } : {};
    let dirty = !cached;
    // 目录里已删除的文件，对应条目一并去掉
    for (const name of Object.keys(files)) {
      if (!onDisk.has(name)) {
        delete files[name];
        dirty = true;
      }
    }
    // 新出现或 mtime/大小变过的文件才单独读取，其余直接复用摘要
    for (const name of onDisk) {
      let st;
      try {
        st = await fsp.stat(path.join(dir, name));
      } catch (_) {
        continue;
      }
      const prev = files[name];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
      const rec = await this._readFileAsync(path.join(dir, name), true);
      files[name] = { mtimeMs: st.mtimeMs, size: st.size, summary: rec ? summaryOf(rec) : null };
      dirty = true;
    }
    if (dirty) this._writeIndex(dir, files);
    const out = [];
    for (const name of Object.keys(files)) {
      const summary = files[name] && files[name].summary;
      if (summary) out.push(summary);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  read(assetId, protocol, id) {
    return this._readFile(this.fileOf(assetId, protocol, id));
  }

  /** 新建或覆盖一条会话记录；createdAt 由已有记录保留，返回摘要给渲染端直接上列表。 */
  write(record) {
    const file = this.fileOf(record.assetId, record.protocol, record.id);
    const prev = this._readFile(file);
    const context = record.context && Array.isArray(record.context.messages) ? normalizeContext(record.context) : null;
    const rec = {
      version: context ? 2 : 1,
      id: record.id,
      assetId: record.assetId,
      assetName: str(record.assetName, 120),
      protocol: record.protocol,
      host: str(record.host, 200),
      port: Number.isInteger(record.port) ? record.port : 0,
      title: str(record.title, 120),
      createdAt: prev ? prev.createdAt : record.createdAt || Date.now(),
      updatedAt: Date.now(),
      messages: (record.messages || []).map(normalizeMessage).filter(Boolean),
      context,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再改名：中途崩溃不会留下半截 JSON
    fs.writeFileSync(file + '.tmp', JSON.stringify(rec, null, 2), 'utf8');
    fs.renameSync(file + '.tmp', file);
    const summary = summaryOf(rec);
    this._indexPut(path.dirname(file), path.basename(file), file, summary);
    this.log && this.log.info('ai', 'ai session archived', { file: path.basename(file), assetId: rec.assetId, messages: rec.messages.length });
    return summary;
  }

  rename(assetId, protocol, id, title) {
    const file = this.fileOf(assetId, protocol, id);
    const rec = this._readFile(file);
    if (!rec) throw this.error('AI_SESSION_GONE', 'session record not found');
    const next = str(title, 120).trim();
    if (!next) throw this.error('AI_REQUEST', 'empty title');
    rec.title = next;
    rec.updatedAt = Date.now();
    fs.writeFileSync(file + '.tmp', JSON.stringify(rec, null, 2), 'utf8');
    fs.renameSync(file + '.tmp', file);
    const summary = summaryOf(rec);
    this._indexPut(path.dirname(file), path.basename(file), file, summary);
    return summary;
  }

  remove(assetId, protocol, id) {
    const file = this.fileOf(assetId, protocol, id);
    fs.rmSync(file, { force: true });
    this._indexDrop(path.dirname(file), path.basename(file));
    this.log && this.log.info('ai', 'ai session deleted', { sessionId: id, assetId });
    return { ok: true };
  }

  /** 读取目录摘要缓存；缺失、损坏或版本不符一律返回 null，交调用方整目录重建。 */
  _readIndex(dir) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
      if (!obj || obj.version !== INDEX_VERSION || !obj.files || typeof obj.files !== 'object') return null;
      return obj.files;
    } catch (_) {
      return null;
    }
  }

  _writeIndex(dir, files) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, INDEX_FILE);
      fs.writeFileSync(file + '.tmp', JSON.stringify({ version: INDEX_VERSION, files }, null, 2), 'utf8');
      fs.renameSync(file + '.tmp', file);
    } catch (_) {
      // 索引只是加速层，写不进去就等下次整目录重建
    }
  }

  /** 单条摘要写回；索引还不存在时不急着建，避免建出缺项的半成品，交给 list 全量重建。 */
  _indexPut(dir, name, file, summary) {
    const files = this._readIndex(dir);
    if (!files) return;
    try {
      const st = fs.statSync(file);
      files[name] = { mtimeMs: st.mtimeMs, size: st.size, summary };
    } catch (_) {
      delete files[name];
    }
    this._writeIndex(dir, files);
  }

  _indexDrop(dir, name) {
    const files = this._readIndex(dir);
    if (!files) return;
    delete files[name];
    this._writeIndex(dir, files);
  }

  _readFile(file, skipContext) {
    try {
      return this._parseRecord(JSON.parse(fs.readFileSync(file, 'utf8')), skipContext);
    } catch (_) {
      return null;
    }
  }

  /** list 的逐文件读取走异步版，避免列历史时同步读整份文件把主进程卡住。 */
  async _readFileAsync(file, skipContext) {
    try {
      return this._parseRecord(JSON.parse(await fsp.readFile(file, 'utf8')), skipContext);
    } catch (_) {
      return null;
    }
  }

  _parseRecord(parsed, skipContext) {
    if (!parsed || !Array.isArray(parsed.messages) || typeof parsed.id !== 'string') return null;
    parsed.messages = parsed.messages.map(normalizeMessage).filter(Boolean);
    parsed.title = str(parsed.title, 120);
    parsed.context = !skipContext && parsed.context && Array.isArray(parsed.context.messages) ? normalizeContext(parsed.context) : null;
    return parsed;
  }
}

/** 记录条目只保留面板要消费的字段，多余内容一律丢掉，避免旧文件结构变化把渲染端带崩。 */
function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.role === 'user' || m.role === 'ai') {
    const text = str(m.text, ANSWER_CHARS).trim();
    return text ? { role: m.role, text } : null;
  }
  if (m.role === 'approval') {
    const out = {
      role: 'approval',
      name: str(m.name, 60),
      command: str(m.command, TEXT_CHARS),
      reason: str(m.reason, 1000),
      readOnly: !!m.readOnly,
      // 读不懂的结论按「未允许」处理：脏记录不能伪装成用户点过允许。timeout 是旧记录里的「整轮被停止」
      decision: ['allow', 'deny', 'canceled', 'ended', 'timeout'].includes(m.decision) ? m.decision : 'deny',
    };
    return out;
  }
  if (m.role === 'think') {
    const text = str(m.text, ANSWER_CHARS).trim();
    return text ? { role: 'think', text, ms: numOrNull(m.ms) } : null;
  }
  if (m.role === 'choice') {
    const options = (Array.isArray(m.options) ? m.options : [])
      .map((o) => str(o, 200).trim())
      .filter(Boolean)
      .slice(0, 6);
    if (!options.length) return null;
    return {
      role: 'choice',
      question: str(m.question, TEXT_CHARS),
      options,
      choice: str(m.choice, 200),
      state: m.state === 'skipped' ? 'skipped' : 'picked',
    };
  }
  if (m.role === 'turn') {
    // 只承载整轮统计，回放时给回合头部一个耗时与用量，不参与模型上下文
    const out = { role: 'turn', ms: numOrNull(m.ms) };
    if (m.promptTokens) out.promptTokens = numOrNull(m.promptTokens);
    if (m.completionTokens) out.completionTokens = numOrNull(m.completionTokens);
    if (m.truncated) out.truncated = true;
    return out;
  }
  if (m.role === 'compress') {
    // 展示行只留「这里压过一次」的数字，备忘正文在 context 段里，不重复存一遍
    return { role: 'compress', moved: numOrNull(m.moved), from: numOrNull(m.from), to: numOrNull(m.to) };
  }
  if (m.role === 'step') {
    return {
      role: 'step',
      name: str(m.name, 60),
      command: str(m.command, TEXT_CHARS),
      channel: str(m.channel, 20),
      state: ['done', 'denied', 'failed', 'stopped'].includes(m.state) ? m.state : 'done',
      exitCode: Number.isInteger(m.exitCode) ? m.exitCode : null,
      ms: Number.isFinite(m.ms) ? m.ms : null,
      auto: !!m.auto,
      output: str(m.output, OUTPUT_CHARS),
    };
  }
  return null;
}

/** 上下文里的单条消息：只认模型序列用得上的四种角色，其余一律丢弃。 */
function normalizeContextMessage(m) {
  if (!m || typeof m !== 'object') return null;
  if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) return null;
  // 与展示记录同一把上限：重启后恢复的模型序列必须和内存里那份一致，否则重开一次就换了上下文
  const out = { role: m.role, content: str(m.content, ANSWER_CHARS) };
  if (m.role === 'tool') {
    const callId = str(m.tool_call_id, 60);
    if (!callId) return null;
    out.tool_call_id = callId;
    return out;
  }
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls.slice(0, CONTEXT_CALLS) : [];
  const kept = calls.map((c) => ({
    id: str(c && c.id, 60),
    type: 'function',
    function: { name: str(c && c.function && c.function.name, 60), arguments: str(c && c.function && c.function.arguments, CONTEXT_ARGS_CHARS) },
  })).filter((c) => c.id && c.function.name);
  if (kept.length) out.tool_calls = kept;
  return out;
}

/**
 * 上下文段整备：开头不允许是孤儿 tool（它的 assistant 已经不在），
 * 回包找不到对应调用 id 的 tool 也一并剔掉，否则恢复出来的序列会被服务端拒。
 */
function normalizeContext(ctx) {
  const messages = (ctx.messages || []).map(normalizeContextMessage).filter(Boolean);
  while (messages.length && messages[0].role === 'tool') messages.shift();
  const called = new Set();
  for (const m of messages) for (const c of m.tool_calls || []) called.add(c.id);
  const ratio = Number(ctx.ratio);
  return {
    window: Number.isFinite(ctx.window) ? ctx.window : 0,
    used: Number.isFinite(ctx.used) ? ctx.used : 0,
    ratio: ratio >= 0.4 && ratio <= 3 ? ratio : 1,
    messages: messages.filter((m) => m.role !== 'tool' || called.has(m.tool_call_id)),
  };
}

module.exports = { AiSessionStore };
