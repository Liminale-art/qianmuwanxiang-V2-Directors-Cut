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

export const UTILS_MODULE_VERSION = '1.56.0';
export const UTILS_MODULE_NAME = 'qianmu-storyboard-utils';
