// Lightweight declarations; no candidate selection, storage, network or execution authority.
export const COMFY_CLASSIFICATION_VALUES = Object.freeze({
  visualKinds: Object.freeze(['character','environment','object','symbolic','mixed']),
  castSizes: Object.freeze(['none','one','many']),
  narrativeLayers: Object.freeze(['present','memory','fantasy','dream','imagined']),
  contentClasses: Object.freeze(['sfw','adult']),
  promptFormats: Object.freeze(['tags','natural_language','character_blocks']),
});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw Object.assign(new Error(message),{code:'comfy_selection_invalid',submissionState:'not_submitted'});};
export const comfyClassificationChoices=(value,allowed,label)=>{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>allowed.length||value.some(item=>!allowed.includes(item))||new Set(value).size!==value.length)fail(`${label}分类无效`);
  return allowed.filter(item=>value.includes(item));
};
export function normalizeComfyClassification(value={}) {
  if(!object(value)||value.version!==1)fail('工作流分类版本无效');
  const maxSubjects=value.maxSubjects??null;
  if(maxSubjects!==null&&(!Number.isInteger(maxSubjects)||maxSubjects<0||maxSubjects>12))fail('可见人物上限无效');
  const promptFormat=value.promptFormat??'';
  if(promptFormat!==''&&!COMFY_CLASSIFICATION_VALUES.promptFormats.includes(promptFormat))fail('提示输入格式无效');
  return {version:1,
    visualKinds:comfyClassificationChoices(value.visualKinds,COMFY_CLASSIFICATION_VALUES.visualKinds,'画面'),
    castSizes:comfyClassificationChoices(value.castSizes,COMFY_CLASSIFICATION_VALUES.castSizes,'人数'),
    narrativeLayers:comfyClassificationChoices(value.narrativeLayers,COMFY_CLASSIFICATION_VALUES.narrativeLayers,'叙事层'),
    contentClasses:comfyClassificationChoices(value.contentClasses,COMFY_CLASSIFICATION_VALUES.contentClasses,'内容'),
    promptFormat,maxSubjects};
}
