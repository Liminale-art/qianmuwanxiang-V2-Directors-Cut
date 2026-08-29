// 千幕·分镜 - 配置界面
// 版本: 2.0.0
// 作者: Liminale
// 说明: 分镜配置面板UI

/**
 * 渲染分镜配置区域
 * @param {Object} config - 配置对象
 * @returns {string} HTML字符串
 */
export function renderStoryboardConfig(config = {}) {
  const {
    imagesPerFloor = 4,
    maxConcurrent = 1,
    autoCapture = false,
    defaultProvider = 'novel',
    defaultModel = 'nai-diffusion-5-full',
  } = config;

  const providers = [
    { id: 'novel', label: 'NovelAI' },
    { id: 'banana', label: 'Banana' },
    { id: 'openai', label: 'OpenAI' },
  ];

  return `
    <section class="sd-card sd-storyboard-config-section">
      <div class="sd-storyboard-config-header">
        <h3>分镜配置</h3>
        <small>镜组未启用时的默认行为</small>
      </div>

      <div class="sd-storyboard-config-body">
        <!-- 一层楼画面数 -->
        <div class="sd-form-group">
          <label for="qm-storyboard-images-per-floor">
            一层楼生成画面数
            <small>点击"取景"后自动生成的镜头卡片数量</small>
          </label>
          <input
            type="number"
            id="qm-storyboard-images-per-floor"
            class="sd-input"
            min="1"
            max="10"
            value="${imagesPerFloor}"
            data-config-key="imagesPerFloor"
          />
        </div>

        <!-- 并发数 -->
        <div class="sd-form-group">
          <label for="qm-storyboard-max-concurrent">
            并发生成数
            <small>同时生成图片的最大数量</small>
          </label>
          <input
            type="number"
            id="qm-storyboard-max-concurrent"
            class="sd-input"
            min="1"
            max="5"
            value="${maxConcurrent}"
            data-config-key="maxConcurrent"
          />
        </div>

        <!-- 自动取景 -->
        <div class="sd-form-group">
          <label>
            <input
              type="checkbox"
              id="qm-storyboard-auto-capture"
              ${autoCapture ? 'checked' : ''}
              data-config-key="autoCapture"
            />
            <span>自动取景</span>
            <small>新消息到达时自动分析并生成镜头卡片</small>
          </label>
        </div>

        <!-- 默认供应商 -->
        <div class="sd-form-group">
          <label for="qm-storyboard-default-provider">
            默认供应商
            <small>未指定供应商时使用的默认值</small>
          </label>
          <select
            id="qm-storyboard-default-provider"
            class="sd-select"
            data-config-key="defaultProvider"
          >
            ${providers.map(p => `
              <option value="${p.id}" ${p.id === defaultProvider ? 'selected' : ''}>
                ${p.label}
              </option>
            `).join('')}
          </select>
        </div>

        <!-- 默认模型 -->
        <div class="sd-form-group">
          <label for="qm-storyboard-default-model">
            默认模型
            <small>未指定模型时使用的默认值</small>
          </label>
          <input
            type="text"
            id="qm-storyboard-default-model"
            class="sd-input"
            value="${defaultModel}"
            data-config-key="defaultModel"
            placeholder="例如: nai-diffusion-5-full"
          />
        </div>
      </div>

      <div class="sd-storyboard-config-footer">
        <button type="button" class="sd-btn sd-storyboard-save-config">保存配置</button>
        <button type="button" class="sd-btn sd-btn-secondary sd-storyboard-reset-config">恢复默认</button>
      </div>
    </section>

    <section class="sd-card sd-storyboard-management-section">
      <div class="sd-storyboard-management-header">
        <h3>管理工具</h3>
      </div>

      <div class="sd-storyboard-management-body">
        <button type="button" class="sd-btn sd-btn-block sd-storyboard-manage-artists">
          <i class="fa-solid fa-palette"></i>
          <span>管理画师串库</span>
        </button>

        <button type="button" class="sd-btn sd-btn-block sd-storyboard-manage-presets">
          <i class="fa-solid fa-sliders"></i>
          <span>管理预设</span>
        </button>

        <button type="button" class="sd-btn sd-btn-block sd-storyboard-manage-routing">
          <i class="fa-solid fa-route"></i>
          <span>管理路由规则</span>
        </button>
      </div>
    </section>
  `;
}

/**
 * 获取配置样式
 * @returns {string} CSS字符串
 */
