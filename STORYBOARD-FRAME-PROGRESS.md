# 千幕·分镜模块开发进度总览

## 当前完成度：60%（核心架构完成，集成层待落地）

---

## ✅ 已完成部分（7个模块）

### 1. 数据层（100%完成）
- ✅ `qianmu-storyboard-frame.js` - 状态机/队列/数据结构
- ✅ `qianmu-storyboard-presets.js` - 预设管理（工厂预设+用户预设）
- ✅ `qianmu-storyboard-routing.js` - 路由管理（场景模板+规则引擎）
- ✅ `qianmu-storyboard-artist-library.js` - 画师串管理（CRUD+导入导出）
- ✅ `qianmu-storyboard-storage.js` - 持久化存储（5个专项存储管理器）

### 2. 业务逻辑层（100%完成）
- ✅ `qianmu-storyboard-compiler.js` - 提示词编译器（3种模式）
- ✅ `qianmu-storyboard-protocol.js` - 协议处理（JSON修复+验证+容错）
- ✅ `qianmu-storyboard-adapter.js` - 内容适配器（NSFW安全转换）

### 3. UI组件层（70%完成）
- ✅ `qianmu-storyboard-frame-ui.js` - 镜头卡片渲染
  - ✅ `renderShotCard()` - 卡片HTML生成
  - ✅ `getShotCardStyles()` - 卡片CSS样式
  - ✅ `injectFloorCaptureButton()` - 取景按钮注入
  - ✅ `createFloorObserver()` - 楼层自动观察
  - ✅ `mountShotCardToFloor()` - 卡片挂载到楼层
  - ✅ `bindShotCardEvents()` - 卡片交互事件
  - ❌ 编辑面板UI（未实现）
  - ❌ 灯箱预览UI（未实现）

- ✅ `qianmu-storyboard-artist-library-ui.js` - 画师串可视化
  - ✅ `renderArtistCard()` - 画师串卡片
  - ✅ `renderArtistGrid()` - 网格布局
  - ✅ `renderArtistSelector()` - 选择器界面
  - ✅ `createArtistSelectorModal()` - 模态选择器
  - ✅ `injectArtistQuickJump()` - 快速跳转按钮
  - ✅ `renderArtistLibraryManager()` - 管理界面
  - ✅ `renderArtistEditForm()` - 编辑表单
  - ✅ `renderArtistImportDialog()` - 导入对话框

- ✅ `qianmu-storyboard-artist-library.css` - 画师串完整样式

### 4. 基础设施层（100%完成）
- ✅ `qianmu-storyboard-style-injector.js` - 样式动态注入器
- ✅ `qianmu-storyboard-utils.js` - 77个工具函数

### 5. 集成层（30%完成）
- ✅ 所有模块已导入到 `index.js`
- ✅ 画师串样式已在 `init()` 中注入
- ❌ 镜头卡片样式未注入
- ❌ 取景按钮未实际绑定
- ❌ 分析流程未连接到UI
- ❌ 生图API未调用
- ❌ 配置面板未集成

---

## ❌ 待完成部分（按优先级排序）

### 高优先级：核心功能打通（4项）

#### 1. 镜头卡片样式注入 ⚠️
**问题：** `getShotCardStyles()` 生成的CSS未注入到页面
**方案：**
```javascript
// 在 qianmu-storyboard-style-injector.js 中添加
export async function injectShotCardStyles() {
  const { getShotCardStyles } = await import('./qianmu-storyboard-frame-ui.js');
  return injectStoryboardStyles(getShotCardStyles(), 'qianmu-shot-card-styles');
}

// 在 index.js 的 init() 中调用
await injectShotCardStyles();
```

#### 2. 取景按钮绑定到实际流程 ⚠️
**问题：** 按钮UI已实现，但未连接到分析流程
**方案：**
```javascript
// 在 index.js 或新建 qianmu-storyboard-integration.js
function initStoryboardCapture() {
  const storage = createStoryboardStorage();
  const config = storage.config.getConfig();
  
  // 创建观察器
  const observer = createFloorObserver(async (floorElement) => {
    // 1. 提取楼层文本
    const messageText = extractFloorText(floorElement);
    
    // 2. 调用LLM分析
    const result = await analyzeSceneForShots({
      context: messageText,
      // ... 其他上下文
    }, { imagesPerFloor: config.imagesPerFloor });
    
    // 3. 生成镜头卡片
    if (result.success) {
      for (const shot of result.shots) {
        const card = createShotCard(shot);
        mountShotCardToFloor(floorElement, card, {
          onGenerate: (card) => handleGenerate(card),
          onEdit: (card) => handleEdit(card),
          onCancel: (card) => handleCancel(card),
        });
      }
    }
  });
  
  // 启动观察器
  const chatContainer = document.querySelector('#chat');
  if (chatContainer) {
    observer.observe(chatContainer, { childList: true, subtree: true });
  }
}
```

