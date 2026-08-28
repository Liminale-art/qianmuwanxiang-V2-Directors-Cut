// 千幕·分镜 - 镜头卡片 UI
// 版本: 2.0.0
// 作者: Liminale
// 说明: 卡片渲染、楼层内联注入、交互事件、灯箱预览

import {
  SHOT_CARD_STATUS,
  SHOT_TYPES,
} from './qianmu-storyboard-frame.js';
import { htmlEscape } from './qianmu-storyboard-utils.js';

/**
 * 渲染镜头卡片 HTML
 * @param {Object} card - 镜头卡片
 * @returns {string} HTML 字符串
 */
export function renderShotCard(card) {
  const shotType = SHOT_TYPES[card.shotType] || SHOT_TYPES.custom;
  const statusLabels = {
    [SHOT_CARD_STATUS.DRAFT]: '草稿',
    [SHOT_CARD_STATUS.QUEUED]: `队列中 (${card.queuePosition || '?'})`,
    [SHOT_CARD_STATUS.GENERATING]: `生成中 (${card.progress}%)`,
    [SHOT_CARD_STATUS.COMPLETED]: '已完成',
    [SHOT_CARD_STATUS.FAILED]: '生成失败',
  };

  const statusLabel = statusLabels[card.status] || card.status;
  const canEdit = card.status === SHOT_CARD_STATUS.DRAFT;
  const canGenerate = [SHOT_CARD_STATUS.DRAFT, SHOT_CARD_STATUS.COMPLETED, SHOT_CARD_STATUS.FAILED].includes(card.status);
  const canCancel = [SHOT_CARD_STATUS.QUEUED, SHOT_CARD_STATUS.GENERATING].includes(card.status);

  // 图片预览区
  let imagePreview = '';
  if (card.status === SHOT_CARD_STATUS.COMPLETED && card.images && card.images.length > 0) {
    const selectedImage = card.images[card.selectedImageIndex || 0];
    imagePreview = `
      <div class="qm-shot-card-image">
        <img src="${htmlEscape(selectedImage.url)}" alt="生成的图像" loading="lazy">
        ${card.images.length > 1 ? `<div class="qm-shot-card-image-nav">
          <button type="button" class="qm-shot-card-image-prev" ${card.selectedImageIndex === 0 ? 'disabled' : ''}>
            <i class="fa-solid fa-chevron-left"></i>
          </button>
          <span>${(card.selectedImageIndex || 0) + 1} / ${card.images.length}</span>
          <button type="button" class="qm-shot-card-image-next" ${card.selectedImageIndex >= card.images.length - 1 ? 'disabled' : ''}>
            <i class="fa-solid fa-chevron-right"></i>
          </button>
        </div>` : ''}
      </div>
    `;
  } else if (card.status === SHOT_CARD_STATUS.GENERATING) {
    imagePreview = `
      <div class="qm-shot-card-placeholder generating">
        <div class="qm-shot-card-progress">
          <div class="qm-shot-card-progress-bar" style="width: ${card.progress}%"></div>
        </div>
        <span>生成中... ${card.progress}%</span>
      </div>
    `;
  } else if (card.status === SHOT_CARD_STATUS.QUEUED) {
    imagePreview = `
      <div class="qm-shot-card-placeholder queued">
        <i class="fa-solid fa-clock"></i>
        <span>队列中 (第 ${card.queuePosition} 位)</span>
      </div>
    `;
  } else if (card.status === SHOT_CARD_STATUS.FAILED) {
    imagePreview = `
      <div class="qm-shot-card-placeholder failed">
        <i class="fa-solid fa-circle-exclamation"></i>
        <span>${htmlEscape(card.error || '生成失败')}</span>
      </div>
    `;
  } else {
    imagePreview = `
      <div class="qm-shot-card-placeholder draft">
        <i class="fa-solid fa-image"></i>
        <span>等待生成</span>
      </div>
    `;
  }

  // 提示词摘要（折叠时显示）
  const promptSummary = card.prompt ? htmlEscape(card.prompt.slice(0, 60) + (card.prompt.length > 60 ? '...' : '')) : '（未设置提示词）';

  return `
    <div class="qm-shot-card" data-card-id="${htmlEscape(card.id)}" data-card-status="${htmlEscape(card.status)}">
      <div class="qm-shot-card-header">
        <div class="qm-shot-card-title">
          <span class="qm-shot-card-icon">${shotType.icon}</span>
          <span class="qm-shot-card-type">${htmlEscape(shotType.label)}</span>
          <span class="qm-shot-card-status">${htmlEscape(statusLabel)}</span>
        </div>
        <div class="qm-shot-card-actions">
          <button type="button" class="qm-shot-card-toggle" title="折叠/展开" aria-label="折叠/展开">
            <i class="fa-solid fa-chevron-down"></i>
          </button>
        </div>
      </div>

      <div class="qm-shot-card-body">
        ${imagePreview}

        <div class="qm-shot-card-info">
          <div class="qm-shot-card-prompt">
            <span>提示词：</span>
            <span class="qm-shot-card-prompt-text">${promptSummary}</span>
          </div>
          ${card.provider && card.model ? `
            <div class="qm-shot-card-model">
              <span>模型：</span>
              <span>${htmlEscape(card.provider)} · ${htmlEscape(card.model)}</span>
            </div>
          ` : ''}
          ${card.params?.width && card.params?.height ? `
            <div class="qm-shot-card-size">
              <span>尺寸：</span>
              <span>${card.params.width} × ${card.params.height}</span>
            </div>
          ` : ''}
        </div>

        <div class="qm-shot-card-buttons">
          ${canGenerate ? `
            <button type="button" class="qm-shot-card-generate" ${!card.prompt ? 'disabled' : ''}>
              <i class="fa-solid fa-wand-magic-sparkles"></i>
              <span>${card.status === SHOT_CARD_STATUS.DRAFT ? '生成' : '重新生成'}</span>
            </button>
          ` : ''}
          ${canEdit ? `
            <button type="button" class="qm-shot-card-edit">
              <i class="fa-solid fa-pencil"></i>
              <span>调整参数</span>
            </button>
          ` : ''}
          ${canCancel ? `
            <button type="button" class="qm-shot-card-cancel">
              <i class="fa-solid fa-xmark"></i>
              <span>取消</span>
            </button>
          ` : ''}
          <button type="button" class="qm-shot-card-menu">
            <i class="fa-solid fa-ellipsis"></i>
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * 渲染镜头卡片样式（CSS）
 * @returns {string} CSS 字符串
 */
export function getShotCardStyles() {
  return `
    .qm-shot-card {
      background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.3));
      border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
      border-radius: 8px;
      margin: 12px 0;
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .qm-shot-card:hover {
      border-color: var(--SmartThemeHighlightColor, rgba(255, 255, 255, 0.2));
    }

    .qm-shot-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: rgba(0, 0, 0, 0.2);
      cursor: pointer;
    }

    .qm-shot-card-title {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
    }

    .qm-shot-card-icon {
      font-size: 18px;
    }

    .qm-shot-card-type {
      font-weight: 500;
      color: var(--SmartThemeBodyColor, #fff);
    }

    .qm-shot-card-status {
      font-size: 12px;
      color: var(--SmartThemeQuoteColor, rgba(255, 255, 255, 0.6));
      margin-left: auto;
    }

    .qm-shot-card-toggle {
      background: none;
      border: none;
      color: var(--SmartThemeBodyColor, #fff);
      cursor: pointer;
      padding: 4px 8px;
      transition: transform 0.2s ease;
    }

    .qm-shot-card.collapsed .qm-shot-card-toggle i {
      transform: rotate(-90deg);
    }

    .qm-shot-card-body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .qm-shot-card.collapsed .qm-shot-card-body {
      display: none;
    }

    .qm-shot-card-image {
      position: relative;
      width: 100%;
      border-radius: 4px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.4);
    }

    .qm-shot-card-image img {
      width: 100%;
      height: auto;
      display: block;
    }

    .qm-shot-card-image-nav {
      position: absolute;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(0, 0, 0, 0.6);
      padding: 4px 12px;
      border-radius: 16px;
      backdrop-filter: blur(8px);
    }

    .qm-shot-card-image-nav button {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      padding: 4px;
    }

    .qm-shot-card-image-nav button:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .qm-shot-card-placeholder {
      width: 100%;
      height: 200px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 4px;
      color: var(--SmartThemeQuoteColor, rgba(255, 255, 255, 0.6));
    }

    .qm-shot-card-placeholder i {
      font-size: 32px;
    }

    .qm-shot-card-placeholder.failed {
      color: #ff6b6b;
    }

    .qm-shot-card-progress {
      width: 80%;
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
    }

    .qm-shot-card-progress-bar {
      height: 100%;
      background: var(--SmartThemeHighlightColor, #4a9eff);
      transition: width 0.3s ease;
    }

    .qm-shot-card-info {
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 13px;
      color: var(--SmartThemeQuoteColor, rgba(255, 255, 255, 0.7));
    }

    .qm-shot-card-info > div {
      display: flex;
      gap: 8px;
    }

    .qm-shot-card-info > div > span:first-child {
      min-width: 60px;
      color: var(--SmartThemeQuoteColor, rgba(255, 255, 255, 0.5));
    }

    .qm-shot-card-prompt-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .qm-shot-card-buttons {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .qm-shot-card-buttons button {
      flex: 1;
      min-width: 100px;
      padding: 8px 16px;
      background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, 0.1));
      border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
      border-radius: 4px;
      color: var(--SmartThemeBodyColor, #fff);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s ease;
    }

    .qm-shot-card-buttons button:hover:not(:disabled) {
      background: var(--SmartThemeHighlightColor, rgba(74, 158, 255, 0.3));
      border-color: var(--SmartThemeHighlightColor, #4a9eff);
    }

    .qm-shot-card-buttons button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .qm-shot-card-menu {
      flex: 0 !important;
      min-width: auto !important;
      width: 40px;
    }
  `;
}

/**
 * 注入楼层"取景"按钮
 * @param {HTMLElement} floorElement - 楼层元素
 * @param {Function} onClick - 点击回调
 */
export function injectFloorCaptureButton(floorElement, onClick) {
  if (!floorElement) return;

  // 检查是否已注入
  if (floorElement.querySelector('.qm-floor-capture-btn')) {
    return;
  }

  // 查找操作栏
  const actionBar = floorElement.querySelector('.mes_buttons, .message-buttons, .swipe_right')?.parentElement;
  if (!actionBar) return;

  // 创建按钮
  const button = document.createElement('div');
  button.className = 'mes_button qm-floor-capture-btn';
  button.innerHTML = `
    <i class="fa-solid fa-camera" title="取景生成分镜"></i>
  `;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (onClick) onClick(floorElement);
  });

  // 插入按钮
  actionBar.insertBefore(button, actionBar.firstChild);
}

/**
 * 楼层观察器 - 自动注入取景按钮
 * @param {Function} onCapture - 取景回调
 * @returns {MutationObserver} 观察器实例
 */
export function createFloorObserver(onCapture) {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // 检查是否为消息楼层
        const floors = [];
        if (node.classList && node.classList.contains('mes')) {
          floors.push(node);
        }
        floors.push(...node.querySelectorAll('.mes'));

        for (const floor of floors) {
          injectFloorCaptureButton(floor, onCapture);
        }
      }
    }
  });

  return observer;
}

/**
 * 挂载镜头卡片到楼层
 * @param {HTMLElement} floorElement - 楼层元素
 * @param {Object} card - 镜头卡片
 * @param {Object} handlers - 事件处理器
 */
export function mountShotCardToFloor(floorElement, card, handlers = {}) {
  if (!floorElement) return;

  // 查找或创建卡片容器
  let container = floorElement.querySelector('.qm-shot-cards-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'qm-shot-cards-container';

    // 插入到消息文本后面
    const messageText = floorElement.querySelector('.mes_text, .message-text');
    if (messageText) {
      messageText.parentElement.insertBefore(container, messageText.nextSibling);
    } else {
      floorElement.appendChild(container);
    }
  }

  // 检查是否已存在
  const existing = container.querySelector(`[data-card-id="${card.id}"]`);
  if (existing) {
    // 更新现有卡片
    existing.outerHTML = renderShotCard(card);
  } else {
    // 插入新卡片
    container.insertAdjacentHTML('beforeend', renderShotCard(card));
  }

  // 绑定事件
  const cardElement = container.querySelector(`[data-card-id="${card.id}"]`);
  if (cardElement) {
    bindShotCardEvents(cardElement, card, handlers);
  }
}

/**
 * 绑定镜头卡片事件
 * @param {HTMLElement} cardElement - 卡片元素
 * @param {Object} card - 镜头卡片
 * @param {Object} handlers - 事件处理器
 */
export function bindShotCardEvents(cardElement, card, handlers = {}) {
  // 折叠/展开
  const toggleBtn = cardElement.querySelector('.qm-shot-card-toggle');
  const header = cardElement.querySelector('.qm-shot-card-header');
  if (toggleBtn || header) {
    const toggle = () => {
      cardElement.classList.toggle('collapsed');
    };
    toggleBtn?.addEventListener('click', toggle);
    header?.addEventListener('click', (e) => {
      if (e.target === header || e.target.closest('.qm-shot-card-title')) {
        toggle();
      }
    });
  }

  // 生成按钮
  const generateBtn = cardElement.querySelector('.qm-shot-card-generate');
  if (generateBtn && handlers.onGenerate) {
    generateBtn.addEventListener('click', () => handlers.onGenerate(card));
  }

  // 编辑按钮
  const editBtn = cardElement.querySelector('.qm-shot-card-edit');
  if (editBtn && handlers.onEdit) {
    editBtn.addEventListener('click', () => handlers.onEdit(card));
  }

  // 取消按钮
  const cancelBtn = cardElement.querySelector('.qm-shot-card-cancel');
  if (cancelBtn && handlers.onCancel) {
    cancelBtn.addEventListener('click', () => handlers.onCancel(card));
  }

  // 菜单按钮
  const menuBtn = cardElement.querySelector('.qm-shot-card-menu');
  if (menuBtn && handlers.onMenu) {
    menuBtn.addEventListener('click', () => handlers.onMenu(card, menuBtn));
  }

  // 图片导航
  const prevBtn = cardElement.querySelector('.qm-shot-card-image-prev');
  const nextBtn = cardElement.querySelector('.qm-shot-card-image-next');
  if (prevBtn && handlers.onImageNav) {
    prevBtn.addEventListener('click', () => handlers.onImageNav(card, 'prev'));
  }
  if (nextBtn && handlers.onImageNav) {
    nextBtn.addEventListener('click', () => handlers.onImageNav(card, 'next'));
  }

  // 图片点击放大
  const image = cardElement.querySelector('.qm-shot-card-image img');
  if (image && handlers.onImageClick) {
    image.style.cursor = 'pointer';
    image.addEventListener('click', () => handlers.onImageClick(card));
  }
}

export const FRAME_UI_MODULE_VERSION = '2.0.0';
export const FRAME_UI_MODULE_NAME = 'qianmu-storyboard-frame-ui';
