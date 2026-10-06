/**
 * 上下文治理：什么进模型、进多少、逼近上限怎么裁、裁不动了怎么压。
 *
 * 进上下文的只有四类：工具 schema、每轮重建的 system（含终端屏幕快照）、
 * 对话消息（user 正文、assistant 正文与 tool_calls 参数、tool 回包）、以及压缩摘要。
 * 思考全文、整轮统计、审批卡片、压缩提示行都只服务于界面回放与落盘，一律不进。
 *
 * 不变量：展示记录（record）只追加永不删，上下文（messages）是有损滑窗，
 * 两者解耦——用户看到的历史不等于模型记住的内容。
 *
 * 没有真 tokenizer，按「CJK 每字 1 token、其余每 4 字符 1 token」估算，
 * 再用响应回来的真实 usage.prompt_tokens 校准系数（ratio 参数），误差靠预留余量兜住。
 */

/** 水位到这个比例就触发压缩。 */
/** 窗口缺失时的兜底，与设置侧的默认值同源，避免「预算按 A、显示按 B」。 */
const { CONTEXT_DEFAULT } = require('./aiSettings');

const TRIGGER_RATIO = 0.85;
/** 压缩要把水位降到的目标比例。 */
const TARGET_RATIO = 0.35;
/** 估算误差余量占窗口的比例，与 MIN_GUARD_TOKENS 取大。 */
const GUARD_RATIO = 0.05;
const MIN_GUARD_TOKENS = 1024;
/** 每条消息的角色、分隔等结构开销。 */
const MSG_OVERHEAD_TOKENS = 4;
/** 尾部至少留这么多条不许动，否则模型会连用户刚问什么都看不见。 */
const KEEP_LAST_MESSAGES = 2;
/** 少于这么条消息不值得发起压缩请求，直接走裁剪。 */
const MIN_COMPRESS_MESSAGES = 6;
/** 摘要相对被压缩原文的净收益要求，达不到就当作压不动。 */
const DIGEST_GAIN_RATIO = 0.3;
const DIGEST_ITEM_CHARS = 1200;
const DIGEST_SOURCE_CHARS = 24000;
const DIGEST_OUT_TOKENS = 1024;

const CJK = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffdc]/;

function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk += 1;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

/** 校准后的估算：ratio 来自上一次请求的真实 usage / 本轮估算，缺省 1。 */
function withRatio(tokens, ratio) {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return Math.ceil(tokens * r);
}

function messageTokens(msg, ratio) {
  let raw = estimateTokens(msg.content) + MSG_OVERHEAD_TOKENS;
  for (const call of msg.tool_calls || []) {
    raw += estimateTokens(call.function ? call.function.name : '')
      + estimateTokens(call.function ? call.function.arguments : '');
  }
  return withRatio(raw, ratio);
}

function messagesTokens(list, ratio) {
  return (list || []).reduce((n, m) => n + messageTokens(m, ratio), 0);
}

function toolsTokens(defs, ratio) {
  return withRatio(defs && defs.length ? estimateTokens(JSON.stringify(defs)) : 0, ratio);
}

/** 每轮都要重发的固定开销：工具定义 + system 提示词（屏幕快照已经拼在 system 里，不能再单独算）。 */
function fixedTokens({ system, tools }, ratio) {
  return withRatio(estimateTokens(system), ratio) + toolsTokens(tools, ratio);
}

/**
 * 一次预算快照。room 是对话消息能占的额度，used/pct 是圆环要显示的水位。
 * 水位分母是整个窗口，所以预留与安全余量算「占着但没在用」，永远不会显示成 100%。
 */
function budget({ window, maxTokens, system, tools, messages }, ratio) {
  const win = Number.isFinite(window) && window > 0 ? window : CONTEXT_DEFAULT;
  const reserve = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0;
  const guard = Math.max(MIN_GUARD_TOKENS, Math.round(win * GUARD_RATIO));
  const fixed = fixedTokens({ system, tools }, ratio);
  const msgTokens = messagesTokens(messages, ratio);
  const used = fixed + msgTokens;
  return {
    window: win,
    reserve,
    guard,
    fixed,
    parts: {
      tools: toolsTokens(tools, ratio),
      system: withRatio(estimateTokens(system), ratio),
      messages: msgTokens,
    },
    used,
    pct: Math.min(100, Math.round((used / win) * 100)),
    room: Math.max(0, win - reserve - guard - fixed),
    triggerAt: Math.round(win * TRIGGER_RATIO),
    targetRoom: Math.max(0, Math.round(win * TARGET_RATIO) - fixed),
  };
}

