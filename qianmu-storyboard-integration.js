// 千幕·分镜 - 集成层
// 版本: 2.0.0
// 作者: Liminale
// 说明: 连接UI层、业务逻辑层、现有生图系统

import {
  SHOT_CARD_STATUS,
  ShotCardStateMachine,
  ShotCardQueue,
  createShotCard,
  analyzeSceneForShots,
} from './qianmu-storyboard-frame.js';
import {
  renderShotCard,
  mountShotCardToFloor,
  bindShotCardEvents,
  injectFloorCaptureButton,
  createFloorObserver,
} from './qianmu-storyboard-frame-ui.js';
import {
  createStoryboardStorage,
} from './qianmu-storyboard-storage.js';
import {
  adaptShotForProvider,
} from './qianmu-storyboard-adapter.js';
import { PromptCompiler } from './qianmu-storyboard-compiler.js';

// 全局状态
let storyboardIntegration = null;

/**
 * 分镜集成管理器
 */
class StoryboardIntegration {
  constructor(context) {
    this.context = context; // SillyTavern context
    this.storage = createStoryboardStorage();
    this.config = this.storage.config.getConfig();
    this.queue = new ShotCardQueue({ maxConcurrent: this.config.maxConcurrent });
    this.observer = null;
    this.cards = new Map(); // messageId -> cards[]
  }

  /**
   * 初始化分镜系统
   */
  init() {
    // 启动楼层观察器
    this.observer = createFloorObserver((floorElement) => {
      this.handleCaptureClick(floorElement);
    });

    const chatContainer = document.querySelector('#chat');
    if (chatContainer) {
      this.observer.observe(chatContainer, { childList: true, subtree: true });
      console.log('[Qianmu Storyboard] Floor observer started');
    }

    // 为现有楼层注入取景按钮
    this.injectExistingFloors();
  }

  /**
   * 为现有楼层注入取景按钮
   */
  injectExistingFloors() {
    const floors = document.querySelectorAll('#chat .mes');
    floors.forEach((floor) => {
      injectFloorCaptureButton(floor, (floorElement) => {
        this.handleCaptureClick(floorElement);
      });
    });
  }

  /**
   * 提取楼层文本内容
   * @param {HTMLElement} floorElement - 楼层元素
   * @returns {string} 文本内容
   */
  extractFloorText(floorElement) {
    const messageText = floorElement.querySelector('.mes_text');
    if (!messageText) return '';

    // 移除引用块、代码块等，只保留主要叙述文本
    const clone = messageText.cloneNode(true);
    clone.querySelectorAll('.mes_quote, pre, code').forEach(el => el.remove());

    return clone.textContent.trim();
  }

  /**
   * 获取楼层的消息ID
   * @param {HTMLElement} floorElement - 楼层元素
   * @returns {string} 消息ID
   */
  getMessageId(floorElement) {
    // 尝试从 data-message-id 获取
    const messageId = floorElement.dataset.messageId;
    if (messageId) return messageId;

    // 备用方案：使用楼层索引
    const floors = Array.from(document.querySelectorAll('#chat .mes'));
    const index = floors.indexOf(floorElement);
    return `floor-${index}`;
  }

  /**
   * 处理取景按钮点击
   * @param {HTMLElement} floorElement - 楼层元素
   */
  async handleCaptureClick(floorElement) {
    const messageText = this.extractFloorText(floorElement);
    if (!messageText) {
      console.warn('[Qianmu Storyboard] No message text found');
      return;
    }

    const messageId = this.getMessageId(floorElement);

    // 显示加载提示
    this.showLoadingIndicator(floorElement);

    try {
      // 调用LLM分析场景
      const result = await analyzeSceneForShots({
        context: messageText,
        chatHistory: this.getChatHistory(),
        characterName: this.context.name2 || '',
        userName: this.context.name1 || '',
      }, {
        imagesPerFloor: this.config.imagesPerFloor,
      });

      this.hideLoadingIndicator(floorElement);

      if (!result.success) {
        this.showError(floorElement, result.errors.join('; '));
        return;
      }

      // 生成镜头卡片
      const cards = result.shots.map(shot => {
        const card = createShotCard({
          shotType: shot.shotType,
          description: shot.description,
          prompt: shot.prompt,
          negative: shot.negative || '',
          artistString: shot.artistString || '',
          provider: shot.provider || this.config.defaultProvider,
          model: shot.model || this.config.defaultModel,
          params: shot.params || {},
        });

        return card;
      });

      // 保存卡片
      this.cards.set(messageId, cards);
      this.storage.shotCards.saveShotCards(messageId, cards);

      // 挂载卡片到楼层
      cards.forEach(card => {
        mountShotCardToFloor(floorElement, card, {
          onGenerate: (c) => this.handleGenerate(messageId, c),
          onEdit: (c) => this.handleEdit(messageId, c),
          onCancel: (c) => this.handleCancel(messageId, c),
        });
      });

    } catch (error) {
      console.error('[Qianmu Storyboard] Capture failed:', error);
      this.hideLoadingIndicator(floorElement);
      this.showError(floorElement, error.message);
    }
  }

