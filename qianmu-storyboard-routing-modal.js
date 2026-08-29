// 千幕·分镜 - 路由规则管理模态框
// 版本: 2.0.0
// 作者: Liminale
// 说明: 路由规则管理界面（场景模板 + 自定义规则）

import { ROUTING_TEMPLATES, createRoutingRule, validateRoutingRule } from './qianmu-storyboard-routing.js';

/**
 * 创建路由规则管理模态框
 * @param {Object} routingManager - 路由管理器实例
 */
export function createRoutingManagementModal(routingManager) {
  const modal = document.createElement('div');
  modal.className = 'qm-routing-modal';

  modal.innerHTML = `
    <div class="qm-routing-modal-overlay"></div>
    <div class="qm-routing-modal-container">
      <div class="qm-routing-modal-header">
        <h2>路由规则管理</h2>
        <div class="qm-routing-modal-actions">
          <button type="button" class="qm-routing-import-btn" title="导入规则">
            <i class="fa-solid fa-file-import"></i>
          </button>
          <button type="button" class="qm-routing-export-btn" title="导出规则">
            <i class="fa-solid fa-file-export"></i>
          </button>
          <button type="button" class="qm-routing-close-btn" aria-label="关闭">
            <i class="fa-solid fa-times"></i>
          </button>
        </div>
      </div>

      <div class="qm-routing-modal-toolbar">
        <button type="button" class="qm-routing-new-btn">
          <i class="fa-solid fa-plus"></i>
          新建规则
        </button>
        <select class="qm-routing-template-select">
          <option value="">应用场景模板...</option>
          ${ROUTING_TEMPLATES.map(t => `<option value="${t.id}">${t.icon} ${t.name}</option>`).join('')}
        </select>
      </div>

      <div class="qm-routing-modal-body">
        <div class="qm-routing-templates">
          <h3>场景模板（只读）</h3>
          <div class="qm-routing-template-grid"></div>
        </div>
        <div class="qm-routing-rules">
          <h3>自定义规则</h3>
          <div class="qm-routing-rule-list"></div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // 渲染模板和规则
  renderTemplates();
  renderRules();

  // 绑定事件
  modal.querySelector('.qm-routing-close-btn')?.addEventListener('click', closeModal);
  modal.querySelector('.qm-routing-modal-overlay')?.addEventListener('click', closeModal);
  modal.querySelector('.qm-routing-new-btn')?.addEventListener('click', () => openRuleEditor(null));
  modal.querySelector('.qm-routing-import-btn')?.addEventListener('click', openImportDialog);
  modal.querySelector('.qm-routing-export-btn')?.addEventListener('click', exportRules);
  modal.querySelector('.qm-routing-template-select')?.addEventListener('change', handleTemplateSelect);

  // 阻止点击容器关闭
  modal.querySelector('.qm-routing-modal-container')?.addEventListener('click', (e) => e.stopPropagation());

  // ESC 关闭
  const handleEsc = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', handleEsc);
  modal._handleEsc = handleEsc;

  function renderTemplates() {
    const grid = modal.querySelector('.qm-routing-template-grid');
    if (!grid) return;

    grid.innerHTML = ROUTING_TEMPLATES.map(template => `
      <div class="qm-routing-template-card">
        <div class="qm-routing-template-icon">${template.icon}</div>
        <h4>${escapeHtml(template.name)}</h4>
        <p>${escapeHtml(template.description)}</p>
        <div class="qm-routing-template-rules">
          <small>${template.rules.length} 条规则</small>
        </div>
      </div>
    `).join('');
  }

  function renderRules() {
    const list = modal.querySelector('.qm-routing-rule-list');
    if (!list) return;

    const rules = routingManager.getAllRules();

    if (rules.length === 0) {
      list.innerHTML = '<div class="qm-routing-empty">暂无自定义规则</div>';
      return;
    }

    list.innerHTML = rules.map(rule => `
      <div class="qm-routing-rule-card ${rule.enabled ? 'enabled' : 'disabled'}" data-rule-id="${rule.id}">
        <div class="qm-routing-rule-header">
          <div class="qm-routing-rule-info">
            <h4>${escapeHtml(rule.name)}</h4>
            <span class="qm-routing-rule-priority">优先级: ${rule.priority}</span>
          </div>
          <label class="qm-routing-rule-toggle">
            <input type="checkbox" ${rule.enabled ? 'checked' : ''} data-rule-id="${rule.id}">
            <span class="qm-routing-toggle-slider"></span>
          </label>
        </div>
        <div class="qm-routing-rule-match">
          <strong>匹配条件:</strong>
          ${rule.match.shotTypes?.length > 0
            ? `<span class="qm-routing-tag">镜头: ${rule.match.shotTypes.join(', ')}</span>`
            : '<span class="qm-routing-tag">所有镜头</span>'
          }
          ${rule.match.contentRating !== 'all'
            ? `<span class="qm-routing-tag">评级: ${rule.match.contentRating}</span>`
            : ''
          }
        </div>
        <div class="qm-routing-rule-target">
          <strong>目标配置:</strong>
          <span class="qm-routing-tag">${escapeHtml(rule.target.provider)}</span>
          <span class="qm-routing-tag">${escapeHtml(rule.target.model)}</span>
          ${rule.target.preset ? `<span class="qm-routing-tag">预设: ${escapeHtml(rule.target.preset)}</span>` : ''}
        </div>
        <div class="qm-routing-rule-actions">
          <button type="button" class="qm-routing-edit-btn" data-rule-id="${rule.id}" title="编辑">
            <i class="fa-solid fa-edit"></i>
          </button>
          <button type="button" class="qm-routing-delete-btn" data-rule-id="${rule.id}" title="删除">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `).join('');

    // 绑定切换开关
    list.querySelectorAll('.qm-routing-rule-toggle input').forEach(toggle => {
      toggle.addEventListener('change', (e) => {
        const ruleId = e.target.dataset.ruleId;
        routingManager.update(ruleId, { enabled: e.target.checked });
        renderRules();
      });
    });

    // 绑定编辑按钮
    list.querySelectorAll('.qm-routing-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ruleId = btn.dataset.ruleId;
        const rule = routingManager.rules.find(r => r.id === ruleId);
        if (rule) openRuleEditor(rule);
      });
    });

    // 绑定删除按钮
    list.querySelectorAll('.qm-routing-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ruleId = btn.dataset.ruleId;
        if (confirm('确定要删除此规则吗？')) {
          routingManager.delete(ruleId);
          renderRules();
        }
      });
    });
  }

  function handleTemplateSelect(e) {
    const templateId = e.target.value;
    if (!templateId) return;

    const template = ROUTING_TEMPLATES.find(t => t.id === templateId);
    if (!template) return;

    if (!confirm(`确定要应用"${template.name}"模板吗？这将创建 ${template.rules.length} 条新规则。`)) {
      e.target.value = '';
      return;
    }

    // 创建模板中的所有规则
    for (const ruleData of template.rules) {
      try {
        routingManager.create(ruleData);
      } catch (err) {
        console.warn('创建规则失败:', err);
      }
    }

    renderRules();
    e.target.value = '';
    alert(`成功应用模板，创建了 ${template.rules.length} 条规则`);
  }

  function openRuleEditor(rule) {
    const isEdit = rule !== null;
    const editModal = document.createElement('div');
    editModal.className = 'qm-routing-edit-dialog';

    const data = rule || {
      name: '',
      enabled: true,
      priority: 0,
      match: {
        shotTypes: [],
        contentRating: 'all',
        floorRange: null,
      },
      target: {
        provider: 'novel',
        model: '',
        preset: null,
        paramsOverride: {},
      },
    };

    editModal.innerHTML = `
      <div class="qm-routing-edit-overlay"></div>
      <div class="qm-routing-edit-container">
        <div class="qm-routing-edit-header">
          <h3>${isEdit ? '编辑规则' : '新建规则'}</h3>
          <button type="button" class="qm-routing-edit-close">
            <i class="fa-solid fa-times"></i>
          </button>
        </div>
        <form class="qm-routing-edit-form">
          <div class="qm-routing-form-row">
            <label>
              <span>规则名称 <abbr title="必填">*</abbr></span>
              <input type="text" name="name" value="${escapeHtml(data.name)}" required maxlength="60">
            </label>
            <label>
              <span>优先级</span>
              <input type="number" name="priority" value="${data.priority}" min="0" max="100">
              <small>数值越大，优先级越高</small>
            </label>
          </div>

          <fieldset>
            <legend>匹配条件</legend>

            <label>
              <span>镜头类型（逗号分隔，留空匹配所有）</span>
              <input type="text" name="shotTypes" value="${escapeHtml((data.match?.shotTypes || []).join(', '))}">
              <small>例如: portrait, closeup, environment, action</small>
            </label>

            <label>
              <span>内容评级</span>
              <select name="contentRating">
                <option value="all" ${data.match?.contentRating === 'all' ? 'selected' : ''}>所有</option>
                <option value="sfw" ${data.match?.contentRating === 'sfw' ? 'selected' : ''}>仅SFW</option>
                <option value="nsfw" ${data.match?.contentRating === 'nsfw' ? 'selected' : ''}>仅NSFW</option>
              </select>
            </label>

            <div class="qm-routing-form-row">
              <label>
                <span>楼层范围 - 最小</span>
                <input type="number" name="floorMin" value="${data.match?.floorRange?.min || ''}" placeholder="不限">
              </label>
              <label>
                <span>楼层范围 - 最大</span>
                <input type="number" name="floorMax" value="${data.match?.floorRange?.max || ''}" placeholder="不限">
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>目标配置</legend>

            <div class="qm-routing-form-row">
              <label>
                <span>供应商 <abbr title="必填">*</abbr></span>
                <select name="provider" required>
                  <option value="novel" ${data.target?.provider === 'novel' ? 'selected' : ''}>NovelAI</option>
                  <option value="stable" ${data.target?.provider === 'stable' ? 'selected' : ''}>Stable Diffusion</option>
                  <option value="comfy" ${data.target?.provider === 'comfy' ? 'selected' : ''}>ComfyUI</option>
                  <option value="banana" ${data.target?.provider === 'banana' ? 'selected' : ''}>Banana</option>
                </select>
              </label>
              <label>
                <span>模型 <abbr title="必填">*</abbr></span>
                <input type="text" name="model" value="${escapeHtml(data.target?.model || '')}" required>
              </label>
            </div>

            <label>
              <span>预设 ID（可选）</span>
              <input type="text" name="preset" value="${escapeHtml(data.target?.preset || '')}">
              <small>指定预设 ID，将应用预设的所有配置</small>
            </label>
          </fieldset>

          <div class="qm-routing-edit-actions">
            <button type="button" class="qm-routing-cancel-btn">取消</button>
            <button type="submit" class="qm-routing-save-btn">${isEdit ? '保存' : '创建'}</button>
          </div>
        </form>
      </div>
    `;

    modal.appendChild(editModal);

    const form = editModal.querySelector('.qm-routing-edit-form');
    const closeEdit = () => editModal.remove();

    editModal.querySelector('.qm-routing-edit-close')?.addEventListener('click', closeEdit);
    editModal.querySelector('.qm-routing-edit-overlay')?.addEventListener('click', closeEdit);
    editModal.querySelector('.qm-routing-cancel-btn')?.addEventListener('click', closeEdit);

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const formData = new FormData(form);

      const shotTypesStr = formData.get('shotTypes');
      const shotTypes = shotTypesStr
        ? shotTypesStr.split(',').map(s => s.trim()).filter(Boolean)
        : [];

      const floorMin = formData.get('floorMin');
      const floorMax = formData.get('floorMax');
      const floorRange = (floorMin || floorMax)
        ? {
            min: floorMin ? parseInt(floorMin) : null,
            max: floorMax ? parseInt(floorMax) : null,
          }
        : null;

      const ruleData = {
        name: formData.get('name'),
        enabled: data.enabled,
        priority: parseInt(formData.get('priority')) || 0,
        match: {
          shotTypes,
          contentRating: formData.get('contentRating'),
          floorRange,
        },
        target: {
          provider: formData.get('provider'),
          model: formData.get('model'),
          preset: formData.get('preset') || null,
          paramsOverride: {},
        },
      };

      try {
        if (isEdit) {
          routingManager.update(rule.id, ruleData);
        } else {
          routingManager.create(ruleData);
        }
        renderRules();
        closeEdit();
      } catch (error) {
        alert(`保存失败: ${error.message}`);
      }
    });
  }

  function openImportDialog() {
    const importDialog = document.createElement('div');
    importDialog.className = 'qm-routing-import-dialog';

    importDialog.innerHTML = `
      <div class="qm-routing-import-overlay"></div>
      <div class="qm-routing-import-container">
        <div class="qm-routing-import-header">
          <h3>导入路由规则</h3>
          <button type="button" class="qm-routing-import-close">
            <i class="fa-solid fa-times"></i>
          </button>
        </div>
        <div class="qm-routing-import-body">
          <textarea class="qm-routing-import-textarea" placeholder="粘贴 JSON 格式的路由规则..." rows="15"></textarea>
          <div class="qm-routing-import-actions">
            <button type="button" class="qm-routing-import-cancel">取消</button>
            <button type="button" class="qm-routing-import-confirm">导入</button>
          </div>
        </div>
      </div>
    `;

    modal.appendChild(importDialog);

    const closeImport = () => importDialog.remove();
    const textarea = importDialog.querySelector('.qm-routing-import-textarea');

    importDialog.querySelector('.qm-routing-import-close')?.addEventListener('click', closeImport);
    importDialog.querySelector('.qm-routing-import-overlay')?.addEventListener('click', closeImport);
    importDialog.querySelector('.qm-routing-import-cancel')?.addEventListener('click', closeImport);

    importDialog.querySelector('.qm-routing-import-confirm')?.addEventListener('click', () => {
      try {
        const json = textarea.value.trim();
        const data = JSON.parse(json);

        const rules = Array.isArray(data) ? data : [data];
        let imported = 0;

        for (const ruleData of rules) {
          try {
            routingManager.create(ruleData);
            imported++;
          } catch (err) {
            console.warn('导入规则失败:', err);
          }
        }

        alert(`成功导入 ${imported} 条规则`);
        renderRules();
        closeImport();
      } catch (error) {
        alert(`导入失败: ${error.message}`);
      }
    });
  }

  function exportRules() {
    const rules = routingManager.rules;
    if (rules.length === 0) {
      alert('没有可导出的规则');
      return;
    }

    const json = JSON.stringify(rules, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qianmu-routing-rules-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
 * 获取路由管理模态框样式
 * @returns {string} CSS内容
 */
export function getRoutingModalStyles() {
  return `
/* 路由规则管理模态框 */
.qm-routing-modal {
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

.qm-routing-modal-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.qm-routing-modal-container {
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

.qm-routing-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem;
  border-bottom: 1px solid var(--sd-border, #e5e7eb);
}

.qm-routing-modal-header h2 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}

.qm-routing-modal-actions {
  display: flex;
  gap: 0.5rem;
}

.qm-routing-import-btn,
.qm-routing-export-btn,
.qm-routing-close-btn {
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

.qm-routing-import-btn:hover,
.qm-routing-export-btn:hover,
.qm-routing-close-btn:hover {
  background: var(--sd-hover-bg, #f3f4f6);
  color: var(--sd-text-primary, #111827);
}

.qm-routing-modal-toolbar {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--sd-border, #e5e7eb);
  display: flex;
  gap: 1rem;
  align-items: center;
}

.qm-routing-new-btn {
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

.qm-routing-new-btn:hover {
  background: var(--sd-primary-dark, #2563eb);
}

.qm-routing-template-select {
  flex: 1;
  padding: 0.5rem 1rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.375rem;
  background: var(--sd-input-bg, #fff);
  color: var(--sd-text-primary, #111827);
  cursor: pointer;
}

.qm-routing-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.qm-routing-templates h3,
.qm-routing-rules h3 {
  margin: 0 0 1rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--sd-text-primary, #111827);
}

.qm-routing-template-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 1rem;
}

.qm-routing-template-card {
  padding: 1rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.5rem;
  background: var(--sd-bg-secondary, #f9fafb);
  text-align: center;
}

.qm-routing-template-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

.qm-routing-template-card h4 {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  font-weight: 600;
}

.qm-routing-template-card p {
  margin: 0 0 0.75rem;
  font-size: 0.75rem;
  color: var(--sd-text-secondary, #6b7280);
  line-height: 1.4;
}

.qm-routing-template-rules small {
  font-size: 0.75rem;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-routing-rule-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.qm-routing-rule-card {
  padding: 1rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.5rem;
  background: var(--sd-card-bg, #fff);
  transition: all 0.2s;
}

.qm-routing-rule-card.disabled {
  opacity: 0.6;
}

.qm-routing-rule-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.qm-routing-rule-info h4 {
  margin: 0 0 0.25rem;
  font-size: 0.875rem;
  font-weight: 600;
}

.qm-routing-rule-priority {
  font-size: 0.75rem;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-routing-rule-toggle {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 20px;
}

.qm-routing-rule-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.qm-routing-toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #ccc;
  transition: 0.2s;
  border-radius: 20px;
}

.qm-routing-toggle-slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.2s;
  border-radius: 50%;
}

.qm-routing-rule-toggle input:checked + .qm-routing-toggle-slider {
  background-color: var(--sd-primary, #3b82f6);
}

.qm-routing-rule-toggle input:checked + .qm-routing-toggle-slider:before {
  transform: translateX(20px);
}

.qm-routing-rule-match,
.qm-routing-rule-target {
  margin-bottom: 0.5rem;
  font-size: 0.75rem;
}

.qm-routing-rule-match strong,
.qm-routing-rule-target strong {
  display: inline-block;
  margin-right: 0.5rem;
  color: var(--sd-text-primary, #111827);
}

.qm-routing-tag {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  margin-right: 0.25rem;
  margin-bottom: 0.25rem;
  background: var(--sd-bg-tertiary, #f3f4f6);
  border-radius: 0.25rem;
  font-size: 0.75rem;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-routing-rule-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--sd-border, #e5e7eb);
}

.qm-routing-edit-btn,
.qm-routing-delete-btn {
  flex: 1;
  padding: 0.375rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  background: transparent;
  cursor: pointer;
  border-radius: 0.25rem;
  transition: all 0.2s;
}

.qm-routing-edit-btn:hover {
  background: var(--sd-primary, #3b82f6);
  color: white;
  border-color: var(--sd-primary, #3b82f6);
}

.qm-routing-delete-btn:hover {
  background: var(--sd-danger, #ef4444);
  color: white;
  border-color: var(--sd-danger, #ef4444);
}

.qm-routing-empty {
  padding: 2rem;
  text-align: center;
  color: var(--sd-text-secondary, #6b7280);
}

/* 编辑对话框 - 复用预设模态框的样式 */
.qm-routing-edit-dialog,
.qm-routing-import-dialog {
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

.qm-routing-edit-overlay,
.qm-routing-import-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.3);
}

.qm-routing-edit-container,
.qm-routing-import-container {
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

.qm-routing-edit-header,
.qm-routing-import-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--sd-border, #e5e7eb);
}

.qm-routing-edit-header h3,
.qm-routing-import-header h3 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
}

.qm-routing-edit-close,
.qm-routing-import-close {
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

.qm-routing-edit-form {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.qm-routing-form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
}

.qm-routing-edit-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.qm-routing-edit-form label > span {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--sd-text-primary, #111827);
}

.qm-routing-edit-form input,
.qm-routing-edit-form select,
.qm-routing-edit-form textarea {
  padding: 0.5rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.375rem;
  background: var(--sd-input-bg, #fff);
  color: var(--sd-text-primary, #111827);
}

.qm-routing-edit-form fieldset {
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.5rem;
  padding: 1rem;
}

.qm-routing-edit-form legend {
  padding: 0 0.5rem;
  font-weight: 600;
  font-size: 0.875rem;
}

.qm-routing-edit-form small {
  font-size: 0.75rem;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-routing-edit-form abbr {
  color: var(--sd-danger, #ef4444);
  text-decoration: none;
}

.qm-routing-edit-actions {
  display: flex;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--sd-border, #e5e7eb);
}

.qm-routing-cancel-btn,
.qm-routing-save-btn,
.qm-routing-import-cancel,
.qm-routing-import-confirm {
  flex: 1;
  padding: 0.625rem 1rem;
  border: 1px solid var(--sd-border, #e5e7eb);
  border-radius: 0.375rem;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.2s;
}

.qm-routing-cancel-btn,
.qm-routing-import-cancel {
  background: transparent;
  color: var(--sd-text-secondary, #6b7280);
}

.qm-routing-save-btn,
.qm-routing-import-confirm {
  background: var(--sd-primary, #3b82f6);
  color: white;
  border-color: var(--sd-primary, #3b82f6);
}

.qm-routing-save-btn:hover,
.qm-routing-import-confirm:hover {
  background: var(--sd-primary-dark, #2563eb);
}

/* 导入对话框 */
.qm-routing-import-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.qm-routing-import-textarea {
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

.qm-routing-import-actions {
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
  .qm-routing-modal-container,
  .qm-routing-rule-card,
  .qm-routing-edit-container,
  .qm-routing-import-container {
    background: var(--sd-card-bg, #1f2937);
  }

  .qm-routing-modal-header,
  .qm-routing-modal-toolbar,
  .qm-routing-edit-header,
  .qm-routing-import-header {
    border-bottom-color: var(--sd-border, #374151);
  }

  .qm-routing-template-card {
    background: var(--sd-bg-secondary, #374151);
  }

  .qm-routing-template-select,
  .qm-routing-edit-form input,
  .qm-routing-edit-form select,
  .qm-routing-edit-form textarea,
  .qm-routing-import-textarea {
    background: var(--sd-input-bg, #374151);
    border-color: var(--sd-border, #4b5563);
  }
}
`;
}

export const ROUTING_MODAL_VERSION = '2.0.0';
export const ROUTING_MODAL_NAME = 'qianmu-storyboard-routing-modal';
