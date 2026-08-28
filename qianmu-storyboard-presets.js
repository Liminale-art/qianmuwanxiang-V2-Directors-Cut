// 千幕·分镜 - 预设系统
// 版本: 2.0.0
// 作者: Liminale
// 说明: 工厂预设、用户预设、预设应用逻辑

import { uid, clone } from './qianmu-storyboard-utils.js';

/**
 * 工厂预设（内置，只读）
 */
export const FACTORY_PRESETS = Object.freeze([
  {
    id: 'factory-portrait-closeup',
    name: '人物特写',
    icon: '🎨',
    builtin: true,
    description: '适合单人特写、表情刻画',

    provider: 'novel',
    model: 'nai-diffusion-5-full',

    params: {
      ratio: '2:3',
      width: 832,
      height: 1216,
      steps: 28,
      cfg: 5.5,
      sampler: 'k_euler',
      scheduler: 'native',
    },

    promptEnhancement: {
      quality: 'best quality, amazing quality, very aesthetic, absurdres',
      negative: 'lowres, worst quality, low quality, bad anatomy',
    },

    suggestedFor: ['portrait', 'closeup'],
  },

  {
    id: 'factory-group-shot',
    name: '群像构图',
    icon: '👥',
    builtin: true,
    description: '适合多人场景、互动构图',

    provider: 'novel',
    model: 'nai-diffusion-5-full',

    params: {
      ratio: '16:9',
      width: 1216,
      height: 832,
      steps: 28,
      cfg: 5.5,
      sampler: 'k_euler',
      scheduler: 'native',
    },

    promptEnhancement: {
      quality: 'best quality, amazing quality, very aesthetic, absurdres',
      negative: 'lowres, worst quality, low quality, bad anatomy, bad hands',
    },

    suggestedFor: ['group'],
  },

  {
    id: 'factory-environment-wide',
    name: '场景全景',
    icon: '🏞️',
    builtin: true,
    description: '适合风景、建筑、大场景',

    provider: 'banana',
    model: 'gemini-3.1-flash-image',

    params: {
      ratio: '16:9',
      width: 1344,
      height: 768,
    },

    promptEnhancement: {
      quality: 'highly detailed, cinematic lighting, wide angle',
      negative: 'blurry, low quality, distorted',
    },

    suggestedFor: ['environment'],
  },

  {
    id: 'factory-action-freeze',
    name: '动作瞬间',
    icon: '⚡',
    builtin: true,
    description: '适合动态画面、运动瞬间',

    provider: 'novel',
    model: 'nai-diffusion-5-full',

    params: {
      ratio: '3:2',
      width: 1216,
      height: 832,
      steps: 32,
      cfg: 6.0,
      sampler: 'k_euler',
      scheduler: 'native',
    },

    promptEnhancement: {
      quality: 'best quality, very aesthetic, motion blur, dynamic pose',
      negative: 'lowres, worst quality, static pose',
    },

    suggestedFor: ['action'],
  },

  {
    id: 'factory-object-detail',
    name: '物件特写',
    icon: '🔍',
    builtin: true,
    description: '适合物品、道具、细节展示',

    provider: 'banana',
    model: 'gemini-3.1-flash-image',

    params: {
      ratio: '1:1',
      width: 1024,
      height: 1024,
    },

    promptEnhancement: {
      quality: 'macro photography, highly detailed, sharp focus',
      negative: 'blurry, out of focus, low detail',
    },

    suggestedFor: ['object', 'closeup'],
  },
]);

/**
 * 获取工厂预设
 * @param {string} id - 预设 ID
 * @returns {Object|null} 预设对象
 */
export function getFactoryPreset(id) {
  return FACTORY_PRESETS.find((preset) => preset.id === id) || null;
}

/**
 * 按镜头类型推荐预设
 * @param {string} shotType - 镜头类型
 * @returns {Object[]} 推荐预设列表
 */
export function getSuggestedPresets(shotType) {
  return FACTORY_PRESETS.filter((preset) =>
    preset.suggestedFor && preset.suggestedFor.includes(shotType)
  );
}

/**
 * 创建用户预设
 * @param {Object} data - 预设数据
 * @returns {Object} 预设对象
 */
