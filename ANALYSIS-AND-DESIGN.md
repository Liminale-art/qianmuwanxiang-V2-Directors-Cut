# 千幕（Omniscene）项目分析与设计方案

## 项目版本
- **当前版本**: v1.55.0
- **分析日期**: 2026-08-28
- **分析范围**: 分镜模块为核心，兼顾整体架构健康

---

## 一、项目现状诊断

### 1.1 整体架构评估

#### 优点 ✅
1. **模块化程度高**：代码按功能拆分为独立 JS 文件
   - `qianmu-storyboard.js` (689行) - 分镜数据契约
   - `qianmu-image-gateway.js` (928行) - 图像网关
   - `qianmu-theaters.js` / `builtin-theaters.js` - 剧场/镜组系统
   - `qianmu-reader.js` (1147行) - 伴读模块
   - TTS相关模块独立

2. **数据规范严谨**：
   - Schema版本管理（STORYBOARD_SCHEMA_VERSION = 6）
   - 完整的数据迁移系统（migrateStoryboardState）
   - 类型安全的数据验证（normalizeStoryboardState）

3. **多模型支持完善**：
   - NovelAI (V3-V5)
   - Gemini/Banana
   - OpenAI GPT Image 2
   - Doubao Seedream
   - ComfyUI工作流

#### 核心问题 ⚠️

**1. index.js 极度臃肿（26,354行，1.6MB）**
```
问题严重度: 🔴 严重
- 包含6432个函数/类定义
- 单文件包含所有UI逻辑、事件处理、状态管理
- 难以维护、调试困难、协作冲突高
```

**2. 分镜前端交互流程混乱**
```
问题严重度: 🟡 中等
- 用户操作路径不够直观
- 多步骤流程缺乏明确引导
- 状态反馈不够实时
```

**3. CSS文件过大（396KB）**
```
问题严重度: 🟡 中等
- 样式组织需要优化
- 可能存在冗余样式
```

**4. 潜在死代码**
```
问题严重度: 🟢 轻微
- 未发现明显TODO/FIXME标记
- 需深度扫描未使用函数
```

---

## 二、分镜模块深度分析

### 2.1 当前架构

#### 数据流
```
用户输入 → 状态管理(index.js) 
         ↓
    构建请求(qianmu-storyboard.js)
         ↓
    网关转发(qianmu-image-gateway.js)
         ↓
    服务端插件 → 图像API
         ↓
    结果回传 → UI更新
```

#### 关键组件

1. **连接管理**
   - 每个供应商独立保存连接配置
   - 预设系统（Presets）
   - 凭证隔离存储

2. **参数系统**
   - 按模型能力动态显示
   - 参数预设独立管理
   - 工作流JSON验证（ComfyUI）

3. **人物一致性**
   - 形象档案系统（Entity Profiles）
   - 多档案支持
   - 参考图策略（描述/头像/画廊/Vibe）

4. **生成队列**
   - Pipeline日志系统
   - 最多8项任务
   - 严格串行执行

### 2.2 用户体验问题点

#### 🔴 严重问题

**A. 新手引导缺失**
- 首次进入分镜模块无任何引导
- 连接配置步骤不明确
- 缺乏最佳实践提示

**B. 多步骤流程不清晰**
```
当前流程：选择供应商 → 配置连接 → 设置参数 → 选择人物 → 输入提示词 → 生成

问题：
- 每步完成状态不明显
- 缺少进度指示
- 错误提示位置分散
```

**C. 形象档案管理复杂**
- 档案、变体、引用策略三层概念
- 操作入口分散
- 绑定关系不够直观

#### 🟡 中等问题

**D. 参数配置学习成本高**
- 不同模型参数差异大
- 缺少参数说明
- 预设命名不够语义化

**E. 成片管理功能分散**
- 画廊、日志、楼层挂载分开
- 批量操作不够便捷
- 检索功能待增强

