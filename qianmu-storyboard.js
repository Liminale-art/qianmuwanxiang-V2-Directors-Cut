// 千幕·分镜：只负责稳定的数据契约与 SillyTavern /imagine 命令适配。
// UI、密钥录入与正文挂载留在主扩展；此层不实现任何生图供应商 HTTP 请求。

export const STORYBOARD_SOURCES = Object.freeze({
  novel: Object.freeze({ id: 'novel', label: 'NovelAI', stSource: 'novel', secretKey: 'api_key_novel' }),
  comfy: Object.freeze({ id: 'comfy', label: 'ComfyUI', stSource: 'comfy', secretKey: '' }),
  openai: Object.freeze({ id: 'openai', label: 'OpenAI', stSource: 'openai', secretKey: 'api_key_openai' }),
  banana: Object.freeze({ id: 'banana', label: 'Banana', stSource: 'google', secretKey: 'api_key_makersuite' }),
});

export const STORYBOARD_RATIOS = Object.freeze([
  Object.freeze({ id: '', label: '沿用当前' }),
  Object.freeze({ id: '1:1', label: '1 : 1', value: 1 }),
  Object.freeze({ id: '2:3', label: '2 : 3', value: 2 / 3 }),
  Object.freeze({ id: '3:2', label: '3 : 2', value: 3 / 2 }),
  Object.freeze({ id: '3:4', label: '3 : 4', value: 3 / 4 }),
  Object.freeze({ id: '4:3', label: '4 : 3', value: 4 / 3 }),
  Object.freeze({ id: '9:16', label: '9 : 16', value: 9 / 16 }),
  Object.freeze({ id: '16:9', label: '16 : 9', value: 16 / 9 }),
]);

export function createStoryboardDefaults() {
  return {
    view: 'create',                // create | characters | gallery | connection
    source: 'novel',
    initialized: false,             // 首开时从 ST 当前连接取一次，不在千幕硬塞画质默认值
    target: 'latest',              // latest | floor | gallery
    floor: '',
    inlineByDefault: true,
    prompt: '',
    negative: '',
    selectedCharacterId: '',
    profiles: Object.fromEntries(Object.keys(STORYBOARD_SOURCES).map((id) => [id, {
      loaded: false,
      model: '', sampler: '', scheduler: '', width: '', height: '', ratio: '', steps: '', cfg: '', seed: '',
      comfyUrl: '', comfyWorkflow: '', openaiStyle: '', openaiQuality: '', googleEnhance: false,
      novelSm: false, novelSmDyn: false, novelDecrisper: false, novelVarietyBoost: false,
    }])),
    characters: [],
  };
}

export function normalizeStoryboardState(value) {
  const defaults = createStoryboardDefaults();
  const state = value && typeof value === 'object' ? value : {};
  for (const [key, fallback] of Object.entries(defaults)) {
    if (state[key] === undefined) state[key] = structuredCloneSafe(fallback);
  }
  state.view = ['create', 'characters', 'gallery', 'connection'].includes(state.view) ? state.view : 'create';
  state.source = STORYBOARD_SOURCES[state.source] ? state.source : 'novel';
  state.target = ['latest', 'floor', 'gallery'].includes(state.target) ? state.target : 'latest';
  state.inlineByDefault = state.inlineByDefault !== false;
  if (!state.profiles || typeof state.profiles !== 'object') state.profiles = {};
  for (const [id, fallback] of Object.entries(defaults.profiles)) {
    if (!state.profiles[id] || typeof state.profiles[id] !== 'object') state.profiles[id] = structuredCloneSafe(fallback);
    for (const [key, defaultValue] of Object.entries(fallback)) {
      if (state.profiles[id][key] === undefined) state.profiles[id][key] = defaultValue;
    }
  }
  if (!Array.isArray(state.characters)) state.characters = [];
  state.characters = state.characters.filter((item) => item && typeof item === 'object').map((item) => ({
    id: String(item.id || ''),
    name: String(item.name || '').slice(0, 80),
    subtitle: String(item.subtitle || '').slice(0, 120),
    appearance: String(item.appearance || '').slice(0, 12000),
    negative: String(item.negative || '').slice(0, 6000),
    referenceUrl: String(item.referenceUrl || '').slice(0, 2048),
    updatedAt: Number(item.updatedAt || 0),
  })).filter((item) => item.id);
  if (!state.characters.some((item) => item.id === state.selectedCharacterId)) state.selectedCharacterId = '';
  return state;
}

export function storyboardRatioDimensions(ratioId, currentWidth, currentHeight) {
  const ratio = STORYBOARD_RATIOS.find((item) => item.id === ratioId && item.value);
  if (!ratio) return { width: numericOrBlank(currentWidth), height: numericOrBlank(currentHeight) };
  const width = Number(currentWidth);
  const height = Number(currentHeight);
  const area = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? width * height
    : 1024 * 1024;
  const rawHeight = Math.sqrt(area / ratio.value);
  const rawWidth = rawHeight * ratio.value;
  return {
    width: clamp64(rawWidth),
    height: clamp64(rawHeight),
  };
}

export function buildImagineCommand({ prompt, negative = '', width = '', height = '', steps = '', cfg = '', seed = '' }) {
  const cleanPrompt = slashValue(prompt, 24000);
  if (!cleanPrompt) throw new Error('画面描述不能为空');
  const parts = ['/imagine', 'quiet=true', 'gallery=false'];
  if (String(negative || '').trim()) parts.push(`negative="${slashValue(negative, 12000)}"`);
  addNumber(parts, 'width', width, 64, 4096, true);
  addNumber(parts, 'height', height, 64, 4096, true);
  addNumber(parts, 'steps', steps, 1, 300, true);
  addNumber(parts, 'cfg', cfg, 0, 100, false);
  addNumber(parts, 'seed', seed, -1, Number.MAX_SAFE_INTEGER, true);
  parts.push(`"${cleanPrompt}"`);
  return parts.join(' ');
}

function addNumber(parts, key, raw, min, max, integer) {
  if (raw === '' || raw === null || raw === undefined) return;
  let value = Number(raw);
  if (!Number.isFinite(value)) return;
  value = Math.max(min, Math.min(max, value));
  if (integer) value = Math.round(value);
  parts.push(`${key}=${value}`);
}

function slashValue(value, max) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\|/g, '｜')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function numericOrBlank(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : '';
}

function clamp64(value) {
  return Math.max(64, Math.min(4096, Math.round(Number(value || 0) / 64) * 64));
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
