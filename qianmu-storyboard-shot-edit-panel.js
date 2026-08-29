// 千幕·分镜 - 编辑面板
// 版本: 2.0.0
// 作者: Liminale
// 说明: 镜头卡片参数编辑界面

import { htmlEscape } from './qianmu-storyboard-utils.js';
import { SHOT_TYPES } from './qianmu-storyboard-frame.js';
import { STORYBOARD_RATIOS } from './qianmu-storyboard.js';

/**
 * 渲染镜头编辑面板
 * @param {Object} card - 镜头卡片
 * @param {Object} options - 选项
 * @returns {string} HTML字符串
 */
export function renderShotEditPanel(card, options = {}) {
  const {
    providers = ['novel', 'banana', 'openai'],
    models = {
      novel: ['nai-diffusion-5-full', 'nai-diffusion-5-inpainting', 'nai-diffusion-4-curated'],
      banana: ['gemini-3.1-flash-image', 'gemini-3.1-pro-image'],
      openai: ['dall-e-3', 'dall-e-2'],
    },
  } = options;

  const currentProvider = card.provider || 'novel';
  const currentModel = card.model || 'nai-diffusion-5-full';

  const providerOptions = providers.map(p => {
    const selected = p === currentProvider ? 'selected' : '';
    const labels = {
      novel: 'NovelAI',
      banana: 'Banana',
      openai: 'OpenAI',
      stability: 'Stability AI',
    };
    return `<option value="${p}" ${selected}>${labels[p] || p}</option>`;
  }).join('');

  const modelOptions = (models[currentProvider] || []).map(m => {
    const selected = m === currentModel ? 'selected' : '';
    return `<option value="${m}" ${selected}>${m}</option>`;
  }).join('');

  const ratioOptions = Object.entries(STORYBOARD_RATIOS).map(([key, ratio]) => {
    const current = card.params?.ratio || '2:3';
    const selected = key === current ? 'selected' : '';
    return `<option value="${key}" ${selected}>${ratio.label} (${ratio.width}×${ratio.height})</option>`;
  }).join('');

  const shotTypeOptions = Object.entries(SHOT_TYPES).map(([key, type]) => {
    const selected = key === card.shotType ? 'selected' : '';
    return `<option value="${key}" ${selected}>${type.icon} ${type.label}</option>`;
  }).join('');

  return `
    <div class="qm-shot-edit-panel">
      <div class="qm-shot-edit-header">
        <h3>调整镜头参数</h3>
        <button type="button" class="qm-shot-edit-close" title="关闭">×</button>
      </div>

      <div class="qm-shot-edit-body">
        <!-- 镜头类型 -->
        <div class="qm-form-group">
          <label>镜头类型</label>
          <select class="qm-form-select" name="shotType">
            ${shotTypeOptions}
          </select>
        </div>

        <!-- 场景描述 -->
        <div class="qm-form-group">
          <label>场景描述</label>
          <textarea class="qm-form-textarea" name="description" rows="2" placeholder="简要描述这个镜头的内容">${htmlEscape(card.description || '')}</textarea>
        </div>

        <!-- 提示词 -->
        <div class="qm-form-group">
          <label>提示词 *</label>
          <textarea class="qm-form-textarea" name="prompt" rows="4" placeholder="输入提示词..." required>${htmlEscape(card.prompt || '')}</textarea>
        </div>

        <!-- 画师串 -->
        <div class="qm-form-group">
          <label>画师串（NovelAI）</label>
          <div class="qm-form-input-with-button">
            <textarea class="qm-form-textarea" name="artistString" rows="2" placeholder="artist:xxx, style:yyy">${htmlEscape(card.artistString || '')}</textarea>
            <button type="button" class="qm-artist-quick-jump-btn" title="从画师串库选择">选择画师串</button>
          </div>
          <small>支持画师标签，逗号分隔</small>
        </div>

        <!-- 负面提示词 -->
        <div class="qm-form-group">
          <label>负面提示词</label>
          <textarea class="qm-form-textarea" name="negative" rows="3" placeholder="不希望出现的元素...">${htmlEscape(card.negative || '')}</textarea>
        </div>

        <!-- 供应商和模型 -->
        <div class="qm-form-row">
          <div class="qm-form-group">
            <label>供应商</label>
            <select class="qm-form-select" name="provider" data-sync-models="true">
              ${providerOptions}
            </select>
          </div>
          <div class="qm-form-group">
            <label>模型</label>
            <select class="qm-form-select" name="model">
              ${modelOptions}
            </select>
          </div>
        </div>

        <!-- 尺寸比例 -->
        <div class="qm-form-group">
          <label>尺寸比例</label>
          <select class="qm-form-select" name="ratio" data-sync-dimensions="true">
            ${ratioOptions}
          </select>
        </div>

        <!-- 宽度和高度 -->
        <div class="qm-form-row">
          <div class="qm-form-group">
            <label>宽度</label>
            <input type="number" class="qm-form-input" name="width" min="64" max="2048" step="64" value="${card.params?.width || 832}">
          </div>
          <div class="qm-form-group">
            <label>高度</label>
            <input type="number" class="qm-form-input" name="height" min="64" max="2048" step="64" value="${card.params?.height || 1216}">
          </div>
        </div>

        <!-- 采样步数 -->
        <div class="qm-form-group">
          <label>采样步数</label>
          <input type="range" class="qm-form-range" name="steps" min="1" max="50" value="${card.params?.steps || 28}">
          <span class="qm-form-range-value">${card.params?.steps || 28}</span>
        </div>

        <!-- CFG Scale -->
        <div class="qm-form-group">
          <label>CFG Scale</label>
          <input type="range" class="qm-form-range" name="cfg" min="1" max="20" step="0.5" value="${card.params?.cfg || 5.5}">
          <span class="qm-form-range-value">${card.params?.cfg || 5.5}</span>
        </div>

        <!-- Seed -->
        <div class="qm-form-group">
          <label>种子（Seed）</label>
          <div class="qm-form-input-with-button">
            <input type="number" class="qm-form-input" name="seed" placeholder="留空随机" value="${card.params?.seed || ''}">
            <button type="button" class="qm-seed-random-btn" title="随机种子">🎲</button>
          </div>
        </div>
      </div>

      <div class="qm-shot-edit-footer">
        <button type="button" class="qm-shot-edit-cancel">取消</button>
        <button type="button" class="qm-shot-edit-save">保存并生成</button>
      </div>
    </div>
  `;
}

