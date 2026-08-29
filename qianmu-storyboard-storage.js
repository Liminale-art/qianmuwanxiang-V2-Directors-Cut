// 千幕·分镜 - 存储接口
// 版本: 2.0.0
// 作者: Liminale
// 说明: 分镜数据持久化（预设/路由/画师串/配置）

import { clone } from './qianmu-storyboard-utils.js';

const STORAGE_VERSION = '2.0.0';
const STORAGE_KEYS = Object.freeze({
  USER_PRESETS: 'qianmu.storyboard.userPresets',
  ROUTING_RULES: 'qianmu.storyboard.routingRules',
  USER_ARTISTS: 'qianmu.storyboard.userArtists',
  STORYBOARD_CONFIG: 'qianmu.storyboard.config',
  SHOT_CARDS: 'qianmu.storyboard.shotCards',
});

/**
 * 存储管理器基类
 */
class StorageManager {
  constructor(key, defaultValue = null) {
    this.key = key;
    this.defaultValue = defaultValue;
  }

  /**
   * 读取数据
   * @returns {*} 存储的数据
   */
  load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return clone(this.defaultValue);

      const data = JSON.parse(raw);
      return data;
    } catch (error) {
      console.warn(`[Qianmu Storage] Failed to load ${this.key}:`, error);
      return clone(this.defaultValue);
    }
  }

  /**
   * 保存数据
   * @param {*} data - 要保存的数据
   * @returns {boolean} 是否保存成功
   */
  save(data) {
    try {
      const json = JSON.stringify(data);
      localStorage.setItem(this.key, json);
      return true;
    } catch (error) {
      console.error(`[Qianmu Storage] Failed to save ${this.key}:`, error);
      return false;
    }
  }

  /**
   * 清除数据
   * @returns {boolean} 是否清除成功
   */
  clear() {
    try {
      localStorage.removeItem(this.key);
      return true;
    } catch (error) {
      console.error(`[Qianmu Storage] Failed to clear ${this.key}:`, error);
      return false;
    }
  }
}

/**
 * 用户预设存储
 */
export class UserPresetsStorage extends StorageManager {
  constructor() {
    super(STORAGE_KEYS.USER_PRESETS, []);
  }

  /**
   * 获取所有用户预设
   * @returns {Object[]} 用户预设列表
   */
  getUserPresets() {
    return this.load();
  }

  /**
   * 保存用户预设
   * @param {Object[]} presets - 预设列表
   * @returns {boolean} 是否保存成功
   */
  saveUserPresets(presets) {
    return this.save(presets);
  }
}

/**
 * 路由规则存储
 */
export class RoutingRulesStorage extends StorageManager {
  constructor() {
    super(STORAGE_KEYS.ROUTING_RULES, []);
  }

  /**
   * 获取所有路由规则
   * @returns {Object[]} 路由规则列表
   */
  getRoutingRules() {
    return this.load();
  }

  /**
   * 保存路由规则
   * @param {Object[]} rules - 规则列表
   * @returns {boolean} 是否保存成功
   */
  saveRoutingRules(rules) {
    return this.save(rules);
  }
}

/**
 * 用户画师串存储
 */
export class UserArtistsStorage extends StorageManager {
  constructor() {
    super(STORAGE_KEYS.USER_ARTISTS, []);
  }

  /**
   * 获取所有用户画师串
   * @returns {Object[]} 用户画师串列表
   */
  getUserArtists() {
    return this.load();
  }

  /**
   * 保存用户画师串
   * @param {Object[]} artists - 画师串列表
   * @returns {boolean} 是否保存成功
   */
  saveUserArtists(artists) {
    return this.save(artists);
  }
}

/**
 * 分镜配置存储
 */
export class StoryboardConfigStorage extends StorageManager {
  constructor() {
    super(STORAGE_KEYS.STORYBOARD_CONFIG, {
      version: STORAGE_VERSION,
      imagesPerFloor: 4, // 一层楼几个画面（镜组未启用时）
      maxConcurrent: 1, // 并发数
      autoCapture: false, // 自动取景
      defaultProvider: 'novel',
      defaultModel: 'nai-diffusion-5-full',
    });
  }

  /**
   * 获取配置
   * @returns {Object} 配置对象
   */
  getConfig() {
    const config = this.load();
    // 确保版本号
    if (!config.version || config.version !== STORAGE_VERSION) {
      config.version = STORAGE_VERSION;
      this.save(config);
    }
    return config;
  }

  /**
   * 保存配置
   * @param {Object} config - 配置对象
   * @returns {boolean} 是否保存成功
   */
  saveConfig(config) {
    return this.save({
      ...config,
      version: STORAGE_VERSION,
    });
  }

  /**
   * 更新配置字段
   * @param {Object} updates - 要更新的字段
   * @returns {boolean} 是否更新成功
   */
  updateConfig(updates) {
    const config = this.getConfig();
    return this.saveConfig({
      ...config,
      ...updates,
    });
  }
}

/**
 * 镜头卡片存储（会话级）
 */
export class ShotCardsStorage extends StorageManager {
  constructor() {
    super(STORAGE_KEYS.SHOT_CARDS, {});
  }

