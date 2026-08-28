// 千幕·分镜 - 镜组智能路由
// 版本: 2.0.0
// 作者: Liminale
// 说明: 场景模板、规则匹配引擎、可视化配置

import { uid, clone } from './qianmu-storyboard-utils.js';

/**
 * 场景模板（预定义路由规则组合）
 */
export const ROUTING_TEMPLATES = Object.freeze([
  {
    id: 'template-portrait-focus',
    name: '人物优先',
    description: '人物/特写用 NovelAI 高质量，场景/物件用 Banana 快速生成',
    icon: '📸',
    rules: [
      {
        name: '人物镜头',
        enabled: true,
        priority: 10,
        match: {
          shotTypes: ['portrait', 'closeup'],
          contentRating: 'all',
        },
        target: {
          provider: 'novel',
          model: 'nai-diffusion-5-full',
          preset: 'factory-portrait-closeup',
        },
      },
      {
        name: '场景镜头',
        enabled: true,
        priority: 5,
        match: {
          shotTypes: ['environment', 'object'],
          contentRating: 'all',
        },
        target: {
          provider: 'banana',
          model: 'gemini-3.1-flash-image',
          preset: 'factory-environment-wide',
        },
      },
    ],
  },

  {
    id: 'template-environment-focus',
    name: '场景优先',
    description: '场景/物件用 Banana 高质量，人物用 NovelAI 补充',
    icon: '🌆',
    rules: [
      {
        name: '场景镜头',
        enabled: true,
        priority: 10,
        match: {
          shotTypes: ['environment', 'object'],
          contentRating: 'all',
        },
        target: {
          provider: 'banana',
          model: 'gemini-3.1-flash-image',
          preset: 'factory-environment-wide',
        },
      },
      {
        name: '人物镜头',
        enabled: true,
        priority: 5,
        match: {
          shotTypes: ['portrait', 'closeup'],
          contentRating: 'all',
        },
        target: {
          provider: 'novel',
          model: 'nai-diffusion-5-full',
          preset: 'factory-portrait-closeup',
        },
      },
    ],
  },

  {
    id: 'template-high-quality',
    name: '全能高质',
    description: '所有镜头都用 NovelAI V5，追求最高画质',
    icon: '⚡',
    rules: [
      {
        name: '所有镜头',
        enabled: true,
        priority: 10,
        match: {
          shotTypes: [],
          contentRating: 'all',
        },
        target: {
          provider: 'novel',
          model: 'nai-diffusion-5-full',
        },
      },
    ],
  },

  {
    id: 'template-fast-generate',
    name: '快速生成',
    description: '所有镜头都用 Banana，速度优先',
    icon: '🚀',
    rules: [
      {
        name: '所有镜头',
        enabled: true,
        priority: 10,
        match: {
          shotTypes: [],
          contentRating: 'all',
        },
        target: {
          provider: 'banana',
          model: 'gemini-3.1-flash-image',
        },
      },
    ],
  },
]);

/**
 * 创建路由规则
 * @param {Object} data - 规则数据
 * @returns {Object} 规则对象
 */
