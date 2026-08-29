// 千幕·分镜 - 内容适配器
// 版本: 2.0.0
// 作者: Liminale
// 说明: 根据供应商能力智能调整镜头内容，处理NSFW场景

/**
 * 供应商能力定义
 */
export const PROVIDER_CAPABILITIES = Object.freeze({
  novel: {
    nsfw: true,
    supportsArtistString: true,
    supportsNegative: true,
    supportedTypes: ['portrait', 'group', 'environment', 'object', 'action', 'closeup', 'custom'],
  },
  banana: {
    nsfw: false,
    supportsArtistString: false,
    supportsNegative: true,
    supportedTypes: ['portrait', 'group', 'environment', 'object', 'action', 'closeup', 'custom'],
  },
  openai: {
    nsfw: false,
    supportsArtistString: false,
    supportsNegative: false,
    supportedTypes: ['portrait', 'group', 'environment', 'object', 'custom'],
  },
  seedream: {
    nsfw: false,
    supportsArtistString: false,
    supportsNegative: false,
    supportedTypes: ['portrait', 'group', 'environment', 'object', 'action', 'closeup', 'custom'],
  },
  comfy: {
    nsfw: true, // 取决于用户工作流
    supportsArtistString: true,
    supportsNegative: true,
    supportedTypes: ['portrait', 'group', 'environment', 'object', 'action', 'closeup', 'custom'],
  },
});

/**
 * 敏感内容关键词映射
 */
const NSFW_SAFE_MAPPING = Object.freeze({
  // 场景替换
  'bedroom': 'interior, ambient lighting',
  'bath': 'room interior, water effects',
  'intimate': 'close proximity, emotional connection',
  'undressed': 'artistic silhouette, shadow play',
  'nude': 'artistic composition, implied form',

  // 动作替换
  'embrace': 'close interaction, emotional moment',
  'kiss': 'intimate moment, close-up faces',
  'touch': 'hand gesture, connection',

  // 视角调整
  'explicit': 'suggestive, implied',
  'revealing': 'partial view, artistic angle',
  'seductive': 'elegant, alluring pose',
});

/**
 * 检查提示词是否包含敏感内容
 * @param {string} prompt - 提示词
 * @returns {boolean} 是否包含敏感内容
 */
export function containsNSFWContent(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;

  const lowerPrompt = prompt.toLowerCase();
  const nsfwKeywords = Object.keys(NSFW_SAFE_MAPPING);

  return nsfwKeywords.some((keyword) => lowerPrompt.includes(keyword));
}

/**
 * 调整提示词为安全视角
 * @param {string} prompt - 原始提示词
 * @returns {string} 调整后的提示词
 */
export function adjustToSafePerspective(prompt) {
  if (!prompt || typeof prompt !== 'string') return prompt;

  let adjusted = prompt;

  // 替换敏感关键词
  for (const [nsfw, safe] of Object.entries(NSFW_SAFE_MAPPING)) {
    const regex = new RegExp(`\\b${nsfw}\\b`, 'gi');
    adjusted = adjusted.replace(regex, safe);
  }

  // 添加安全构图提示
  const safeCompositionHints = [
    'artistic composition',
    'tasteful framing',
    'implied narrative',
  ];

  // 如果原始提示词包含敏感内容，添加安全提示
  if (containsNSFWContent(prompt)) {
    // 随机选择一个安全构图提示
    const hint = safeCompositionHints[Math.floor(Math.random() * safeCompositionHints.length)];
    adjusted = `${adjusted}, ${hint}`;
  }

  return adjusted;
}

/**
 * 内容适配器 - 根据供应商能力调整镜头
 * @param {Object} shot - 镜头对象
 * @param {string} provider - 供应商ID
 * @param {boolean} isNSFW - 是否为NSFW场景
 * @returns {Object} 调整后的镜头
 */
