// 千幕·分镜 - 提示词编译器
// 版本: 2.0.0
// 作者: Liminale
// 说明: 模式切换、LLM 调用封装、上下文构建、标签过滤

import { clone } from './qianmu-storyboard-utils.js';

/**
 * 编译模式
 */
export const COMPILER_MODES = Object.freeze({
  MANUAL: 'manual',   // 完全手写
  AUTO: 'auto',       // 自动生成
  HYBRID: 'hybrid',   // 混合模式
});

/**
 * 编译器配置
 */
export function createCompilerConfig(data = {}) {
  return {
    mode: data.mode || COMPILER_MODES.MANUAL,

    // 上下文配置
    context: {
      includeCurrentFloor: data.context?.includeCurrentFloor !== false,
      includeRecentFloors: data.context?.includeRecentFloors || 2,
      includeCharacterCards: data.context?.includeCharacterCards !== false,
      includeWorldInfo: data.context?.includeWorldInfo !== false,
      includeUserPersona: data.context?.includeUserPersona !== false,
    },

    // API 配置
    apiProfileId: data.apiProfileId || '',

    // 排除标签
    excludedTags: data.excludedTags || ['think', 'thinking', 'analysis', 'reasoning', 'status', 'summary', 'script', 'style'],

    // 指令模板
    instructionTemplate: data.instructionTemplate || '',
  };
}

/**
 * 构建提示词编译上下文
 * @param {Object} options - 配置项
 * @returns {Object} 上下文对象
 */
export function buildCompilerContext(options = {}) {
  const context = {
    currentFloor: null,
    recentFloors: [],
    characterCards: [],
    worldInfo: [],
    userPersona: null,
  };

  // TODO: 实际实现需要从千幕现有的上下文获取数据
  // 这里是占位结构

  if (options.includeCurrentFloor && options.currentFloorData) {
    context.currentFloor = {
      floor: options.currentFloorData.floor,
      speaker: options.currentFloorData.speaker,
      text: options.currentFloorData.text,
      isUser: options.currentFloorData.isUser,
    };
  }

  if (options.includeRecentFloors && options.recentFloorsData) {
    context.recentFloors = options.recentFloorsData.map((floor) => ({
      floor: floor.floor,
      speaker: floor.speaker,
      text: floor.text,
      isUser: floor.isUser,
    }));
  }

  if (options.includeCharacterCards && options.characterCardsData) {
    context.characterCards = options.characterCardsData.map((card) => ({
      name: card.name,
      description: card.description,
      personality: card.personality,
      appearance: card.appearance,
    }));
  }

  if (options.includeWorldInfo && options.worldInfoData) {
    context.worldInfo = options.worldInfoData.map((entry) => ({
      key: entry.key,
      content: entry.content,
    }));
  }

  if (options.includeUserPersona && options.userPersonaData) {
    context.userPersona = {
      name: options.userPersonaData.name,
      description: options.userPersonaData.description,
    };
  }

  return context;
}

/**
 * 清洗文本（移除排除标签）
 * @param {string} text - 原始文本
 * @param {string[]} excludedTags - 排除标签列表
 * @returns {string} 清洗后的文本
 */
