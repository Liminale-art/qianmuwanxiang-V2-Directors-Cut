// 千幕·分镜 - JSON修复与协议验证
// 版本: 2.0.0
// 作者: Liminale
// 说明: 处理LLM返回格式不稳定问题，提供多层防御和优雅降级

import { insertMissingCommas } from './qianmu-storyboard-utils.js';

/**
 * 智能JSON修复
 * @param {string} response - LLM原始响应
 * @returns {Object|null} 解析结果
 */
export function repairAndParseJSON(response) {
  if (!response || typeof response !== 'string') {
    return null;
  }

  let text = response.trim();

  // 第1步：移除markdown代码块标记
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

  // 第2步：移除开头的解释文字（找第一个{或[）
  const firstBrace = Math.min(
    text.indexOf('{') === -1 ? Infinity : text.indexOf('{'),
    text.indexOf('[') === -1 ? Infinity : text.indexOf('[')
  );
  if (firstBrace > 0 && firstBrace !== Infinity) {
    text = text.slice(firstBrace);
  }

  // 第3步：移除结尾的解释文字（找最后一个}或]）
  const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (lastBrace > -1 && lastBrace < text.length - 1) {
    text = text.slice(0, lastBrace + 1);
  }

  // 第4步：尝试直接解析
  try {
    return JSON.parse(text);
  } catch (error) {
    // 继续尝试修复
  }

  // 第5步：修复常见的JSON错误
  try {
    // 修复缺失的逗号
    text = insertMissingCommas(text);

    // 修复单引号（JSON只支持双引号）
    text = text.replace(/([{,]\s*)'/g, '$1"').replace(/'(\s*[},:}])/g, '"$1');

    // 修复尾部逗号
    text = text.replace(/,(\s*[}\]])/g, '$1');

    // 修复未闭合的字符串（简单情况）
    const openQuotes = (text.match(/"/g) || []).length;
    if (openQuotes % 2 !== 0) {
      text += '"';
    }

    // 修复未闭合的大括号/方括号
    const openBraces = (text.match(/{/g) || []).length;
    const closeBraces = (text.match(/}/g) || []).length;
    if (openBraces > closeBraces) {
      text += '}'.repeat(openBraces - closeBraces);
    }

    const openBrackets = (text.match(/\[/g) || []).length;
    const closeBrackets = (text.match(/]/g) || []).length;
    if (openBrackets > closeBrackets) {
      text += ']'.repeat(openBrackets - closeBrackets);
    }

    return JSON.parse(text);
  } catch (error) {
    console.error('[JSON修复] 无法修复:', error.message);
    return null;
  }
}

/**
 * 验证镜头序列协议
 * @param {Object} data - 解析的数据
 * @returns {Object} { valid: boolean, shots: [], errors: [], warnings: [] }
 */
export function validateShotSequence(data) {
  const errors = [];
  const warnings = [];
  const validShots = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, shots: [], errors: ['数据格式无效'], warnings: [] };
  }

  if (!Array.isArray(data.shots)) {
    return { valid: false, shots: [], errors: ['缺少 shots 数组'], warnings: [] };
  }

  const VALID_TYPES = ['portrait', 'group', 'environment', 'object', 'action', 'closeup', 'custom'];
  const seenSequences = new Set();

  for (let i = 0; i < data.shots.length; i++) {
    const shot = data.shots[i];
    const shotErrors = [];

    // 验证必填字段
    if (!shot || typeof shot !== 'object') {
      errors.push(`镜头 ${i + 1}: 数据格式无效`);
      continue;
    }

    // 验证类型
    if (!shot.type) {
      shotErrors.push('缺少类型');
    } else if (!VALID_TYPES.includes(shot.type)) {
      shotErrors.push(`类型无效: ${shot.type}`);
      shot.type = 'custom'; // 自动修正
      warnings.push(`镜头 ${i + 1}: 类型已修正为 custom`);
    }

    // 验证提示词
    if (!shot.prompt || typeof shot.prompt !== 'string') {
      shotErrors.push('缺少提示词');
    } else if (shot.prompt.trim().length < 5) {
      shotErrors.push('提示词过短（少于5个字符）');
    }

    // 验证序号（可选，但推荐）
    if (shot.sequence != null) {
      const seq = Number(shot.sequence);
      if (!Number.isInteger(seq) || seq < 1) {
        warnings.push(`镜头 ${i + 1}: 序号无效，已自动分配`);
        shot.sequence = i + 1;
      } else if (seenSequences.has(seq)) {
        warnings.push(`镜头 ${i + 1}: 序号重复，已自动分配`);
        shot.sequence = i + 1;
      } else {
        seenSequences.add(seq);
      }
    } else {
      shot.sequence = i + 1;
    }

    // 如果有错误，跳过该镜头
    if (shotErrors.length > 0) {
      errors.push(`镜头 ${i + 1}: ${shotErrors.join(', ')}`);
      continue;
    }

    // 标准化数据
    validShots.push({
      sequence: shot.sequence,
      type: shot.type,
      focus: String(shot.focus || '').trim() || '场景主体',
      prompt: String(shot.prompt).trim(),
      negative: String(shot.negative || '').trim(),
      style: String(shot.style || '').trim(),
      artistString: String(shot.artistString || '').trim(),
    });
  }

  return {
    valid: validShots.length > 0,
    shots: validShots,
    errors,
    warnings,
  };
}

/**
 * 从文本提取关键信息（降级方案1）
 * @param {string} text - LLM响应文本
 * @param {Object} context - 上下文
 * @returns {Object} 提取结果
 */
