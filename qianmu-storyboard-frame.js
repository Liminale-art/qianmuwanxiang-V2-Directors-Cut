// 千幕·分镜 - 镜头卡片核心逻辑
// 版本: 2.0.0
// 作者: Liminale
// 说明: 镜头卡片状态机、队列管理、位置锚定、快速取景

import {
  uid,
  hashText,
  clone,
} from './qianmu-storyboard-utils.js';

/**
 * 镜头类型定义
 */
export const SHOT_TYPES = Object.freeze({
  portrait: { id: 'portrait', label: '人物特写', icon: '🎨' },
  group: { id: 'group', label: '群像构图', icon: '👥' },
  environment: { id: 'environment', label: '场景全景', icon: '🏞️' },
  object: { id: 'object', label: '物件特写', icon: '🔍' },
  action: { id: 'action', label: '动作瞬间', icon: '⚡' },
  closeup: { id: 'closeup', label: '特写镜头', icon: '📸' },
  custom: { id: 'custom', label: '自定义', icon: '🎬' },
});

/**
 * 镜头卡片状态枚举
 */
export const SHOT_CARD_STATUS = Object.freeze({
  DRAFT: 'draft',           // 草稿（可编辑）
  QUEUED: 'queued',         // 队列中
  GENERATING: 'generating', // 生成中
  COMPLETED: 'completed',   // 完成
  FAILED: 'failed',         // 失败
});

/**
 * 创建镜头卡片
 * @param {Object} options - 配置项
 * @returns {Object} 镜头卡片对象
 */
export function createShotCard(options = {}) {
  const now = Date.now();
  return {
    // 唯一标识
    id: options.id || uid('shot'),

    // 位置锚定
    chatKey: options.chatKey || '',
    floor: Number(options.floor) || 0,
    swipeId: Number(options.swipeId) || 0,
    position: options.position || 'end',
    anchorHash: options.anchorHash || null,

    // 状态
    status: options.status || SHOT_CARD_STATUS.DRAFT,
    progress: 0,
    queuePosition: null,

    // 内容
    prompt: options.prompt || '',
    negative: options.negative || '',
    shotType: options.shotType || 'custom',

    // 路由结果
    provider: options.provider || '',
    model: options.model || '',
    preset: options.preset || null,

    // 生成参数
    params: options.params || {},

    // 结果
    images: [],
    selectedImageIndex: 0,
    error: null,

    // 元数据
    createdAt: options.createdAt || now,
    updatedAt: now,
    generatedAt: null,
    generationTimeMs: null,
  };
}

/**
 * 镜头卡片状态机
 */
export class ShotCardStateMachine {
  constructor(card) {
    this.card = card;
  }

  /**
   * 转换到新状态
   * @param {string} newStatus - 新状态
   * @param {Object} data - 状态数据
   */
  transition(newStatus, data = {}) {
    const validTransitions = {
      [SHOT_CARD_STATUS.DRAFT]: [SHOT_CARD_STATUS.QUEUED, SHOT_CARD_STATUS.GENERATING],
      [SHOT_CARD_STATUS.QUEUED]: [SHOT_CARD_STATUS.GENERATING, SHOT_CARD_STATUS.DRAFT],
      [SHOT_CARD_STATUS.GENERATING]: [SHOT_CARD_STATUS.COMPLETED, SHOT_CARD_STATUS.FAILED, SHOT_CARD_STATUS.DRAFT],
      [SHOT_CARD_STATUS.COMPLETED]: [SHOT_CARD_STATUS.DRAFT, SHOT_CARD_STATUS.GENERATING],
      [SHOT_CARD_STATUS.FAILED]: [SHOT_CARD_STATUS.DRAFT, SHOT_CARD_STATUS.GENERATING],
    };

    const allowed = validTransitions[this.card.status] || [];
    if (!allowed.includes(newStatus)) {
      console.warn(`[ShotCard] Invalid transition: ${this.card.status} -> ${newStatus}`);
      return false;
    }

    this.card.status = newStatus;
    this.card.updatedAt = Date.now();

    // 状态特定处理
    switch (newStatus) {
      case SHOT_CARD_STATUS.QUEUED:
        this.card.queuePosition = data.queuePosition || null;
        break;
      case SHOT_CARD_STATUS.GENERATING:
        this.card.progress = 0;
        this.card.queuePosition = null;
        break;
      case SHOT_CARD_STATUS.COMPLETED:
        this.card.progress = 100;
        this.card.images = data.images || [];
        this.card.generatedAt = Date.now();
        this.card.generationTimeMs = data.generationTimeMs || null;
        break;
      case SHOT_CARD_STATUS.FAILED:
        this.card.progress = 0;
        this.card.error = data.error || '生成失败';
        break;
      case SHOT_CARD_STATUS.DRAFT:
        this.card.progress = 0;
        this.card.queuePosition = null;
        this.card.error = null;
        break;
    }

    return true;
  }

