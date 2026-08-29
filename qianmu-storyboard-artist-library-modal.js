// 千幕·分镜 - 画师串库管理界面（完整模态框版本）
// 版本: 2.0.0
// 作者: Liminale
// 说明: 独立的画师串库管理模态框

import {
  renderArtistLibraryManager,
  renderArtistGrid,
  renderArtistEditForm,
  renderArtistImportDialog,
} from './qianmu-storyboard-artist-library-ui.js';

/**
 * 创建画师串库管理模态框
 * @param {Object} libraryManager - 画师串库管理器实例
 * @returns {HTMLElement} 模态框元素
 */
export function createArtistLibraryModal(libraryManager) {
  const modal = document.createElement('div');
  modal.className = 'qm-modal-overlay qm-artist-library-modal-overlay';
  modal.innerHTML = `
    <div class="qm-modal-content qm-artist-library-modal-content">
      <div class="qm-artist-library-modal">
        ${renderArtistLibraryManager(libraryManager)}
      </div>
    </div>
  `;

  // 关闭模态框
  const closeModal = () => {
    document.body.removeChild(modal);
  };

  // 点击遮罩关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  // 新建画师串
  const createBtn = modal.querySelector('.qm-artist-create-btn');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      openEditDialog(null, libraryManager, modal);
    });
  }

  // 编辑按钮
  modal.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.qm-artist-edit-btn');
    if (editBtn) {
      const artistId = editBtn.dataset.artistId;
      const artist = libraryManager.get(artistId);
      if (artist) {
        openEditDialog(artist, libraryManager, modal);
      }
    }
  });

  // 删除按钮
  modal.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.qm-artist-delete-btn');
    if (deleteBtn) {
      const artistId = deleteBtn.dataset.artistId;
      const artist = libraryManager.get(artistId);
      if (artist && confirm(`确定要删除画师串"${artist.name}"吗？`)) {
        libraryManager.delete(artistId);
        refreshModalContent(modal, libraryManager);
      }
    }
  });

  // 导入按钮
  const importBtn = modal.querySelector('.qm-artist-import-btn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      openImportDialog(libraryManager, modal);
    });
  }

  // 导出按钮
  const exportBtn = modal.querySelector('.qm-artist-export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const json = libraryManager.export();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `qianmu-artist-library-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // 搜索过滤
  const searchInput = modal.querySelector('.qm-artist-search-input');
  const categoryFilter = modal.querySelector('.qm-artist-category-filter');

  const applyFilters = () => {
    const filters = {
      search: searchInput?.value.trim() || '',
      category: categoryFilter?.value || '',
    };
    refreshModalContent(modal, libraryManager, filters);
  };

  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }

  if (categoryFilter) {
    categoryFilter.addEventListener('change', applyFilters);
  }

  return modal;
}

/**
 * 刷新模态框内容
 * @param {HTMLElement} modal - 模态框元素
 * @param {Object} libraryManager - 画师串库管理器
 * @param {Object} filters - 过滤条件
 */
function refreshModalContent(modal, libraryManager, filters = {}) {
  const container = modal.querySelector('.qm-artist-library-modal');
  if (container) {
    container.innerHTML = renderArtistLibraryManager(libraryManager);

    // 重新应用过滤
    if (filters.search || filters.category) {
      const searchInput = container.querySelector('.qm-artist-search-input');
      const categoryFilter = container.querySelector('.qm-artist-category-filter');

      if (searchInput) searchInput.value = filters.search;
      if (categoryFilter) categoryFilter.value = filters.category;

      const artists = libraryManager.getAll(filters);
      const gridContainer = container.querySelector('.qm-artist-manager-content');
      if (gridContainer) {
        gridContainer.innerHTML = renderArtistGrid(artists, { selectable: false, showActions: true });
      }
    }

    // 重新绑定事件
    bindModalEvents(modal, libraryManager);
  }
}

/**
 * 绑定模态框事件
 * @param {HTMLElement} modal - 模态框元素
 * @param {Object} libraryManager - 画师串库管理器
 */