/**
 * 获取编辑面板样式
 * @returns {string} CSS字符串
 */
export function getShotEditPanelStyles() {
  return `
    .qm-shot-edit-panel {
      background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.9));
      border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
      border-radius: 8px;
      width: 600px;
      max-width: 90vw;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }

    .qm-shot-edit-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
    }

    .qm-shot-edit-header h3 {
      margin: 0;
      font-size: 16px;
      color: var(--SmartThemeBodyColor, #fff);
    }

    .qm-shot-edit-close {
      width: 32px;
      height: 32px;
      border: none;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 50%;
      font-size: 20px;
      line-height: 1;
      color: var(--SmartThemeBodyColor, #fff);
      cursor: pointer;
      transition: background 0.2s ease;
    }

    .qm-shot-edit-close:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    .qm-shot-edit-body {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }

    .qm-form-group {
      margin-bottom: 16px;
    }

    .qm-form-group:last-child {
      margin-bottom: 0;
    }

    .qm-form-group label {
      display: block;
      margin-bottom: 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--SmartThemeBodyColor, #fff);
    }

    .qm-form-group small {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      color: var(--SmartThemeQuoteColor, rgba(255, 255, 255, 0.5));
    }

    .qm-form-input,
    .qm-form-textarea,
    .qm-form-select {
      width: 100%;
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
      border-radius: 4px;
      color: var(--SmartThemeBodyColor, #fff);
      font-size: 13px;
      font-family: inherit;
      transition: border-color 0.2s ease;
    }

    .qm-form-input:focus,
    .qm-form-textarea:focus,
    .qm-form-select:focus {
      outline: none;
      border-color: var(--SmartThemeHighlightColor, rgba(74, 158, 255, 0.5));
    }

    .qm-form-textarea {
      resize: vertical;
      min-height: 60px;
    }

    .qm-form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .qm-form-input-with-button {
      display: flex;
      gap: 8px;
      align-items: flex-start;
    }

    .qm-form-input-with-button .qm-form-input,
    .qm-form-input-with-button .qm-form-textarea {
      flex: 1;
    }

    .qm-form-input-with-button button {
      flex-shrink: 0;
      padding: 8px 12px;
      background: rgba(74, 158, 255, 0.2);
      border: 1px solid rgba(74, 158, 255, 0.3);
      border-radius: 4px;
      color: #4a9eff;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s ease;
    }

    .qm-form-input-with-button button:hover {
      background: rgba(74, 158, 255, 0.3);
      border-color: rgba(74, 158, 255, 0.5);
    }

    .qm-form-range {
      width: calc(100% - 50px);
      margin-right: 8px;
    }

    .qm-form-range-value {
      display: inline-block;
      min-width: 40px;
      text-align: right;
      font-size: 13px;
      color: var(--SmartThemeBodyColor, #fff);
    }

    .qm-seed-random-btn {
      min-width: 40px !important;
      padding: 8px !important;
    }

    .qm-shot-edit-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding: 16px 20px;
      border-top: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
    }

    .qm-shot-edit-cancel,
    .qm-shot-edit-save {
      padding: 8px 24px;
      font-size: 13px;
      border-radius: 4px;
      border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .qm-shot-edit-cancel {
      background: rgba(255, 255, 255, 0.05);
      color: var(--SmartThemeBodyColor, #fff);
    }

    .qm-shot-edit-cancel:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .qm-shot-edit-save {
      background: #4a9eff;
      border-color: #4a9eff;
      color: #fff;
    }

    .qm-shot-edit-save:hover {
      background: #357ae8;
      border-color: #357ae8;
    }
  `;
}