export function adaptShotForProvider(shot, provider, isNSFW = false) {
  if (!shot || !provider) return shot;

  const capabilities = PROVIDER_CAPABILITIES[provider];
  if (!capabilities) {
    console.warn(`[内容适配] 未知供应商: ${provider}`);
    return shot;
  }

  const adapted = { ...shot };
  let adaptationNotes = [];

  // NSFW内容适配
  if (isNSFW && !capabilities.nsfw) {
    adapted.prompt = adjustToSafePerspective(adapted.prompt);
    adaptationNotes.push('已调整为常规分镜（模型不支持敏感内容）');
  }

  // 画师串支持
  if (!capabilities.supportsArtistString && adapted.artistString) {
    // 将画师串合并到主提示词
    adapted.prompt = `${adapted.prompt}, ${adapted.artistString}`.trim();
    adapted.artistString = '';
    adaptationNotes.push('画师串已合并到提示词');
  }

  // 负面提示词支持
  if (!capabilities.supportsNegative && adapted.negative) {
    adapted.negative = '';
    adaptationNotes.push('该模型不支持负面提示词');
  }

  // 镜头类型支持
  if (!capabilities.supportedTypes.includes(adapted.type)) {
    const fallbackType = 'custom';
    adaptationNotes.push(`镜头类型 ${adapted.type} 不支持，已改为 ${fallbackType}`);
    adapted.type = fallbackType;
  }

  // 记录适配信息
  if (adaptationNotes.length > 0) {
    adapted.adaptationNote = adaptationNotes.join('；');
  }

  return adapted;
}

/**
 * 批量适配镜头序列
 * @param {Object[]} shots - 镜头数组
 * @param {string} provider - 供应商ID
 * @param {boolean} isNSFW - 是否为NSFW场景
 * @returns {Object[]} 适配后的镜头数组
 */
export function adaptShotSequence(shots, provider, isNSFW = false) {
  if (!Array.isArray(shots)) return [];

  return shots.map((shot) => adaptShotForProvider(shot, provider, isNSFW));
}

/**
 * 获取供应商能力信息
 * @param {string} provider - 供应商ID
 * @returns {Object|null} 能力对象
 */
export function getProviderCapabilities(provider) {
  return PROVIDER_CAPABILITIES[provider] || null;
}

/**
 * 检查供应商是否支持NSFW
 * @param {string} provider - 供应商ID
 * @returns {boolean} 是否支持
 */
export function providerSupportsNSFW(provider) {
  const capabilities = PROVIDER_CAPABILITIES[provider];
  return capabilities ? capabilities.nsfw : false;
}

/**
 * 检查供应商是否支持画师串
 * @param {string} provider - 供应商ID
 * @returns {boolean} 是否支持
 */
export function providerSupportsArtistString(provider) {
  const capabilities = PROVIDER_CAPABILITIES[provider];
  return capabilities ? capabilities.supportsArtistString : false;
}

/**
 * 为镜头序列推荐合适的供应商
 * @param {Object[]} shots - 镜头数组
 * @param {boolean} isNSFW - 是否为NSFW场景
 * @returns {string[]} 推荐的供应商ID列表（按优先级排序）
 */
export function recommendProvidersForSequence(shots, isNSFW = false) {
  const recommendations = [];

  // 如果是NSFW场景，优先推荐支持NSFW的供应商
  if (isNSFW) {
    const nsfwProviders = Object.entries(PROVIDER_CAPABILITIES)
      .filter(([id, cap]) => cap.nsfw)
      .map(([id]) => id);
    recommendations.push(...nsfwProviders);
  }

  // 根据镜头类型推荐
  const hasPortrait = shots.some((shot) => ['portrait', 'closeup'].includes(shot.type));
  const hasEnvironment = shots.some((shot) => shot.type === 'environment');

  if (hasPortrait) {
    // 人物镜头优先 NovelAI
    if (!recommendations.includes('novel')) recommendations.push('novel');
  }

  if (hasEnvironment) {
    // 场景镜头推荐 Banana
    if (!recommendations.includes('banana')) recommendations.push('banana');
  }

  // 兜底推荐
  const allProviders = Object.keys(PROVIDER_CAPABILITIES);
  for (const provider of allProviders) {
    if (!recommendations.includes(provider)) {
      recommendations.push(provider);
    }
  }

  return recommendations;
}

export const ADAPTER_MODULE_VERSION = '2.0.0';
export const ADAPTER_MODULE_NAME = 'qianmu-storyboard-adapter';