export function createUserPreset(data = {}) {
  const now = Date.now();
  return {
    id: data.id || uid('preset'),
    name: data.name || '未命名预设',
    icon: data.icon || '⭐',
    builtin: false,

    provider: data.provider || 'novel',
    model: data.model || '',

    params: data.params || {},

    promptEnhancement: {
      quality: data.promptEnhancement?.quality || '',
      negative: data.promptEnhancement?.negative || '',
    },

    suggestedFor: data.suggestedFor || [],

    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

/**
 * 应用预设到卡片
 * @param {Object} card - 镜头卡片
 * @param {Object} preset - 预设
 * @returns {Object} 更新后的卡片
 */
export function applyPresetToCard(card, preset) {
  if (!card || !preset) return card;

  const updated = clone(card);

  // 应用模型配置
  updated.provider = preset.provider;
  updated.model = preset.model;
  updated.preset = preset.id;

  // 应用参数
  updated.params = {
    ...updated.params,
    ...preset.params,
  };

  // 应用提示词增强（如果当前为空）
  if (preset.promptEnhancement) {
    if (!updated.prompt && preset.promptEnhancement.quality) {
      // 保留原始提示词，只追加质量词
      // updated.prompt = `${updated.prompt}, ${preset.promptEnhancement.quality}`.trim();
    }
    if (!updated.negative && preset.promptEnhancement.negative) {
      updated.negative = preset.promptEnhancement.negative;
    }
  }

  updated.updatedAt = Date.now();

  return updated;
}

/**
 * 验证预设
 * @param {Object} preset - 预设对象
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validatePreset(preset) {
  const errors = [];

  if (!preset.name || !preset.name.trim()) {
    errors.push('预设名称不能为空');
  }

  if (!preset.provider) {
    errors.push('必须指定渲染供应商');
  }

  if (!preset.model) {
    errors.push('必须指定模型');
  }

  if (!preset.params || typeof preset.params !== 'object') {
    errors.push('参数配置无效');
  } else {
    if (!preset.params.width || preset.params.width < 64 || preset.params.width > 8192) {
      errors.push('图片宽度必须在 64-8192 之间');
    }
    if (!preset.params.height || preset.params.height < 64 || preset.params.height > 8192) {
      errors.push('图片高度必须在 64-8192 之间');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 预设管理器
 */
export class PresetManager {
  constructor(storage) {
    this.storage = storage; // 外部注入存储接口
    this.userPresets = [];
    this.load();
  }

  /**
   * 加载用户预设
   */
  load() {
    if (this.storage && typeof this.storage.getUserPresets === 'function') {
      this.userPresets = this.storage.getUserPresets() || [];
    }
  }

  /**
   * 保存用户预设
   */
  save() {
    if (this.storage && typeof this.storage.saveUserPresets === 'function') {
      this.storage.saveUserPresets(this.userPresets);
    }
  }

  /**
   * 获取所有预设（工厂 + 用户）
   * @returns {Object[]} 预设列表
   */
  getAllPresets() {
    return [...FACTORY_PRESETS, ...this.userPresets];
  }

  /**
   * 获取预设
   * @param {string} id - 预设 ID
   * @returns {Object|null} 预设对象
   */
  getPreset(id) {
    const factory = getFactoryPreset(id);
    if (factory) return factory;

    return this.userPresets.find((preset) => preset.id === id) || null;
  }

  /**
   * 创建用户预设
   * @param {Object} data - 预设数据
   * @returns {Object} 创建的预设
   */
  create(data) {
    const preset = createUserPreset(data);
    const validation = validatePreset(preset);

    if (!validation.valid) {
      throw new Error(`预设验证失败: ${validation.errors.join(', ')}`);
    }

    this.userPresets.push(preset);
    this.save();
    return preset;
  }

  /**
   * 更新用户预设
   * @param {string} id - 预设 ID
   * @param {Object} updates - 更新数据
   * @returns {Object|null} 更新后的预设
   */
  update(id, updates) {
    const index = this.userPresets.findIndex((preset) => preset.id === id);
    if (index === -1) return null;

    const updated = {
      ...this.userPresets[index],
      ...updates,
      id, // 保持 ID 不变
      builtin: false, // 用户预设永远不是内置
      updatedAt: Date.now(),
    };

    const validation = validatePreset(updated);
    if (!validation.valid) {
      throw new Error(`预设验证失败: ${validation.errors.join(', ')}`);
    }

    this.userPresets[index] = updated;
    this.save();
    return updated;
  }

  /**
   * 删除用户预设
   * @param {string} id - 预设 ID
   * @returns {boolean} 是否删除成功
   */
  delete(id) {
    const index = this.userPresets.findIndex((preset) => preset.id === id);
    if (index === -1) return false;

    this.userPresets.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * 从当前配置保存为预设
   * @param {Object} card - 镜头卡片
   * @param {string} name - 预设名称
   * @returns {Object} 创建的预设
   */
  saveFromCard(card, name) {
    return this.create({
      name,
      provider: card.provider,
      model: card.model,
      params: clone(card.params),
      promptEnhancement: {
        quality: '',
        negative: card.negative || '',
      },
      suggestedFor: [card.shotType],
    });
  }

  /**
   * 导出用户预设（JSON）
   * @returns {string} JSON 字符串
   */
  export() {
    return JSON.stringify({
      version: '2.0.0',
      presets: this.userPresets,
      exportedAt: Date.now(),
    }, null, 2);
  }

  /**
   * 导入用户预设（JSON）
   * @param {string} json - JSON 字符串
   * @returns {Object} { success: boolean, imported: number, errors: string[] }
   */
  import(json) {
    try {
      const data = JSON.parse(json);
      if (!data.presets || !Array.isArray(data.presets)) {
        return { success: false, imported: 0, errors: ['无效的预设文件格式'] };
      }

      const errors = [];
      let imported = 0;

      for (const preset of data.presets) {
        try {
          // 生成新 ID 避免冲突
          const newPreset = createUserPreset({
            ...preset,
            id: uid('preset'),
          });

          const validation = validatePreset(newPreset);
          if (!validation.valid) {
            errors.push(`预设 "${preset.name}" 验证失败: ${validation.errors.join(', ')}`);
            continue;
          }

          this.userPresets.push(newPreset);
          imported++;
        } catch (error) {
          errors.push(`导入预设 "${preset.name}" 失败: ${error.message}`);
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

export const PRESETS_MODULE_VERSION = '2.0.0';
export const PRESETS_MODULE_NAME = 'qianmu-storyboard-presets';
