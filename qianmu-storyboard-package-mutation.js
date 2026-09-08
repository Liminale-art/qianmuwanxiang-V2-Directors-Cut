import {vibeDigest} from './qianmu-vibe-file.js';
export {vibeDigest as storyboardPackageDigest} from './qianmu-vibe-file.js';
export const STORYBOARD_IMPORT_FIELDS=Object.freeze(['enabled','automation','source','inlineByDefault','promptMode','promptCompiler','profiles','modelProfiles','parameterPresets','parameterPresetSelection','generationPolicy','promptPresets','artistPresets','artistCollections','artistPools','tagLibrary','vibeLibrary','selectedVibeIds','selectedArtistPresetId','selectedArtistPoolId','promptDefaults','compositionPolicy','routing','logs','pipelineLogs','shotPlans','taskStates','connections']);
const chatFields=['storyboardImages','storyboardCollections'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const account=v=>typeof v==='string'&&/^st-user:.+/.test(v)&&v.length<=512&&!/[\u0000-\u001f\u007f]/.test(v);
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_package_mutation',submissionState:'not_submitted'});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function slot(target,key){return Object.hasOwn(target,key)?{exists:true,value:structuredClone(target[key])}:{exists:false};}
const arrays=new Set(['parameterPresets','promptPresets','artistPresets','artistCollections','artistPools','tagLibrary','vibeLibrary','selectedVibeIds','logs','pipelineLogs','shotPlans','taskStates',...chatFields]);
const strings=new Set(['source','promptMode','selectedArtistPresetId','selectedArtistPoolId']);
function validateSlot(value,key){
  if(!object(value)||typeof value.exists!=='boolean'||Object.keys(value).some(key=>!['exists','value'].includes(key))||Object.hasOwn(value,'value')!==value.exists)fail('导入恢复片段无效');
  if(!value.exists)return;const item=value.value;
  if(arrays.has(key)?!Array.isArray(item):strings.has(key)?typeof item!=='string':['enabled','inlineByDefault'].includes(key)?typeof item!=='boolean':!object(item))fail('导入恢复字段类型无效');
}
export function validateStoryboardMutation(row){
  if(!object(row)||Object.keys(row).some(key=>!['namespace','chatHash','fileHash','version','revision','createdAt','phase','patch'].includes(key))||!account(row.namespace)||!hash(row.chatHash)||!hash(row.fileHash)||row.version!==1||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.createdAt)||row.createdAt<0||!['prepared','applied','uncertain'].includes(row.phase)||!Array.isArray(row.patch)||row.patch.length>STORYBOARD_IMPORT_FIELDS.length+chatFields.length)fail('分镜元数据恢复记录无效');
  const seen=new Set();for(const entry of row.patch){
    if(!object(entry)||Object.keys(entry).some(key=>!['area','key','before','after'].includes(key))||!(entry.area==='settings'?STORYBOARD_IMPORT_FIELDS:entry.area==='chat'?chatFields:[]).includes(entry.key))fail('分镜恢复字段不在允许范围');
    const key=`${entry.area}:${entry.key}`;if(seen.has(key))fail('分镜恢复字段重复');seen.add(key);validateSlot(entry.before,entry.key);validateSlot(entry.after,entry.key);
  }
  if(new Blob([JSON.stringify(row)]).size>64*1024*1024)fail('分镜恢复记录超过 64 MiB，请缩小导入范围');return row;
}
export async function createStoryboardMutation({namespace,chatKey,fileHash,settings,chat,draft,now=Date.now}){
  const patch=[];for(const [area,target,after,keys] of [['settings',settings,draft.settings,STORYBOARD_IMPORT_FIELDS],['chat',chat,draft.chat,chatFields]])for(const key of keys){
    if(!Object.hasOwn(after,key))continue;const before=slot(target,key),next=slot(after,key);if(!same(before,next))patch.push({area,key,before,after:next});
  }
  return validateStoryboardMutation({namespace,chatHash:await vibeDigest(chatKey),fileHash,version:1,revision:1,createdAt:now(),phase:'prepared',patch});
}
export function inspectStoryboardMutation(row,{settings,chat}){
  validateStoryboardMutation(row);const rows=row.patch.map(entry=>{const current=slot(entry.area==='settings'?settings:chat,entry.key);return {area:entry.area,key:entry.key,state:same(current,entry.before)?'before':same(current,entry.after)?'after':'conflict'};});
  return {rows,conflicts:rows.filter(row=>row.state==='conflict'),before:rows.filter(row=>row.state==='before').length,after:rows.filter(row=>row.state==='after').length};
}
// Caller must durably prepare the record first and synchronously guard the live objects before this call.
export function applyStoryboardMutation(row,targets,direction='after'){
  if(!['before','after'].includes(direction))fail('导入恢复方向无效');const report=inspectStoryboardMutation(row,targets);if(report.conflicts.length)fail('导入涉及的数据已被修改，未覆盖；请先保全并处理冲突');
  const prepared=row.patch.map(entry=>({...entry,value:structuredClone(entry[direction])}));
  for(const entry of prepared){const target=entry.area==='settings'?targets.settings:targets.chat;if(entry.value.exists)target[entry.key]=entry.value.value;else delete target[entry.key];}
}