#### 🟢 轻微问题

**F. 视觉设计待统一**
- 部分卡片样式不一致
- 图标使用不够系统化
- 间距律动感可优化

---

## 三、设计方案

### 3.1 核心设计原则

遵循项目定位：
1. **简约精致** - 减少视觉噪音，突出核心功能
2. **绝对实用** - 每个功能都有明确价值
3. **流畅体验** - 小白到高端用户都能舒适使用

### 3.2 架构重构方案

#### Phase 1: index.js 拆分（优先级：🔴 最高）

**目标**: 将26K行拆分为功能模块

```javascript
// 新的文件结构
qianmu-ui-core.js          // 核心UI框架 (~1500行)
qianmu-ui-storyboard.js    // 分镜UI组件 (~3000行)
qianmu-ui-theaters.js      // 剧场UI (~800行)
qianmu-ui-tts.js           // 配音UI (~1200行)
qianmu-ui-reader.js        // 伴读UI (~1500行)
qianmu-ui-focus.js         // 专注UI (~600行)
qianmu-state-manager.js    // 状态管理 (~1000行)
qianmu-event-handlers.js   // 事件处理 (~1500行)
qianmu-utils.js            // 工具函数 (~800行)
qianmu-validators.js       // 数据验证 (~600行)
index.js                   // 主入口 (~500行，仅协调)
```

**实施步骤**:
1. 第一周：创建模块骨架，保持向后兼容
2. 第二周：迁移分镜UI代码
3. 第三周：迁移其他模块UI
4. 第四周：重构状态管理
5. 第五周：测试与优化

**风险控制**:
- 每个模块独立测试
- 保留原index.js作为备份
- 版本号升级到2.0.0标记重大变更

#### Phase 2: 分镜流程优化（优先级：🔴 最高）

**新用户引导系统**

```javascript
// 首次使用检测
const StoryboardOnboarding = {
  steps: [
    {
      id: 'welcome',
      title: '欢迎使用分镜',
      content: '为你的故事创作精美画面',
      target: '.sd-storyboard-hero-card'
    },
    {
      id: 'provider-setup',
      title: '选择生图服务',
      content: '配置你的图像生成API',
      target: '.sd-storyboard-source-tabs',
      action: 'highlight-providers'
    },
    {
      id: 'connection-test',
      title: '测试连接',
      content: '验证配置是否正确',
      target: '.sd-storyboard-connection-actions',
      requiredAction: 'test-connection'
    },
    {
      id: 'first-generation',
      title: '生成第一张图',
      content: '输入描述，开始创作',
      target: '.sd-storyboard-prompt-card'
    }
  ],
  
  shouldShow: (state) => {
    return !state.initialized || state.logs.length === 0;
  }
};
```

**分步式工作台**

```
┌─────────────────────────────────────┐
│  [1.连接] → [2.参数] → [3.人物] → [4.生成]  │  ← 步骤指示器
├─────────────────────────────────────┤
│                                     │
│  当前步骤内容                          │
│  ✓ 已完成项                           │
│  ○ 待完成项                           │
│                                     │
│  [上一步]           [下一步/生成]      │
└─────────────────────────────────────┘
```

**智能默认值系统**

```javascript
const SmartDefaults = {
  // 根据用户历史自动推荐
  suggestProvider: (history) => {
    const usage = countProviderUsage(history);
    return getMostUsedProvider(usage);
  },
  
  // 根据正文内容推荐比例
  suggestRatio: (text) => {
    if (hasMultipleCharacters(text)) return '16:9';
    if (isPortraitScene(text)) return '2:3';
    return '1:1';
  },
  
  // 智能提示词增强建议
  suggestPromptEnhancement: (prompt) => {
    const suggestions = [];
    if (!hasQualityTags(prompt)) {
      suggestions.push('添加画质标签?');
    }
    if (!hasLightingInfo(prompt)) {
      suggestions.push('补充光照描述?');
    }
    return suggestions;
  }
};
```