function bindModalEvents(modal, libraryManager) {
  // 新建
  const createBtn = modal.querySelector('.qm-artist-create-btn');
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      openEditDialog(null, libraryManager, modal);
    });
  }

  // 导入
  const importBtn = modal.querySelector('.qm-artist-import-btn');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      openImportDialog(libraryManager, modal);
    });
  }

  // 导出
  const exportBtn = modal.querySelector('.qm-artist-export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const json = libraryManager.export();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `qianmu-artist-library-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // 搜索/过滤
  const searchInput = modal.querySelector('.qm-artist-search-input');
  const categoryFilter = modal.querySelector('.qm-artist-category-filter');

  const applyFilters = () => {
    const filters = {
      search: searchInput?.value.trim() || '',
      category: categoryFilter?.value || '',
    };
    refreshModalContent(modal, libraryManager, filters);
  };

  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }

  if (categoryFilter) {
    categoryFilter.addEventListener('change', applyFilters);
  }
}

/**
 * 打开编辑对话框
 * @param {Object|null} artist - 画师串对象（null表示新建）
 * @param {Object} libraryManager - 画师串库管理器
 * @param {HTMLElement} parentModal - 父模态框
 */
function openEditDialog(artist, libraryManager, parentModal) {
  const categories = libraryManager.getCategories();
  const editDialog = document.createElement('div');
  editDialog.className = 'qm-modal-overlay';
  editDialog.style.zIndex = '10001'; // 高于父模态框

  editDialog.innerHTML = `
    <div class="qm-modal-content">
      ${renderArtistEditForm(artist, categories)}
    </div>
  `;

  document.body.appendChild(editDialog);

  // 关闭对话框
  const closeDialog = () => {
    document.body.removeChild(editDialog);
  };

  const closeBtn = editDialog.querySelector('.qm-artist-form-close');
  const cancelBtn = editDialog.querySelector('.qm-artist-form-cancel-btn');

  if (closeBtn) closeBtn.addEventListener('click', closeDialog);
  if (cancelBtn) cancelBtn.addEventListener('click', closeDialog);

  // 点击遮罩关闭
  editDialog.addEventListener('click', (e) => {
    if (e.target === editDialog) {
      closeDialog();
    }
  });

  // 类别选择逻辑
  const categorySelect = editDialog.querySelector('select[name="category"]');
  const customCategoryInput = editDialog.querySelector('input[name="customCategory"]');

  if (categorySelect && customCategoryInput) {
    categorySelect.addEventListener('change', () => {
      if (categorySelect.value === '__custom__') {
        customCategoryInput.style.display = 'block';
        categorySelect.style.display = 'none';
      }
    });

    customCategoryInput.addEventListener('blur', () => {
      const value = customCategoryInput.value.trim();
      if (value) {
        // 隐藏自定义输入，显示选择框
        customCategoryInput.style.display = 'none';
        categorySelect.style.display = 'block';

        // 添加新类别选项
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        option.selected = true;
        categorySelect.insertBefore(option, categorySelect.querySelector('[value="__custom__"]'));
      }
    });
  }

  // 保存按钮
  const saveBtn = editDialog.querySelector('.qm-artist-form-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      // 收集表单数据
      const formData = {
        name: editDialog.querySelector('input[name="name"]').value.trim(),
        category: categorySelect.value === '__custom__'
          ? customCategoryInput.value.trim()
          : categorySelect.value,
        tags: editDialog.querySelector('textarea[name="tags"]').value.trim(),
        preview: editDialog.querySelector('input[name="preview"]').value.trim(),
        description: editDialog.querySelector('textarea[name="description"]').value.trim(),
        provider: editDialog.querySelector('select[name="provider"]').value,
        suggestedFor: Array.from(editDialog.querySelectorAll('input[name="suggestedFor"]:checked'))
          .map(input => input.value),
      };

      // 验证
      if (!formData.name) {
        alert('请输入名称');
        return;
      }

      if (!formData.tags) {
        alert('请输入画师串标签');
        return;
      }

      if (!formData.category) {
        alert('请选择或输入类别');
        return;
      }

      // 保存
      if (artist) {
        libraryManager.update(artist.id, formData);
      } else {
        libraryManager.create(formData);
      }

      // 刷新父模态框
      refreshModalContent(parentModal, libraryManager);

      closeDialog();
    });
  }
}