  /**
   * 获取指定消息的镜头卡片
   * @param {string} messageId - 消息ID
   * @returns {Object[]} 镜头卡片列表
   */
  getShotCards(messageId) {
    const allCards = this.load();
    return allCards[messageId] || [];
  }

  /**
   * 保存指定消息的镜头卡片
   * @param {string} messageId - 消息ID
   * @param {Object[]} cards - 镜头卡片列表
   * @returns {boolean} 是否保存成功
   */
  saveShotCards(messageId, cards) {
    const allCards = this.load();
    allCards[messageId] = cards;
    return this.save(allCards);
  }

  /**
   * 删除指定消息的镜头卡片
   * @param {string} messageId - 消息ID
   * @returns {boolean} 是否删除成功
   */
  deleteShotCards(messageId) {
    const allCards = this.load();
    delete allCards[messageId];
    return this.save(allCards);
  }

  /**
   * 清除所有镜头卡片
   * @returns {boolean} 是否清除成功
   */
  clearAll() {
    return this.clear();
  }
}

/**
 * 统一存储接口
 */
export class StoryboardStorage {
  constructor() {
    this.userPresets = new UserPresetsStorage();
    this.routingRules = new RoutingRulesStorage();
    this.userArtists = new UserArtistsStorage();
    this.config = new StoryboardConfigStorage();
    this.shotCards = new ShotCardsStorage();
  }

  /**
   * 获取存储统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    try {
      const presets = this.userPresets.load();
      const rules = this.routingRules.load();
      const artists = this.userArtists.load();
      const allCards = this.shotCards.load();

      const totalCards = Object.values(allCards).reduce((sum, cards) => sum + cards.length, 0);

      return {
        userPresets: presets.length,
        routingRules: rules.length,
        userArtists: artists.length,
        shotCards: totalCards,
        messageCount: Object.keys(allCards).length,
      };
    } catch (error) {
      console.error('[Qianmu Storage] Failed to get stats:', error);
      return {
        userPresets: 0,
        routingRules: 0,
        userArtists: 0,
        shotCards: 0,
        messageCount: 0,
      };
    }
  }

  /**
   * 清除所有存储数据
   * @param {Object} options - 清除选项
   * @returns {Object} 清除结果
   */
  clearAll(options = {}) {
    const {
      clearPresets = false,
      clearRules = false,
      clearArtists = false,
      clearConfig = false,
      clearCards = true, // 默认清除卡片
    } = options;

    const result = {
      userPresets: false,
      routingRules: false,
      userArtists: false,
      config: false,
      shotCards: false,
    };

    try {
      if (clearPresets) result.userPresets = this.userPresets.clear();
      if (clearRules) result.routingRules = this.routingRules.clear();
      if (clearArtists) result.userArtists = this.userArtists.clear();
      if (clearConfig) result.config = this.config.clear();
      if (clearCards) result.shotCards = this.shotCards.clear();
    } catch (error) {
      console.error('[Qianmu Storage] Failed to clear all:', error);
    }

    return result;
  }

  /**
   * 导出所有数据
   * @returns {string} JSON字符串
   */
  exportAll() {
    try {
      const data = {
        version: STORAGE_VERSION,
        exportedAt: Date.now(),
        userPresets: this.userPresets.load(),
        routingRules: this.routingRules.load(),
        userArtists: this.userArtists.load(),
        config: this.config.load(),
      };

      return JSON.stringify(data, null, 2);
    } catch (error) {
      console.error('[Qianmu Storage] Failed to export:', error);
      return null;
    }
  }

  /**
   * 导入数据
   * @param {string} json - JSON字符串
   * @returns {Object} 导入结果
   */
  importAll(json) {
    const result = {
      success: false,
      imported: {
        userPresets: 0,
        routingRules: 0,
        userArtists: 0,
        config: false,
      },
      errors: [],
    };

    try {
      const data = JSON.parse(json);

      if (!data.version) {
        result.errors.push('数据格式无效：缺少版本号');
        return result;
      }

      // 导入用户预设
      if (data.userPresets && Array.isArray(data.userPresets)) {
        this.userPresets.save(data.userPresets);
        result.imported.userPresets = data.userPresets.length;
      }

      // 导入路由规则
      if (data.routingRules && Array.isArray(data.routingRules)) {
        this.routingRules.save(data.routingRules);
        result.imported.routingRules = data.routingRules.length;
      }

      // 导入画师串
      if (data.userArtists && Array.isArray(data.userArtists)) {
        this.userArtists.save(data.userArtists);
        result.imported.userArtists = data.userArtists.length;
      }

      // 导入配置
      if (data.config) {
        this.config.save(data.config);
        result.imported.config = true;
      }

      result.success = true;
    } catch (error) {
      result.errors.push(`导入失败: ${error.message}`);
    }

    return result;
  }
}

/**
 * 创建默认存储实例
 * @returns {StoryboardStorage} 存储实例
 */
export function createStoryboardStorage() {
  return new StoryboardStorage();
}

export const STORAGE_MODULE_VERSION = '2.0.0';
export const STORAGE_MODULE_NAME = 'qianmu-storyboard-storage';
