/**
 * OpenAI 标准接口的流式客户端。只负责「一次请求 + 把 tool_calls 的分片拼回来」，
 * 不做任何业务判断——回合循环与审批在 aiManager。
 *
 * 错误一律抛成带 code 的 Error，消息保持英文技术描述供日志使用；
 * 面向用户的文案由渲染端按 code 翻译，避免主进程硬编码中文。
 */

const { OpenAI } = require('openai');

const REQUEST_TIMEOUT_MS = 90000;
const TEST_TIMEOUT_MS = 12000;
const MAX_TEXT_CHUNK = 4096;
const MAX_REASON_CHUNK = 4096;

function aiError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function clientFor(baseUrl, apiKey) {
  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/** SDK 的异常类型不带我们自己的 code，这里按状态码归一，401/404/429 是最常见的三类。 */
function toAiError(error) {
  // openai v4 的取消异常 name 就是 'Error'，只按 name 判会把「停止」报成请求失败
  if (error && (error instanceof OpenAI.APIUserAbortError || error.name === 'AbortError')) {
    return aiError('AI_CANCELED', 'request aborted');
  }
  const status = Number(error && error.status);
  const message = String((error && error.message) || error || 'unknown error').slice(0, 300);
  if (status === 401 || status === 403) return aiError('AI_AUTH', message, status);
  if (status === 404 || status === 400 || status === 422) return aiError('AI_MODEL', message, status);
  if (status === 429) return aiError('AI_RATE', message, status);
  if (status >= 500) return aiError('AI_SERVER', message, status);
  if (error && error.name === 'APIConnectionTimeoutError') return aiError('AI_TIMEOUT', message);
  if (error && error.name === 'APIConnectionError') return aiError('AI_NETWORK', message);
  return aiError('AI_REQUEST', message, status || undefined);
}

function textOf(delta) {
  const content = delta && delta.content;
  if (typeof content === 'string') return content;
  // 少数兼容网关把 content 发成 [{type:'text',text}] 数组
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

/** 思考增量：DeepSeek-R1 用 reasoning_content，o1 类网关用 reasoning，两者都归到同一条流里。 */
function reasonOf(delta) {
  const raw = (delta && (delta.reasoning_content || delta.reasoning)) || '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  if (raw && typeof raw.text === 'string') return raw.text;
  return '';
}

/**
 * 发一轮对话并流式回调文本增量，返回聚合后的完整文本与工具调用列表。
 * tool_calls 在流里是按 index 分片到达的（arguments 是 JSON 字符串碎片），必须自己累加。
 * 第一条分片到达就用 onCall 报出工具名：参数要整轮跑完才有 tool 事件，这段静默面板得先知道。
 */
async function streamChat(opts) {
  const { baseUrl, apiKey, model, messages, tools, maxTokens, temperature, signal, onText, onReason, onCall, log } = opts;
  const body = () => {
    const b = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      // 不声明就要不到流式末帧的 usage，用量行会一直是空
      stream_options: { include_usage: true },
    };
    if (Array.isArray(tools) && tools.length) b.tools = tools;
    return b;
  };
  const client = clientFor(baseUrl, apiKey);
  let stream;
  try {
    stream = await client.chat.completions.create(body(), { signal });
  } catch (error) {
    // 老网关（vLLM 0.4 之前、部分自建代理）遇到 stream_options 直接 400：丢掉该字段重试一次，
    // 只是拿不到 usage，不能让整条对话因此失败。
    const status = Number(error && error.status);
    if (status !== 400 && status !== 422) throw toAiError(error);
    log && log.warn('ai', 'ai stream_options rejected, retrying without usage', { model, status });
    const retry = body();
    delete retry.stream_options;
    try {
      stream = await client.chat.completions.create(retry, { signal });
    } catch (again) {
      throw toAiError(again);
    }
  }
  const calls = new Map();
  let text = '';
  let finishReason = '';
  let usage = null;
  let firstCallKey = null;
  let firstCallName = '';
  try {
    for await (const part of stream) {
      if (signal && signal.aborted) break;
      if (part.usage) usage = part.usage;
      const choice = part.choices && part.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      const piece = textOf(delta);
      if (piece) {
        text += piece;
        if (onText) onText(piece.slice(0, MAX_TEXT_CHUNK));
      }
      const thought = reasonOf(delta);
      if (thought && onReason) onReason(thought.slice(0, MAX_REASON_CHUNK));
      for (const tc of delta.tool_calls || []) {
        const key = tc.index == null ? calls.size : tc.index;
        if (!calls.has(key)) calls.set(key, { id: '', name: '', args: '' });
        const acc = calls.get(key);
        if (tc.id) acc.id = tc.id;
        if (tc.function && tc.function.name) acc.name += tc.function.name;
        // 第一条 tool_call 的名字一到就报给面板，参数还要跑完整轮才成事件；
        // 网关把名字也分片送时（首片空或半截），名字每长一截就重报一次，面板只是替换占位文案。
        if (firstCallKey === null) firstCallKey = key;
        if (key === firstCallKey && acc.name && acc.name !== firstCallName) {
          firstCallName = acc.name;
          if (onCall) onCall(acc.name);
        }
        if (tc.function && typeof tc.function.arguments === 'string') acc.args += tc.function.arguments;
      }
    }
  } catch (error) {
    throw toAiError(error);
  }
  const toolCalls = [...calls.values()].filter((c) => c.name).map((c) => ({
    id: c.id || 'call-' + Math.random().toString(36).slice(2, 10),
    name: c.name,
    args: parseArgs(c.args),
  }));
  return { text, toolCalls, finishReason, usage };
}

/** 网关偶尔吐出不合法 JSON 的参数串；解析失败要保留原文，让模型下一轮自己纠正。 */
function parseArgs(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { input: text };
  } catch (_) {
    return { __unparsed: text.slice(0, 2000) };
  }
}