### 3.3 UI/UX 优化方案

#### 1. 镜组（Theaters）可视化增强

**当前问题**: 镜组概念新颖但不够直观

**解决方案**: 类比「摄影工作室灯光预设」

```html
<!-- 镜组卡片重设计 -->
<div class="qm-theater-card">
  <div class="theater-preview">
    <!-- 视觉化预览：色调、风格图示 -->
    <div class="theater-style-indicator">
      <span class="color-tone" style="background: linear-gradient(...)"></span>
      <span class="style-tag">电影感</span>
    </div>
  </div>
  
  <div class="theater-info">
    <h4>周年纪事</h4>
    <p class="theater-desc">贯穿二人一生的结婚周年主题</p>
    <div class="theater-meta">
      <span class="length">≥5000字</span>
      <span class="style">温暖 · 深情</span>
    </div>
  </div>
  
  <button class="theater-use-btn">使用此剧场</button>
</div>
```

**交互改进**:
- 悬停预览效果
- 快速切换对比
- 收藏常用镜组
- 自定义镜组模板

#### 2. 形象档案系统简化

**三层合一的快捷操作**

```
当前: 人物 → 档案 → 引用策略（三步）

优化: 
┌──────────────────────┐
│ 选择人物              │
│ ☑ 张三 (默认档案)     │  ← 一步完成
│   └─ 策略: 头像       │
│ ☐ 李四               │
│ ☐ 王五               │
└──────────────────────┘

高级选项：展开查看更多档案和策略
```

**可视化档案卡片**

```html
<div class="qm-profile-card">
  <div class="profile-avatar">
    <img src="..." />
    <span class="profile-badge">默认</span>
  </div>
  
  <div class="profile-details">
    <h4>张三 · 档案A</h4>
    <p class="profile-desc-preview">黑色短发，琥珀色眼睛...</p>
    <div class="profile-stats">
      <span>已用23次</span>
      <span>成功率92%</span>
    </div>
  </div>
  
  <div class="profile-actions">
    <button class="btn-edit">编辑</button>
    <button class="btn-duplicate">复制</button>
  </div>
</div>
```

#### 3. 参数配置优化

**参数分级显示**

```
基础参数 (始终显示)
├─ 比例
├─ 模型
└─ 提示词

进阶参数 (折叠，按需展开)
├─ 采样器
├─ 步数
├─ CFG
└─ 种子

专家参数 (独立标签页)
├─ ComfyUI工作流
├─ 自定义header
└─ 调试选项
```

**参数预设可视化**

```html
<div class="qm-preset-gallery">
  <div class="preset-card" data-preset="cinematic">
    <div class="preset-preview">
      <!-- 小图标或色块示意 -->
      <i class="fa fa-film"></i>
    </div>
    <span class="preset-name">电影感</span>
    <span class="preset-params">Steps:28 CFG:7</span>
  </div>
  
  <div class="preset-card" data-preset="anime">
    <div class="preset-preview">
      <i class="fa fa-star"></i>
    </div>
    <span class="preset-name">二次元</span>
    <span class="preset-params">Steps:20 CFG:12</span>
  </div>
</div>
```

#### 4. 生成队列可视化

**实时状态卡片**

```
┌────────────────────────────────┐
│ 🎬 生成队列 (2/3)              │
├────────────────────────────────┤
│ ● 正在生成                     │
│   "黄昏下的两人"               │
│   [████████░░] 80%            │
│   NovelAI V5 · 1024x1024      │
│                                │
│ ○ 等待中                       │
│   "清晨的咖啡店"               │
│   Banana · 16:9               │
│   [移除]                       │
│                                │
│ ✓ 已完成 (3张)                 │
│   点击查看                     │
└────────────────────────────────┘
```

### 3.4 技术优化方案

#### 性能优化