/**
 * 打开导入对话框
 * @param {Object} libraryManager - 画师串库管理器
 * @param {HTMLElement} parentModal - 父模态框
 */
function openImportDialog(libraryManager, parentModal) {
  const importDialog = document.createElement('div');
  importDialog.className = 'qm-modal-overlay';
  importDialog.style.zIndex = '10001';

  importDialog.innerHTML = `
    <div class="qm-modal-content">
      ${renderArtistImportDialog()}
    </div>
  `;

  document.body.appendChild(importDialog);

  // 关闭对话框
  const closeDialog = () => {
    document.body.removeChild(importDialog);
  };

  const closeBtn = importDialog.querySelector('.qm-artist-dialog-close');
  const cancelBtn = importDialog.querySelector('.qm-artist-dialog-cancel-btn');

  if (closeBtn) closeBtn.addEventListener('click', closeDialog);
  if (cancelBtn) cancelBtn.addEventListener('click', closeDialog);

  // 点击遮罩关闭
  importDialog.addEventListener('click', (e) => {
    if (e.target === importDialog) {
      closeDialog();
    }
  });

  // 标签页切换
  const tabs = importDialog.querySelectorAll('.qm-artist-import-tab');
  const tabContents = importDialog.querySelectorAll('.qm-artist-import-tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('qm-artist-import-tab-active'));
      tab.classList.add('qm-artist-import-tab-active');

      const targetTab = tab.dataset.tab;
      tabContents.forEach(content => {
        content.style.display = content.classList.contains(`qm-artist-import-tab-${targetTab}`)
          ? 'block'
          : 'none';
      });
    });
  });

  // 预设数据源按钮
  const presetBtn = importDialog.querySelector('.qm-artist-import-preset-btn');
  const urlInput = importDialog.querySelector('input[name="importUrl"]');

  if (presetBtn && urlInput) {
    presetBtn.addEventListener('click', () => {
      urlInput.value = presetBtn.dataset.url;
    });
  }

  // 导入按钮
  const importBtn = importDialog.querySelector('.qm-artist-dialog-import-btn');
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      const activeTab = importDialog.querySelector('.qm-artist-import-tab-active').dataset.tab;
      const resultDiv = importDialog.querySelector('.qm-artist-import-result');
      const statusDiv = importDialog.querySelector('.qm-artist-import-status');

      let result;

      if (activeTab === 'url') {
        const url = urlInput.value.trim();
        if (!url) {
          alert('请输入数据源URL');
          return;
        }
        result = await libraryManager.importFromURL(url);
      } else {
        const json = importDialog.querySelector('textarea[name="importJson"]').value.trim();
        if (!json) {
          alert('请输入JSON数据');
          return;
        }
        result = libraryManager.importFromJSON(json);
      }

      // 显示结果
      resultDiv.style.display = 'block';
      if (result.success) {
        statusDiv.innerHTML = `成功导入 ${result.imported} 个画师串`;
        statusDiv.style.color = '#4caf50';
      } else {
        statusDiv.innerHTML = `导入失败：${result.errors.join('、')}`;
        statusDiv.style.color = '#f44336';
      }

      if (result.success) {
        // 刷新父模态框
        refreshModalContent(parentModal, libraryManager);

        // 2秒后关闭
        setTimeout(closeDialog, 2000);
      }
    });
  }
}

export const ARTIST_LIBRARY_MODAL_VERSION = '2.0.0';
export const ARTIST_LIBRARY_MODAL_NAME = 'qianmu-storyboard-artist-library-modal';