/**
 * 创建编辑面板模态框
 * @param {Object} card - 镜头卡片
 * @param {Function} onSave - 保存回调
 * @param {Object} options - 选项
 * @returns {HTMLElement} 模态框元素
 */
export function createShotEditModal(card, onSave, options = {}) {
  const modal = document.createElement('div');
  modal.className = 'qm-modal-overlay';
  modal.innerHTML = `
    <div class="qm-modal-content">
      ${renderShotEditPanel(card, options)}
    </div>
  `;

  const panel = modal.querySelector('.qm-shot-edit-panel');

  // 关闭按钮
  const closeBtn = panel.querySelector('.qm-shot-edit-close');
  const cancelBtn = panel.querySelector('.qm-shot-edit-cancel');

  const closeModal = () => {
    document.body.removeChild(modal);
  };

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  // 点击遮罩关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  // Range 输入同步显示
  const ranges = panel.querySelectorAll('.qm-form-range');
  ranges.forEach(range => {
    const valueSpan = range.nextElementSibling;
    range.addEventListener('input', () => {
      if (valueSpan) valueSpan.textContent = range.value;
    });
  });

  // 随机种子按钮
  const seedRandomBtn = panel.querySelector('.qm-seed-random-btn');
  const seedInput = panel.querySelector('input[name="seed"]');
  if (seedRandomBtn && seedInput) {
    seedRandomBtn.addEventListener('click', () => {
      seedInput.value = Math.floor(Math.random() * 4294967295);
    });
  }

  // 供应商切换同步模型列表
  const providerSelect = panel.querySelector('select[name="provider"]');
  const modelSelect = panel.querySelector('select[name="model"]');
  if (providerSelect && modelSelect && options.models) {
    providerSelect.addEventListener('change', () => {
      const provider = providerSelect.value;
      const models = options.models[provider] || [];
      modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    });
  }

  // 比例切换同步尺寸
  const ratioSelect = panel.querySelector('select[name="ratio"]');
  const widthInput = panel.querySelector('input[name="width"]');
  const heightInput = panel.querySelector('input[name="height"]');
  if (ratioSelect && widthInput && heightInput) {
    ratioSelect.addEventListener('change', () => {
      const ratioKey = ratioSelect.value;
      const ratio = STORYBOARD_RATIOS[ratioKey];
      if (ratio) {
        widthInput.value = ratio.width;
        heightInput.value = ratio.height;
      }
    });
  }

  // 画师串快速跳转按钮
  const artistJumpBtn = panel.querySelector('.qm-artist-quick-jump-btn');
  if (artistJumpBtn) {
    artistJumpBtn.addEventListener('click', async () => {
      const { createArtistSelectorModal } = await import('./qianmu-storyboard-artist-library-ui.js');
      const { ArtistLibraryManager } = await import('./qianmu-storyboard-artist-library.js');
      const { createStoryboardStorage } = await import('./qianmu-storyboard-storage.js');

      const storage = createStoryboardStorage();
      const libraryManager = new ArtistLibraryManager(storage.userArtists);

      const artistModal = createArtistSelectorModal(libraryManager, (artist) => {
        const artistStringTextarea = panel.querySelector('textarea[name="artistString"]');
        if (artistStringTextarea) {
          artistStringTextarea.value = artist.tags;
        }
      });

      document.body.appendChild(artistModal);
    });
  }

  // 保存按钮
  const saveBtn = panel.querySelector('.qm-shot-edit-save');
  saveBtn.addEventListener('click', () => {
    // 收集表单数据
    const formData = {
      shotType: panel.querySelector('select[name="shotType"]').value,
      description: panel.querySelector('textarea[name="description"]').value,
      prompt: panel.querySelector('textarea[name="prompt"]').value,
      artistString: panel.querySelector('textarea[name="artistString"]').value,
      negative: panel.querySelector('textarea[name="negative"]').value,
      provider: panel.querySelector('select[name="provider"]').value,
      model: panel.querySelector('select[name="model"]').value,
      params: {
        ratio: panel.querySelector('select[name="ratio"]').value,
        width: parseInt(panel.querySelector('input[name="width"]').value, 10),
        height: parseInt(panel.querySelector('input[name="height"]').value, 10),
        steps: parseInt(panel.querySelector('input[name="steps"]').value, 10),
        cfg: parseFloat(panel.querySelector('input[name="cfg"]').value),
        seed: panel.querySelector('input[name="seed"]').value ? parseInt(panel.querySelector('input[name="seed"]').value, 10) : undefined,
      },
    };

    // 验证
    if (!formData.prompt.trim()) {
      alert('请输入提示词');
      return;
    }

    // 更新卡片
    const updatedCard = {
      ...card,
      ...formData,
    };

    closeModal();

    if (onSave) {
      onSave(updatedCard);
    }
  });

  return modal;
}

export const SHOT_EDIT_PANEL_VERSION = '2.0.0';
export const SHOT_EDIT_PANEL_NAME = 'qianmu-storyboard-shot-edit-panel';
