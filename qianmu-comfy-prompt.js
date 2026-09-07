// Final prompt projection for an explicitly classified fixed workflow. Never rewrites a graph.
import { normalizeStoryboardShotSpec, getStoryboardCapabilities } from './qianmu-storyboard.js';
import { normalizeStoryboardPromptFormats, resolveStoryboardPromptRendering } from './qianmu-prompt-formats.js';

const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw Object.assign(new Error(message), {code:'storyboard_prompt_format',submissionState:'not_submitted',retryable:false}); };
async function hash(value) {
  if (!globalThis.crypto?.subtle) fail('当前环境不能核对提示表达');
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function compileComfyPromptRendering(rendering, shot, {positive='',negative='',supportsNegative=false}={}) {
  normalizeStoryboardPromptFormats([rendering.format]);
  const names = new Map(shot.characters.map(character=>[character.id,character.name || character.id]));
  const separator = rendering.format === 'tags' ? ', ' : '\n\n';
  const characterBlocks = rendering.characters.map(character => {
    if (!names.has(character.character_id)) fail('提示表达人物不在本镜');
    return `${JSON.stringify(names.get(character.character_id))}: ${character.positive}`;
  });
  const prompt = [positive,rendering.global,...characterBlocks].filter(Boolean).join(separator);
  const exclusions = supportsNegative ? [negative,rendering.negative].filter(Boolean).join(separator) : '';
  if (!prompt.trim() || prompt.length > 24000 || exclusions.length > 12000) fail('最终提示表达为空或过长，请精简后重试');
  return {prompt,negative:exclusions,characterBlocks};
}

export async function prepareComfyPromptJob(job,{prepare=false,guard=async()=>{}}={}) {
  if (job?.source !== 'comfy' || !Object.hasOwn(job.profile || {},'comfyRoutePromptFormat')) return null;
  const format = job.profile.comfyRoutePromptFormat;
  normalizeStoryboardPromptFormats([format]);
  if (!job.profile.comfyRouteBinding || job.profile.comfyRouteBinding.invalid) fail('提示格式缺少对应的固定工作流版本');
  const before = JSON.stringify([job.profile,job.payload,job.shotSpec,job.promptLocked,job.safetyAdapted]);
  const current = async () => { await guard(); if (before !== JSON.stringify([job.profile,job.payload,job.shotSpec,job.promptLocked,job.safetyAdapted])) fail('本镜提示配置已变化，未提交生成'); };
  const manual = job.promptLocked === true || job.payload?.compiledPrompt?.degradation?.mode === 'manual_flat';
  const mode = manual ? 'manual' : 'extracted';
  const shot = normalizeStoryboardShotSpec(job.payload?.shotSpec || job.shotSpec);
  await current();
  let text,sourceHash='';
  if (manual) {
    text = {prompt:job.payload.prompt,negative:job.payload.negative || '',characterBlocks:[]};
    if (typeof text.prompt !== 'string' || !text.prompt.trim() || text.prompt.length > 24000 || typeof text.negative !== 'string' || text.negative.length > 12000) fail('手动提示词为空或过长');
  } else {
    if (job.safetyAdapted) fail('安全调整后旧表达已失效，请手动核对提示词或重新提取');
    const rendering = await resolveStoryboardPromptRendering(shot,shot.promptRenderingPack,format,{guard:current});
    sourceHash = rendering.sourceHash;
    const layer = job.profile.comfyRoutePromptLayer;
    if (!layer || layer.invalid) fail('固定工作流提示补充无效');
    const capabilities = getStoryboardCapabilities('comfy',job.profile.capabilityModelId,job.profile.comfyWorkflow,job.connection);
    text = compileComfyPromptRendering(rendering,shot,{...layer,supportsNegative:capabilities.supportsNativeNegative === true});
  }
  const receipt = {version:1,format,mode,sourceHash,outputHash:await hash(text)};
  await current();
  const previous = job.payload.promptRendering;
  // Explicit manual edits may create a new receipt at enqueue; submission never rewrites a receipt.
  if (!prepare || previous && !manual) {
    if (!previous || Object.keys(previous).length !== Object.keys(receipt).length || Object.keys(receipt).some(key=>previous[key]!==receipt[key])
      || job.payload.prompt !== text.prompt || (job.payload.negative || '') !== text.negative
      || !manual && (job.payload.compiledPrompt?.prompt !== text.prompt || job.payload.compiledPrompt?.negative !== text.negative
        || JSON.stringify(job.payload.compiledPrompt?.characterBlocks) !== JSON.stringify(text.characterBlocks))) fail('已准备的提示表达与本镜不符，请重新核对原记录');
  } else {
    job.payload.prompt = text.prompt; job.payload.negative = text.negative;
    const compiled = {...job.payload.compiledPrompt,...text,promptFormat:format,
      degradation:manual ? {mode:'manual_flat',reason:'user_locked_prompt'} : shot.characters.length > 1 ? {mode:'named_character_blocks',reason:'text_layout_not_spatial_isolation'} : null};
    job.payload.compiledPrompt=compiled;job.compiledPrompt=clone(compiled);
    job.payload.promptRendering = receipt;
  }
  return receipt;
}