/**
 * 压缩历史用的单次补全：只要一段备忘文本，不要工具调用，也不流式。
 * 失败由调用方退回裁剪，所以这里保持「要么给出正文，要么抛出带 code 的错误」。
 */
async function completeOnce(opts) {
  const { baseUrl, apiKey, model, messages, maxTokens, temperature, signal } = opts;
  const client = clientFor(baseUrl, apiKey);
  try {
    const res = await client.chat.completions.create(
      { model, messages, temperature: temperature == null ? 0 : temperature, max_tokens: maxTokens, stream: false },
      { signal }
    );
    const msg = res && res.choices && res.choices[0] ? res.choices[0].message : null;
    return { text: String((msg && msg.content) || ''), usage: (res && res.usage) || null };
  } catch (error) {
    throw toAiError(error);
  }
}

/**
 * 设置页的「测试连接」：只验证地址与 Key 可用，不把模型清单带回去（清单由「添加模型」单独拉）。
 * 优先打 /models；网关不支持该端点时退化成一次 1 token 的补全，此时必须有模型名。
 */
async function testConnection(opts) {
  const { baseUrl, apiKey, model, signal } = opts;
  const client = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout: TEST_TIMEOUT_MS });
  const started = Date.now();
  let probeError = null;
  try {
    await client.models.list({ signal });
    return { ok: true, ms: Date.now() - started, via: 'models' };
  } catch (error) {
    const mapped = toAiError(error);
    if (mapped.code === 'AI_AUTH' || mapped.code === 'AI_CANCELED') throw mapped;
    probeError = mapped;
  }
  if (!model) throw probeError;
  try {
    await client.chat.completions.create(
      { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
      { signal }
    );
    return { ok: true, ms: Date.now() - started, via: 'completion' };
  } catch (error) {
    throw toAiError(error);
  }
}

/** 「添加模型」用：拉 /models 的模型 id，最多 200 条。 */
async function listModels(opts) {
  const { baseUrl, apiKey, signal } = opts;
  const client = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout: TEST_TIMEOUT_MS });
  const started = Date.now();
  try {
    const list = await client.models.list({ signal });
    const models = (list && list.data ? list.data : []).map((m) => m && m.id).filter(Boolean).slice(0, 200);
    return { ms: Date.now() - started, models };
  } catch (error) {
    throw toAiError(error);
  }
}

module.exports = { streamChat, completeOnce, testConnection, listModels };
