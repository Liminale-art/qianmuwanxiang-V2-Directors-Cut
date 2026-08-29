// 千幕·分镜 - 预设管理模态框
// 版本: 2.0.0
// 作者: Liminale
// 说明: 预设库管理界面（工厂预设 + 用户预设）

import { FACTORY_PRESETS, createUserPreset, validatePreset } from './qianmu-storyboard-presets.js';

/**
 * 创建预设管理模态框
 * @param {Object} presetManager - 预设管理器实例
 */
export function createPresetManagementModal(presetManager) {
  const modal = document.createElement('div');
  modal.className = 'qm-preset-modal';

  modal.innerHTML = `
    <div class="qm-preset-modal-overlay"></div>
    <div class="qm-preset-modal-container">
      <div class="qm-preset-modal-header">
        <h2>预设管理</h2>
        <div class="qm-preset-modal-actions">
          <button type="button" class="qm-preset-import-btn" title="导入预设">
            <i class="fa-solid fa-file-import"></i>
          </button>
          <button type="button" class="qm-preset-export-btn" title="导出预设">
            <i class="fa-solid fa-file-export"></i>
          </button>
          <button type="button" class="qm-preset-close-btn" aria-label="关闭">
            <i class="fa-solid fa-times"></i>
          </button>
        </div>
      </div>

      <div class="qm-preset-modal-toolbar">
        <button type="button" class="qm-preset-new-btn">
          <i class="fa-solid fa-plus"></i>
          新建预设
        </button>
        <input type="search" class="qm-preset-search" placeholder="搜索预设...">
      </div>

      <div class="qm-preset-modal-body">
        <div class="qm-preset-grid"></div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // 渲染预设列表
  renderPresetGrid();

  // 绑定事件
  modal.querySelector('.qm-preset-close-btn')?.addEventListener('click', closeModal);
  modal.querySelector('.qm-preset-modal-overlay')?.addEventListener('click', closeModal);
  modal.querySelector('.qm-preset-new-btn')?.addEventListener('click', () => openPresetEditor(null));
  modal.querySelector('.qm-preset-import-btn')?.addEventListener('click', openImportDialog);
  modal.querySelector('.qm-preset-export-btn')?.addEventListener('click', exportPresets);
  modal.querySelector('.qm-preset-search')?.addEventListener('input', handleSearch);

  // 阻止点击容器关闭
  modal.querySelector('.qm-preset-modal-container')?.addEventListener('click', (e) => e.stopPropagation());

  // ESC 关闭
  const handleEsc = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', handleEsc);
  modal._handleEsc = handleEsc;

  function renderPresetGrid() {
    const grid = modal.querySelector('.qm-preset-grid');
    if (!grid) return;

    const allPresets = presetManager.getAllPresets();
    const searchTerm = modal.querySelector('.qm-preset-search')?.value?.toLowerCase() || '';

    const filtered = searchTerm
      ? allPresets.filter(p =>
          p.name.toLowerCase().includes(searchTerm) ||
          p.description?.toLowerCase().includes(searchTerm)
        )
      : allPresets;

    if (filtered.length === 0) {
      grid.innerHTML = '<div class="qm-preset-empty">未找到预设</div>';
      return;
    }

    grid.innerHTML = filtered.map(preset => `
      <div class="qm-preset-card ${preset.builtin ? 'builtin' : 'user'}" data-preset-id="${preset.id}">
        <div class="qm-preset-card-header">
          <span class="qm-preset-icon">${preset.icon || '⭐'}</span>
          <span class="qm-preset-badge">${preset.builtin ? '工厂' : '用户'}</span>
        </div>
        <h3 class="qm-preset-name">${escapeHtml(preset.name)}</h3>
        <p class="qm-preset-description">${escapeHtml(preset.description || '无描述')}</p>
        <div class="qm-preset-meta">
          <span class="qm-preset-provider">${escapeHtml(preset.provider)}</span>
          <span class="qm-preset-model">${escapeHtml(preset.model)}</span>
        </div>
        <div class="qm-preset-params">
          <span>${preset.params?.width || 0}x${preset.params?.height || 0}</span>
          <span>Steps: ${preset.params?.steps || 'N/A'}</span>
          <span>CFG: ${preset.params?.cfg || 'N/A'}</span>
        </div>
        ${preset.builtin ? '' : `
          <div class="qm-preset-card-actions">
            <button type="button" class="qm-preset-edit-btn" data-preset-id="${preset.id}" title="编辑">
              <i class="fa-solid fa-edit"></i>
            </button>
            <button type="button" class="qm-preset-delete-btn" data-preset-id="${preset.id}" title="删除">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        `}
      </div>
    `).join('');

    // 绑定卡片事件
    grid.querySelectorAll('.qm-preset-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const presetId = btn.dataset.presetId;
        const preset = presetManager.getPreset(presetId);
        if (preset && !preset.builtin) openPresetEditor(preset);
      });
    });

    grid.querySelectorAll('.qm-preset-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const presetId = btn.dataset.presetId;
        if (confirm('确定要删除此预设吗？')) {
          presetManager.delete(presetId);
          renderPresetGrid();
        }
      });
    });
  }

  function openPresetEditor(preset) {
    const isEdit = preset !== null;
    const editModal = document.createElement('div');
    editModal.className = 'qm-preset-edit-dialog';

    const data = preset || {
      name: '',
      icon: '⭐',
      description: '',
      provider: 'novel',
      model: '',
      params: {
        width: 832,
        height: 1216,
        steps: 28,
        cfg: 5.5,
        sampler: 'k_euler',
        scheduler: 'native',
      },
      promptEnhancement: {
        quality: '',
        negative: '',
      },
      suggestedFor: [],
    };

    editModal.innerHTML = `
      <div class="qm-preset-edit-overlay"></div>
      <div class="qm-preset-edit-container">
        <div class="qm-preset-edit-header">
          <h3>${isEdit ? '编辑预设' : '新建预设'}</h3>
          <button type="button" class="qm-preset-edit-close">
            <i class="fa-solid fa-times"></i>
          </button>
        </div>
        <form class="qm-preset-edit-form">
          <div class="qm-preset-form-row">
            <label>
              <span>预设名称 <abbr title="必填">*</abbr></span>
              <input type="text" name="name" value="${escapeHtml(data.name)}" required maxlength="60">
            </label>
            <label>
              <span>图标 Emoji</span>
              <input type="text" name="icon" value="${escapeHtml(data.icon)}" maxlength="4">
            </label>
          </div>

          <label>
            <span>描述</span>
            <textarea name="description" rows="2" maxlength="200">${escapeHtml(data.description || '')}</textarea>
          </label>

          <div class="qm-preset-form-row">
            <label>
              <span>供应商 <abbr title="必填">*</abbr></span>
              <select name="provider" required>
                <option value="novel" ${data.provider === 'novel' ? 'selected' : ''}>NovelAI</option>
                <option value="stable" ${data.provider === 'stable' ? 'selected' : ''}>Stable Diffusion</option>
                <option value="comfy" ${data.provider === 'comfy' ? 'selected' : ''}>ComfyUI</option>
                <option value="banana" ${data.provider === 'banana' ? 'selected' : ''}>Banana</option>
              </select>
            </label>
            <label>
              <span>模型 <abbr title="必填">*</abbr></span>
              <input type="text" name="model" value="${escapeHtml(data.model)}" required>
            </label>
          </div>

          <fieldset>
            <legend>图片尺寸</legend>
            <div class="qm-preset-form-row">
              <label>
                <span>宽度 <abbr title="必填">*</abbr></span>
                <input type="number" name="width" value="${data.params?.width || 832}" min="64" max="8192" step="8" required>
              </label>
              <label>
                <span>高度 <abbr title="必填">*</abbr></span>
                <input type="number" name="height" value="${data.params?.height || 1216}" min="64" max="8192" step="8" required>
              </label>
              <label>
                <span>比例</span>
                <input type="text" name="ratio" value="${escapeHtml(data.params?.ratio || '')}" placeholder="16:9">
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>生成参数</legend>
            <div class="qm-preset-form-row">
              <label>
                <span>Steps</span>
                <input type="number" name="steps" value="${data.params?.steps || 28}" min="1" max="150">
              </label>
              <label>
                <span>CFG Scale</span>
                <input type="number" name="cfg" value="${data.params?.cfg || 5.5}" min="1" max="30" step="0.5">
              </label>
              <label>
                <span>Sampler</span>
                <input type="text" name="sampler" value="${escapeHtml(data.params?.sampler || 'k_euler')}">
              </label>
              <label>
                <span>Scheduler</span>
                <input type="text" name="scheduler" value="${escapeHtml(data.params?.scheduler || 'native')}">
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>提示词增强</legend>
            <label>
              <span>质量词</span>
              <input type="text" name="quality" value="${escapeHtml(data.promptEnhancement?.quality || '')}">
            </label>
            <label>
              <span>负面词</span>
              <input type="text" name="negative" value="${escapeHtml(data.promptEnhancement?.negative || '')}">
            </label>
          </fieldset>

          <label>
            <span>建议用途（逗号分隔）</span>
            <input type="text" name="suggestedFor" value="${escapeHtml((data.suggestedFor || []).join(', '))}">
            <small>例如: portrait, closeup, action</small>
          </label>

          <div class="qm-preset-edit-actions">
            <button type="button" class="qm-preset-cancel-btn">取消</button>
            <button type="submit" class="qm-preset-save-btn">${isEdit ? '保存' : '创建'}</button>
          </div>
        </form>
      </div>
    `;

    modal.appendChild(editModal);

    const form = editModal.querySelector('.qm-preset-edit-form');
    const closeEdit = () => editModal.remove();

    editModal.querySelector('.qm-preset-edit-close')?.addEventListener('click', closeEdit);
    editModal.querySelector('.qm-preset-edit-overlay')?.addEventListener('click', closeEdit);
    editModal.querySelector('.qm-preset-cancel-btn')?.addEventListener('click', closeEdit);

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const formData = new FormData(form);

      const presetData = {
        name: formData.get('name'),
        icon: formData.get('icon'),
        description: formData.get('description'),
        provider: formData.get('provider'),
        model: formData.get('model'),
        params: {
          width: parseInt(formData.get('width')),
          height: parseInt(formData.get('height')),
          ratio: formData.get('ratio'),
          steps: parseInt(formData.get('steps')) || undefined,
          cfg: parseFloat(formData.get('cfg')) || undefined,
          sampler: formData.get('sampler'),
          scheduler: formData.get('scheduler'),
        },
        promptEnhancement: {
          quality: formData.get('quality'),
          negative: formData.get('negative'),
        },
        suggestedFor: formData.get('suggestedFor')
          ? formData.get('suggestedFor').split(',').map(s => s.trim()).filter(Boolean)
          : [],
      };

      try {
        if (isEdit) {
          presetManager.update(preset.id, presetData);
        } else {
          presetManager.create(presetData);
        }
        renderPresetGrid();
        closeEdit();
      } catch (error) {
        alert(`保存失败: ${error.message}`);
      }
    });
  }

  function openImportDialog() {
    const importDialog = document.createElement('div');
    importDialog.className = 'qm-preset-import-dialog';

    importDialog.innerHTML = `
      <div class="qm-preset-import-overlay"></div>
      <div class="qm-preset-import-container">
        <div class="qm-preset-import-header">
          <h3>导入预设</h3>
          <button type="button" class="qm-preset-import-close">
            <i class="fa-solid fa-times"></i>
          </button>
        </div>
        <div class="qm-preset-import-body">
          <textarea class="qm-preset-import-textarea" placeholder="粘贴 JSON 格式的预设数据..." rows="15"></textarea>
          <div class="qm-preset-import-actions">
            <button type="button" class="qm-preset-import-cancel">取消</button>
            <button type="button" class="qm-preset-import-confirm">导入</button>
          </div>
        </div>
      </div>
    `;

    modal.appendChild(importDialog);

    const closeImport = () => importDialog.remove();
    const textarea = importDialog.querySelector('.qm-preset-import-textarea');

    importDialog.querySelector('.qm-preset-import-close')?.addEventListener('click', closeImport);
    importDialog.querySelector('.qm-preset-import-overlay')?.addEventListener('click', closeImport);
    importDialog.querySelector('.qm-preset-import-cancel')?.addEventListener('click', closeImport);

    importDialog.querySelector('.qm-preset-import-confirm')?.addEventListener('click', () => {
      try {
        const json = textarea.value.trim();
        const data = JSON.parse(json);

        const presets = Array.isArray(data) ? data : [data];
        let imported = 0;

        for (const presetData of presets) {
          try {
            presetManager.create(presetData);
            imported++;
          } catch (err) {
            console.warn('导入预设失败:', err);
          }
        }

        alert(`成功导入 ${imported} 个预设`);
        renderPresetGrid();
        closeImport();
      } catch (error) {
        alert(`导入失败: ${error.message}`);
      }
    });
  }

  function exportPresets() {
    const userPresets = presetManager.userPresets;
    if (userPresets.length === 0) {
      alert('没有可导出的用户预设');
      return;
    }

    const json = JSON.stringify(userPresets, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qianmu-presets-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleSearch() {
    renderPresetGrid();
  }

  function closeModal() {
    if (modal._handleEsc) {
      document.removeEventListener('keydown', modal._handleEsc);
    }
    modal.remove();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str || '');
    return div.innerHTML;
  }
}

/**
 * 获取预设管理模态框样式
 * @returns {string} CSS内容
 */
export function getPresetModalStyles() {
  return `
/* 预设管理模态框 */
.qm-preset-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: qm-fade-in 0.2s ease-out;
}

