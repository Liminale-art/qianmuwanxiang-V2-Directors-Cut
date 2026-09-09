import {STORYBOARD_PROVIDER_REGISTRY,STORYBOARD_MODEL_PROFILE_LIMIT} from './qianmu-storyboard.js';
import {storyboardPortableEqual} from './qianmu-storyboard-package-fields.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_portable_presets',submissionState:'not_submitted'});};
const providers=Object.keys(STORYBOARD_PROVIDER_REGISTRY);
const bindingKey=row=>JSON.stringify([row.model,row.capabilityModelId]);
const validId=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=240&&!/[\u0000-\u001f\u007f]/.test(value);
function memoryShape(value){
  if(!object(value)||Object.keys(value).some(key=>key!=='bindings'&&!providers.includes(key)))fail('模型参数记忆目录无效，请保留原资料');
  if(Object.hasOwn(value,'bindings')&&(!object(value.bindings)||Object.keys(value.bindings).some(key=>!providers.includes(key))))fail('模型能力记忆目录无效');
  for(const provider of providers){
    const bucket=Object.hasOwn(value,provider)?value[provider]:{},bound=Object.hasOwn(value.bindings||{},provider)?value.bindings[provider]:[];
    if(!object(bucket)||!Array.isArray(bound))fail('模型参数记忆结构无效');
    for(const [id,row] of Object.entries(bucket))if(!validId(id)||!object(row)||Object.hasOwn(row,'model')&&row.model!==id)fail('模型参数记忆编号与内容不符');
    const seen=new Set();for(const row of bound){
      if(!object(row)||!validId(row.model)||!validId(row.capabilityModelId)||seen.has(bindingKey(row)))fail('模型能力记忆编号无效或重复');seen.add(bindingKey(row));
    }
    if(Object.keys(bucket).length+bound.length>STORYBOARD_MODEL_PROFILE_LIMIT)fail(`模型参数记忆合并超过 ${STORYBOARD_MODEL_PROFILE_LIMIT} 项，请先整理；未淘汰旧参数`);
  }
}

// Incoming values replace only the exact provider/remote-model/capability identity, never the entire target catalogue.
export function mergeStoryboardParameterMemory(local={},incoming={}){
  memoryShape(local);memoryShape(incoming);const result=structuredClone(local);
  for(const provider of providers){
    if(Object.hasOwn(incoming,provider))result[provider]={...(result[provider]||{}),...structuredClone(incoming[provider])};
    if(Object.hasOwn(incoming.bindings||{},provider)){
      const rows=new Map((result.bindings?.[provider]||[]).map(row=>[bindingKey(row),row]));
      for(const row of incoming.bindings[provider])rows.set(bindingKey(row),structuredClone(row));
      result.bindings||={};result.bindings[provider]=[...rows.values()];
    }
  }
  memoryShape(result);return result;
}

export function assertStoryboardMemoryIdentitiesRetained(before,after){
  memoryShape(before);memoryShape(after);
  for(const provider of providers){
    if(Object.keys(before[provider]||{}).some(id=>!Object.hasOwn(after[provider]||{},id)))fail('模型参数记忆无法完整保留，未自动淘汰或改配其他模型');
    const remaining=new Set((after.bindings?.[provider]||[]).map(bindingKey));
    if((before.bindings?.[provider]||[]).some(row=>!remaining.has(bindingKey(row))))fail('模型能力记忆无法完整保留，未改配其他模型');
  }
}

export function mergeStoryboardPromptDefaults(local={},incoming={}){
  if(!object(local)||!object(incoming))fail('默认提示词目录无效');
  for(const source of [local,incoming])for(const [id,row] of Object.entries(source)){
    if(!id||id.trim()!==id||id.length>500||/[\u0000-\u001f\u007f]/.test(id)||!object(row)||Object.keys(row).some(key=>!['positive','negative'].includes(key))||Object.values(row).some(value=>typeof value!=='string'||value.length>12000))fail('默认提示词字段无效或超长，未截短导入');
  }
  const entries=new Map(Object.entries(local).map(([id,row])=>[id,structuredClone(row)]));
  for(const [id,row] of Object.entries(incoming)){
    entries.set(id,{...(entries.get(id)||{}),...structuredClone(row)});
  }
  if(entries.size>200)fail('默认提示词合并超过 200 项，请先整理；未移除本机默认词');
  return Object.fromEntries(entries);
}

export const STORYBOARD_PRESET_DATA_FIELDS=Object.freeze(['profiles','modelProfiles','parameterPresets','promptPresets','artistPresets','artistCollections','artistPools','promptDefaults']);
export function captureStoryboardPresetData(state,keys=STORYBOARD_PRESET_DATA_FIELDS){
  return structuredClone(Object.fromEntries(STORYBOARD_PRESET_DATA_FIELDS.filter(key=>keys.includes(key)&&Object.hasOwn(state,key)).map(key=>[key,state[key]])));
}

// Current-format values must survive normalization. Older schema conversions are handled separately by the caller.
export function assertStoryboardPresetDataRetained(before,after){
  let nodes=0;
  function retained(a,b,field,depth=0,key=''){
    if(++nodes>500000||depth>40)fail('预设备份结构过大或过深');
    if(a===b)return true;
    if(key==='comfyWorkflow'&&typeof a==='string'&&typeof b==='string'&&a.length<=2*1048576){
      try{return storyboardPortableEqual(JSON.parse(a),JSON.parse(b));}catch(_){return false;}
    }
    if(Array.isArray(a)){
      // Current-model cache creation may append a capability entry; all original entries and their order must remain.
      const append=field==='modelProfiles'&&depth===2&&providers.includes(key);
      return Array.isArray(b)&&(append?a.length<=b.length:a.length===b.length)&&a.every((row,i)=>retained(row,b[i],field,depth+1));
    }
    if(object(a))return object(b)&&Object.keys(a).every(name=>{
      // These are derived display summaries; item text and collection membership remain authoritative and checked.
      if(field==='promptPresets'&&depth===1&&name==='instruction'&&Array.isArray(a.items))return true;
      if(field==='artistPresets'&&depth===1&&name==='collectionId'&&Array.isArray(a.collectionIds))return true;
      return Object.hasOwn(b,name)&&retained(a[name],b[name],field,depth+1,name);
    });
    return false;
  }
  for(const key of STORYBOARD_PRESET_DATA_FIELDS)if(Object.hasOwn(before,key)&&!retained(before[key],after[key],key))fail(`分镜预设 ${key} 无法完整保留，未静默裁剪内容或引用，请保留原资料核对`);
}
