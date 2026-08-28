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

export const UTILS_MODULE_VERSION = '1.56.0';
export const UTILS_MODULE_NAME = 'qianmu-storyboard-utils';
