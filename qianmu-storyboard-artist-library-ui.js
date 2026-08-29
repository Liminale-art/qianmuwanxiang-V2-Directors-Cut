// 千幕·分镜 - 画师串库可视化界面
// 版本: 2.0.0
// 作者: Liminale
// 说明: 画师串可视化卡片、选择器、快速跳转

import { BUILTIN_ARTISTS } from './qianmu-storyboard-artist-library.js';

/**
 * 渲染画师串卡片
 * @param {Object} artist - 画师串对象
 * @param {Object} options - 渲染选项
 * @returns {string} HTML字符串
 */
export function renderArtistCard(artist, options = {}) {
  const { selectable = false, selected = false, showActions = true } = options;

  const previewHTML = artist.preview
    ? `<img src="${artist.preview}" alt="${artist.name}" class="qm-artist-preview" />`
    : `<div class="qm-artist-preview-placeholder">
         <div class="qm-artist-preview-icon">暂无预览</div>
       </div>`;

  const selectableClass = selectable ? 'qm-artist-card-selectable' : '';
  const selectedClass = selected ? 'qm-artist-card-selected' : '';
  const builtinBadge = artist.builtin
    ? '<span class="qm-artist-badge qm-artist-badge-builtin">内置</span>'
    : '';
  const importedBadge = artist.imported
    ? '<span class="qm-artist-badge qm-artist-badge-imported">导入</span>'
    : '';

  const suggestedForHTML = artist.suggestedFor && artist.suggestedFor.length > 0
    ? `<div class="qm-artist-suggested">
         适用: ${artist.suggestedFor.map(type => `<span class="qm-artist-tag">${type}</span>`).join(' ')}
       </div>`
    : '';

  const actionsHTML = showActions && !artist.builtin
    ? `<div class="qm-artist-actions">
         <button class="qm-artist-action-btn qm-artist-edit-btn" data-artist-id="${artist.id}" title="编辑">
           编辑
         </button>
         <button class="qm-artist-action-btn qm-artist-delete-btn" data-artist-id="${artist.id}" title="删除">
           删除
         </button>
       </div>`
    : '';

  return `
    <div class="qm-artist-card ${selectableClass} ${selectedClass}" data-artist-id="${artist.id}">
      <div class="qm-artist-preview-container">
        ${previewHTML}
        <div class="qm-artist-badges">
          ${builtinBadge}
          ${importedBadge}
        </div>
      </div>
      <div class="qm-artist-info">
        <div class="qm-artist-header">
          <h4 class="qm-artist-name" title="${artist.name}">${artist.name}</h4>
          <span class="qm-artist-category">${artist.category}</span>
        </div>
        ${artist.description ? `<p class="qm-artist-description">${artist.description}</p>` : ''}
        <div class="qm-artist-tags-preview" title="${artist.tags}">
          ${artist.tags.substring(0, 60)}${artist.tags.length > 60 ? '...' : ''}
        </div>
        ${suggestedForHTML}
      </div>
      ${actionsHTML}
    </div>
  `;
}

/**
 * 渲染画师串网格
 * @param {Object[]} artists - 画师串列表
 * @param {Object} options - 渲染选项
 * @returns {string} HTML字符串
 */
export function renderArtistGrid(artists, options = {}) {
  if (!artists || artists.length === 0) {
    return '<div class="qm-artist-empty">暂无画师串</div>';
  }

  const cardsHTML = artists.map(artist => renderArtistCard(artist, options)).join('');

  return `
    <div class="qm-artist-grid">
      ${cardsHTML}
    </div>
  `;
}

/**
 * 渲染画师串选择器界面
 * @param {Object} libraryManager - 画师串库管理器实例
 * @param {Object} options - 选项
 * @returns {string} HTML字符串
 */