#### 3. 镜头卡片编辑面板 ⚠️
**问题：** "调整参数"按钮没有对应的编辑界面
**方案：**
在 `qianmu-storyboard-frame-ui.js` 中新增：
```javascript
export function renderShotEditPanel(card) {
  return `
    <div class="qm-shot-edit-panel">
      <div class="qm-shot-edit-header">
        <h3>调整镜头参数</h3>
        <button class="qm-shot-edit-close">×</button>
      </div>
      <div class="qm-shot-edit-body">
        <!-- 提示词编辑 -->
        <div class="qm-form-group">
          <label>提示词</label>
          <textarea name="prompt">${card.prompt}</textarea>
        </div>
        
        <!-- 画师串选择 -->
        <div class="qm-form-group">
          <label>画师串</label>
          <input name="artistString" value="${card.artistString || ''}">
          <button class="qm-artist-quick-jump-btn">选择画师串</button>
        </div>
        
        <!-- 负面提示词 -->
        <div class="qm-form-group">
          <label>负面提示词</label>
          <textarea name="negative">${card.negative || ''}</textarea>
        </div>
        
        <!-- 供应商/模型 -->
        <div class="qm-form-group">
          <label>供应商</label>
          <select name="provider">
            <option value="novel">NovelAI</option>
            <option value="banana">Banana</option>
            <!-- ... -->
          </select>
        </div>
        
        <!-- 尺寸/步数/CFG -->
        <div class="qm-form-row">
          <div class="qm-form-group">
            <label>宽度</label>
            <input type="number" name="width" value="${card.params?.width || 832}">
          </div>
          <div class="qm-form-group">
            <label>高度</label>
            <input type="number" name="height" value="${card.params?.height || 1216}">
          </div>
        </div>
        
        <!-- 更多参数... -->
      </div>
      <div class="qm-shot-edit-footer">
        <button class="qm-shot-edit-cancel">取消</button>
        <button class="qm-shot-edit-save">保存</button>
      </div>
    </div>
  `;
}

export function createShotEditModal(card, onSave) {
  // 创建模态框逻辑...
}
```

#### 4. 生图API调用集成 ⚠️
**问题：** 点击"生成"按钮后无实际生图调用
**方案：**
```javascript
// 复用现有 qianmu-storyboard.js 中的 API 调用逻辑
async function handleGenerate(card) {
  // 1. 更新卡片状态为 GENERATING
  card.status = SHOT_CARD_STATUS.GENERATING;
  card.progress = 0;
  updateShotCard(card);
  
  // 2. 调用生图API（复用现有 storyboard 模块）
  const result = await generateImage({
    provider: card.provider,
    model: card.model,
    prompt: card.prompt,
    negative: card.negative,
    params: card.params,
    onProgress: (progress) => {
      card.progress = progress;
      updateShotCard(card);
    },
  });
  
  // 3. 更新卡片状态
  if (result.success) {
    card.status = SHOT_CARD_STATUS.COMPLETED;
    card.images = result.images;
    card.selectedImageIndex = 0;
  } else {
    card.status = SHOT_CARD_STATUS.FAILED;
    card.error = result.error;
  }
  updateShotCard(card);
}
```

---

### 中优先级：配置与管理界面（3项）

#### 5. 分镜配置面板
**位置：** 千幕设置面板 → 新增"分镜"标签页
**内容：**
```javascript
function renderStoryboardSettingsTab() {
  return `
    <div class="sd-tab-content" data-tab="storyboard">
      <h3>分镜设置</h3>
      
      <div class="sd-setting-group">
        <label>一层楼生成画面数（镜组未启用时）</label>
        <input type="number" min="1" max="10" value="4" 
               data-setting="storyboard.imagesPerFloor">
        <small>点击"取景"后自动生成的镜头卡片数量</small>
      </div>
      
      <div class="sd-setting-group">
        <label>并发生成数</label>
        <input type="number" min="1" max="5" value="1" 
               data-setting="storyboard.maxConcurrent">
        <small>同时生成图片的最大数量</small>
      </div>
      
      <div class="sd-setting-group">
        <label>自动取景</label>
        <input type="checkbox" data-setting="storyboard.autoCapture">
        <small>新消息到达时自动分析并生成镜头卡片</small>
      </div>
      
      <div class="sd-setting-group">
        <label>默认供应商</label>
        <select data-setting="storyboard.defaultProvider">
          <option value="novel">NovelAI</option>
          <option value="banana">Banana</option>
          <!-- ... -->
        </select>
      </div>
      
      <hr>
      
      <button class="sd-btn" onclick="openArtistLibraryManager()">
        管理画师串库
      </button>
      
      <button class="sd-btn" onclick="openPresetManager()">
        管理预设
      </button>
      
      <button class="sd-btn" onclick="openRoutingManager()">
        管理路由规则
      </button>
    </div>
  `;
}
```