```javascript
// 1. 懒加载画廊图片
const ImageLazyLoader = {
  observer: new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        loadImage(entry.target);
      }
    });
  }),
  
  observe: (container) => {
    container.querySelectorAll('.lazy-image').forEach(img => {
      ImageLazyLoader.observer.observe(img);
    });
  }
};

// 2. 状态更新防抖
const debouncedStateUpdate = debounce((key, value) => {
  updateState(key, value);
  saveToStorage();
}, 500);

// 3. 大列表虚拟滚动
const VirtualScroll = {
  itemHeight: 120,
  visibleCount: 10,
  render: (items, scrollTop) => {
    const startIndex = Math.floor(scrollTop / itemHeight);
    const endIndex = startIndex + visibleCount;
    return items.slice(startIndex, endIndex);
  }
};
```

#### 错误处理改进

```javascript
// 统一错误处理器
const ErrorHandler = {
  handle: (error, context) => {
    // 用户友好的错误消息
    const message = getReadableError(error);
    
    // 错误分类
    if (isNetworkError(error)) {
      showRetryableError(message);
    } else if (isAuthError(error)) {
      showConfigError(message);
    } else {
      showGeneralError(message);
    }
    
    // 诊断信息收集（不含敏感数据）
    logDiagnostics({
      error: sanitizeError(error),
      context,
      timestamp: Date.now()
    });
  }
};
```

### 3.5 样式系统重构

#### CSS模块化

```css
/* qianmu-variables.css - 设计令牌 */
:root {
  /* 色彩系统 */
  --qm-primary: #6aa879;
  --qm-primary-light: color-mix(in srgb, var(--qm-primary) 30%, white);
  --qm-primary-dark: color-mix(in srgb, var(--qm-primary) 80%, black);
  
  /* 间距系统 (4px基准) */
  --qm-space-xs: 4px;
  --qm-space-sm: 8px;
  --qm-space-md: 12px;
  --qm-space-lg: 16px;
  --qm-space-xl: 24px;
  --qm-space-2xl: 32px;
  
  /* 圆角系统 */
  --qm-radius-sm: 8px;
  --qm-radius-md: 12px;
  --qm-radius-lg: 16px;
  --qm-radius-full: 9999px;
  
  /* 阴影系统 */
  --qm-shadow-sm: 0 2px 8px rgba(0,0,0,0.08);
  --qm-shadow-md: 0 4px 16px rgba(0,0,0,0.12);
  --qm-shadow-lg: 0 8px 32px rgba(0,0,0,0.16);
}

/* qianmu-components.css - 组件样式 */
.qm-card {
  padding: var(--qm-space-lg);
  border-radius: var(--qm-radius-md);
  background: var(--sd-card);
  box-shadow: var(--qm-shadow-sm);
}

.qm-button-primary {
  padding: var(--qm-space-sm) var(--qm-space-lg);
  border-radius: var(--qm-radius-full);
  background: var(--qm-primary);
  color: white;
  transition: all 0.2s ease;
}

.qm-button-primary:hover {
  background: var(--qm-primary-dark);
  transform: translateY(-1px);
  box-shadow: var(--qm-shadow-md);
}
```

---

## 四、实施计划

### 4.1 时间表（8周）

**Week 1-2: 架构拆分**
- [ ] index.js 模块拆分设计
- [ ] 创建新模块文件结构
- [ ] 迁移核心UI代码
- [ ] 单元测试覆盖

**Week 3-4: 分镜流程重构**
- [ ] 新用户引导系统
- [ ] 分步式工作台
- [ ] 智能默认值
- [ ] 错误处理优化

**Week 5-6: UI/UX优化**
- [ ] 镜组可视化
- [ ] 形象档案简化
- [ ] 参数界面优化
- [ ] 队列状态改进

**Week 7: 性能与样式**
- [ ] 懒加载实现
- [ ] CSS模块化
- [ ] 动画优化
- [ ] 移动端适配

