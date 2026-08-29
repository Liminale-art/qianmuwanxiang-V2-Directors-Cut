# 千幕分镜模块设计文档

> **历史设计稿**：当前默认流程已改为无感自动配图，本文中的“三步取景/确认/生成”不再代表生产体验。最新基线见 [`STORYBOARD-V7-STATUS.md`](./STORYBOARD-V7-STATUS.md)。

> **版本**: 2.0  
> **状态**: 设计确认，开发中  
> **更新**: 2025-01-XX

---

## 一、设计目标

### 核心原则
1. **简约精致**: 界面元素不超过 5 层深度，单屏完成 80% 常用任务
2. **绝对实用**: 默认配置可用（零配置生图），3 秒内完成常规生图
3. **全能力覆盖**: 新手用自动模式，进阶调参数，高端自定义工作流

### 用户体验目标
- **新手**: 点击"取景"按钮 → 自动分析 → 一键生成
- **进阶**: 预设快速切换 → 微调参数 → 批量生成
- **高端**: 镜组智能路由 → 自定义工作流 → API 级控制

---

## 二、核心功能模块

### 2.1 镜头卡片系统

**设计思路**: 每个生成任务是独立的"镜头卡片"，嵌入楼层内联显示

**状态机**:
```
draft → queued → generating → completed / failed
  ↓                              ↓
  └──────── 可编辑 ──────────→ 可重新生成
```

**卡片结构**:
```
┌─────────────────────────────────┐
│ 🎬 镜头 #1 - 人物特写           │ ← 标题栏（可折叠）
├─────────────────────────────────┤
│ [预览缩略图区域]                 │ ← 图片槽（未生成显示占位）
├─────────────────────────────────┤
│ 提示词：girl, moonlight, hall   │ ← 精简显示（点击展开）
│ 模型：NovelAI V5 | 832×1216     │
├─────────────────────────────────┤
│ [重新生成] [调整参数] [⋯更多]   │ ← 操作按钮
└─────────────────────────────────┘
```

**文件**: `qianmu-storyboard-frame.js`, `qianmu-storyboard-frame-ui.js`

---

### 2.2 快速取景模式

**触发点**: 楼层悬浮操作栏新增"取景"按钮

**流程**:
```
用户点击"取景" 
  → 调用 LLM 分析当前楼层
  → 返回 1-3 个镜头建议
  → 卡片内联插入楼层下方
  → 用户可微调后生成
```

**LLM 分析 Schema**:
```json
{
  "need_image": true,
  "shots": [
    {
      "type": "portrait",  // 人物/群像/场景/特写/动作
      "focus": "girl opening door",
      "prompt": "1girl, opening door, moonlight, abandoned hall",
      "position": "end"  // start/middle/end
    }
  ]
}
```

**文件**: `qianmu-storyboard-frame.js` (快速取景逻辑)

---

### 2.3 预设系统

**三层架构**:

1. **工厂预设**（只读，内置）
   - 🎨 人物特写 (Portrait Close-up)
   - 👥 群像构图 (Group Shot)
   - 🏞️ 场景全景 (Environment Wide)
   - ⚡ 动作瞬间 (Action Freeze)
   - 🔍 物件特写 (Object Detail)

2. **用户预设**（可编辑）
   - 用户保存的自定义配置
   - 支持导入/导出

3. **临时草稿**（自动保存）
   - 记录上次使用的配置
   - 会话级持久化

**预设内容**:
```typescript
interface ShotPreset {
  id: string;
  name: string;
  icon?: string;
  builtin: boolean;
  
  // 模型配置
  provider: 'novel' | 'banana' | 'openai' | 'seedream' | 'comfy';
  model: string;
  
  // 画幅参数
  ratio: '1:1' | '2:3' | '3:2' | '16:9' | ...;
  width: number;
  height: number;
  
  // 生成参数
  steps?: number;
  cfg?: number;
  seed?: number;
  sampler?: string;
  scheduler?: string;
  
  // 提示词增强
  qualityTags?: string;
  negativeTags?: string;
  
  // 适用场景
  suggestedFor?: ShotType[];
}
```

**文件**: `qianmu-storyboard-presets.js`

---

### 2.4 镜组智能路由

**重新命名**: "智能分工" / "多模型协作"

**场景模板**:

```
📸 人物优先 (Portrait Focus)
  - 人物/特写 → NovelAI V5
  - 场景/物件 → Banana Nano 2

🌆 场景优先 (Environment Focus)
  - 场景/物件 → Banana Nano 2
  - 人物/特写 → NovelAI V5

⚡ 全能高质 (High Quality)
  - 所有类型 → NovelAI V5

🎨 自定义分工 (Custom)
  - 用户自定义规则
```