  /**
   * 更新进度
   * @param {number} progress - 进度（0-100）
   */
  updateProgress(progress) {
    if (this.card.status !== SHOT_CARD_STATUS.GENERATING) {
      console.warn(`[ShotCard] Cannot update progress in status: ${this.card.status}`);
      return false;
    }
    this.card.progress = Math.max(0, Math.min(100, progress));
    this.card.updatedAt = Date.now();
    return true;
  }

  /**
   * 是否可以编辑
   */
  canEdit() {
    return this.card.status === SHOT_CARD_STATUS.DRAFT;
  }

  /**
   * 是否可以生成
   */
  canGenerate() {
    return [SHOT_CARD_STATUS.DRAFT, SHOT_CARD_STATUS.COMPLETED, SHOT_CARD_STATUS.FAILED].includes(this.card.status);
  }

  /**
   * 是否可以取消
   */
  canCancel() {
    return [SHOT_CARD_STATUS.QUEUED, SHOT_CARD_STATUS.GENERATING].includes(this.card.status);
  }
}

/**
 * 镜头卡片队列管理器
 */
export class ShotCardQueue {
  constructor(options = {}) {
    this.queue = [];
    this.maxConcurrent = options.maxConcurrent || 1;
    this.activeCount = 0;
    this.onCardStart = options.onCardStart || null;
    this.onCardComplete = options.onCardComplete || null;
    this.onCardFail = options.onCardFail || null;
  }

  /**
   * 添加卡片到队列
   * @param {Object} card - 镜头卡片
   */
  enqueue(card) {
    if (!card || this.queue.find((item) => item.id === card.id)) {
      return false;
    }

    const stateMachine = new ShotCardStateMachine(card);
    if (!stateMachine.transition(SHOT_CARD_STATUS.QUEUED, { queuePosition: this.queue.length + 1 })) {
      return false;
    }

    this.queue.push(card);
    this.updateQueuePositions();
    this.processQueue();
    return true;
  }

  /**
   * 从队列移除卡片
   * @param {string} cardId - 卡片 ID
   */
  remove(cardId) {
    const index = this.queue.findIndex((item) => item.id === cardId);
    if (index === -1) return false;

    const card = this.queue[index];
    if (card.status === SHOT_CARD_STATUS.GENERATING) {
      // TODO: 调用取消生成的逻辑
      console.log(`[ShotCardQueue] Cancelling generation for card: ${cardId}`);
    }

    this.queue.splice(index, 1);
    this.updateQueuePositions();
    return true;
  }

  /**
   * 更新队列位置
   */
  updateQueuePositions() {
    this.queue.forEach((card, index) => {
      if (card.status === SHOT_CARD_STATUS.QUEUED) {
        card.queuePosition = index + 1;
      }
    });
  }

