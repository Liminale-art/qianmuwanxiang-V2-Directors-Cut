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

export const UTILS_MODULE_VERSION = '1.56.0';
export const UTILS_MODULE_NAME = 'qianmu-storyboard-utils';