**规则结构**:
```typescript
interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  
  // 匹配条件
  shotTypes?: ShotType[];
  contentRating?: 'sfw' | 'nsfw' | 'all';
  
  // 目标配置
  provider: string;
  model: string;
  preset?: string;
}
```

**文件**: `qianmu-storyboard-routing.js`

---

### 2.5 提示词编译器

**三种模式**:

1. **完全手写**（新手推荐）
   - 用户自己控制每个词
   - 不调用 LLM

2. **自动生成**
   - LLM 分析场景后生成
   - 参考角色卡、世界书、最近楼层

3. **混合模式**（进阶推荐）
   - 手写基础提示词
   - LLM 补充细节（环境、光线、构图）

**配置项**:
```typescript
interface CompilerConfig {
  mode: 'manual' | 'auto' | 'hybrid';
  
  // 自动模式配置
  context: {
    includeCurrentFloor: boolean;
    includeRecentFloors: number;
    includeCharacterCards: boolean;
    includeWorldInfo: boolean;
  };
  
  // API 配置
  apiProfileId?: string;
  
  // 排除标签
  excludedTags: string[];
}
```

**文件**: `qianmu-storyboard-compiler.js`

---

## 三、数据结构设计

### 3.1 镜头卡片 (ShotCard)

```typescript
interface ShotCard {
  // 唯一标识
  id: string;
  
  // 位置锚定
  chatKey: string;
  floor: number;
  swipeId: number;
  position: 'start' | 'middle' | 'end';
  anchorHash?: string;  // 正文片段哈希，用于重定位
  
  // 状态
  status: 'draft' | 'queued' | 'generating' | 'completed' | 'failed';
  progress?: number;  // 0-100
  queuePosition?: number;
  
  // 内容
  prompt: string;
  negative?: string;
  shotType: ShotType;
  
  // 路由结果
  provider: string;
  model: string;
  preset?: string;
  
  // 生成参数
  params: GenerationParams;
  
  // 结果
  images?: Image[];
  selectedImageIndex?: number;
  error?: string;
  
  // 元数据
  createdAt: number;
  updatedAt: number;
  generatedAt?: number;
  generationTimeMs?: number;
}

type ShotType = 'portrait' | 'group' | 'environment' | 'object' | 'action' | 'closeup' | 'custom';

interface GenerationParams {
  width: number;
  height: number;
  ratio: string;
  steps?: number;
  cfg?: number;
  seed?: number;
  sampler?: string;
  scheduler?: string;
  count?: number;
  // ... 供应商特定参数
}

interface Image {
  url: string;
  seed?: number;
  width: number;
  height: number;
  format: string;
}
```

### 3.2 预设 (ShotPreset)

```typescript
interface ShotPreset {
  id: string;
  name: string;
  icon?: string;
  builtin: boolean;
  
  provider: string;
  model: string;
  
  params: Partial<GenerationParams>;
  
  promptEnhancement?: {
    quality?: string;
    negative?: string;
  };
  
  suggestedFor?: ShotType[];
  
  createdAt?: number;
  updatedAt?: number;
}
```

### 3.3 镜组规则 (RoutingRule)

```typescript
interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;  // 优先级，数字越大越优先
  
  // 匹配条件
  match: {
    shotTypes?: ShotType[];
    contentRating?: 'sfw' | 'nsfw' | 'all';
    floorRange?: { min?: number; max?: number };
  };
  
  // 目标配置
  target: {
    provider: string;
    model: string;
    preset?: string;
    paramsOverride?: Partial<GenerationParams>;
  };
  
  createdAt: number;
  updatedAt: number;
}

interface RoutingTemplate {
  id: string;
  name: string;
  description: string;
  icon?: string;
  rules: Omit<RoutingRule, 'id' | 'createdAt' | 'updatedAt'>[];
}
```

---

## 四、UI 布局设计

### 4.1 主界面（工作台模式）

```
┌──────────────────────────────────────────┐
│ 千幕 - 分镜工作台                         │
├────────┬─────────────────────────────────┤
│ 导航   │ 🎬 快速开始                     │
│        │ ┌─────────────────────────────┐ │
│ • 工作台│ │ [🎨 选择预设 ▼]             │ │
│ • 预设库│ │ [📝 提示词: 自动 ▼]         │ │
│ • 镜组  │ │ [🎯 目标: 最新楼层 ▼]       │ │
│ • 角色  │ │ [🚀 立即取景]               │ │
│ • 历史  │ └─────────────────────────────┘ │
│ • 设置  │                                 │
│        │ 📸 镜头队列 (2)                 │
│        │ [队列卡片...]                   │
│        │                                 │
│        │ 🖼️ 最近生成                    │
│        │ [缩略图网格...]                │
└────────┴─────────────────────────────────┘
```