export function cleanText(text, excludedTags = []) {
  let cleaned = String(text || '');

  // 移除 HTML 注释
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  // 移除排除标签
  for (const tag of excludedTags) {
    const regex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    cleaned = cleaned.replace(regex, '');
  }

  // 移除多余空白
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

/**
 * 构建编译提示词
 * @param {Object} context - 上下文
 * @param {Object} config - 编译器配置
 * @param {Object} shot - 镜头信息
 * @returns {string} 编译提示词
 */
export function buildCompilerPrompt(context, config, shot = {}) {
  const parts = [];

  // 系统指令
  parts.push('你是一个专业的图像提示词生成器，擅长将场景描述转化为适合 AI 绘图模型的提示词。');
  parts.push('');

  // 角色信息
  if (context.characterCards && context.characterCards.length > 0) {
    parts.push('# 角色信息');
    for (const card of context.characterCards) {
      parts.push(`## ${card.name}`);
      if (card.appearance) parts.push(`外貌：${card.appearance}`);
      if (card.personality) parts.push(`性格：${card.personality}`);
    }
    parts.push('');
  }

  // 用户人设
  if (context.userPersona) {
    parts.push('# 用户人设');
    parts.push(`名称：${context.userPersona.name}`);
    if (context.userPersona.description) parts.push(`描述：${context.userPersona.description}`);
    parts.push('');
  }

  // 世界书信息
  if (context.worldInfo && context.worldInfo.length > 0) {
    parts.push('# 世界设定');
    for (const entry of context.worldInfo) {
      parts.push(`- ${entry.content}`);
    }
    parts.push('');
  }

  // 最近对话
  if (context.recentFloors && context.recentFloors.length > 0) {
    parts.push('# 最近对话');
    for (const floor of context.recentFloors) {
      parts.push(`${floor.speaker}: ${cleanText(floor.text, config.excludedTags)}`);
    }
    parts.push('');
  }

  // 当前楼层（重点）
  if (context.currentFloor) {
    parts.push('# 当前场景（需要生成图像）');
    parts.push(`${context.currentFloor.speaker}: ${cleanText(context.currentFloor.text, config.excludedTags)}`);
    parts.push('');
  }

  // 镜头类型提示
  if (shot.shotType) {
    const typeHints = {
      portrait: '生成人物特写镜头，突出面部表情和细节',
      group: '生成群像构图，展示多个角色的互动',
      environment: '生成场景全景，展示环境氛围',
      object: '生成物件特写，突出物品细节',
      action: '生成动作瞬间，捕捉动态画面',
      closeup: '生成特写镜头，聚焦关键细节',
    };
    const hint = typeHints[shot.shotType] || '生成符合场景的图像';
    parts.push(`# 镜头要求\n${hint}`);
    parts.push('');
  }

  // 输出要求
  parts.push('# 输出要求');
  parts.push('1. 生成英文提示词，使用逗号分隔的标签格式');
  parts.push('2. 包含：主体、动作、环境、光线、构图、风格');
  parts.push('3. 避免重复和冗余词汇');
  parts.push('4. 不要包含质量词（如 masterpiece, best quality 等），这些会自动添加');
  parts.push('');
  parts.push('直接输出提示词，不要解释。');

  return parts.join('\n');
}

/**
 * 提示词编译器
 */
export class PromptCompiler {
  constructor(config, llmCaller) {
    this.config = config || createCompilerConfig();
    this.llmCaller = llmCaller; // 外部注入 LLM 调用函数
  }

  /**
   * 编译提示词
   * @param {Object} shot - 镜头信息
   * @param {Object} contextData - 上下文数据
   * @returns {Promise<Object>} 编译结果
   */
  async compile(shot, contextData = {}) {
    // 手动模式：不编译
    if (this.config.mode === COMPILER_MODES.MANUAL) {
      return {
        mode: COMPILER_MODES.MANUAL,
        prompt: shot.prompt || '',
        negative: shot.negative || '',
        compiled: false,
      };
    }

    // 构建上下文
    const context = buildCompilerContext({
      ...this.config.context,
      ...contextData,
    });

    // 自动模式：完全由 LLM 生成
    if (this.config.mode === COMPILER_MODES.AUTO) {
      const prompt = buildCompilerPrompt(context, this.config, shot);

      if (!this.llmCaller) {
        throw new Error('LLM 调用器未配置');
      }

      try {
        const response = await this.llmCaller(prompt, {
          apiProfileId: this.config.apiProfileId,
        });

        return {
          mode: COMPILER_MODES.AUTO,
          prompt: response.trim(),
          negative: shot.negative || '',
          compiled: true,
          source: 'llm',
        };
      } catch (error) {
        console.error('[PromptCompiler] LLM 调用失败:', error);
        return {
          mode: COMPILER_MODES.AUTO,
          prompt: shot.prompt || '',
          negative: shot.negative || '',
          compiled: false,
          error: error.message,
        };
      }
    }

    // 混合模式：保留手写基础，LLM 补充细节
    if (this.config.mode === COMPILER_MODES.HYBRID) {
      const basePrompt = shot.prompt || '';
      const enhancementPrompt = `基于以下场景和已有提示词，补充环境、光线、构图等细节描述。

已有提示词：${basePrompt}

场景：${context.currentFloor ? cleanText(context.currentFloor.text, this.config.excludedTags) : '（无）'}

只输出补充的标签，用逗号分隔，不要重复已有内容。`;

      if (!this.llmCaller) {
        throw new Error('LLM 调用器未配置');
      }

      try {
        const enhancement = await this.llmCaller(enhancementPrompt, {
          apiProfileId: this.config.apiProfileId,
        });

        const combined = [basePrompt, enhancement.trim()]
          .filter((s) => s)
          .join(', ');

        return {
          mode: COMPILER_MODES.HYBRID,
          prompt: combined,
          negative: shot.negative || '',
          compiled: true,
          source: 'hybrid',
          base: basePrompt,
          enhancement: enhancement.trim(),
        };
      } catch (error) {
        console.error('[PromptCompiler] LLM 调用失败:', error);
        return {
          mode: COMPILER_MODES.HYBRID,
          prompt: basePrompt,
          negative: shot.negative || '',
          compiled: false,
          error: error.message,
        };
      }
    }

    // 未知模式
    return {
      mode: this.config.mode,
      prompt: shot.prompt || '',
      negative: shot.negative || '',
      compiled: false,
      error: '未知编译模式',
    };
  }

  /**
   * 更新配置
   * @param {Object} updates - 配置更新
   */
  updateConfig(updates) {
    this.config = {
      ...this.config,
      ...updates,
      context: {
        ...this.config.context,
        ...(updates.context || {}),
      },
    };
  }

  /**
   * 验证配置
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validateConfig() {
    const errors = [];

    if (!Object.values(COMPILER_MODES).includes(this.config.mode)) {
      errors.push('无效的编译模式');
    }

    if (this.config.mode !== COMPILER_MODES.MANUAL && !this.llmCaller) {
      errors.push('自动/混合模式需要配置 LLM 调用器');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

export const COMPILER_MODULE_VERSION = '2.0.0';
export const COMPILER_MODULE_NAME = 'qianmu-storyboard-compiler';