/**
 * 删除单元：带 tool_calls 的 assistant 必须连同它后面所有 tool 回包一起走，
 * 否则残留的孤儿 tool 消息会让服务端把整个请求拒掉。
 */
function oldestUnit(list, limit) {
  for (let i = 0; i < Math.min(limit, list.length); i += 1) {
    const msg = list[i];
    if (msg.role === 'assistant' && msg.tool_calls) {
      let end = i + 1;
      while (end < list.length && list[end].role === 'tool') end += 1;
      return { at: i, count: end - i };
    }
    // 连续的孤儿 tool（前一条 assistant 已被删）也要一并清掉，不能留在序列里
    if (msg.role !== 'tool') return { at: i, count: 1 };
  }
  return { at: 0, count: 1 };
}

/** 按额度成对裁剪；返回新数组与被删条数，尾部 KEEP_LAST_MESSAGES 条不动。 */
function trimToFit(messages, roomTokens, ratio) {
  const list = messages.slice();
  let dropped = 0;
  let limit = Math.max(0, list.length - KEEP_LAST_MESSAGES);
  while (messagesTokens(list, ratio) > roomTokens && list.length > KEEP_LAST_MESSAGES) {
    const unit = oldestUnit(list, limit);
    if (unit.at < 0 || unit.count <= 0) break;
    list.splice(unit.at, unit.count);
    dropped += unit.count;
    limit = Math.max(0, list.length - KEEP_LAST_MESSAGES);
  }
  return { messages: list, dropped, tokens: messagesTokens(list, ratio) };
}

/**
 * 找出压缩分界点：尾巴先兜住最后 KEEP_LAST_MESSAGES 条（哪怕超出额度，
 * 也不能把用户刚问的问题压进摘要），额度还有富余就往前多留几条。
 * 尾巴不能以 tool 回包开头，否则它对应的 assistant 被压进了摘要，会留下孤儿。
 */
function splitForDigest(messages, tailRoomTokens, ratio) {
  let at = Math.max(0, messages.length - KEEP_LAST_MESSAGES);
  let acc = messagesTokens(messages.slice(at), ratio);
  while (at > 0) {
    const next = acc + messageTokens(messages[at - 1], ratio);
    if (next > tailRoomTokens) break;
    acc = next;
    at -= 1;
  }
  while (at > 0 && messages[at].role === 'tool') at -= 1;
  const head = messages.slice(0, at);
  const tail = messages.slice(at);
  return { head, tail, ok: head.length >= MIN_COMPRESS_MESSAGES };
}

/** 摘要在上下文里的样子：一条 system 消息，后面接保留下来的尾巴。 */
function digestMessage(text) {
  return { role: 'system', content: '[前情摘要]' + text };
}

/** 送去压缩的原文：逐条截断，总长再兜一层，别把压缩请求自己顶爆。 */
function digestSource(list) {
  const lines = [];
  let chars = 0;
  for (const m of list) {
    let body = String(m.content == null ? '' : m.content).slice(0, DIGEST_ITEM_CHARS);
    for (const call of m.tool_calls || []) {
      body = (body ? body + ' ' : '') + '调用 ' + (call.function ? call.function.name : '')
        + '(' + String(call.function ? call.function.arguments : '').slice(0, 400) + ')';
    }
    const line = m.role + ': ' + body;
    chars += line.length;
    if (chars > DIGEST_SOURCE_CHARS) { lines.push('……更早内容已省略'); break; }
    lines.push(line);
  }
  return lines.join('\n');
}

/** 压缩指令：终端排障场景里，被否决过的操作和未完成任务比结论更要命。 */
const DIGEST_PROMPT = [
  '你在压缩一段 SSH 终端助手的对话历史，输出后续推理需要的备忘。',
  '必须保留：主机与目录等环境事实；已经确认的结论；用户明确否决或要求过的操作；',
  '尚未完成的任务目标；失败过的命令与失败原因。',
  '用要点式中文，不超过 400 字，不要复述命令的完整输出，不要添加历史里没有的推断。',
  '只输出备忘正文，不要开场白。',
].join('\n');

module.exports = {
  estimateTokens,
  messagesTokens,
  budget,
  trimToFit,
  splitForDigest,
  digestMessage,
  digestSource,
  DIGEST_PROMPT,
  DIGEST_OUT_TOKENS,
  DIGEST_GAIN_RATIO,
};