export function getStoryboardConfigStyles() {
  return `
    .sd-storyboard-config-section,
    .sd-storyboard-management-section {
      margin-bottom: 20px;
    }

    .sd-storyboard-config-header,
    .sd-storyboard-management-header {
      margin-bottom: 16px;
    }

    .sd-storyboard-config-header h3,
    .sd-storyboard-management-header h3 {
      margin: 0 0 4px;
      font-size: 16px;
      color: var(--SmartThemeBodyColor, #fff);
    }

    .sd-storyboard-config-header small {
      font-size: 12px;
      color: var(--SmartThemeQuoteColor, rgba(255, 255, 255, 0.6));
    }

    .sd-storyboard-config-body {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .sd-form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .sd-form-group label {
      font-size: 13px;
      font-weight: 500;
      color: var(--SmartThemeBodyColor, #fff);
    }

    .sd-form-group label small {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      font-weight: normal;
      color: var(--SmartThemeQuoteColor, rgba(255, 255, 255, 0.5));
    }

    .sd-form-group input[type="checkbox"] {
      margin-right: 8px;
      cursor: pointer;
    }

    .sd-input,
    .sd-select {
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
      border-radius: 4px;
      color: var(--SmartThemeBodyColor, #fff);
      font-size: 13px;
    }

    .sd-input:focus,
    .sd-select:focus {
      outline: none;
      border-color: var(--SmartThemeHighlightColor, rgba(74, 158, 255, 0.5));
    }

    .sd-storyboard-config-footer {
      display: flex;
      gap: 12px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
    }

    .sd-btn {
      padding: 8px 16px;
      font-size: 13px;
      border-radius: 4px;
      border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
      background: rgba(74, 158, 255, 0.2);
      color: #4a9eff;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .sd-btn:hover {
      background: rgba(74, 158, 255, 0.3);
    }

    .sd-btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      color: var(--SmartThemeBodyColor, #fff);
    }

    .sd-btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .sd-storyboard-management-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .sd-btn-block {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .sd-btn-block i {
      font-size: 14px;
    }
  `;
}

/**
 * 绑定配置事件
 * @param {HTMLElement} container - 容器元素
 * @param {Object} storage - 存储实例
 * @param {Function} onSave - 保存回调
 */
export function bindStoryboardConfigEvents(container, storage, onSave) {
  if (!container) return;

  // 保存配置
  const saveBtn = container.querySelector('.sd-storyboard-save-config');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const config = {};
      container.querySelectorAll('[data-config-key]').forEach(field => {
        const key = field.dataset.configKey;
        if (field.type === 'checkbox') {
          config[key] = field.checked;
        } else if (field.type === 'number') {
          config[key] = parseInt(field.value, 10);
        } else {
          config[key] = field.value;
        }
      });

      storage.config.updateConfig(config);

      if (onSave) onSave(config);

      // 显示保存成功提示
      if (window.toastr || window.toast) {
        (window.toastr || window.toast)('配置已保存', 'success');
      }
    });
  }

  // 恢复默认
  const resetBtn = container.querySelector('.sd-storyboard-reset-config');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (!confirm('确定要恢复默认配置吗？')) return;

      const defaultConfig = {
        imagesPerFloor: 4,
        maxConcurrent: 1,
        autoCapture: false,
        defaultProvider: 'novel',
        defaultModel: 'nai-diffusion-5-full',
      };

      storage.config.saveConfig(defaultConfig);

      // 更新UI
      container.querySelectorAll('[data-config-key]').forEach(field => {
        const key = field.dataset.configKey;
        if (field.type === 'checkbox') {
          field.checked = defaultConfig[key];
        } else {
          field.value = defaultConfig[key];
        }
      });

      if (window.toastr || window.toast) {
        (window.toastr || window.toast)('已恢复默认配置', 'info');
      }
    });
  }

  // 管理画师串库
  const manageArtistsBtn = container.querySelector('.sd-storyboard-manage-artists');
  if (manageArtistsBtn) {
    manageArtistsBtn.addEventListener('click', async () => {
      const { createArtistLibraryModal } = await import('./qianmu-storyboard-artist-library-modal.js');
      const { ArtistLibraryManager } = await import('./qianmu-storyboard-artist-library.js');

      const libraryManager = new ArtistLibraryManager(storage.userArtists);
      const modal = createArtistLibraryModal(libraryManager);
      document.body.appendChild(modal);
    });
  }

  // 管理预设
  const managePresetsBtn = container.querySelector('.sd-storyboard-manage-presets');
  if (managePresetsBtn) {
    managePresetsBtn.addEventListener('click', async () => {
      const { createPresetManagementModal } = await import('./qianmu-storyboard-preset-modal.js');
      const { PresetManager } = await import('./qianmu-storyboard-presets.js');

      const presetManager = new PresetManager(storage.userPresets);
      createPresetManagementModal(presetManager);
    });
  }

  // 管理路由规则
  const manageRoutingBtn = container.querySelector('.sd-storyboard-manage-routing');
  if (manageRoutingBtn) {
    manageRoutingBtn.addEventListener('click', async () => {
      const { createRoutingManagementModal } = await import('./qianmu-storyboard-routing-modal.js');
      const { RoutingManager } = await import('./qianmu-storyboard-routing.js');

      const routingManager = new RoutingManager(storage.routingRules);
      createRoutingManagementModal(routingManager);
    });
  }
}

export const STORYBOARD_CONFIG_UI_VERSION = '2.0.0';
export const STORYBOARD_CONFIG_UI_NAME = 'qianmu-storyboard-config-ui';