#### 6. 预设管理界面集成
**方案：** 在设置面板中添加预设管理器UI
```javascript
function renderPresetManager() {
  const presetManager = new PresetManager(storage.userPresets);
  const presets = presetManager.getAll();
  
  return `
    <div class="qm-preset-manager">
      <div class="qm-preset-list">
        <!-- 工厂预设（只读） -->
        <h4>工厂预设</h4>
        ${FACTORY_PRESETS.map(p => renderPresetCard(p, true)).join('')}
        
        <!-- 用户预设（可编辑） -->
        <h4>我的预设</h4>
        ${presets.map(p => renderPresetCard(p, false)).join('')}
      </div>
      
      <button class="qm-preset-create">新建预设</button>
    </div>
  `;
}
```

#### 7. 路由规则管理界面集成
**方案：** 类似预设管理器，提供模板+规则编辑
```javascript
function renderRoutingManager() {
  const routingManager = new RoutingManager(storage.routingRules);
  
  return `
    <div class="qm-routing-manager">
      <div class="qm-routing-templates">
        <h4>场景模板</h4>
        ${ROUTING_TEMPLATES.map(t => renderTemplateCard(t)).join('')}
      </div>
      
      <div class="qm-routing-rules">
        <h4>自定义规则</h4>
        <!-- 规则列表 -->
      </div>
      
      <button class="qm-routing-create">新建规则</button>
    </div>
  `;
}
```

---

### 低优先级：增强功能（5项）

#### 8. 灯箱预览（点击图片全屏查看）
```javascript
export function createImageLightbox(imageUrl) {
  // 创建全屏灯箱
}
```

#### 9. 队列可视化（显示当前队列状态）
```javascript
export function renderQueueStatus(queue) {
  return `
    <div class="qm-queue-status">
      <span>队列: ${queue.active} 生成中 / ${queue.pending} 等待中</span>
    </div>
  `;
}
```

#### 10. 批量操作（全部生成/全部取消）
```javascript
export function renderBatchActions(cards) {
  return `
    <div class="qm-batch-actions">
      <button class="qm-batch-generate">全部生成</button>
      <button class="qm-batch-cancel">全部取消</button>
    </div>
  `;
}
```

#### 11. 卡片拖拽排序
```javascript
// 使用 Sortable.js 或原生拖拽API
```

#### 12. 图片保存到本地/插入到输入框
```javascript
export function saveShotImage(imageUrl, filename) {
  // 下载图片
}

export function insertShotImage(imageUrl) {
  // 插入到输入框
}
```

---

## 当前架构完整性

```
数据层       ████████████████████ 100%  ✅
业务逻辑层   ████████████████████ 100%  ✅
UI组件层     ██████████████░░░░░░  70%  ⚠️ (编辑面板/灯箱未实现)
基础设施层   ████████████████████ 100%  ✅
集成层       ██████░░░░░░░░░░░░░░  30%  ❌ (核心流程未打通)
配置管理层   ████░░░░░░░░░░░░░░░░  20%  ❌ (UI未实现)
```

**整体完成度：60%**
- 核心架构：✅ 完成
- 数据流转：✅ 完成
- UI渲染：⚠️ 70%完成
- 实际集成：❌ 30%完成

---

## 下一步行动计划

### 第一阶段：打通核心流程（预计2-3小时）
1. ✅ 注入镜头卡片样式
2. ✅ 实现取景按钮绑定
3. ✅ 实现镜头卡片编辑面板
4. ✅ 集成生图API调用

**完成后可实现：** 点击取景 → 生成卡片 → 编辑参数 → 实际生图

### 第二阶段：配置界面（预计1-2小时）
5. ✅ 添加分镜设置标签页
6. ✅ 集成画师串管理界面
7. ✅ 集成预设/路由管理界面

**完成后可实现：** 完整的配置和管理功能

### 第三阶段：增强功能（预计1-2小时）
8-12. 灯箱/队列/批量操作/拖拽/保存等

**完成后可实现：** 完整的用户体验

---

## 关键待确认事项

1. **LLM调用接口** - 现有 `analyzeSceneForShots()` 需要实际的LLM caller，是否复用现有导演系统的LLM接口？
2. **生图API接口** - 是否复用现有 `qianmu-storyboard.js` 中的生图逻辑？
3. **配置面板位置** - 是否在现有设置面板新增"分镜"标签页，还是独立入口？
4. **画师串库入口** - 是否在设置面板，还是悬浮球快捷菜单？

---

**版本：** 2.0.0  
**更新时间：** 2026-08-28  
**状态：** 核心架构完成，准备第一阶段集成
