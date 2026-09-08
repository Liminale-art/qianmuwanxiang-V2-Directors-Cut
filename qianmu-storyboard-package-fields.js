import {normalizeComfyAutoBinding} from './qianmu-comfy-auto-binding.js';
import {normalizeComfyRouteSelection} from './qianmu-comfy-route-contract.js';

// One field inventory for capture, strict input and reversible configuration patches.
export const STORYBOARD_ADDED_IMPORT_FIELDS=Object.freeze(['directorBridge','prompt','negative','contentRating','paragraphMode','promptDraft','lastModelSource','comfyPoolSelection','comfyAutoEnabled','comfyLibrarySelection','characterArchive','collapsedCards','tagSort']);
export const STORYBOARD_IMPORT_FIELDS=Object.freeze(['enabled','automation','source','inlineByDefault','promptMode','promptCompiler','profiles','modelProfiles','parameterPresets','parameterPresetSelection','generationPolicy','promptPresets','artistPresets','artistCollections','artistPools','tagLibrary','vibeLibrary','selectedVibeIds','selectedArtistPresetId','selectedArtistPoolId','promptDefaults','compositionPolicy','routing','logs','pipelineLogs','shotPlans','taskStates','connections',...STORYBOARD_ADDED_IMPORT_FIELDS]);
// Navigation/search and unfinished editor operations stay with the destination UI, not the imported scene.
export const STORYBOARD_LOCAL_STATE_FIELDS=Object.freeze(['view','workspaceView','assetView','assetSearch','logFilter','gallerySearch','gallerySource','galleryTrack','initialized','target','floor','manualParagraphIndex','pendingParagraphSelection','editingPromptPresetId','editingPromptItemId','promptItemDraft','artistCollectionId','artistSearch','editingArtistPresetId','tagPage']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const storyboardPortableEqual=(a,b)=>JSON.stringify(a,(_,v)=>object(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)===JSON.stringify(b,(_,v)=>object(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_portable_settings',submissionState:'not_submitted'});};
const retained=(before,after)=>Array.isArray(before)?Array.isArray(after)&&before.length===after.length&&before.every((item,i)=>retained(item,after[i]))
  :object(before)?object(after)&&Object.keys(before).every(key=>Object.hasOwn(after,key)&&retained(before[key],after[key])):before===after;
export function assertStoryboardAdditionalSettingsRetained(before,after,{resetAutomatic=false}={}){
  for(const key of STORYBOARD_ADDED_IMPORT_FIELDS)if(Object.hasOwn(before,key)&&!(resetAutomatic&&key==='comfyAutoEnabled')&&!retained(before[key],after[key]))fail(`分镜设置 ${key} 无法完整保留，未静默截短或重置，请保留原资料核对`);
}

export function inspectStoryboardPortableSelections(settings,namespace){
  const selected=settings.comfyLibrarySelection;
  if(selected!=null){
    const normalized={...normalizeComfyRouteSelection(selected),name:selected.name};
    if(typeof selected.name!=='string'||selected.name.length>80||/[\u0000-\u001f\u007f]/.test(selected.name)||!storyboardPortableEqual(selected,normalized))fail('当前工作流选择不完整，请重新选择原版本');
  }
  const pool=settings.comfyPoolSelection;
  if(pool!=null){const normalized=normalizeComfyAutoBinding(pool);if(normalized.namespace!==namespace||!storyboardPortableEqual(pool,normalized))fail('当前候选方案不属于备份来源，未猜配其他账户');}
  return {workflow:selected??null,pool:pool??null};
}

export function captureStoryboardPackageSettings(state,overrides={}){
  if(!object(state)||!object(overrides)||Object.keys(overrides).some(key=>!STORYBOARD_IMPORT_FIELDS.includes(key)))fail('分镜备份字段范围无效');
  const result={schemaVersion:state.schemaVersion};
  for(const key of STORYBOARD_IMPORT_FIELDS)if(Object.hasOwn(overrides,key)||Object.hasOwn(state,key))result[key]=structuredClone(Object.hasOwn(overrides,key)?overrides[key]:state[key]);
  return result;
}

export function assertStoryboardSelectionRestoreScope(settings,{namespace,sourceNamespace}={}){
  if(settings.comfyLibrarySelection==null&&settings.comfyPoolSelection==null)return;
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace!==sourceNamespace)fail('当前Comfy选择需要原账户核对；跨账户请等待明确资源派生，未自动匹配同名方案');
  inspectStoryboardPortableSelections(settings,sourceNamespace);
}
