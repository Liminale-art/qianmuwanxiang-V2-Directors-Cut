// 千幕·分镜 - 工具函数模块
// 版本: 1.56.0
// 作者: Liminale
// 说明: 独立的工具函数，无外部依赖

/**
 * 深度克隆对象
 * @param {*} value - 要克隆的值
 * @returns {*} 克隆后的值
 */
export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * 检查是否为纯对象
 * @param {*} value - 要检查的值
 * @returns {boolean} 是否为纯对象
 */
export function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 计算文本的简单哈希值
 * @param {string} text - 要计算哈希的文本
 * @returns {string} 十六进制哈希字符串
 */
export function hashText(text) {
  let hash = 0;
  const str = String(text || '');
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * HTML 转义
 * @param {string} input - 要转义的文本
 * @returns {string} 转义后的文本
 */
export function htmlEscape(input) {
  const text = String(input ?? '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 移除思维链标记
 * @param {string} text - 原始文本
 * @returns {string} 清理后的文本
 */
export function stripThinkChain(text) {
  if (!text) return '';
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

// UID 生成器的内部计数器
let uidCounter = 0;

/**
 * 生成唯一 ID
 * @param {string} prefix - ID 前缀
 * @returns {string} 唯一 ID
 */
export function uid(prefix = 'id') {
  uidCounter = (uidCounter + 1) % 1000000;
  const rand = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${uidCounter.toString(36)}-${rand}`;
}

/**
 * 生成文件名时间戳（本地时区 YYYY-MM-DD_HH-MM-SS）
 * @returns {string} 格式化的时间戳
 */
export function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * 转义正则表达式特殊字符
 * @param {string} text - 要转义的文本
 * @returns {string} 转义后的文本
 */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析任意值为字符串数组
 * @param {*} value - 要解析的值
 * @returns {string[]} 字符串数组
 */
export function parseAnyString(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(parseAnyString);
  if (typeof value === 'object') return Object.values(value).flatMap(parseAnyString);
  return [];
}

/**
 * 去重并清理字符串数组
 * @param {string[]} list - 字符串数组
 * @returns {string[]} 去重后的数组
 */
export function uniqueClean(list) {
  return [...new Set((list || []).map((x) => String(x || '').trim()).filter(Boolean))];
}

/**
 * 规范化来源名称
 * @param {string} name - 来源名称
 * @returns {string} 规范化后的名称
 */
export function normalizeSourceName(name) {
  return String(name || '').trim();
}

/**
 * 清理文件夹名称（限制长度）
 * @param {string} name - 文件夹名称
 * @returns {string} 清理后的名称
 */
export function sanitizeFolder(name) {
  return String(name || '').trim().slice(0, 16);
}

/**
 * 截断过长的日志文本
 * @param {string} text - 日志文本
 * @param {number} limit - 长度限制
 * @returns {string} 截断后的文本
 */
export function clipLog(text, limit = 1000) {
  const value = String(text || '');
  return value.length > limit ? `${value.slice(0, limit)}\n…[内容过长已截断]` : value;
}

/**
 * 估算文本的 token 数量
 * @param {string} text - 要估算的文本
 * @returns {number} 估算的 token 数
 */
export function estimateTokens(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  const cjk = (value.match(/[一-鿿]/g) || []).length;
  const latin = value.replace(/[一-鿿]/g, '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(cjk / 1.7 + latin * 1.25));
}

/**
 * 截断文本并添加省略号
 * @param {string} text - 要截断的文本
 * @param {number} n - 最大长度
 * @returns {string} 截断后的文本
 */
export function snip(text, n = 64) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > n ? `${value.slice(0, n)}...` : value;
}

/**
 * 转义 STscript 斜杠命令的值
 * @param {string} s - 要转义的字符串
 * @returns {string} 转义后的字符串
 */
export function escapeSlashValue(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim();
}

/**
 * 为 STscript 斜杠命令的值添加引号
 * @param {string} s - 要处理的字符串
 * @returns {string} 加引号后的字符串
 */
export function quoteSlashValue(s) {
  return `"${escapeSlashValue(s).replace(/"/g, '\\"')}"`;
}

/**
 * 在 JSON 文本中插入缺失的逗号
 * @param {string} text - JSON 文本
 * @returns {string} 修复后的文本
 */
export function insertMissingCommas(text) {
  let result = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    result += ch;
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') {
        inString = false;
        if (/^\s*[{\["]/.test(text.slice(i + 1))) result += ',';
      }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if ((ch === '}' || ch === ']') && /^\s*[{\["]/.test(text.slice(i + 1))) result += ',';
  }
  return result;
}

/**
 * 修复被截断的 JSON 文本
 * @param {string} text - 被截断的 JSON 文本
 * @returns {*} 解析后的对象，失败返回 null
 */
export function repairTruncatedJson(text) {
  const tryCut = (includeStrings) => {
    let inString = false;
    let escape = false;
    let cutIndex = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') { inString = false; if (includeStrings) cutIndex = i + 1; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '}' || ch === ']') cutIndex = i + 1;
    }
    if (cutIndex <= 0) return null;
    let candidate = text.slice(0, cutIndex).replace(/,\s*$/, '');
    inString = false;
    escape = false;
    const stack = [];
    for (const ch of candidate) {
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    candidate += stack.reverse().join('');
    candidate = candidate.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(candidate); } catch (_) { return null; }
  };
  return tryCut(false) ?? tryCut(true);
}

/**
 * 规范化 URL（移除末尾斜杠和 /v1 后缀）
 * @param {string} url - 要规范化的 URL
 * @returns {string} 规范化后的 URL
 */
export function normalizeUrl(url) {
  let value = String(url || '').trim().replace(/\/+$/, '');
  if (value.endsWith('/v1')) value = value.slice(0, -3);
  return value;
}

/**
 * 处理文本中的随机宏 {{random:option1,option2,...}}
 * @param {string} text - 包含随机宏的文本
 * @returns {string} 处理后的文本
 */
export function processRandomMacros(text) {
  return String(text || '').replace(/\{\{random:(.*?)\}\}/gi, (_, raw) => {
    const options = raw.split(',').map((x) => x.trim()).filter(Boolean);
    return options.length ? options[Math.floor(Math.random() * options.length)] : '';
  });
}

/**
 * 清理快速坞站标签
 * @param {string} value - 标签值
 * @returns {string} 清理后的标签
 */
export function quickDockCleanLabel(value) {
  const label = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!label) return '';
  if (/^(?:第三方)?(?:插件|工具|入口|悬浮窗|悬浮球)(?:按钮)?$/i.test(label)) return '';
  if (/^(?:打开|关闭|菜单|设置|工具|入口)$/i.test(label)) return '';
  return label;
}

// 暗线显影阶段梯度
export const STAGE_LADDER = ['铺陈', '升温', '临界', '高潮', '落幕'];

// 世界事件阶段梯度
export const EVENT_STAGE_LADDER = ['酝酿', '爆发', '蔓延', '消退', '落定'];

/**
 * 清理暗线显影阶段值
 * @param {string} stage - 阶段值
 * @returns {string} 有效的阶段值
 */
export function sanitizeStage(stage) {
  return STAGE_LADDER.includes(stage) ? stage : '铺陈';
}

/**
 * 暗线显影阶段升级
 * @param {string} stage - 当前阶段
 * @returns {string} 下一阶段
 */
export function advanceStage(stage) {
  const idx = STAGE_LADDER.indexOf(sanitizeStage(stage));
  return STAGE_LADDER[Math.min(idx + 1, STAGE_LADDER.length - 1)];
}

/**
 * 清理世界事件阶段值
 * @param {string} stage - 阶段值
 * @returns {string} 有效的阶段值
 */
export function sanitizeEventStage(stage) {
  return EVENT_STAGE_LADDER.includes(stage) ? stage : '酝酿';
}

/**
 * 世界事件阶段升级
 * @param {string} stage - 当前阶段
 * @returns {string} 下一阶段
 */
export function advanceEventStage(stage) {
  const idx = EVENT_STAGE_LADDER.indexOf(sanitizeEventStage(stage));
  return EVENT_STAGE_LADDER[Math.min(idx + 1, EVENT_STAGE_LADDER.length - 1)];
}

/**
 * 规范化证据文本（用于比对）
 * @param {string} value - 原始文本
 * @returns {string} 规范化后的文本
 */
export function directorEvidenceNorm(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 生成文本的 bigram 集合
 * @param {string} value - 输入文本
 * @returns {Set<string>} bigram 集合
 */
export function directorBigrams(value) {
  const text = directorEvidenceNorm(value);
  const out = new Set();
  if (text.length < 2) { if (text) out.add(text); return out; }
  for (let index = 0; index < text.length - 1; index++) out.add(text.slice(index, index + 2));
  return out;
}

/**
 * 计算两段文本的重叠率
 * @param {string} needle - 查找文本
 * @param {string} haystack - 目标文本
 * @returns {number} 重叠率 (0-1)
 */
export function directorOverlapRatio(needle, haystack) {
  const left = directorBigrams(needle);
  const right = directorBigrams(haystack);
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const token of left) if (right.has(token)) hit += 1;
  return hit / left.size;
}

/**
 * 转义 HTML 属性值
 * @param {string} value - 属性值
 * @returns {string} 转义后的值
 */
export function quickDockAttrEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
}

/**
 * 规范化路径数组
 * @param {Array} value - 路径数组
 * @returns {Array<string>} 规范化后的路径
 */
export function quickDockNormalizePath(value) {
  if (!Array.isArray(value)) return [];
  return value.map((part) => String(part || '').trim().slice(0, 500)).filter(Boolean).slice(0, 12);
}

/**
 * 转义 CSS 选择器
 * @param {string} value - 选择器值
 * @returns {string} 转义后的选择器
 */
export function quickDockSelectorEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value || ''));
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.codePointAt(0).toString(16)} `);
}

/**
 * 生成路径键
 * @param {Array} value - 路径数组
 * @returns {string} 路径键
 */
export function quickDockPathKey(value) {
  const path = quickDockNormalizePath(value);
  return path.length ? path.join('\n>>>shadow>>>\n') : '';
}

/**
 * 生成定位器键
 * @param {Object} item - 项目对象
 * @returns {string} 定位器键
 */
export function quickDockLocatorKey(item) {
  return quickDockPathKey(item?.shadowPath) || String(item?.selector || '').trim();
}

// 蜂巢布局相关常量
export const QUICK_HEX_WIDTH_RATIO = Math.sqrt(3) / 2;
export const QUICK_HIVE_AXIAL_DIRECTIONS = Object.freeze([
  [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1],
]);

/**
 * 生成蜂巢环的轴向六角坐标
 * @param {number} radius - 环半径
 * @returns {Array<{q: number, r: number}>} 坐标数组
 */
export function quickHiveAxialRing(radius) {
  if (!Number.isInteger(radius) || radius < 1) return [];
  const cells = [];
  let q = 0;
  let r = -radius;
  for (const [dq, dr] of QUICK_HIVE_AXIAL_DIRECTIONS) {
    for (let step = 0; step < radius; step++) {
      cells.push({ q, r });
      q += dq;
      r += dr;
    }
  }
  return cells;
}

/**
 * 生成指定数量的蜂巢格子
 * @param {number} count - 格子数量
 * @param {number} maxRing - 最大环数
 * @returns {Array<{q: number, r: number}>} 格子数组
 */
export function quickHiveCells(count, maxRing = 6) {
  const cells = [];
  for (let ring = 1; ring <= maxRing && cells.length < count; ring++) cells.push(...quickHiveAxialRing(ring));
  return cells.slice(0, count);
}

/**
 * 计算格子所在的环数
 * @param {{q: number, r: number}} cell - 格子坐标
 * @returns {number} 环数
 */
export function quickHiveCellRing(cell) {
  return Math.max(Math.abs(cell.q), Math.abs(cell.r), Math.abs(cell.q + cell.r));
}

/**
 * 计算格子的像素偏移
 * @param {{q: number, r: number}} cell - 格子坐标
 * @param {number} itemSize - 项目尺寸
 * @param {number} gap - 间隙
 * @returns {{x: number, y: number}} 像素偏移
 */
export function quickHivePixelOffset(cell, itemSize, gap) {
  const renderedRadius = itemSize / QUICK_HEX_WIDTH_RATIO / 2;
  const latticeRadius = renderedRadius + gap / Math.sqrt(3);
  return {
    x: Math.sqrt(3) * latticeRadius * (cell.q + cell.r / 2),
    y: 1.5 * latticeRadius * cell.r,
  };
}

/**
 * 检查格子是否在几何范围内
 * @param {{q: number, r: number}} cell - 格子坐标
 * @param {Object} geometry - 几何参数
 * @returns {boolean} 是否适合
 */
export function quickHiveCellFits(cell, geometry) {
  const offset = quickHivePixelOffset(cell, geometry.itemSize, geometry.gap);
  const halfW = geometry.itemSize / 2;
  const halfH = geometry.itemHeight / 2;
  const x = geometry.centerX + offset.x;
  const y = geometry.centerY + offset.y;
  return x - halfW >= geometry.margin
    && x + halfW <= geometry.viewportWidth - geometry.margin
    && y - halfH >= geometry.margin
    && y + halfH <= geometry.viewportHeight - geometry.margin;
}

/**
 * 生成 HTML 信息标签
 * @param {string} text - 标签文本
 * @returns {string} HTML 标签
 */
export function infoTag(text) {
  return `<span class="sd-info-tag">${htmlEscape(text)}</span>`;
}

/**
 * 提取推理模型的思考内容
 * @param {*} value - 推理内容
 * @returns {string} 思考文本
 */
export function modelReasoningText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(modelReasoningText).filter(Boolean).join('\n').trim();
  if (!value || typeof value !== 'object') return '';
  return modelReasoningText(value.text ?? value.content ?? value.summary ?? value.reasoning ?? '');
}

/**
 * 从消息对象中提取推理内容
 * @param {Object} message - 消息对象
 * @returns {string} 推理文本
 */
export function modelMessageReasoning(message) {
  if (!message || typeof message !== 'object') return '';
  return modelReasoningText(message.reasoning_content ?? message.reasoning ?? message.reasoning_details
    ?? message.thinking_content ?? message.thinking ?? message.analysis ?? message.thoughts ?? '');
}

/**
 * 提取导演项目的文本内容
 * @param {string} field - 字段类型
 * @param {Object} item - 项目对象
 * @returns {string} 文本内容
 */
export function directorItemText(field, item) {
  if (!item || typeof item !== 'object') return String(item || '');
  const keys = {
    quests: ['title', 'objective', 'description', 'trigger', 'reward'],
    npc_updates: ['name', 'role', 'current_goal', 'emotional_state', 'next_action', 'hidden_agenda', 'relations'],
    world_updates: ['type', 'title', 'content', 'scope', 'timing'],
    chain_reactions: ['spark', 'chain'],
    relation_undercurrents: ['parties', 'tone', 'tension', 'drift', 'user_awareness'],
  }[field] || Object.keys(item);
  return keys.map((key) => {
    const value = item[key];
    return Array.isArray(value) ? value.join(' ') : String(value || '');
  }).join(' ');
}

/**
 * 计算两段文本的相似度
 * @param {string} left - 第一段文本
 * @param {string} right - 第二段文本
 * @returns {number} 相似度 (0-1)
 */
export function directorSimilarity(left, right) {
  const a = directorBigrams(left);
  const b = directorBigrams(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.min(a.size, b.size);
}

/**
 * 检查是否为噪声预设名称
 * @param {string} name - 预设名称
 * @returns {boolean} 是否为噪声名称
 */
export function isNoisePresetName(name) {
  const value = normalizeSourceName(name);
  return !value || ['in_use', 'settings', 'prompts', 'prompt_order', 'preset_settings', '当前预设'].includes(value);
}

/**
 * 规范化预设条目
 * @param {Array} entries - 条目数组
 * @returns {Array} 规范化后的条目
 */
export function normalizePresetEntries(entries) {
  return (Array.isArray(entries) ? entries : Object.values(entries || {}))
    .filter((item) => item && typeof item === 'object')
    .filter((item) => String(item.identifier || item.name || '').trim() !== 'in_use')
    .filter((item) => item.content || item.prompt || item.message || item.text || item.name || item.identifier);
}

/**
 * 解析名称源
 * @param {*} source - 名称源
 * @returns {Array<string>} 名称数组
 */
export function parseNameSource(source) {
  if (!source) return [];
  if (typeof source === 'string') return [source];
  if (Array.isArray(source)) return source.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (item && typeof item === 'object') return [item.name, item.id, item.filename].filter(Boolean);
    return [];
  });
  if (typeof source === 'object') return Object.keys(source);
  return [];
}

/**
 * 从世界书条目提取伴读逻辑标识
 * @param {Object} entry - 世界书条目
 * @returns {string} 逻辑标识
 */
export function coreadEntryLogicalId(entry) {
  const u = String(entry?.uid ?? '');
  if (u.startsWith('coread::')) return u;
  const c = `${entry?.comment ?? ''}\n${entry?.name ?? ''}\n${entry?.title ?? ''}\n${entry?.memo ?? ''}`;
  const mm = c.match(/⟨(coread::[^⟩]+)⟩/);
  return mm ? mm[1] : '';
}

/**
 * 验证豆包语音模型值
 * @param {string} value - 模型值
 * @param {string} fallback - 回退值
 * @returns {string} 有效的模型值
 */
export function ttsDoubaoVoiceModel(value, fallback = 'auto') {
  const model = String(value || '').trim();
  if (model === 'auto') return 'auto';
  // 注意：此函数依赖 getTtsProvider，在工具模块中简化为仅校验 'auto'
  // 完整校验需要在主模块中进行
  return model || fallback;
}

/**
 * 获取豆包语音模型标签
 * @param {string} value - 模型值
 * @returns {string} 模型标签
 */
export function ttsDoubaoVoiceModelLabel(value) {
  if (value === 'auto' || !value) return '自动识别';
  // 注意：完整实现需要 getTtsProvider，这里返回默认值
  return '自动识别';
}

/**
 * 合并默认值到目标对象
 * @param {Object} target - 目标对象
 * @param {Object} defaults - 默认值对象
 */
export function mergeDefaults(target, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = clone(value);
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeDefaults(target[key], value);
    }
  }
}

/**
 * 检查是否为旧版蓝图
 * @param {string} text - 蓝图文本
 * @returns {boolean} 是否为旧版
 */
export function isLegacyBlueprint(text) {
  const value = String(text || '').trim();
  if (value.includes('【主要指令】')) return false;
  return value.includes('现代都市 / 校园 / 西幻 / 末日 / 无限流 / 其他')
    || value.includes('例如：慢热恋爱、悬疑调查、群像成长、轻喜剧、黑暗奇幻')
    || value.includes('【给导演的额外叮嘱】')
    || (value.includes('【故事基底】') && value.includes('时代、地域、社会秩序、生活方式'))
    || (value.includes('【故事基底】') && !value.includes('【任务与节点偏好】'))
    || (value.includes('【世界观】') && value.includes('【剧情基调】') && value.includes('【长期目标】'));
}

/**
 * 按文件夹分组条目
 * @param {Array} items - 条目数组
 * @param {Function} getFolder - 获取文件夹函数
 * @param {Function} getName - 获取名称函数
 * @param {boolean} sortAlpha - 是否按字母排序
 * @returns {Object} 分组结果
 */
export function groupByFolder(items, getFolder, getName, sortAlpha) {
  const folders = new Map();
  const loose = [];
  for (const it of items) {
    const f = sanitizeFolder(getFolder(it));
    if (f) {
      if (!folders.has(f)) folders.set(f, []);
      folders.get(f).push(it);
    } else {
      loose.push(it);
    }
  }
  if (sortAlpha && typeof getName === 'function') {
    const byName = (a, b) => String(getName(a) || '').localeCompare(String(getName(b) || ''), 'zh');
    for (const list of folders.values()) list.sort(byName);
    loose.sort(byName);
  }
  const folderList = [...folders.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
    .map(([name, list]) => ({ name, list }));
  return { folderList, loose };
}

/**
 * 按预算裁剪行数组（从最近开始累加）
 * @param {Array<string>} lines - 行数组
 * @param {number} budget - 预算字符数
 * @returns {Array<string>} 裁剪后的行数组
 */
export function capByBudget(lines, budget) {
  if (!(budget > 0)) return lines;
  const kept = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > budget && kept.length) break;
    kept.unshift(lines[i]);
  }
  return kept;
}

/**
 * 将 Blob 转换为 Base64
 * @param {Blob} blob - Blob 对象
 * @returns {Promise<string>} Base64 字符串
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/**
 * 将 Base64 转换为 Blob
 * @param {string} b64 - Base64 字符串
 * @param {string} mime - MIME 类型
 * @returns {Blob} Blob 对象
 */
export function base64ToBlob(b64, mime = 'image/*') {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/**
 * 检查脚本是否为内置脚本
 * @param {Object} s - 脚本对象
 * @returns {boolean} 是否为内置脚本
 */
export function isBuiltinScript(s) {
  return !!s && (s.builtin === true || (typeof s.id === 'string' && (s.id.startsWith('sd-bt-') || s.id.startsWith('sd-qm-'))));
}

/**
 * 检查文本是否看起来像 HTML
 * @param {string} text - 文本
 * @returns {boolean} 是否像 HTML
 */
export function looksLikeHtml(text) {
  return /<\s*(html|body|div|section|article|table|canvas|svg|style|script|button|input|h[1-6]|p|ul|ol|img|iframe)\b/i.test(String(text || ''));
}

/**
 * 提取场景开头文本
 * @param {Object} scene - 场景对象
 * @param {number} n - 最大长度
 * @returns {string} 开头文本
 */
export function theaterOpening(scene, n = 28) {
  if (!scene) return '番外';
  let text = String(scene.content || '');
  // 简化版本，不调用 extractTheaterBody
  if (scene.isHtml || /<[^>]+>/.test(text)) {
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text ? snip(text, n) : '番外';
}

/**
 * 生成场景副标题
 * @param {Object} scene - 场景对象
 * @returns {string} 副标题
 */
export function theaterSubtitle(scene) {
  const src = String(scene?.source || '').trim();
  return src ? `@${src}` : '@即兴';
}

/**
 * 从文本中提取 JSON
 * @param {string} text - 文本
 * @returns {Object} 解析后的 JSON 对象
 * @throws {Error} JSON 解析失败
 */
export function extractJson(text) {
  let content = String(text || '').trim();
  content = content.replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) content = content.slice(start, end + 1);
  const base = content.replace(/,\s*([}\]])/g, '$1');
  let lastError = null;
  try { return JSON.parse(base); } catch (e) { lastError = e; }
  const commaFixed = insertMissingCommas(base).replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(commaFixed); } catch (e) { lastError = e; }
  const repaired = repairTruncatedJson(commaFixed);
  if (repaired !== null) {
    console.warn('[qianmu-storyboard-utils] JSON 已自动修复（若为截断，末尾少量条目可能缺失）');
    return repaired;
  }
  throw new Error(`JSON_PARSE_FAILED::${lastError?.message || 'unknown'}`);
}

/**
 * 清理十六进制颜色值
 * @param {string} c - 颜色值
 * @returns {string} 有效的十六进制颜色值或空字符串
 */
export function sanitizeHexColor(c) {
  const s = String(c || '').trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : '';
}

/**
 * 格式化阅读时长
 * @param {number} ms - 毫秒数
 * @returns {string} 格式化的时长字符串
 */
export function formatReadDuration(ms) {
  const m = Math.floor((ms || 0) / 60000);
  if (m < 1) return '不足 1 分钟';
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

/**
 * 格式化日期时间
 * @param {*} date - 日期对象或字符串
 * @returns {string} 格式化的日期时间字符串
 */
export function formatDateTime(date) {
  if (!date) return '';
  try { return new Date(date).toLocaleString(); } catch (_) { return String(date); }
}

/**
 * 页宽转内边距百分比
 * @param {number} widthRem - 页宽（rem）
 * @returns {string} 内边距百分比
 */
export function widthToPad(widthRem) {
  const w = Math.max(28, Math.min(66, widthRem || 42));
  return ((66 - w) / 38 * 14).toFixed(1);
}

/**
 * 计算世界热度
 * @param {Array} rels - 关系数组
 * @param {Array} events - 事件数组
 * @returns {number} 热度值 (0-100)
 */
export function computeWorldHeat(rels, events) {
  const relWeight = { 冲突: 26, 张力: 13, 依附: 5, 中立: 0, 同盟: -8 };
  let heat = 0;
  for (const r of rels) heat += relWeight[r.kind] || 0;
  for (const e of events) {
    if (e.status === 'closed') continue;
    heat += e.stage === '爆发' ? 18 : e.stage === '蔓延' ? 14 : e.stage === '酝酿' ? 7 : 2;
  }
  return Math.max(0, Math.min(100, Math.round(heat)));
}

/**
 * 根据热度获取层级信息
 * @param {number} heat - 热度值
 * @returns {Object} 层级对象
 */
export function heatTier(heat) {
  if (heat >= 72) return { key: 'boil', label: '鼎沸', desc: '多方火并，世界沸反盈天' };
  if (heat >= 45) return { key: 'turmoil', label: '动荡', desc: '冲突四起，暗潮已掀明浪' };
  if (heat >= 20) return { key: 'undercurrent', label: '暗流', desc: '表面平静，底下各有盘算' };
  return { key: 'calm', label: '承平', desc: '大势安稳，余波细微' };
}

/**
 * 稳定哈希函数
 * @param {string} value - 输入值
 * @returns {number} 哈希值
 */
export function geoStableHash(value) {
  let hash = 2166136261;
  for (const ch of String(value || '')) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/**
 * 获取地缘关系的 CSS 类名
 * @param {string} kind - 关系类型
 * @returns {string} CSS 类名
 */
export function geoRelationClass(kind) {
  return { 冲突: 'conflict', 同盟: 'ally', 张力: 'tension', 中立: 'neutral', 依附: 'vassal' }[kind] || 'neutral';
}

/**
 * 计算可见窗口
 * @param {Array} chapters - 章节数组
 * @param {number} chapterIndex - 当前章节索引
 * @param {number} scrollRatio - 滚动比例
 * @param {number} percent - 百分比
 * @param {number} charCap - 字符上限
 * @returns {Object} 可见窗口信息
 */
export function computeVisibleWindow(chapters, chapterIndex, scrollRatio, percent, charCap) {
  const list = Array.isArray(chapters) ? chapters : [];
  const bodies = list.map((ch) => String(ch?.content || ''));
  const offsets = [];
  let acc = 0;
  for (const b of bodies) { offsets.push(acc); acc += b.length; }
  const totalLen = acc || 1;
  const full = bodies.join('');
  const ci = Math.max(0, Math.min(Number(chapterIndex) || 0, Math.max(0, bodies.length - 1)));
  const curLen = bodies[ci] ? bodies[ci].length : 0;
  const ratio = Math.max(0, Math.min(1, Number(scrollRatio) || 0));
  const readPos = Math.max(0, Math.min(full.length, (offsets[ci] || 0) + Math.round(curLen * ratio)));
  const pct = Math.max(1, Math.min(100, Number(percent) || 15));
  const cap = Math.max(200, Number(charCap) || 6000);
  const windowChars = Math.min(Math.ceil((pct / 100) * totalLen), cap);
  let start = Math.max(0, readPos - windowChars);
  if (start > 0) {
    const m = full.slice(start, Math.min(readPos, start + 200)).search(/[。！？…\n」』】）\)]/);
    if (m >= 0) start = Math.min(readPos, start + m + 1);
  }
  return { visibleText: full.slice(start, readPos), readPos, totalLen: full.length, windowChars, start };
}

/**
 * 剥离对话引号
 * @param {string} s - 输入字符串
 * @returns {string} 去除引号后的字符串
 */
export function stripDialogQuotes(s) {
  let t = String(s || '').trim();
  const pairs = [['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"], ['"', '"'], ["'", "'"], ['《', '》']];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [l, r] of pairs) {
      if (t.length >= 2 && t.startsWith(l) && t.endsWith(r)) {
        t = t.slice(l.length, t.length - r.length).trim();
        changed = true;
      }
    }
  }
  t = t.replace(/[「」『』""''""'']/g, '').trim();
  t = t.replace(/[—─]{1,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return t;
}

/**
 * readerCoverPlaceholder - 生成网格封面占位符（无图时显示书名+作者）
 * @param {string} title - 书名
 * @param {string} author - 作者
 * @returns {string} - HTML 字符串
 */
export function readerCoverPlaceholder(title, author) {
  return `<div class="sd-reader-cover-ph">
    <span class="sd-reader-cover-title">${htmlEscape(title || '未命名')}</span>
    ${author ? `<span class="sd-reader-cover-author">${htmlEscape(author)}</span>` : ''}
  </div>`;
}

/**
 * extractTheaterBody - 从剧场文本中提取正文，免疫标签残缺问题
 * @param {string} text - 原始文本
 * @returns {string} - 提取的正文
 */
export function extractTheaterBody(text) {
  const raw = String(text || '');
  let body = '';
  let m = raw.match(/<\s*幕外正文\s*>([\s\S]*?)<\s*\/\s*幕外正文\s*>/i);
  if (m && m[1].trim()) body = m[1];
  if (!body) { m = raw.match(/<\s*幕外正文\s*>([\s\S]*)$/i); if (m && m[1].trim()) body = m[1]; }
  if (!body) { m = raw.match(/^([\s\S]*?)<\s*\/\s*幕外正文\s*>/i); if (m && m[1].trim()) body = m[1]; }
  if (!body) body = raw;
  body = body.replace(/<\s*\/?\s*幕外正文\s*>/gi, '');
  return stripThinkChain(body).trim();
}

/**
 * parseModelList - 从多种API响应结构中提取模型列表
 * @param {any} data - API响应数据
 * @returns {Array<string>} - 模型ID列表（排序去重）
 */
export function parseModelList(data) {
  const candidates = [];
  if (Array.isArray(data?.data)) candidates.push(...data.data.map((x) => x?.id || x?.name || x));
  if (Array.isArray(data?.models)) candidates.push(...data.models.map((x) => x?.id || x?.name || x));
  if (Array.isArray(data)) candidates.push(...data.map((x) => x?.id || x?.name || x));
  if (data?.data && typeof data.data === 'object' && !Array.isArray(data.data)) candidates.push(...Object.keys(data.data));
  if (data?.models && typeof data.models === 'object' && !Array.isArray(data.models)) candidates.push(...Object.keys(data.models));
  return uniqueClean(candidates).sort((a, b) => a.localeCompare(b));
}

/**
 * countGroupTag - 生成审片页跳转标签HTML
 * @param {string} label - 标签名
 * @param {string} jump - 跳转目标
 * @param {Array<[string, number]>} parts - 分项名称和数量
 * @returns {string} - HTML字符串
 */
export function countGroupTag(label, jump, parts) {
  const inner = parts.map(([name, count]) => `<span class="sd-ct-part">${htmlEscape(name)}<b>${count}</b></span>`).join('');
  return `<button class="sd-count-tag sd-count-group" data-jump="${jump}"><span class="sd-ct-label">${htmlEscape(label)}</span>${inner}</button>`;
}

/**
 * normalizeScripts - 规整剧札顺序（用户自建项在前、内置项在后）
 * @param {Array} scripts - 脚本列表
 * @returns {Array} - 排序后的脚本列表
 */
export function normalizeScripts(scripts) {
  const list = Array.isArray(scripts) ? scripts : [];
  const user = list.filter((s) => !isBuiltinScript(s));
  const builtins = list.filter((s) => isBuiltinScript(s));
  return [...user, ...builtins];
}

/**
 * validateThreadEvidence - 验证暗线证据引用的有效性
 * @param {Object} raw - 原始证据数据
 * @param {Function} directorRecentEvidenceRows - 获取最近对话行的函数
 * @returns {Object} - { valid, floor, quote, reason }
 */
export function validateThreadEvidence(raw, directorRecentEvidenceRows) {
  const quote = String(raw?.evidence_quote || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const quoteNorm = directorEvidenceNorm(quote);
  if (quoteNorm.length < 4) return { valid: false, floor: -1, quote, reason: '未提供可核验原句' };
  const rows = directorRecentEvidenceRows();
  let floor = Number.parseInt(String(raw?.evidence_floor ?? ''), 10);
  let row = rows.find((item) => item.floor === floor);
  if (!row || !directorEvidenceNorm(row.text).includes(quoteNorm)) {
    row = rows.find((item) => directorEvidenceNorm(item.text).includes(quoteNorm));
    floor = row?.floor ?? -1;
  }
  return row
    ? { valid: true, floor, quote, reason: `楼层${floor}原句命中` }
    : { valid: false, floor: -1, quote, reason: '原句不在近期对话中' };
}

export const UTILS_MODULE_VERSION = '1.56.0';
export const UTILS_MODULE_NAME = 'qianmu-storyboard-utils';