.qm-preset-modal-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.qm-preset-modal-container {
  position: relative;
  width: 90%;
  max-width: 1200px;
  max-height: 90vh;
  background: var(--sd-card-bg, #fff);
  border-radius: 1rem;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  animation: qm-slide-up 0.3s ease-out;
}

.qm-preset-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem;
  border-bottom: 1px solid var(--sd-border, #e5e7eb);
}

.qm-preset-modal-header h2 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}

.qm-preset-modal-actions {
  display: flex;
  gap: 0.5rem;
}

.qm-preset-import-btn,
.qm-preset-export-btn,
.qm-preset-close-btn {
  width: 2rem;
  height: 2rem;
  border: none;
  background: transparent;
  color: var(--sd-text-secondary, #6b7280);
  cursor: pointer;
  border-radius: 0.375rem;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.qm-preset-import-btn:hover,
.qm-preset-export-btn:hover,
.qm-preset-close-btn:hover {
  background: var(--sd-hover-bg, #f3f4f6);
  color: var(--sd-text-primary, #111827);
}

.qm-preset-modal-toolbar {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--sd-border, #e5e7eb);
  display: flex;
  gap: 1rem;
  align-items: center;
}

.qm-preset-new-btn {
  padding: 0.5rem 1rem;
  background: var(--sd-primary, #3b82f6);
  color: white;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 500;
  transition: all 0.2s;
}

.qm-preset-new-btn:hover {
  background: var(--sd-primary-dark, #2563eb);
}

.qm-preset-search {
  flex: 1;
  padding: 0.5rem 1rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.375rem;
  background: var(--sd-input-bg, #fff);
  color: var(--sd-text-primary, #111827);
}

.qm-preset-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
}

.qm-preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.qm-preset-card {
  padding: 1rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.5rem;
  background: var(--sd-card-bg, #fff);
  transition: all 0.2s;
  position: relative;
}

.qm-preset-card:hover {
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  border-color: var(--sd-primary, #3b82f6);
}

.qm-preset-card.builtin {
  border-left: 3px solid var(--sd-success, #10b981);
}

.qm-preset-card.user {
  border-left: 3px solid var(--sd-primary, #3b82f6);
}

.qm-preset-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.qm-preset-icon {
  font-size: 1.5rem;
}

.qm-preset-badge {
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  background: var(--sd-bg-secondary, #f3f4f6);
  border-radius: 0.25rem;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-preset-name {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}

.qm-preset-description {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
  color: var(--sd-text-secondary, #6b7280);
  line-height: 1.4;
}

.qm-preset-meta {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  font-size: 0.75rem;
}

.qm-preset-provider,
.qm-preset-model {
  padding: 0.25rem 0.5rem;
  background: var(--sd-bg-tertiary, #f9fafb);
  border-radius: 0.25rem;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-preset-params {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  font-size: 0.75rem;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-preset-card-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--sd-border, #e5e7eb);
}

.qm-preset-edit-btn,
.qm-preset-delete-btn {
  flex: 1;
  padding: 0.375rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  background: transparent;
  cursor: pointer;
  border-radius: 0.25rem;
  transition: all 0.2s;
}

.qm-preset-edit-btn:hover {
  background: var(--sd-primary, #3b82f6);
  color: white;
  border-color: var(--sd-primary, #3b82f6);
}

.qm-preset-delete-btn:hover {
  background: var(--sd-danger, #ef4444);
  color: white;
  border-color: var(--sd-danger, #ef4444);
}

.qm-preset-empty {
  padding: 3rem;
  text-align: center;
  color: var(--sd-text-secondary, #6b7280);
}

/* 编辑对话框 */
.qm-preset-edit-dialog,
.qm-preset-import-dialog {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
}

.qm-preset-edit-overlay,
.qm-preset-import-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.3);
}

.qm-preset-edit-container,
.qm-preset-import-container {
  position: relative;
  width: 90%;
  max-width: 600px;
  max-height: 90vh;
  background: var(--sd-card-bg, #fff);
  border-radius: 0.75rem;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
}

.qm-preset-edit-header,
.qm-preset-import-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--sd-border, #e5e7eb);
}

.qm-preset-edit-header h3,
.qm-preset-import-header h3 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
}

.qm-preset-edit-close,
.qm-preset-import-close {
  width: 2rem;
  height: 2rem;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 0.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-preset-edit-form {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.qm-preset-form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
}

.qm-preset-edit-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.qm-preset-edit-form label > span {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--sd-text-primary, #111827);
}

.qm-preset-edit-form input,
.qm-preset-edit-form select,
.qm-preset-edit-form textarea {
  padding: 0.5rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.375rem;
  background: var(--sd-input-bg, #fff);
  color: var(--sd-text-primary, #111827);
}

.qm-preset-edit-form fieldset {
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.5rem;
  padding: 1rem;
}

.qm-preset-edit-form legend {
  padding: 0 0.5rem;
  font-weight: 600;
  font-size: 0.875rem;
}

.qm-preset-edit-form small {
  font-size: 0.75rem;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-preset-edit-form abbr {
  color: var(--sd-danger, #ef4444);
  text-decoration: none;
}

.qm-preset-edit-actions {
  display: flex;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--sd-border, #e5e7eb);
}

.qm-preset-cancel-btn,
.qm-preset-save-btn,
.qm-preset-import-cancel,
.qm-preset-import-confirm {
  flex: 1;
  padding: 0.625rem 1rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.375rem;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.2s;
}

.qm-preset-cancel-btn,
.qm-preset-import-cancel {
  background: transparent;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-preset-save-btn,
.qm-preset-import-confirm {
  background: var(--sd-primary, #3b82f6);
  color: white;
  border-color: var(--sd-primary, #3b82f6);
}

.qm-preset-save-btn:hover,
.qm-preset-import-confirm:hover {
  background: var(--sd-primary-dark, #2563eb);
}

/* 导入对话框 */
.qm-preset-import-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.qm-preset-import-textarea {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.5rem;
  background: var(--sd-input-bg, #fff);
  color: var(--sd-text-primary, #111827);
  font-family: monospace;
  font-size: 0.875rem;
  resize: vertical;
}

.qm-preset-import-actions {
  display: flex;
  gap: 0.75rem;
}

@keyframes qm-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes qm-slide-up {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@media (prefers-color-scheme: dark) {
  .qm-preset-modal-container,
  .qm-preset-card,
  .qm-preset-edit-container,
  .qm-preset-import-container {
    background: var(--sd-card-bg, #1f2937);
  }

  .qm-preset-modal-header,
  .qm-preset-modal-toolbar,
  .qm-preset-edit-header,
  .qm-preset-import-header {
    border-bottom-color: var(--sd-border, #374151);
  }

  .qm-preset-search,
  .qm-preset-edit-form input,
  .qm-preset-edit-form select,
  .qm-preset-edit-form textarea,
  .qm-preset-import-textarea {
    background: var(--sd-input-bg, #374151);
    border-color: var(--sd-border, #4b5563);
  }
}
`;
}

export const PRESET_MODAL_VERSION = '2.0.0';
export const PRESET_MODAL_NAME = 'qianmu-storyboard-preset-modal';
