// 千幕·分镜 - 画师串库管理
// 版本: 2.0.0
// 作者: Liminale
// 说明: 画师串可视化管理、预览图支持、快速跳转

import { uid, clone } from './qianmu-storyboard-utils.js';

/**
 * 画师串数据结构
 */
export function createArtistEntry(data = {}) {
  const now = Date.now();
  return {
    id: data.id || uid('artist'),
    name: data.name || '未命名画师串',
    preview: data.preview || '', // 预览图URL
    tags: data.tags || '', // 实际的画师串标签
    category: data.category || '其他',
    description: data.description || '',

    // 元数据
    suggestedFor: data.suggestedFor || [], // ['portrait', 'environment', ...]
    provider: data.provider || 'novel', // 适用供应商
    builtin: data.builtin || false, // 是否内置

    // 导入信息
    imported: data.imported || false,
    importedFrom: data.importedFrom || '',

    // 时间戳
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

/**
 * 内置画师串库（待管理员填充）
 */
export const BUILTIN_ARTISTS = Object.freeze([
  // 内置画师串将由管理员后续添加
]);


/**
 * 画师串库管理器
 */
export class ArtistLibraryManager {
  constructor(storage) {
    this.storage = storage;
    this.userArtists = [];
    this.load();
  }

  /**
   * 加载用户画师串
   */
  load() {
    if (this.storage && typeof this.storage.getUserArtists === 'function') {
      this.userArtists = this.storage.getUserArtists() || [];
    }
  }

  /**
   * 保存用户画师串
   */
  save() {
    if (this.storage && typeof this.storage.saveUserArtists === 'function') {
      this.storage.saveUserArtists(this.userArtists);
    }
  }

  /**
   * 获取所有画师串（内置 + 用户）
   * @param {Object} filters - 过滤条件
   * @returns {Object[]} 画师串列表
   */
  getAll(filters = {}) {
    let artists = [...BUILTIN_ARTISTS, ...this.userArtists];

    // 按类别过滤
    if (filters.category) {
      artists = artists.filter((artist) => artist.category === filters.category);
    }

    // 按供应商过滤
    if (filters.provider) {
      artists = artists.filter((artist) => artist.provider === filters.provider);
    }

    // 按镜头类型过滤
    if (filters.shotType) {
      artists = artists.filter((artist) =>
        artist.suggestedFor && artist.suggestedFor.includes(filters.shotType)
      );
    }

    // 搜索关键词
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      artists = artists.filter((artist) =>
        artist.name.toLowerCase().includes(searchLower) ||
        artist.tags.toLowerCase().includes(searchLower) ||
        artist.category.toLowerCase().includes(searchLower)
      );
    }

    return artists;
  }

  /**
   * 获取单个画师串
   * @param {string} id - 画师串ID
   * @returns {Object|null} 画师串对象
   */
  get(id) {
    const builtin = BUILTIN_ARTISTS.find((artist) => artist.id === id);
    if (builtin) return builtin;

    return this.userArtists.find((artist) => artist.id === id) || null;
  }

  /**
   * 创建用户画师串
   * @param {Object} data - 画师串数据
   * @returns {Object} 创建的画师串
   */
  create(data) {
    const artist = createArtistEntry({
      ...data,
      builtin: false,
    });

    this.userArtists.push(artist);
    this.save();
    return artist;
  }

  /**
   * 更新用户画师串
   * @param {string} id - 画师串ID
   * @param {Object} updates - 更新数据
   * @returns {Object|null} 更新后的画师串
   */
  update(id, updates) {
    const index = this.userArtists.findIndex((artist) => artist.id === id);
    if (index === -1) return null;

    const updated = {
      ...this.userArtists[index],
      ...updates,
      id, // 保持ID不变
      builtin: false,
      updatedAt: Date.now(),
    };

    this.userArtists[index] = updated;
    this.save();
    return updated;
  }

  /**
   * 删除用户画师串
   * @param {string} id - 画师串ID
   * @returns {boolean} 是否删除成功
   */
  delete(id) {
    const index = this.userArtists.findIndex((artist) => artist.id === id);
    if (index === -1) return false;

    this.userArtists.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * 获取所有类别
   * @returns {string[]} 类别列表
   */
  getCategories() {
    const categories = new Set();
    const allArtists = [...BUILTIN_ARTISTS, ...this.userArtists];

    for (const artist of allArtists) {
      if (artist.category) {
        categories.add(artist.category);
      }
    }

    return Array.from(categories).sort();
  }

  /**
   * 从外部源导入画师串
   * @param {string} url - 数据源URL
   * @returns {Promise<Object>} 导入结果
   */
  async importFromURL(url) {
    try {
      const response = await fetch(url);
      const data = await response.json();

      if (!data.artists || !Array.isArray(data.artists)) {
        return { success: false, imported: 0, errors: ['数据格式无效'] };
      }

      const errors = [];
      let imported = 0;

      for (const artistData of data.artists) {
        try {
          const artist = createArtistEntry({
            ...artistData,
            id: uid('artist'), // 生成新ID避免冲突
            imported: true,
            importedFrom: url,
          });

          this.userArtists.push(artist);
          imported++;
        } catch (error) {
          errors.push(`导入 "${artistData.name}" 失败: ${error.message}`);
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
        errors: [`导入失败: ${error.message}`],
      };
    }
  }

  /**
   * 导出用户画师串
   * @returns {string} JSON字符串
   */
  export() {
    return JSON.stringify({
      version: '2.0.0',
      artists: this.userArtists,
      exportedAt: Date.now(),
    }, null, 2);
  }

  /**
   * 从JSON导入
   * @param {string} json - JSON字符串
   * @returns {Object} 导入结果
   */
  importFromJSON(json) {
    try {
      const data = JSON.parse(json);
      if (!data.artists || !Array.isArray(data.artists)) {
        return { success: false, imported: 0, errors: ['数据格式无效'] };
      }

      const errors = [];
      let imported = 0;

      for (const artistData of data.artists) {
        try {
          const artist = createArtistEntry({
            ...artistData,
            id: uid('artist'),
          });

          this.userArtists.push(artist);
          imported++;
        } catch (error) {
          errors.push(`导入 "${artistData.name}" 失败: ${error.message}`);
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
        errors: [`解析JSON失败: ${error.message}`],
      };
    }
  }
}

export const ARTIST_LIBRARY_MODULE_VERSION = '2.0.0';
export const ARTIST_LIBRARY_MODULE_NAME = 'qianmu-storyboard-artist-library';
