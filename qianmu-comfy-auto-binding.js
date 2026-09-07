// Persist only the chosen pool version. This reference is not an automation switch or execution permission.
import { assertComfyRouteNamespace, normalizeComfyRouteSelection } from './qianmu-comfy-route-contract.js';
export const comfyAutoError=message=>Object.assign(new Error(message),{code:'comfy_auto_selection',submissionState:'not_submitted',retryable:false});
export function normalizeComfyAutoBinding(value) {
  if (!value || value.schemaVersion!==1 || value.invalid || typeof value.name!=='string' || value.name.length>80
    || /[\u0000-\u001f\u007f]/.test(value.name) || !/^[a-f0-9]{64}$/.test(value.poolHash || '')) throw comfyAutoError('候选方案来源无效，请重新选择');
  return {schemaVersion:1,namespace:assertComfyRouteNamespace(value.namespace),...normalizeComfyRouteSelection(value),name:value.name,poolHash:value.poolHash};
}
export function retainComfyAutoBinding(value) {
  if (value==null) return null;
  try { return normalizeComfyAutoBinding(value); } catch (_) { return {invalid:true}; }
}
