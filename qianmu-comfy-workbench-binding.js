// Small workbench provenance only. Parameters and prompt additions remain editable, not pinned to recipe defaults.
import { normalizeComfyRouteBinding, assertComfyRouteNamespace, comfyRouteError } from './qianmu-comfy-route-contract.js';
import { normalizeComfyClassification } from './qianmu-comfy-classification.js';

export function normalizeComfyWorkbenchBinding(value) {
  if (!value || value.schemaVersion !== 1 || value.invalid) throw comfyRouteError('工作流分类来源无效，请从库重新应用');
  return {schemaVersion:1,binding:normalizeComfyRouteBinding(value.binding),classification:normalizeComfyClassification(value.classification)};
}
export function retainComfyWorkbenchBinding(value) {
  try { return normalizeComfyWorkbenchBinding(value); }
  catch (_) { return {invalid:true}; }
}
export function storyboardComfyPromptFormat(profile) {
  if (Object.hasOwn(profile || {},'comfyRoutePromptFormat')) return profile.comfyRoutePromptFormat;
  if (!Object.hasOwn(profile || {},'comfyWorkbenchBinding')) return '';
  const value=retainComfyWorkbenchBinding(profile.comfyWorkbenchBinding);
  return value.invalid ? '[invalid]' : value.classification.promptFormat;
}
export async function assertComfyWorkbenchProfile(profile,{namespace,guard=async()=>{}}={}) {
  const before=JSON.stringify([profile.comfyWorkflow,profile.comfyWorkbenchBinding,profile.comfyRouteBinding]);
  const captured=normalizeComfyWorkbenchBinding(profile.comfyWorkbenchBinding);
  if (profile.comfyRouteBinding != null) throw comfyRouteError('当前工作台与固定分工来源冲突，请重新选择');
  if (assertComfyRouteNamespace(namespace)!==captured.binding.namespace) throw comfyRouteError('当前工作流分类属于另一账户，请从库重新应用');
  await guard(); const {comfyWorkflowReferenceHash}=await import('./qianmu-comfy-references.js'); await guard();
  const hash=await comfyWorkflowReferenceHash(profile.comfyWorkflow); await guard();
  if (before!==JSON.stringify([profile.comfyWorkflow,profile.comfyWorkbenchBinding,profile.comfyRouteBinding])) throw comfyRouteError('当前工作流已变化，未提交生成');
  if (hash!==captured.binding.workflowHash) throw comfyRouteError('工作流图已修改，请保存到库并重新应用分类');
  return captured;
}