export function renderArtistSelector(libraryManager, options = {}) {
  const {
    title = '选择画师串',
    filters = {},
    selectedId = null,
  } = options;

  const categories = libraryManager.getCategories();
  const artists = libraryManager.getAll(filters);

  const categoryOptions = categories.map(cat => {
    const selected = filters.category === cat ? 'selected' : '';
    return `<option value="${cat}" ${selected}>${cat}</option>`;
  }).join('');

  return `
    <div class="qm-artist-selector">
      <div class="qm-artist-selector-header">
        <h3>${title}</h3>
        <button class="qm-artist-selector-close" title="关闭">×</button>
      </div>

      <div class="qm-artist-selector-filters">
        <div class="qm-artist-filter-group">
          <label>搜索:</label>
          <input
            type="text"
            class="qm-artist-search-input"
            placeholder="输入画师串名称或标签..."
            value="${filters.search || ''}"
          />
        </div>

        <div class="qm-artist-filter-group">
          <label>类别:</label>
          <select class="qm-artist-category-filter">
            <option value="">全部类别</option>
            ${categoryOptions}
          </select>
        </div>

        <div class="qm-artist-filter-group">
          <label>供应商:</label>
          <select class="qm-artist-provider-filter">
            <option value="">全部</option>
            <option value="novel" ${filters.provider === 'novel' ? 'selected' : ''}>NovelAI</option>
            <option value="banana" ${filters.provider === 'banana' ? 'selected' : ''}>Banana</option>
          </select>
        </div>
      </div>

      <div class="qm-artist-selector-content">
        ${renderArtistGrid(artists, { selectable: true, selected: false, showActions: false })}
      </div>

      <div class="qm-artist-selector-footer">
        <button class="qm-artist-import-btn">导入画师串</button>
        <button class="qm-artist-create-btn">新建画师串</button>
        <div class="qm-artist-selector-actions">
          <button class="qm-artist-cancel-btn">取消</button>
          <button class="qm-artist-confirm-btn" disabled>确认选择</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * 渲染画师串管理界面
 * @param {Object} libraryManager - 画师串库管理器实例
 * @returns {string} HTML字符串
 */
export function renderArtistLibraryManager(libraryManager) {
  const categories = libraryManager.getCategories();
  const artists = libraryManager.getAll();

  const categoryOptions = categories.map(cat =>
    `<option value="${cat}">${cat}</option>`
  ).join('');

  const statsHTML = `
    <div class="qm-artist-stats">
      <span>内置: ${BUILTIN_ARTISTS.length}</span>
      <span>用户: ${libraryManager.userArtists.length}</span>
      <span>总计: ${artists.length}</span>
    </div>
  `;

  return `
    <div class="qm-artist-library-manager">
      <div class="qm-artist-manager-header">
        <h3>画师串库管理</h3>
        ${statsHTML}
      </div>

      <div class="qm-artist-manager-toolbar">
        <div class="qm-artist-filter-group">
          <input
            type="text"
            class="qm-artist-search-input"
            placeholder="搜索画师串..."
          />
        </div>

        <div class="qm-artist-filter-group">
          <select class="qm-artist-category-filter">
            <option value="">全部类别</option>
            ${categoryOptions}
          </select>
        </div>

        <div class="qm-artist-manager-actions">
          <button class="qm-artist-create-btn">新建</button>
          <button class="qm-artist-import-btn">导入</button>
          <button class="qm-artist-export-btn">导出</button>
        </div>
      </div>

      <div class="qm-artist-manager-content">
        ${renderArtistGrid(artists, { selectable: false, showActions: true })}
      </div>
    </div>
  `;
}

/**
 * 渲染画师串编辑表单
 * @param {Object|null} artist - 画师串对象（null表示新建）
 * @param {string[]} categories - 类别列表
 * @returns {string} HTML字符串
 */
export function renderArtistEditForm(artist = null, categories = []) {
  const isEdit = artist !== null;
  const title = isEdit ? '编辑画师串' : '新建画师串';

  const categoryOptions = categories.map(cat => {
    const selected = artist && artist.category === cat ? 'selected' : '';
    return `<option value="${cat}" ${selected}>${cat}</option>`;
  }).join('');

  return `
    <div class="qm-artist-edit-form">
      <div class="qm-artist-form-header">
        <h3>${title}</h3>
        <button class="qm-artist-form-close" title="关闭">×</button>
      </div>

      <div class="qm-artist-form-content">
        <div class="qm-artist-form-group">
          <label>名称 *</label>
          <input
            type="text"
            class="qm-artist-form-input"
            name="name"
            value="${artist ? artist.name : ''}"
            placeholder="例如: 柔和水彩风"
            required
          />
        </div>

        <div class="qm-artist-form-group">
          <label>类别 *</label>
          <div class="qm-artist-form-category-wrapper">
            <select class="qm-artist-form-select" name="category">
              <option value="">选择类别</option>
              ${categoryOptions}
              <option value="__custom__">自定义类别...</option>
            </select>
            <input
              type="text"
              class="qm-artist-form-input qm-artist-form-custom-category"
              name="customCategory"
              placeholder="输入新类别"
              style="display: none;"
            />
          </div>
        </div>

        <div class="qm-artist-form-group">
          <label>画师串标签 *</label>
          <textarea
            class="qm-artist-form-textarea"
            name="tags"
            rows="3"
            placeholder="例如: watercolor, soft colors, gentle lighting, pastel tones"
            required
          >${artist ? artist.tags : ''}</textarea>
          <small>这是实际使用的画师串标签，逗号分隔</small>
        </div>

        <div class="qm-artist-form-group">
          <label>预览图URL</label>
          <input
            type="url"
            class="qm-artist-form-input"
            name="preview"
            value="${artist ? artist.preview : ''}"
            placeholder="https://example.com/preview.jpg"
          />
          <small>支持图片URL，留空则显示占位符</small>
        </div>

        <div class="qm-artist-form-group">
          <label>描述</label>
          <textarea
            class="qm-artist-form-textarea"
            name="description"
            rows="2"
            placeholder="简要描述这个画师串的风格特点"
          >${artist ? artist.description : ''}</textarea>
        </div>

        <div class="qm-artist-form-group">
          <label>适用镜头类型</label>
          <div class="qm-artist-form-checkbox-group">
            <label><input type="checkbox" name="suggestedFor" value="portrait" ${artist && artist.suggestedFor.includes('portrait') ? 'checked' : ''}> 人物</label>
            <label><input type="checkbox" name="suggestedFor" value="closeup" ${artist && artist.suggestedFor.includes('closeup') ? 'checked' : ''}> 特写</label>
            <label><input type="checkbox" name="suggestedFor" value="group" ${artist && artist.suggestedFor.includes('group') ? 'checked' : ''}> 群像</label>
            <label><input type="checkbox" name="suggestedFor" value="environment" ${artist && artist.suggestedFor.includes('environment') ? 'checked' : ''}> 环境</label>
            <label><input type="checkbox" name="suggestedFor" value="object" ${artist && artist.suggestedFor.includes('object') ? 'checked' : ''}> 物体</label>
            <label><input type="checkbox" name="suggestedFor" value="action" ${artist && artist.suggestedFor.includes('action') ? 'checked' : ''}> 动作</label>
          </div>
        </div>

        <div class="qm-artist-form-group">
          <label>供应商</label>
          <select class="qm-artist-form-select" name="provider">
            <option value="novel" ${artist && artist.provider === 'novel' ? 'selected' : ''}>NovelAI</option>
            <option value="banana" ${artist && artist.provider === 'banana' ? 'selected' : ''}>Banana</option>
            <option value="openai" ${artist && artist.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
          </select>
        </div>
      </div>

      <div class="qm-artist-form-footer">
        <button class="qm-artist-form-cancel-btn">取消</button>
        <button class="qm-artist-form-save-btn">保存</button>
      </div>
    </div>
  `;
}

/**
 * 创建画师串选择器模态框
 * @param {Object} libraryManager - 画师串库管理器实例
 * @param {Function} onSelect - 选择回调函数
 * @param {Object} options - 选项
 * @returns {HTMLElement} 模态框DOM元素
 */
export function createArtistSelectorModal(libraryManager, onSelect, options = {}) {
  const modal = document.createElement('div');
  modal.className = 'qm-artist-modal-overlay';
  modal.innerHTML = `
    <div class="qm-artist-modal">
      ${renderArtistSelector(libraryManager, options)}
    </div>
  `;

  let selectedArtist = null;
  const confirmBtn = modal.querySelector('.qm-artist-confirm-btn');

  // 卡片选择
  modal.addEventListener('click', (e) => {
    const card = e.target.closest('.qm-artist-card-selectable');
    if (card) {
      // 清除其他选中状态
      modal.querySelectorAll('.qm-artist-card').forEach(c => c.classList.remove('qm-artist-card-selected'));
      card.classList.add('qm-artist-card-selected');

      selectedArtist = libraryManager.get(card.dataset.artistId);
      confirmBtn.disabled = false;
    }
  });

  // 搜索过滤
  const searchInput = modal.querySelector('.qm-artist-search-input');
  const categoryFilter = modal.querySelector('.qm-artist-category-filter');
  const providerFilter = modal.querySelector('.qm-artist-provider-filter');

  const applyFilters = () => {
    const filters = {
      search: searchInput.value.trim(),
      category: categoryFilter.value,
      provider: providerFilter.value,
    };

    const artists = libraryManager.getAll(filters);
    const content = modal.querySelector('.qm-artist-selector-content');
    content.innerHTML = renderArtistGrid(artists, { selectable: true, showActions: false });

    selectedArtist = null;
    confirmBtn.disabled = true;
  };

  searchInput.addEventListener('input', applyFilters);
  categoryFilter.addEventListener('change', applyFilters);
  providerFilter.addEventListener('change', applyFilters);

  // 确认选择
  confirmBtn.addEventListener('click', () => {
    if (selectedArtist && onSelect) {
      onSelect(selectedArtist);
    }
    document.body.removeChild(modal);
  });

  // 取消
  modal.querySelector('.qm-artist-cancel-btn').addEventListener('click', () => {
    document.body.removeChild(modal);
  });

  modal.querySelector('.qm-artist-selector-close').addEventListener('click', () => {
    document.body.removeChild(modal);
  });

  // 点击遮罩关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
    }
  });

  return modal;
}

/**
 * 注入"选择画师串"快速跳转按钮
 * @param {HTMLElement} container - 目标容器（画师串输入框旁）
 * @param {Object} libraryManager - 画师串库管理器实例
 * @param {Function} onSelect - 选择回调函数
 */
export function injectArtistQuickJump(container, libraryManager, onSelect) {
  if (!container) return;

  const existingBtn = container.querySelector('.qm-artist-quick-jump-btn');
  if (existingBtn) return; // 已存在，避免重复注入

  const btn = document.createElement('button');
  btn.className = 'qm-artist-quick-jump-btn';
  btn.textContent = '选择画师串';
  btn.title = '从画师串库选择';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const modal = createArtistSelectorModal(libraryManager, onSelect);
    document.body.appendChild(modal);
  });

  container.appendChild(btn);
}

/**
 * 渲染画师串导入对话框
 * @returns {string} HTML字符串
 */
export function renderArtistImportDialog() {
  return `
    <div class="qm-artist-import-dialog">
      <div class="qm-artist-dialog-header">
        <h3>导入画师串</h3>
        <button class="qm-artist-dialog-close" title="关闭">×</button>
      </div>

      <div class="qm-artist-dialog-content">
        <div class="qm-artist-import-tabs">
          <button class="qm-artist-import-tab qm-artist-import-tab-active" data-tab="url">从URL导入</button>
          <button class="qm-artist-import-tab" data-tab="json">从JSON导入</button>
        </div>

        <div class="qm-artist-import-tab-content qm-artist-import-tab-url">
          <div class="qm-artist-form-group">
            <label>数据源URL</label>
            <input
              type="url"
              class="qm-artist-form-input"
              name="importUrl"
              placeholder="https://example.com/artists.json"
            />
            <small>支持标准格式的JSON数据源</small>
          </div>
          <div class="qm-artist-form-group">
            <label>推荐数据源</label>
            <div class="qm-artist-import-presets">
              <button class="qm-artist-import-preset-btn" data-url="https://hsk-8e4.pages.dev/">HSK画师库</button>
            </div>
          </div>
        </div>

        <div class="qm-artist-import-tab-content qm-artist-import-tab-json" style="display: none;">
          <div class="qm-artist-form-group">
            <label>JSON数据</label>
            <textarea
              class="qm-artist-form-textarea"
              name="importJson"
              rows="10"
              placeholder='{"version": "2.0.0", "artists": [...]}'
            ></textarea>
          </div>
        </div>

        <div class="qm-artist-import-result" style="display: none;">
          <div class="qm-artist-import-status"></div>
        </div>
      </div>

      <div class="qm-artist-dialog-footer">
        <button class="qm-artist-dialog-cancel-btn">取消</button>
        <button class="qm-artist-dialog-import-btn">开始导入</button>
      </div>
    </div>
  `;
}

export const ARTIST_LIBRARY_UI_VERSION = '2.0.0';
export const ARTIST_LIBRARY_UI_NAME = 'qianmu-storyboard-artist-library-ui';
