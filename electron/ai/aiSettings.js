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
  maxTurns: 30,
  maxTokens: 2048,
  temperature: 0.2,
  services: [],
  defaultRef: null,
});

const PERMISSIONS = ['ask', 'auto', 'full'];

/**
 * 上下文窗口的边界，单位是 token（设置页按 k token 输入，1k = 1000 token）。
 * 界面会把数字写实，这里只做范围收敛；缺失时取 128k 的保守默认，宁可提前压缩也不让请求超限。
 */
const CONTEXT_MIN = 64 * 1000;
const CONTEXT_MAX = 1024 * 1000;
const CONTEXT_DEFAULT = 128 * 1000;

const str = (value, max = 400) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const int = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const clamp01 = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

function normalizeModel(raw) {
  const src = raw || {};
  const id = str(src.id, 120);
  if (!id) return null;
  const contextTokens = int(src.contextTokens, CONTEXT_MIN, CONTEXT_MAX, CONTEXT_DEFAULT);
  return { id, alias: str(src.alias, 60) || id, contextTokens };
}

function normalizeService(raw) {
  const src = raw || {};
  const id = str(src.id, 64);
  const baseUrl = str(src.baseUrl, 300).replace(/\/+$/, '');
  if (!id || !/^https?:\/\//i.test(baseUrl)) return null;
  const models = (Array.isArray(src.models) ? src.models : []).map(normalizeModel).filter(Boolean);
  return { id, name: str(src.name, 60) || baseUrl, baseUrl, apiKey: str(src.apiKey, 400), models };
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const services = (Array.isArray(src.services) ? src.services : []).map(normalizeService).filter(Boolean);
  const permission = PERMISSIONS.includes(src.permission) ? src.permission : AI_DEFAULTS.permission;
  return {
    enabled: bool(src.enabled, AI_DEFAULTS.enabled),
    permission,
    readScreen: bool(src.readScreen, AI_DEFAULTS.readScreen),
    commandTimeoutSec: int(src.commandTimeoutSec, 10, 1800, AI_DEFAULTS.commandTimeoutSec),
    maxTurns: int(src.maxTurns, 3, 60, AI_DEFAULTS.maxTurns),
    maxTokens: int(src.maxTokens, 256, 32768, AI_DEFAULTS.maxTokens),
    temperature: clamp01(src.temperature, AI_DEFAULTS.temperature),
    services,
    defaultRef: src.defaultRef && typeof src.defaultRef === 'object'
      ? { serviceId: str(src.defaultRef.serviceId, 64), modelId: str(src.defaultRef.modelId, 120) }
      : null,
  };
}

function aiError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 解析一次调用要用的模型。ref 缺省时回落到 defaultRef，再回落到第一个服务的第一个模型，
 * 这样「刚配好服务就直接问」不必先去设默认值。找不到就明确报未配置，不猜服务。
 */
function resolveModel(settings, ref) {
  const cfg = normalize(settings);
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
  if (!service) throw aiError('AI_NO_SERVICE', '尚未配置模型服务');
  if (!model) throw aiError('AI_NO_MODEL', '该服务下没有模型');
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

module.exports = { AI_DEFAULTS, PERMISSIONS, normalize, resolveModel };