### 4.2 楼层内联模式

```
┌────────────────────────────────────────┐
│ AI: 少女推开门，月光倾泻而入...         │
│ [💬回复] [🎬取景] [♻重新生成] [...]   │
└────────────────────────────────────────┘
      ↓ 点击"取景"后
┌────────────────────────────────────────┐
│ AI: 少女推开门，月光倾泻而入...         │
│                                         │
│ ┌────────────────────────────────────┐ │
│ │ 🎬 镜头 #1 - 人物特写               │ │
│ │ [图片预览区]                        │ │
│ │ 提示词: 1girl, door, moonlight...   │ │
│ │ [⚙️调整] [🔄重新生成] [❌取消]     │ │
│ └────────────────────────────────────┘ │
│                                         │
│ [💬回复] [♻重新生成] [...]             │
└────────────────────────────────────────┘
```

---

## 五、技术实现方案

### 5.1 模块文件结构

```
qianmu-storyboard-frame.js          # 镜头卡片核心逻辑
  - ShotCard 类（状态机）
  - 队列管理（并发控制）
  - 位置锚定（哈希 + LCS）
  - 快速取景（LLM 调用）

qianmu-storyboard-frame-ui.js       # 镜头卡片 UI
  - 卡片渲染（HTML + CSS）
  - 楼层内联注入（MutationObserver）
  - 交互事件（点击/编辑/拖拽）
  - 灯箱预览

qianmu-storyboard-presets.js        # 预设系统
  - 工厂预设库（5-10 个内置）
  - 用户预设 CRUD
  - 预设应用逻辑
  - 导入/导出

qianmu-storyboard-routing.js        # 镜组路由
  - 场景模板（4-5 个典型场景）
  - 规则匹配引擎
  - 可视化配置 UI
  - 规则优先级排序

qianmu-storyboard-compiler.js       # 提示词编译
  - 模式切换（手写/自动/混合）
  - LLM 调用封装
  - 上下文构建（角色卡/世界书/历史）
  - 标签过滤
```

### 5.2 与现有代码集成

**保留现有**:
- `qianmu-storyboard.js` - 数据契约、供应商注册表
- `qianmu-storyboard-utils.js` - 工具函数
- `index.js` 中的核心生成逻辑

**渐进式迁移**:
1. 新建模块文件
2. 在 `index.js` 中导入新模块
3. 逐步将 UI 和业务逻辑迁移到新模块
4. 保持向后兼容

---

## 六、开发计划

### Week 1: 基础设施
- [ ] 创建模块文件骨架
- [ ] 实现 ShotCard 状态机
- [ ] 楼层内联注入机制
- [ ] 基础卡片 UI 组件

### Week 2: 预设系统
- [ ] 定义 5 个工厂预设
- [ ] 用户预设 CRUD
- [ ] 预设选择器 UI
- [ ] 自动保存草稿

### Week 3: 快速取景
- [ ] 楼层"取景"按钮注入
- [ ] LLM 场景分析 Prompt
- [ ] 自动生成镜头方案
- [ ] 卡片自动插入

### Week 4: 镜组可视化
- [ ] 场景模板库
- [ ] 规则卡片 UI
- [ ] 模板应用逻辑
- [ ] 测试与优化

---

## 七、竞品分析参考

### 柏宝绘（易用性标杆）
- ✅ **学习**: 自动化流程、Tag 与图片分离、渐进式体验
- ❌ **避免**: 直接复制 `<bbi_image>` Tag 格式

### 智绘姬（功能全面）
- ✅ **学习**: 功能全面性、深度可控
- ❌ **避免**: 复杂 UI、陡峭学习曲线

### PS 轮椅插件（可视化）
- ✅ **学习**: 预设驱动、场景化组织、实时预览
- ❌ **避免**: 照搬视觉风格

---

## 八、交付标准

### 新手体验
- ✅ 零配置可用（默认预设）
- ✅ 点击"取景"3 秒内看到结果
- ✅ 错误提示清晰友好

### 进阶体验
- ✅ 预设可自定义并复用
- ✅ 镜组规则可视化配置
- ✅ 提示词编译可调参

### 高端体验
- ✅ 自定义工作流支持
- ✅ 批量生成与队列管理
- ✅ API 级别参数控制

---

## 九、风险控制

### 不照搬原则
- ✅ 学习思路，不复制代码
- ✅ 参考功能，不复制 UI
- ✅ 借鉴理念，不复制视觉

### 技术债务管理
- ✅ 新功能独立模块开发
- ✅ 老代码渐进式重构
- ✅ 每周可验证的里程碑

---

**文档版本**: 2.0  
**最后更新**: 2025-01-XX  
**维护者**: Kiro + Liminale
