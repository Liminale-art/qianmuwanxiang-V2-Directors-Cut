// 千幕·分镜 - 样式注入器
// 版本: 2.0.0
// 作者: Liminale
// 说明: 动态注入分镜模块样式表

/**
 * 注入分镜样式表
 * @param {string} cssContent - CSS内容
 * @param {string} styleId - 样式表ID
 * @returns {boolean} 是否注入成功
 */
export function injectStoryboardStyles(cssContent, styleId = 'qianmu-storyboard-styles') {
  if (!cssContent || typeof cssContent !== 'string') {
    console.warn('[Qianmu Storyboard] Invalid CSS content');
    return false;
  }

  // 检查是否已存在
  let style = document.getElementById(styleId);
  if (style) {
    // 已存在，更新内容
    style.textContent = cssContent;
    return true;
  }

  // 创建新样式表
  style = document.createElement('style');
  style.id = styleId;
  style.textContent = cssContent;
  document.head.appendChild(style);

  return true;
}

/**
 * 移除分镜样式表
 * @param {string} styleId - 样式表ID
 * @returns {boolean} 是否移除成功
 */
export function removeStoryboardStyles(styleId = 'qianmu-storyboard-styles') {
  const style = document.getElementById(styleId);
  if (style) {
    style.remove();
    return true;
  }
  return false;
}

/**
 * 加载并注入CSS文件
 * @param {string} cssUrl - CSS文件URL
 * @param {string} styleId - 样式表ID
 * @returns {Promise<boolean>} 是否注入成功
 */
export async function loadAndInjectStyles(cssUrl, styleId = 'qianmu-storyboard-styles') {
  try {
    const response = await fetch(cssUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch CSS: ${response.statusText}`);
    }

    const cssContent = await response.text();
    return injectStoryboardStyles(cssContent, styleId);
  } catch (error) {
    console.error('[Qianmu Storyboard] Failed to load styles:', error);
    return false;
  }
}

/**
 * 注入镜头卡片样式
 * @returns {Promise<boolean>} 是否注入成功
 */
export async function injectShotCardStyles() {
  try {
    const { getShotCardStyles } = await import('./qianmu-storyboard-frame-ui.js');
    const cssContent = getShotCardStyles();
    return injectStoryboardStyles(cssContent, 'qianmu-shot-card-styles');
  } catch (error) {
    console.error('[Qianmu Storyboard] Failed to inject shot card styles:', error);
    return false;
  }
}

/**
 * 注入编辑面板样式
 * @returns {Promise<boolean>} 是否注入成功
 */
export async function injectShotEditPanelStyles() {
  try {
    const { getShotEditPanelStyles } = await import('./qianmu-storyboard-shot-edit-panel.js');
    const cssContent = getShotEditPanelStyles();
    return injectStoryboardStyles(cssContent, 'qianmu-shot-edit-panel-styles');
  } catch (error) {
    console.error('[Qianmu Storyboard] Failed to inject shot edit panel styles:', error);
    return false;
  }
}

/**
 * 注入配置界面样式
 * @returns {Promise<boolean>} 是否注入成功
 */
export async function injectConfigUIStyles() {
  try {
    const { getStoryboardConfigStyles } = await import('./qianmu-storyboard-config-ui.js');
    const cssContent = getStoryboardConfigStyles();
    return injectStoryboardStyles(cssContent, 'qianmu-storyboard-config-ui-styles');
  } catch (error) {
    console.error('[Qianmu Storyboard] Failed to inject config UI styles:', error);
    return false;
  }
}

/**
 * 注入所有分镜相关样式
 * @param {string} baseUrl - 基础URL路径
 * @returns {Promise<Object>} 注入结果
 */
export async function injectAllStoryboardStyles(baseUrl = '') {
  const result = {
    frame: false,
    editPanel: false,
    configUI: false,
    artist: false,
  };

  try {
    // 注入镜头卡片样式
    result.frame = await injectShotCardStyles();

    // 注入编辑面板样式
    result.editPanel = await injectShotEditPanelStyles();

    // 注入配置界面样式
    result.configUI = await injectConfigUIStyles();

    // 注入画师串库样式
    const artistCssUrl = baseUrl
      ? `${baseUrl}/qianmu-storyboard-artist-library.css`
      : new URL('./qianmu-storyboard-artist-library.css', import.meta.url).href;

    result.artist = await loadAndInjectStyles(artistCssUrl, 'qianmu-storyboard-artist-styles');

    // 注入配置按钮样式
    const headerToolsStyles = `
.sd-storyboard-header-tools {
  position: absolute;
  top: 0;
  right: 0;
  padding: 1rem;
  z-index: 10;
}

.sd-storyboard-config-btn {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 0.5rem;
  background: var(--sd-card-bg, #fff);
  border: 1px solid var(--sd-border, #e5e7eb);
  color: var(--sd-text-secondary, #6b7280);
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sd-storyboard-config-btn:hover {
  background: var(--sd-hover-bg, #f9fafb);
  color: var(--sd-primary, #3b82f6);
  border-color: var(--sd-primary, #3b82f6);
}

@media (prefers-color-scheme: dark) {
  .sd-storyboard-config-btn {
    background: var(--sd-card-bg, #1f2937);
    border-color: var(--sd-border, #374151);
  }
  .sd-storyboard-config-btn:hover {
    background: var(--sd-hover-bg, #374151);
  }
}
`;
    injectStoryboardStyles(headerToolsStyles, 'qianmu-storyboard-header-tools-styles');

    // 注入配置模态框样式
    const { getStoryboardConfigModalStyles } = await import('./qianmu-storyboard-config-modal.js');
    const modalStyles = getStoryboardConfigModalStyles();
    injectStoryboardStyles(modalStyles, 'qianmu-storyboard-config-modal-styles');

    // 注入预设管理模态框样式
    const { getPresetModalStyles } = await import('./qianmu-storyboard-preset-modal.js');
    const presetStyles = getPresetModalStyles();
    injectStoryboardStyles(presetStyles, 'qianmu-storyboard-preset-modal-styles');

    // 注入路由规则管理模态框样式
    const { getRoutingModalStyles } = await import('./qianmu-storyboard-routing-modal.js');
    const routingStyles = getRoutingModalStyles();
    injectStoryboardStyles(routingStyles, 'qianmu-storyboard-routing-modal-styles');

  } catch (error) {
    console.error('[Qianmu Storyboard] Failed to inject all styles:', error);
  }

  return result;
}

export const STYLE_INJECTOR_VERSION = '2.0.0';
export const STYLE_INJECTOR_NAME = 'qianmu-storyboard-style-injector';