  /**
   * 处理队列
   */
  async processQueue() {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const card = this.queue.find((item) => item.status === SHOT_CARD_STATUS.QUEUED);
      if (!card) break;

      this.activeCount++;
      const stateMachine = new ShotCardStateMachine(card);
      stateMachine.transition(SHOT_CARD_STATUS.GENERATING);

      if (this.onCardStart) {
        this.onCardStart(card);
      }

      try {
        // TODO: 实际生成逻辑由外部注入
        console.log(`[ShotCardQueue] Generating card: ${card.id}`);
        // 这里需要调用实际的生成函数
        // await generateImage(card);
      } catch (error) {
        console.error(`[ShotCardQueue] Generation failed:`, error);
        stateMachine.transition(SHOT_CARD_STATUS.FAILED, { error: error.message });
        if (this.onCardFail) {
          this.onCardFail(card, error);
        }
      } finally {
        this.activeCount--;
        this.remove(card.id);
        this.processQueue();
      }
    }
  }

  /**
   * 清空队列
   */
  clear() {
    this.queue = [];
    this.activeCount = 0;
  }

  /**
   * 获取队列状态
   */
  getStatus() {
    return {
      total: this.queue.length,
      queued: this.queue.filter((card) => card.status === SHOT_CARD_STATUS.QUEUED).length,
      generating: this.activeCount,
    };
  }
}

/**
 * 快速取景 - 分析场景
 * @param {Object} context - 上下文（楼层、角色、世界书等）
 * @param {Object} options - 配置项
 * @returns {Promise<Object>} 分析结果
 */
export async function analyzeSceneForShots(context, options = {}) {
  // TODO: 调用 LLM 分析场景
  // 这里是占位实现，实际需要集成现有的 API 调用逻辑

  const floorText = context.floorText || '';
  if (!floorText.trim()) {
    return { needImage: false, shots: [] };
  }

  // 构建提示词（简化版本，实际需要更完整的上下文）
  const analysisPrompt = `分析以下场景，判断是否需要配图，最多提供 ${options.maxShots || 3} 个镜头方案。

场景：${floorText}

返回 JSON 格式：
{
  "need_image": true/false,
  "shots": [
    {
      "type": "portrait",  // portrait/group/environment/object/action/closeup/custom
      "focus": "描述镜头焦点",
      "prompt": "英文提示词",
      "position": "end"  // start/middle/end
    }
  ]
}`;

  console.log('[analyzeSceneForShots] Analysis prompt:', analysisPrompt);

  // TODO: 实际 API 调用
  // const response = await callLLM(analysisPrompt, options);
  // return JSON.parse(response);

  // 占位返回
  return {
    needImage: true,
    shots: [
      {
        type: 'portrait',
        focus: '场景主体人物',
        prompt: 'placeholder prompt',
        position: 'end',
      },
    ],
  };
}

/**
 * 位置锚定 - 计算正文片段哈希
 * @param {string} text - 正文片段
 * @returns {string} 哈希值
 */
export function calculateAnchorHash(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  return hashText(normalized);
}

/**
 * 位置锚定 - 查找插入位置
 * @param {string} currentText - 当前正文
 * @param {string} anchorHash - 锚点哈希
 * @param {string} fallbackPosition - 回退位置（start/middle/end）
 * @returns {Object} { position, confidence }
 */
export function findInsertPosition(currentText, anchorHash, fallbackPosition = 'end') {
  if (!anchorHash) {
    return { position: fallbackPosition, confidence: 'low' };
  }

  // TODO: 实现基于 LCS 的精确定位
  // 当前简化实现：按段落分割，计算每段哈希，寻找匹配
  const paragraphs = currentText.split(/\n+/).filter((p) => p.trim());

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraphHash = calculateAnchorHash(paragraphs[i]);
    if (paragraphHash === anchorHash) {
      return { position: i, confidence: 'high' };
    }
  }

  // 未找到精确匹配，使用回退位置
  return { position: fallbackPosition, confidence: 'low' };
}

/**
 * 导出队列实例（全局单例）
 */
export const globalShotQueue = new ShotCardQueue({
  maxConcurrent: 1,
  onCardStart: (card) => console.log('[ShotCardQueue] Started:', card.id),
  onCardComplete: (card) => console.log('[ShotCardQueue] Completed:', card.id),
  onCardFail: (card, error) => console.error('[ShotCardQueue] Failed:', card.id, error),
});

export const FRAME_MODULE_VERSION = '2.0.0';
export const FRAME_MODULE_NAME = 'qianmu-storyboard-frame';