export function fallbackTextExtraction(text, context = {}) {
  const shots = [];

  // 检测镜头类型关键词
  const typeKeywords = {
    '特写': 'closeup',
    '近景': 'portrait',
    '全景': 'environment',
    '人物': 'portrait',
    '场景': 'environment',
    '群像': 'group',
    '物件': 'object',
    '动作': 'action',
  };

  let detectedType = 'custom';
  for (const [keyword, type] of Object.entries(typeKeywords)) {
    if (text.includes(keyword)) {
      detectedType = type;
      break;
    }
  }

  // 尝试提取提示词（寻找英文词组）
  const englishMatches = text.match(/[a-zA-Z][\w\s,.-]+/g);
  let extractedPrompt = '';
  if (englishMatches && englishMatches.length > 0) {
    // 找最长的英文片段
    extractedPrompt = englishMatches
      .sort((a, b) => b.length - a.length)[0]
      .trim()
      .replace(/\s+/g, ' ');
  }

  // 如果没有提取到英文，使用场景文本
  if (!extractedPrompt && context.currentFloor?.text) {
    extractedPrompt = context.currentFloor.text.slice(0, 100).trim();
  }

  shots.push({
    sequence: 1,
    type: detectedType,
    focus: '场景主体',
    prompt: extractedPrompt || 'scene, atmosphere',
    negative: '',
    style: '',
    artistString: '',
  });

  return {
    valid: true,
    shots,
    errors: [],
    warnings: ['LLM返回格式异常，使用文本提取模式'],
  };
}

/**
 * 创建默认单镜头（降级方案2）
 * @param {Object} context - 上下文
 * @returns {Object} 默认镜头
 */
export function createDefaultShot(context = {}) {
  return {
    valid: true,
    shots: [
      {
        sequence: 1,
        type: 'custom',
        focus: '当前场景',
        prompt: context.currentFloor?.text?.slice(0, 100).trim() || 'scene',
        negative: '',
        style: '',
        artistString: '',
      },
    ],
    errors: [],
    warnings: ['LLM分析失败，使用默认单镜头'],
  };
}

/**
 * 完整的协议处理流程
 * @param {string} response - LLM响应
 * @param {Object} context - 上下文
 * @returns {Object} 处理结果
 */
export function processShotAnalysisResponse(response, context = {}) {
  // 尝试解析JSON
  const parsed = repairAndParseJSON(response);

  if (!parsed) {
    console.warn('[协议处理] JSON解析失败，尝试文本提取');
    return fallbackTextExtraction(response, context);
  }

  // 验证协议
  const validation = validateShotSequence(parsed);

  if (!validation.valid) {
    console.warn('[协议处理] 协议验证失败，使用默认镜头');
    return createDefaultShot(context);
  }

  return validation;
}

/**
 * 构建增强的镜头分析提示词
 * @param {Object} context - 上下文
 * @param {Object} options - 配置项
 * @returns {string} 提示词
 */
export function buildEnhancedShotAnalysisPrompt(context, options = {}) {
  const maxShots = options.maxShots || 3;
  const sceneText = context.currentFloor?.text || '';

  const parts = [];

  // 角色定位
  parts.push('你是专业的分镜师，负责将场景拆解为连续的镜头序列。');
  parts.push('');

  // 场景内容
  parts.push('场景：');
  parts.push(sceneText);
  parts.push('');

  // 任务说明
  parts.push('任务：');
  parts.push(`1. 分析场景的叙事节奏和视觉重点`);
  parts.push(`2. 设计 1-${maxShots} 个连续镜头，形成完整的分镜序列`);
  parts.push('3. 每个镜头应有不同的视角和构图');
  parts.push('');

  // 镜头类型说明
  parts.push('镜头类型说明：');
  parts.push('- closeup: 特写，突出细节（手、眼睛、物件）');
  parts.push('- portrait: 人物，半身或全身');
  parts.push('- group: 群像，多人互动');
  parts.push('- environment: 场景，展示空间和氛围');
  parts.push('- action: 动作，捕捉运动瞬间');
  parts.push('- object: 物件，道具或关键物品');
  parts.push('');

  // 风格描述说明
  parts.push('风格描述：');
  parts.push('- 用形容词描述该镜头的视觉风格（如 "cinematic", "soft lighting", "dramatic"）');
  parts.push('- 风格将用于匹配合适的画师串');
  parts.push('');

  // 输出格式（强约束）
  parts.push('输出严格JSON（不要添加```json```标记或任何解释文字）：');
  parts.push('{');
  parts.push('  "shots": [');
  parts.push('    {');
  parts.push('      "sequence": 1,');
  parts.push('      "type": "closeup",');
  parts.push('      "focus": "门把手，手指触碰的瞬间",');
  parts.push('      "prompt": "door handle, hand reaching, moonlight reflection, detailed",');
  parts.push('      "style": "realistic, sharp focus, dramatic lighting"');
  parts.push('    }');
  parts.push('  ]');
  parts.push('}');
  parts.push('');

  // 关键约束
  parts.push('关键约束：');
  parts.push('1. 必须返回有效的JSON对象');
  parts.push('2. shots数组最多包含 ' + maxShots + ' 个元素');
  parts.push('3. 每个镜头必须包含 type 和 prompt 字段');
  parts.push('4. prompt 使用英文，逗号分隔标签');
  parts.push('5. 不要输出除JSON之外的任何内容');

  return parts.join('\n');
}

export const PROTOCOL_MODULE_VERSION = '2.0.0';
export const PROTOCOL_MODULE_NAME = 'qianmu-storyboard-protocol';