**Week 8: 测试与发布**
- [ ] 完整回归测试
- [ ] 用户测试反馈
- [ ] 文档更新
- [ ] v2.0.0发布

### 4.2 优先级排序

**P0 (必须完成)**
1. index.js拆分
2. 新用户引导
3. 错误处理改进
4. 关键bug修复

**P1 (应该完成)**
5. 分步式工作台
6. 形象档案简化
7. 参数界面优化
8. 性能优化

**P2 (可以完成)**
9. 镜组可视化增强
10. CSS模块化
11. 高级动画效果
12. 扩展文档

### 4.3 质量保证

**代码审查清单**
- [ ] ESLint无错误
- [ ] 所有函数有文档注释
- [ ] 关键路径有单元测试
- [ ] 性能指标达标（FCP < 1.5s）
- [ ] 无console.log残留
- [ ] 无TODO标记

**用户测试清单**
- [ ] 新用户0-10分钟完成首次生图
- [ ] 高级用户满意度 > 8/10
- [ ] 移动端可用性测试通过
- [ ] 无严重可用性问题

---

## 五、风险评估与应对

### 5.1 技术风险

**风险1: 重构破坏现有功能**
- 影响: 🔴 高
- 概率: 🟡 中
- 应对: 
  - 分阶段发布
  - 保留rollback机制
  - Beta测试版本

**风险2: 性能回退**
- 影响: 🟡 中
- 概率: 🟢 低
- 应对:
  - 性能基准测试
  - 持续监控
  - 优化缓存策略

### 5.2 用户接受度风险

**风险3: UI改动引起不适**
- 影响: 🟡 中
- 概率: 🟡 中
- 应对:
  - 提供经典模式选项
  - 渐进式更新
  - 收集用户反馈快速迭代

### 5.3 资源风险

**风险4: 开发周期延长**
- 影响: 🟡 中
- 概率: 🟡 中
- 应对:
  - MVP优先
  - P2功能延后
  - 灵活调整计划

---

## 六、成功指标

### 6.1 技术指标

- index.js减少至 < 5000行
- 首屏加载时间 < 2秒
- 内存占用减少30%
- 代码复用率提升50%

### 6.2 用户体验指标

- 新用户首次生图成功率 > 90%
- 平均操作步骤减少40%
- 用户满意度 > 8.5/10
- Bug报告减少60%

### 6.3 功能指标

- 所有P0任务完成
- 80%的P1任务完成
- 向后兼容性100%
- 文档覆盖率 > 85%

---

## 七、参考资料与学习方向

### 7.1 竞品分析重点

**柏宝绘 (易用性标杆)**
- 学习点：简化流程、默认值设计
- 避免点：功能过于简单

**智绘姬 (功能全面性)**
- 学习点：高级功能组织
- 避免点：学习曲线陡峭

**PS插件 (可视化)**
- 学习点：参数可视化、预设管理
- 避免点：过度依赖图形界面

### 7.2 设计参考

1. **Apple Human Interface Guidelines** - 简约精致
2. **Material Design 3** - 组件系统
3. **Stripe Dashboard** - 复杂数据呈现
4. **Linear App** - 现代交互设计

---

## 八、总结

### 当前最紧迫的任务

1. **拆分index.js** - 解决技术债务，提升可维护性
2. **优化新用户体验** - 降低学习成本，提高首次成功率
3. **简化分镜流程** - 减少操作步骤，增强流畅感

### 千幕的独特优势

- **镜组系统** - 创新的小剧场概念
- **多模型支持** - 广泛的兼容性
- **数据隔离** - 安全的架构设计

### 下一步行动

1. 与项目负责人确认优先级
2. 创建GitHub Issues跟踪任务
3. 建立开发分支开始重构
4. 邀请用户参与Beta测试

---

**文档版本**: v1.0  
**最后更新**: 2026-08-28  
**维护者**: Claude  
**审核状态**: 待审核
