// 千幕·分镜 - 配置模态框
// 版本: 2.0.0
// 作者: Liminale
// 说明: 分镜配置界面的模态框封装

import { renderStoryboardConfig, bindStoryboardConfigEvents } from './qianmu-storyboard-config-ui.js';
import { createStoryboardStorage } from './qianmu-storyboard-storage.js';
import { createArtistLibraryModal } from './qianmu-storyboard-artist-library-modal.js';

/**
 * 打开分镜配置模态框
 */
export function openStoryboardConfigModal() {
  // 创建模态框容器
  const modal = document.createElement('div');
  modal.className = 'qm-storyboard-config-modal';
  modal.innerHTML = `
    <div class="qm-storyboard-config-overlay"></div>
    <div class="qm-storyboard-config-container">
      <div class="qm-storyboard-config-header">
        <h2>分镜配置</h2>
        <button type="button" class="qm-storyboard-config-close" aria-label="关闭">
          <i class="fa-solid fa-times"></i>
        </button>
      </div>
      <div class="qm-storyboard-config-body">
        <!-- 配置内容将在这里渲染 -->
      </div>
    </div>
  `;

  // 加载配置并渲染
  const storage = createStoryboardStorage();
  const config = storage.config.getConfig();
  const configBody = modal.querySelector('.qm-storyboard-config-body');
  configBody.innerHTML = renderStoryboardConfig(config);

  // 绑定事件
  bindStoryboardConfigEvents(configBody, {
    onSave: () => {
      // 配置保存后关闭模态框
      closeConfigModal();
    },
    onOpenArtistLibrary: () => {
      // 打开画师串库管理
      openArtistLibraryFromConfig();
    }
  });

  // 关闭按钮
  modal.querySelector('.qm-storyboard-config-close')?.addEventListener('click', closeConfigModal);
  modal.querySelector('.qm-storyboard-config-overlay')?.addEventListener('click', closeConfigModal);

  // 阻止点击容器时关闭
  modal.querySelector('.qm-storyboard-config-container')?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // 添加到页面
  document.body.appendChild(modal);

  // ESC 键关闭
  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      closeConfigModal();
    }
  };
  document.addEventListener('keydown', handleEsc);
  modal._handleEsc = handleEsc;

  // 保存引用
  window._storyboardConfigModal = modal;

  function closeConfigModal() {
    if (modal._handleEsc) {
      document.removeEventListener('keydown', modal._handleEsc);
    }
    modal.remove();
    window._storyboardConfigModal = null;
  }

  function openArtistLibraryFromConfig() {
    const storage = createStoryboardStorage();
    const libraryManager = storage.artists;
    createArtistLibraryModal(libraryManager);
  }
}

/**
 * 获取配置模态框样式
 * @returns {string} CSS内容
 */
export function getStoryboardConfigModalStyles() {
  return `
/* 分镜配置模态框 */
.qm-storyboard-config-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: qm-modal-fade-in 0.2s ease-out;
}

.qm-storyboard-config-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.qm-storyboard-config-container {
  position: relative;
  width: 90%;
  max-width: 800px;
  max-height: 90vh;
  background: var(--sd-card-bg, #fff);
  border-radius: 1rem;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  display: flex;
  flex-direction: column;
  animation: qm-modal-slide-up 0.3s ease-out;
}

.qm-storyboard-config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem;
  border-bottom: 1px solid var(--sd-border, #e5e7eb);
}

.qm-storyboard-config-header h2 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--sd-text-primary, #111827);
}

.qm-storyboard-config-close {
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

.qm-storyboard-config-close:hover {
  background: var(--sd-hover-bg, #f3f4f6);
  color: var(--sd-text-primary, #111827);
}

.qm-storyboard-config-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
}

@keyframes qm-modal-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes qm-modal-slide-up {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

/* 深色模式 */
@media (prefers-color-scheme: dark) {
  .qm-storyboard-config-container {
    background: var(--sd-card-bg, #1f2937);
  }

  .qm-storyboard-config-header {
    border-bottom-color: var(--sd-border, #374151);
  }

  .qm-storyboard-config-header h2 {
    color: var(--sd-text-primary, #f9fafb);
  }

  .qm-storyboard-config-close:hover {
    background: var(--sd-hover-bg, #374151);
    color: var(--sd-text-primary, #f9fafb);
  }
}
`;
}

export const CONFIG_MODAL_VERSION = '2.0.0';
export const CONFIG_MODAL_NAME = 'qianmu-storyboard-config-modal';
