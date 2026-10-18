/**
 * AI 助手配置在主进程侧的独立边界：设置页写进来的原始对象不可信，这里负责收敛类型、
 * 夹住数值范围，并把「服务 + 模型」解析成一次请求真正需要的 baseUrl / apiKey / model。
 * API Key 只在进程内使用，任何返回值都不带 key 之外的派生副本，也不得进日志。
 */

const AI_DEFAULTS = Object.freeze({
  enabled: true,
  permission: 'auto',
  readScreen: true,
  commandTimeoutSec: 300,
  maxTurns: 80,
  temperature: 0.2,
  services: [],
  defaultRef: null,
});

const PERMISSIONS = ['ask', 'auto', 'full'];

/**
 * 上下文窗口的边界，单位是 token（设置页按 k token 输入，1k = 1000 token）。
 * 界面会把数字写实，这里只做范围收敛；缺字段的旧记录按下面的预置表兜底。
 */
const CONTEXT_MIN = 64 * 1000;
const CONTEXT_MAX = 1024 * 1000;
const CONTEXT_DEFAULT = 128 * 1000;

/**
 * 主流模型的窗口初值（k token），与 `src/constants.js` 的 `AI_CONTEXT_PRESETS` 必须一致：
 * 设置页用它预填新行，这里用它补旧记录缺的 contextTokens。两处不同步就会出现
 * 「界面显示 1000k、引擎按 128k 预算」这种两套口径的 bug。改一处必须改两处。
 */
const CONTEXT_PRESETS = [
  ['gpt-4.1', 1000],
  ['gpt-4.5', 400],
  ['gpt-5', 400],
  ['gpt-4o', 128],
  ['gpt-4-turbo', 128],
  ['chatgpt-4o', 128],
  ['o1', 200],
  ['o3', 200],
  ['o4', 200],
  ['claude', 200],
  ['gemini', 1000],
  ['deepseek', 128],
  ['qwen', 128],
  ['kimi', 128],
  ['moonshot', 128],
  ['glm', 128],
  ['llama', 128],
  ['mistral', 128],
  ['gemma', 128],
  ['command', 128],
];

const str = (value, max = 400) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const int = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const clampTemp = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(0.5, Math.max(0, n)) : fallback;
};

/** 按模型 ID 前缀猜窗口（k token），命中不了用 128k 的保守默认。 */
function presetContextK(modelId) {
  const key = String(modelId || '').toLowerCase();
  const hit = CONTEXT_PRESETS.find(([prefix]) => key.startsWith(prefix));
  return Math.min(CONTEXT_MAX / 1000, Math.max(CONTEXT_MIN / 1000, hit ? hit[1] : CONTEXT_DEFAULT / 1000));
}

function normalizeModel(raw) {
  const src = raw || {};
  const id = str(src.id, 120);
  if (!id) return null;
  const contextTokens = int(src.contextTokens, CONTEXT_MIN, CONTEXT_MAX, presetContextK(id) * 1000);
  return { id, alias: str(src.alias, 60) || id, contextTokens };
}

function normalizeService(raw) {
  const src = raw || {};
  const id = str(src.id, 64);
  const baseUrl = str(src.baseUrl, 300).replace(/\/+$/, '');
  if (!id || !/^https?:\/\//i.test(baseUrl)) return null;
  // 重复 ID 会让设置页的 v-for key 撞车，两行共用一个编辑框，落盘前先按 ID 去重
  const seen = new Set();
  const models = (Array.isArray(src.models) ? src.models : [])
    .map(normalizeModel)
    .filter((m) => m && !seen.has(m.id) && seen.add(m.id));
  return { id, name: str(src.name, 60) || baseUrl, baseUrl, apiKey: str(src.apiKey, 400), models };
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const seenService = new Set();
  const services = (Array.isArray(src.services) ? src.services : [])
    .map(normalizeService)
    .filter((s) => s && !seenService.has(s.id) && seenService.add(s.id));
  // 读不懂的审批级别按「每条都问」收，不能落到 auto：配置损坏或写错值时静默放行命令是不可接受的
  const permission = PERMISSIONS.includes(src.permission) ? src.permission : 'ask';
  // 默认模型必须仍能解析到具体服务与模型，否则星标指向一个已删除的目标，实际应答的却是回落模型
  const ref = src.defaultRef && typeof src.defaultRef === 'object'
    ? { serviceId: str(src.defaultRef.serviceId, 64), modelId: str(src.defaultRef.modelId, 120) }
    : null;
  const refService = ref && services.find((s) => s.id === ref.serviceId) || null;
  const defaultRef = refService && refService.models.some((m) => m.id === ref.modelId) ? ref : null;
  return {
    enabled: bool(src.enabled, AI_DEFAULTS.enabled),
    permission,
    readScreen: bool(src.readScreen, AI_DEFAULTS.readScreen),
    commandTimeoutSec: int(src.commandTimeoutSec, 10, 1800, AI_DEFAULTS.commandTimeoutSec),
    maxTurns: int(src.maxTurns, 3, 300, AI_DEFAULTS.maxTurns),
    temperature: clampTemp(src.temperature, AI_DEFAULTS.temperature),
    services,
    defaultRef,
  };
}

function aiError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 解析一次调用要用的模型。ref 缺省时回落到 defaultRef，再回落到第一个有模型的服务的第一个模型，
 * 这样「刚配好服务就直接问」不必先去设默认值。两个错误码分开：完全没有服务是 AI_NO_SERVICE，
 * 有服务但一个模型都没有（或默认模型被删）是 AI_NO_MODEL。
 */
function resolveModel(settings, ref) {
  const cfg = normalize(settings);
  if (!cfg.services.length) throw aiError('AI_NO_SERVICE', '尚未配置模型服务');
  const wanted = ref && ref.serviceId ? { serviceId: str(ref.serviceId, 64), modelId: str(ref.modelId, 120) } : cfg.defaultRef;
  let service = null;
  let model = null;
  if (wanted && wanted.serviceId) {
    service = cfg.services.find((s) => s.id === wanted.serviceId) || null;
    if (service) {
      model = wanted.modelId ? service.models.find((m) => m.id === wanted.modelId) : service.models[0];
    }
  }
  if (!service || !model) {
    const first = cfg.services.find((s) => s.models.length) || null;
    service = first;
    model = first ? first.models[0] : null;
  }
  if (!model) throw aiError('AI_NO_MODEL', '模型服务里还没有可用的模型');
  if (!service.apiKey) throw aiError('AI_NO_KEY', '服务「' + service.name + '」缺少 API Key');
  return {
    baseUrl: service.baseUrl,
    apiKey: service.apiKey,
    model: model.id,
    label: model.alias || model.id,
    contextTokens: model.contextTokens,
    serviceId: service.id,
    serviceName: service.name,
  };
}

module.exports = { AI_DEFAULTS, PERMISSIONS, CONTEXT_DEFAULT, normalize, resolveModel };