export function createRoutingRule(data = {}) {
  const now = Date.now();
  return {
    id: data.id || uid('route'),
    name: data.name || '未命名规则',
    enabled: data.enabled !== false,
    priority: data.priority || 0,

    match: {
      shotTypes: data.match?.shotTypes || [],
      contentRating: data.match?.contentRating || 'all',
      floorRange: data.match?.floorRange || null,
    },

    target: {
      provider: data.target?.provider || '',
      model: data.target?.model || '',
      preset: data.target?.preset || null,
      paramsOverride: data.target?.paramsOverride || {},
    },

    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

/**
 * 验证路由规则
 * @param {Object} rule - 规则对象
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateRoutingRule(rule) {
  const errors = [];

  if (!rule.name || !rule.name.trim()) {
    errors.push('规则名称不能为空');
  }

  if (!rule.target || !rule.target.provider) {
    errors.push('必须指定目标供应商');
  }

  if (!rule.target || !rule.target.model) {
    errors.push('必须指定目标模型');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 匹配路由规则
 * @param {Object} shot - 镜头信息
 * @param {Object} rule - 路由规则
 * @returns {boolean} 是否匹配
 */
export function matchRoutingRule(shot, rule) {
  if (!rule.enabled) return false;

  // 匹配镜头类型
  if (rule.match.shotTypes && rule.match.shotTypes.length > 0) {
    if (!rule.match.shotTypes.includes(shot.shotType)) {
      return false;
    }
  }

  // 匹配内容评级
  if (rule.match.contentRating && rule.match.contentRating !== 'all') {
    const shotRating = shot.contentRating || 'sfw';
    if (rule.match.contentRating === 'sfw' && shotRating === 'nsfw') {
      return false;
    }
    if (rule.match.contentRating === 'nsfw' && shotRating === 'sfw') {
      return false;
    }
  }

  // 匹配楼层范围
  if (rule.match.floorRange) {
    const floor = shot.floor || 0;
    if (rule.match.floorRange.min != null && floor < rule.match.floorRange.min) {
      return false;
    }
    if (rule.match.floorRange.max != null && floor > rule.match.floorRange.max) {
      return false;
    }
  }

  return true;
}

/**
 * 路由管理器
 */
export class RoutingManager {
  constructor(storage) {
    this.storage = storage;
    this.rules = [];
    this.load();
  }

  /**
   * 加载规则
   */
  load() {
    if (this.storage && typeof this.storage.getRoutingRules === 'function') {
      this.rules = this.storage.getRoutingRules() || [];
    }
  }

  /**
   * 保存规则
   */
  save() {
    if (this.storage && typeof this.storage.saveRoutingRules === 'function') {
      this.storage.saveRoutingRules(this.rules);
    }
  }

  /**
   * 获取所有规则
   * @returns {Object[]} 规则列表（按优先级排序）
   */
  getAllRules() {
    return [...this.rules].sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取已启用的规则
   * @returns {Object[]} 规则列表
   */
  getEnabledRules() {
    return this.getAllRules().filter((rule) => rule.enabled);
  }

  /**
   * 创建规则
   * @param {Object} data - 规则数据
   * @returns {Object} 创建的规则
   */
  create(data) {
    const rule = createRoutingRule(data);
    const validation = validateRoutingRule(rule);

    if (!validation.valid) {
      throw new Error(`规则验证失败: ${validation.errors.join(', ')}`);
    }

    this.rules.push(rule);
    this.save();
    return rule;
  }

  /**
   * 更新规则
   * @param {string} id - 规则 ID
   * @param {Object} updates - 更新数据
   * @returns {Object|null} 更新后的规则
   */
  update(id, updates) {
    const index = this.rules.findIndex((rule) => rule.id === id);
    if (index === -1) return null;

    const updated = {
      ...this.rules[index],
      ...updates,
      id,
      updatedAt: Date.now(),
    };

    const validation = validateRoutingRule(updated);
    if (!validation.valid) {
      throw new Error(`规则验证失败: ${validation.errors.join(', ')}`);
    }

    this.rules[index] = updated;
    this.save();
    return updated;
  }

  /**
   * 删除规则
   * @param {string} id - 规则 ID
   * @returns {boolean} 是否删除成功
   */
  delete(id) {
    const index = this.rules.findIndex((rule) => rule.id === id);
    if (index === -1) return false;

    this.rules.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * 应用模板
   * @param {string} templateId - 模板 ID
   * @returns {Object[]} 创建的规则列表
   */
  applyTemplate(templateId) {
    const template = ROUTING_TEMPLATES.find((t) => t.id === templateId);
    if (!template) {
      throw new Error(`未找到模板: ${templateId}`);
    }

    // 清空现有规则（可选，根据需求调整）
    // this.rules = [];

    const createdRules = [];
    for (const ruleData of template.rules) {
      const rule = this.create(ruleData);
      createdRules.push(rule);
    }

    return createdRules;
  }

  /**
   * 为镜头路由目标
   * @param {Object} shot - 镜头信息
   * @returns {Object|null} 路由目标
   */
  route(shot) {
    const enabledRules = this.getEnabledRules();

    for (const rule of enabledRules) {
      if (matchRoutingRule(shot, rule)) {
        return {
          provider: rule.target.provider,
          model: rule.target.model,
          preset: rule.target.preset,
          paramsOverride: rule.target.paramsOverride || {},
          matchedRule: rule.id,
        };
      }
    }

    // 无匹配规则，返回 null（使用默认配置）
    return null;
  }

  /**
   * 批量路由
   * @param {Object[]} shots - 镜头列表
   * @returns {Object[]} 路由结果列表
   */
  routeMany(shots) {
    return shots.map((shot) => ({
      shot,
      route: this.route(shot),
    }));
  }

  /**
   * 获取路由统计
   * @param {Object[]} shots - 镜头列表
   * @returns {Object} 统计信息
   */
  getRoutingStats(shots) {
    const routed = this.routeMany(shots);
    const stats = {
      total: shots.length,
      routed: 0,
      unrouted: 0,
      byProvider: {},
      byRule: {},
    };

    for (const { route } of routed) {
      if (route) {
        stats.routed++;
        stats.byProvider[route.provider] = (stats.byProvider[route.provider] || 0) + 1;
        stats.byRule[route.matchedRule] = (stats.byRule[route.matchedRule] || 0) + 1;
      } else {
        stats.unrouted++;
      }
    }

    return stats;
  }

  /**
   * 导出规则（JSON）
   * @returns {string} JSON 字符串
   */
  export() {
    return JSON.stringify({
      version: '2.0.0',
      rules: this.rules,
      exportedAt: Date.now(),
    }, null, 2);
  }

  /**
   * 导入规则（JSON）
   * @param {string} json - JSON 字符串
   * @param {boolean} replace - 是否替换现有规则
   * @returns {Object} { success: boolean, imported: number, errors: string[] }
   */
  import(json, replace = false) {
    try {
      const data = JSON.parse(json);
      if (!data.rules || !Array.isArray(data.rules)) {
        return { success: false, imported: 0, errors: ['无效的规则文件格式'] };
      }

      if (replace) {
        this.rules = [];
      }

      const errors = [];
      let imported = 0;

      for (const ruleData of data.rules) {
        try {
          const rule = createRoutingRule({
            ...ruleData,
            id: uid('route'),
          });

          const validation = validateRoutingRule(rule);
          if (!validation.valid) {
            errors.push(`规则 "${ruleData.name}" 验证失败: ${validation.errors.join(', ')}`);
            continue;
          }

          this.rules.push(rule);
          imported++;
        } catch (error) {
          errors.push(`导入规则 "${ruleData.name}" 失败: ${error.message}`);
        }
      }

      if (imported > 0) {
        this.save();
      }

      return {
        success: imported > 0,
        imported,
        errors,
      };
    } catch (error) {
      return {
        success: false,
        imported: 0,
        errors: [`解析 JSON 失败: ${error.message}`],
      };
    }
  }
}

export const ROUTING_MODULE_VERSION = '2.0.0';
export const ROUTING_MODULE_NAME = 'qianmu-storyboard-routing';
