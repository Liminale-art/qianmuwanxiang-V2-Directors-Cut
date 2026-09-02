// 千幕 · 自定义（兼容 OpenAI）生图能力档。
// 只描述可公开保存的协议能力；API Key、Authorization、Cookie 等凭据永不进入此对象。

export const QIANMU_OPENAI_IMAGE_COMPAT_SCHEMA = 'qianmu.openai-image-compat.v1';
export const QIANMU_OPENAI_MODEL_DISCOVERY = Object.freeze(['optional', 'off', 'required']);
export const QIANMU_OPENAI_REFERENCE_FIELDS = Object.freeze(['image', 'image[]']);
export const QIANMU_OPENAI_RESPONSE_KINDS = Object.freeze(['b64_json', 'base64', 'url']);
export const QIANMU_OPENAI_STANDARD_PARAMETERS = Object.freeze(['n', 'size', 'quality', 'background', 'output_format']);

const DEFAULT_PROVIDER_OPTIONS = Object.freeze(['input_fidelity']);
const SENSITIVE_HEADER = /(?:^|-)(?:authorization|proxy-authorization|cookie|set-cookie|api-key|access-key|token|access-token|secret)(?:$|-)/i;

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const cleanText = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const unique = (value, allowed = null, max = 40) => {
  const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\n]+/) : [];
  return [...new Set(rows.map((item) => cleanText(item, 80)).filter((item) => item && (!allowed || allowed.includes(item))))].slice(0, max);
};

function endpointPath(value, fallback) {
  const path = cleanText(value || fallback, 300).replace(/^\/+|\/+$/g, '');
  if (!path || /[:?#\\]/.test(path) || path.split('/').some((part) => part === '..')) return fallback;
  return path;
}

function safeHeaderName(value) {
  const name = cleanText(value, 80);
  return /^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(name) && !SENSITIVE_HEADER.test(name) ? name : '';
}

function safeOptionName(value) {
  const name = cleanText(value, 80);
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name)
    && !/(?:^|[-_.])(?:model|prompt|image|authorization|api[-_]?key|access[-_]?key|token|secret)(?:$|[-_.])/i.test(name) ? name : '';
}

export function normalizeOpenAIImageCompatibility(value = {}) {
  const raw = object(value);
  const responseKinds = unique(raw.responseKinds || raw.response_kinds, QIANMU_OPENAI_RESPONSE_KINDS);
  const allowedParameters = unique(raw.allowedParameters || raw.allowed_parameters, QIANMU_OPENAI_STANDARD_PARAMETERS);
  const providerOptionKeys = unique(raw.providerOptionKeys || raw.provider_option_keys, null).map(safeOptionName).filter(Boolean);
  const customHeaderNames = unique(raw.customHeaderNames || raw.custom_header_names, null).map(safeHeaderName).filter(Boolean);
  return {
    schema: QIANMU_OPENAI_IMAGE_COMPAT_SCHEMA,
    modelDiscovery: QIANMU_OPENAI_MODEL_DISCOVERY.includes(raw.modelDiscovery || raw.model_discovery)
      ? (raw.modelDiscovery || raw.model_discovery) : 'optional',
    endpoints: {
      models: endpointPath(raw.endpoints?.models || raw.modelsEndpoint || raw.models_endpoint, 'models'),
      generation: endpointPath(raw.endpoints?.generation || raw.generationEndpoint || raw.generation_endpoint, 'images/generations'),
      edit: endpointPath(raw.endpoints?.edit || raw.editEndpoint || raw.edit_endpoint, 'images/edits'),
    },
    referenceField: QIANMU_OPENAI_REFERENCE_FIELDS.includes(raw.referenceField || raw.reference_field)
      ? (raw.referenceField || raw.reference_field) : 'image[]',
    responseKinds: responseKinds.length ? responseKinds : [...QIANMU_OPENAI_RESPONSE_KINDS],
    allowedParameters: raw.allowedParameters !== undefined || raw.allowed_parameters !== undefined
      ? allowedParameters : [...QIANMU_OPENAI_STANDARD_PARAMETERS],
    providerOptionKeys: raw.providerOptionKeys !== undefined || raw.provider_option_keys !== undefined
      ? providerOptionKeys : [...DEFAULT_PROVIDER_OPTIONS],
    customHeaderNames,
  };
}

export function normalizeOpenAICompatibleHeaders(value = {}, compatibility = {}) {
  const profile = normalizeOpenAIImageCompatibility(compatibility);
  const allowed = new Set(profile.customHeaderNames.map((item) => item.toLowerCase()));
  const output = {};
  for (const [rawName, rawValue] of Object.entries(object(value)).slice(0, 40)) {
    const name = safeHeaderName(rawName);
    const headerValue = cleanText(rawValue, 2000).replace(/[\r\n]/g, ' ');
    if (name && headerValue && allowed.has(name.toLowerCase())) output[name] = headerValue;
  }
  return output;
}

export function filterOpenAIProviderOptions(value = {}, compatibility = {}) {
  const profile = normalizeOpenAIImageCompatibility(compatibility);
  const allowed = new Set(profile.providerOptionKeys);
  return Object.fromEntries(Object.entries(object(value)).filter(([key, item]) => {
    if (!allowed.has(key) || item === undefined) return false;
    return item === null || ['string', 'number', 'boolean'].includes(typeof item);
  }));
}

export function openAICompatibilityAllows(compatibility, parameter) {
  return normalizeOpenAIImageCompatibility(compatibility).allowedParameters.includes(parameter);
}

export function parseOpenAICompatibleHeaders(value = '') {
  const rows = String(value || '').split(/\r?\n/);
  const headers = {}, names = [];
  for (const row of rows.slice(0, 40)) {
    const separator = row.indexOf(':');
    if (separator < 1) continue;
    const name = safeHeaderName(row.slice(0, separator));
    const headerValue = cleanText(row.slice(separator + 1), 2000).replace(/[\r\n]/g, ' ');
    if (!name || !headerValue) continue;
    headers[name] = headerValue;
    names.push(name);
  }
  return { headers, names: [...new Set(names)] };
}

export function serializeOpenAICompatibleHeaders(value = {}, compatibility = {}) {
  const headers = normalizeOpenAICompatibleHeaders(value, compatibility);
  return Object.entries(headers).map(([name, headerValue]) => `${name}: ${headerValue}`).join('\n');
}
