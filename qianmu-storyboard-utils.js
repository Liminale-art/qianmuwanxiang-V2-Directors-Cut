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

export const UTILS_MODULE_VERSION = '1.56.0';
export const UTILS_MODULE_NAME = 'qianmu-storyboard-utils';
