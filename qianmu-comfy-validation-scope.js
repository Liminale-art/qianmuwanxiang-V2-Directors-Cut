// Host-owned identity of a tested still-workflow configuration. No credentials,
// prose or reference bytes are persisted here; this hash alone grants nothing.
import { createHash } from 'node:crypto';
import { prepareComfyWorkflow } from './qianmu-comfy-workflow.js';

const textInputs = { CLIPTextEncode: ['text'], CLIPTextEncodeSDXL: ['text_g', 'text_l'],
  CLIPTextEncodeSDXLRefiner: ['text'], CLIPTextEncodeSD3: ['clip_l', 'clip_g', 't5xxl'] };
function reusableSlots(graph) {
  // Only these semantically known inputs may vary outside the scope hash.
  // A prompt/seed/reference slot in a model name or other input is not evidence
  // of stable dependencies, even if a previous manual execution succeeded.
  const free = /%qianmu_(?:prompt|negative|seed|reference(?:s|_(?:[1-9]|1[0-6]))?)%/g;
  const contains = value => typeof value === 'string' ? [...value.matchAll(free)].map(match => match[0])
    : value && typeof value === 'object' ? Object.values(value).flatMap(contains) : [];
  for (const node of Object.values(graph)) for (const [field, value] of Object.entries(node.inputs || {})) {
    for (const slot of contains(value)) {
      if (typeof value !== 'string') return false;
      if (slot === '%qianmu_prompt%' || slot === '%qianmu_negative%') {
        if (!Object.hasOwn(textInputs, node.class_type) || !textInputs[node.class_type].includes(field)) return false;
      } else if (slot === '%qianmu_seed%') {
        if (value !== slot || !(node.class_type === 'KSampler' && field === 'seed'
          || node.class_type === 'KSamplerAdvanced' && field === 'noise_seed')) return false;
      } else if (value !== slot || node.class_type !== 'LoadImage' || field !== 'image' || slot === '%qianmu_references%') return false;
    }
  }
  return true;
}

export function comfyWorkflowValidationScope(input, outputNodeIds) {
  const original = typeof input.workflow === 'string' ? JSON.parse(input.workflow) : input.workflow;
  if (!reusableSlots(original)) return null;
  const referenceCount = input.referenceCount ?? input.references?.length ?? 0;
  const graph = prepareComfyWorkflow(original, {
    prompt: 'qianmu-validation-prompt', negativePrompt: 'qianmu-validation-negative',
    model: input.model, parameters: { ...input.parameters, seed: 0 }, referenceCount,
  }).bind(Array.from({ length: referenceCount }, (_, i) => `qianmu-validation-reference-${i + 1}.png`));
  return createHash('sha256').update(JSON.stringify({
    version: 1, original, graph, referenceCount, outputNodeIds,
    instanceType: input.runninghub?.instanceType || '',
  })).digest('hex');
}