  /**
   * 获取聊天历史（用于上下文分析）
   * @returns {Array} 聊天历史
   */
  getChatHistory() {
    const chat = this.context.chat;
    if (!Array.isArray(chat)) return [];

    // 取最近5条消息作为上下文
    return chat.slice(-5).map(msg => ({
      role: msg.is_user ? 'user' : 'assistant',
      content: msg.mes || '',
    }));
  }

  /**
   * 显示加载提示
   * @param {HTMLElement} floorElement - 楼层元素
   */
  showLoadingIndicator(floorElement) {
    let indicator = floorElement.querySelector('.qm-storyboard-loading');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'qm-storyboard-loading';
      indicator.innerHTML = `
        <div style="padding: 12px; text-align: center; color: var(--SmartThemeQuoteColor, rgba(255,255,255,0.6));">
          <i class="fa-solid fa-spinner fa-spin"></i>
          <span style="margin-left: 8px;">分析场景中...</span>
        </div>
      `;

      const messageText = floorElement.querySelector('.mes_text');
      if (messageText) {
        messageText.parentElement.insertBefore(indicator, messageText.nextSibling);
      }
    }
  }

  /**
   * 隐藏加载提示
   * @param {HTMLElement} floorElement - 楼层元素
   */
  hideLoadingIndicator(floorElement) {
    const indicator = floorElement.querySelector('.qm-storyboard-loading');
    if (indicator) {
      indicator.remove();
    }
  }

  /**
   * 显示错误提示
   * @param {HTMLElement} floorElement - 楼层元素
   * @param {string} message - 错误消息
   */
  showError(floorElement, message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'qm-storyboard-error';
    errorDiv.innerHTML = `
      <div style="padding: 12px; background: rgba(244, 67, 54, 0.1); border: 1px solid rgba(244, 67, 54, 0.3); border-radius: 4px; color: #f44336; margin: 12px 0;">
        <i class="fa-solid fa-circle-exclamation"></i>
        <span style="margin-left: 8px;">分镜生成失败: ${message}</span>
      </div>
    `;

    const messageText = floorElement.querySelector('.mes_text');
    if (messageText) {
      messageText.parentElement.insertBefore(errorDiv, messageText.nextSibling);

      // 3秒后自动移除
      setTimeout(() => errorDiv.remove(), 3000);
    }
  }

  /**
   * 处理生成按钮点击
   * @param {string} messageId - 消息ID
   * @param {Object} card - 镜头卡片
   */
  async handleGenerate(messageId, card) {
    console.log('[Qianmu Storyboard] Generate card:', card.id);

    // 更新卡片状态为队列中
    card.status = SHOT_CARD_STATUS.QUEUED;
    this.updateCard(messageId, card);

    // 加入队列
    this.queue.enqueue(card, async () => {
      await this.generateImage(messageId, card);
    });
  }

  /**
   * 实际生图逻辑（复用现有系统）
   * @param {string} messageId - 消息ID
   * @param {Object} card - 镜头卡片
   */
  async generateImage(messageId, card) {
    try {
      // 更新状态为生成中
      card.status = SHOT_CARD_STATUS.GENERATING;
      card.progress = 0;
      this.updateCard(messageId, card);

      // 内容适配（NSFW处理）
      const adapted = adaptShotForProvider(card, card.provider, false); // TODO: 检测NSFW

      // 构建最终提示词
      const compiler = new PromptCompiler();
      const compiled = await compiler.compile(adapted, {
        characterName: this.context.name2,
        userName: this.context.name1,
      });

      // 复用现有生图系统的Job结构
      const storyboardState = this.getStoryboardState();
      const profile = this.buildProfile(card);

      // 创建Job（简化版，复用现有createJob逻辑）
      const job = {
        id: `shotjob-${card.id}`,
        source: card.provider,
        prompt: compiled.prompt,
        negative: compiled.negative || card.negative,
        profile: profile,
        payload: this.buildPayload(card, compiled),
        connection: this.getConnection(card.provider),
        target: 'gallery', // 不内联到楼层
        floor: null,
        chatKey: '',
        discardRequested: false,
        attempt: 1,
      };

      // 调用现有生图API
      const gatewayRequest = this.buildGatewayRequest(job);

      // 模拟进度（实际API不提供进度回调）
      const progressInterval = setInterval(() => {
        if (card.progress < 90) {
          card.progress += 10;
          this.updateCard(messageId, card);
        }
      }, 800);

      // 调用生图服务
      const response = await fetch('/api/plugins/qianmu-tts/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gatewayRequest),
      });

      clearInterval(progressInterval);

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok) {
        throw new Error(data.message || `生图服务请求失败（${response.status}）`);
      }

      const images = Array.isArray(data.images) ? data.images.slice(0, 8) : [];
      if (!images.length) {
        throw new Error('生图服务没有返回可用图片');
      }

      // 持久化图片到本地
      const urls = [];
      for (let index = 0; index < images.length; index++) {
        const url = await this.persistImage(images[index], card, index);
        urls.push(url);
      }

      // 成功
      card.status = SHOT_CARD_STATUS.COMPLETED;
      card.progress = 100;
      card.images = urls.map(url => ({ url }));
      card.selectedImageIndex = 0;
      card.generatedAt = Date.now();

    } catch (error) {
      console.error('[Qianmu Storyboard] Generate failed:', error);
      card.status = SHOT_CARD_STATUS.FAILED;
      card.error = error.message;
    }

    this.updateCard(messageId, card);
  }

  /**
   * 获取现有分镜状态
   * @returns {Object} 分镜状态
   */
  getStoryboardState() {
    // 从全局获取现有分镜状态
    return window.getSettings?.()?.imagegen || {};
  }

  /**
   * 构建Profile对象
   * @param {Object} card - 镜头卡片
   * @returns {Object} Profile
   */
  buildProfile(card) {
    return {
      model: card.model,
      width: card.params?.width || 832,
      height: card.params?.height || 1216,
      steps: card.params?.steps || 28,
      cfg: card.params?.cfg || 5.5,
      seed: card.params?.seed || -1,
      sampler: card.params?.sampler || '',
      scheduler: card.params?.scheduler || '',
    };
  }

  /**
   * 构建Payload对象
   * @param {Object} card - 镜头卡片
   * @param {Object} compiled - 编译后的提示词
   * @returns {Object} Payload
   */
  buildPayload(card, compiled) {
    return {
      prompt: compiled.prompt,
      negative: compiled.negative || card.negative,
      characters: [],
    };
  }

  /**
   * 获取连接配置
   * @param {string} provider - 供应商
   * @returns {Object} 连接配置
   */
  getConnection(provider) {
    const state = this.getStoryboardState();
    const connections = state.connections || {};
    const providerConnections = connections[provider] || {};
    return {
      id: 'default',
      credentialId: '',
      baseUrl: providerConnections.draft?.baseUrl || '',
      model: '',
      options: {},
    };
  }

  /**
   * 构建网关请求
   * @param {Object} job - Job对象
   * @returns {Object} 网关请求
   */
  buildGatewayRequest(job) {
    return {
      provider: job.source,
      model: job.profile.model,
      prompt: job.prompt,
      negativePrompt: job.negative,
      parameters: {
        width: job.profile.width,
        height: job.profile.height,
        steps: job.profile.steps,
        cfg_scale: job.profile.cfg,
        seed: job.profile.seed === -1 ? undefined : job.profile.seed,
        sampler_name: job.profile.sampler || undefined,
        scheduler: job.profile.scheduler || undefined,
      },
      baseUrl: job.connection?.baseUrl || '',
      apiKey: '', // 由后端处理
      references: [],
      vibes: [],
    };
  }

  /**
   * 持久化图片
   * @param {Object} imageData - 图片数据
   * @param {Object} card - 镜头卡片
   * @param {number} index - 索引
   * @returns {Promise<string>} 图片URL
   */
  async persistImage(imageData, card, index) {
    // 如果是base64，直接返回
    if (imageData.base64 || imageData.url?.startsWith('data:')) {
      return imageData.base64 || imageData.url;
    }

    // 如果是URL，可能需要持久化到本地
    // 这里先直接返回URL，实际使用可能需要调用 blobStore
    return imageData.url || imageData;
  }

  /**
   * 更新卡片显示
   * @param {string} messageId - 消息ID
   * @param {Object} card - 镜头卡片
   */
  updateCard(messageId, card) {
    // 更新内存
    const cards = this.cards.get(messageId);
    if (cards) {
      const index = cards.findIndex(c => c.id === card.id);
      if (index !== -1) {
        cards[index] = card;
        this.storage.shotCards.saveShotCards(messageId, cards);
      }
    }

    // 更新UI
    const cardElement = document.querySelector(`[data-card-id="${card.id}"]`);
    if (cardElement) {
      cardElement.outerHTML = renderShotCard(card);

      // 重新绑定事件
      const newCardElement = document.querySelector(`[data-card-id="${card.id}"]`);
      if (newCardElement) {
        bindShotCardEvents(newCardElement, card, {
          onGenerate: (c) => this.handleGenerate(messageId, c),
          onEdit: (c) => this.handleEdit(messageId, c),
          onCancel: (c) => this.handleCancel(messageId, c),
        });
      }
    }
  }

  /**
   * 处理编辑按钮点击
   * @param {string} messageId - 消息ID
   * @param {Object} card - 镜头卡片
   */
  async handleEdit(messageId, card) {
    console.log('[Qianmu Storyboard] Edit card:', card.id);

    // 动态导入编辑面板
    const { createShotEditModal } = await import('./qianmu-storyboard-shot-edit-panel.js');

    // 创建编辑模态框
    const modal = createShotEditModal(card, (updatedCard) => {
      // 保存更新后的卡片
      this.updateCard(messageId, updatedCard);

      // 自动触发生成
      this.handleGenerate(messageId, updatedCard);
    }, {
      providers: ['novel', 'banana', 'openai'],
      models: {
        novel: ['nai-diffusion-5-full', 'nai-diffusion-5-inpainting', 'nai-diffusion-4-curated'],
        banana: ['gemini-3.1-flash-image', 'gemini-3.1-pro-image'],
        openai: ['dall-e-3', 'dall-e-2'],
      },
    });

    document.body.appendChild(modal);
  }

  /**
   * 处理取消按钮点击
   * @param {string} messageId - 消息ID
   * @param {Object} card - 镜头卡片
   */
  handleCancel(messageId, card) {
    console.log('[Qianmu Storyboard] Cancel card:', card.id);

    // 从队列移除
    this.queue.remove(card.id);

    // 更新状态为草稿
    card.status = SHOT_CARD_STATUS.DRAFT;
    card.progress = 0;
    this.updateCard(messageId, card);
  }

  /**
   * 清理资源
   */
  cleanup() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.cards.clear();
  }
}

/**
 * 初始化分镜集成
 * @param {Object} context - SillyTavern context
 */
export function initStoryboardIntegration(context) {
  if (storyboardIntegration) {
    storyboardIntegration.cleanup();
  }

  storyboardIntegration = new StoryboardIntegration(context);
  storyboardIntegration.init();

  return storyboardIntegration;
}

/**
 * 获取分镜集成实例
 * @returns {StoryboardIntegration}
 */
export function getStoryboardIntegration() {
  return storyboardIntegration;
}

/**
 * 清理分镜集成
 */
export function cleanupStoryboardIntegration() {
  if (storyboardIntegration) {
    storyboardIntegration.cleanup();
    storyboardIntegration = null;
  }
}

export const STORYBOARD_INTEGRATION_VERSION = '2.0.0';
export const STORYBOARD_INTEGRATION_NAME = 'qianmu-storyboard-integration';
