// Lightweight, version-pinned route identity. Not a workflow, credential, permission or execution receipt.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const comfyRouteError = message => Object.assign(new Error(message), {
  code: 'comfy_route_binding', submissionState: 'not_submitted', retryable: false,
});
export function assertComfyRouteNamespace(namespace) {
  if (typeof namespace !== 'string' || !/^st-user:\S/.test(namespace) || namespace.length > 240
    || /[\u0000-\u001f\u007f]/.test(namespace) || namespace !== namespace.trim()) {
    throw comfyRouteError('工作流分工账户无效，请重新绑定');
  }
  return namespace;
}
export function normalizeComfyRouteSelection(value) {
  if (!object(value) || !identifier(value.id) || !identifier(value.revision)
    || !Number.isSafeInteger(value.version) || value.version < 1 || value.version > 64) {
    throw comfyRouteError('请选择已保存的工作流版本');
  }
  return { id: value.id, revision: value.revision, version: value.version };
}
export function normalizeComfyRouteBinding(value) {
  if (!object(value) || value.schemaVersion !== 1 || !digest(value.workflowHash) || !digest(value.recipeHash)
    || typeof value.name !== 'string' || value.name.length > 80 || /[\u0000-\u001f\u007f]/.test(value.name)) {
    throw comfyRouteError('工作流分工版本信息无效，请重新绑定');
  }
  return { schemaVersion: 1, namespace: assertComfyRouteNamespace(value.namespace),
    ...normalizeComfyRouteSelection(value), name: value.name.trim(), workflowHash: value.workflowHash, recipeHash: value.recipeHash };
}
export function retainComfyRouteBinding(value) {
  if (value == null) return null; // An explicit clear returns to the current workbench, never a malformed reference.
  try { return normalizeComfyRouteBinding(value); }
  catch (_) { return { invalid: true }; }
}
export function comfyRouteBindingKey(value) {
  const binding = normalizeComfyRouteBinding(value);
  return JSON.stringify([binding.namespace,binding.id,binding.revision,binding.version,binding.workflowHash,binding.recipeHash]);
}
export function retainComfyRoutePromptLayer(value) {
  if (!object(value) || ['positive','negative'].some(key => typeof value[key] !== 'string' || value[key].length > 12000)) return { invalid: true };
  return { positive: value.positive, negative: value.negative };
}
