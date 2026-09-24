import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {comfySceneScope,comfySceneScopeKey} from './qianmu-comfy-scene-lock.js';
import {COMFY_SCENE_NATIVE_SCHEMA,validateSceneIndex,validateSceneMetadata,sceneLeaves,sceneSame,sceneBytes,sceneNativeFail as fail} from './qianmu-comfy-scene-native-contract.js';

// A root retains every current branch. Linked immutable pages retain the full
// chronological metadata catalogue; transition originals remain unchanged.
export const COMFY_SCENE_DIRECTORY_SCHEMA='qianmu.comfy.scene-runtime.v2';
export const COMFY_SCENE_HYBRID_SCHEMA='qianmu.comfy.scene-runtime.v3';
export const COMFY_SCENE_HISTORY_SCHEMA='qianmu.comfy.scene-history.v1';
export const COMFY_SCENE_HISTORY_SLOT='comfy-scene-history';
export const COMFY_SCENE_HISTORY_LIMITS=Object.freeze({pageEntries:64,pageBytes:128*1024,totalBytes:16*1024*1024});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
export function sceneHistoryLocator(value,scope){
  if(!exact(value,['reference','count'])||!integer(value.count)||value.count<1||value.count>8192)fail('续场历史定位信息无效');
  return {reference:stAccountImmutableReference(value.reference,{scope,slot:COMFY_SCENE_HISTORY_SLOT,maxBytes:COMFY_SCENE_HISTORY_LIMITS.pageBytes+1024}),count:value.count};
}
export function validateSceneDirectory(value,namespace,scope){
  if(value?.schema===COMFY_SCENE_HYBRID_SCHEMA){
    if(!Array.isArray(value.entries)||value.entries.length>8192||sceneBytes(value)>8*1024*1024)fail('续场混合目录超过原有容量');
    const inline=value.entries.filter(entry=>Object.hasOwn(entry||{},'versions')),paged=value.entries.filter(entry=>!Object.hasOwn(entry||{},'versions'));
    validateSceneIndex({...value,schema:COMFY_SCENE_NATIVE_SCHEMA,entries:inline},namespace,scope);
    validateSceneDirectory({...value,schema:COMFY_SCENE_DIRECTORY_SCHEMA,entries:paged},namespace,scope);
    const keys=new Set();let live=0,total=0;
    for(const entry of value.entries){const key=comfySceneScopeKey(entry.scope);if(keys.has(key))fail('续场混合目录范围重复');keys.add(key);
      const heads=Object.hasOwn(entry,'versions')?sceneLeaves(entry):entry.heads;
      if(entry.blocked||heads.some(meta=>meta.stateBytes>0)){live++;total+=Math.max(...heads.map(meta=>meta.stateBytes));}
    }
    if(live>1024||total>4*1024*1024)fail('续场记录超过原有场景数量或容量');return value;
  }
  if(value?.schema!==COMFY_SCENE_DIRECTORY_SCHEMA)return validateSceneIndex(value,namespace,scope);
  // Reuse the original complete envelope/source/generation contract without
  // pretending that a head-only entry is a complete v1 predecessor catalogue.
  validateSceneIndex({...value,schema:COMFY_SCENE_NATIVE_SCHEMA,entries:[]},namespace,scope);
  if(!Array.isArray(value.entries)||value.entries.length>8192||sceneBytes(value)>8*1024*1024)fail('续场轻目录超过原有容量');
  const keys=new Set();let live=0,total=0;
  for(const entry of value.entries){
    if(!exact(entry,['scope','blocked','heads','history'])||typeof entry.blocked!=='boolean'||!Array.isArray(entry.heads)||!entry.heads.length||entry.heads.length>8192)fail('续场轻目录条目无效');
    const normalized=comfySceneScope(entry.scope),key=comfySceneScopeKey(normalized);if(normalized.namespace!==namespace||!sceneSame(normalized,entry.scope)||keys.has(key))fail('续场轻目录范围重复或账户不符');keys.add(key);
    const history=sceneHistoryLocator(entry.history,scope),heads=new Set();if(entry.heads.length>history.count)fail('续场当前分支数量与历史不符');
    for(const meta of entry.heads){validateSceneMetadata(meta,scope);if(heads.has(meta.digest))fail('续场当前分支重复');heads.add(meta.digest);}
    if(entry.heads.some(meta=>meta.parents.some(parent=>heads.has(parent))))fail('续场当前分支不是末端');
    if(entry.blocked||entry.heads.some(meta=>meta.stateBytes>0)){live++;total+=Math.max(...entry.heads.map(meta=>meta.stateBytes));}
  }
  if(live>1024||total>4*1024*1024)fail('续场记录超过原有场景数量或容量');return value;
}
export function validateSceneHistoryPage(value,{namespace,scope,storageScope,count}){
  if(!exact(value,['schema','namespace','scope','start','previous','versions'])||value.schema!==COMFY_SCENE_HISTORY_SCHEMA||value.namespace!==namespace||!sceneSame(value.scope,scope)
    ||!integer(value.start)||!Array.isArray(value.versions)||!value.versions.length||value.versions.length>COMFY_SCENE_HISTORY_LIMITS.pageEntries
    ||value.start+value.versions.length!==count||sceneBytes(value)>COMFY_SCENE_HISTORY_LIMITS.pageBytes)fail('续场历史分页不完整或范围不符');
  if(value.start===0?value.previous!==null:value.previous===null||sceneHistoryLocator(value.previous,storageScope).count!==value.start)fail('续场历史分页前序数量不符');
  const seen=new Set();for(const meta of value.versions){validateSceneMetadata(meta,storageScope);if(seen.has(meta.digest))fail('续场历史分页版本重复');seen.add(meta.digest);}return value;
}

// Every page and every declared branch is checked before returning the v1
// semantic view consumed by the existing runtime. This cold compatibility
// path intentionally does not claim lazy/history-free reads. Tails are returned
// only as verified preparation data for the append writer, never execution rights.
export async function readSceneDirectory(value,{namespace,scope,readImmutable,readImmutableBatch,check=async()=>{}}={}){
  value=structuredClone(value);
  validateSceneDirectory(value,namespace,scope);await check();
  if(value.schema===COMFY_SCENE_NATIVE_SCHEMA)return {root:value,index:value,metadataBytes:sceneBytes(value),historyBytes:0,tails:new Map(),historySizes:new Map()};
  const index={...structuredClone(value),schema:COMFY_SCENE_NATIVE_SCHEMA,entries:new Array(value.entries.length)},tails=new Map(),historySizes=new Map(),pending=[];let historyBytes=0;
  for(const [at,entry]of value.entries.entries()){
    if(Object.hasOwn(entry,'versions'))index.entries[at]=entry;
    else pending.push({at,entry,pages:[],seen:new Set(),locator:sceneHistoryLocator(entry.history,scope),bytes:0});
  }
  if(pending.length&&typeof readImmutable!=='function'&&typeof readImmutableBatch!=='function')fail('续场历史读取器不可用');
  // Different scene chains can advance together; a chain never skips its prior
  // page. No cache and no partial success: all complete histories still validate.
  for(let cursor=0;cursor<pending.length;){
    const batch=pending.slice(cursor,cursor+4);cursor+=batch.length;
    for(const row of batch){if(row.seen.has(row.locator.reference.fingerprint))fail('续场历史分页循环引用');row.seen.add(row.locator.reference.fingerprint);}await check();
    const references=batch.map(row=>row.locator.reference),loaded=readImmutableBatch?await readImmutableBatch(references):await Promise.allSettled(references.map(reference=>readImmutable(reference)));
    if(!Array.isArray(loaded)||loaded.length!==batch.length)fail('续场历史批次未完整返回');
    const captured=loaded.map(result=>result?.status==='fulfilled'?{value:structuredClone(result.value?.value)}:{failure:result?.reason||Error('续场历史原件不可读取')});await check();
    for(let i=0;i<batch.length;i++){
      const row=batch[i],{entry,locator,pages}=row;if(captured[i].failure)throw captured[i].failure;
      const page=validateSceneHistoryPage(captured[i].value,{namespace,scope:entry.scope,storageScope:scope,count:locator.count}),key=comfySceneScopeKey(entry.scope);
      if(!pages.length)tails.set(key,{page,locator});const bytes=sceneBytes(page);row.bytes+=bytes;historyBytes+=bytes;
      if(historyBytes>COMFY_SCENE_HISTORY_LIMITS.totalBytes)fail('续场完整历史超过本版兼容读取范围，未截断');pages.push(page.versions);
      if(page.previous!==null){row.locator=sceneHistoryLocator(page.previous,scope);pending.push(row);continue;}
      const expanded={scope:entry.scope,blocked:entry.blocked,versions:pages.reverse().flat()};
      if(expanded.versions.length!==entry.history.count||!sceneSame(sceneLeaves(expanded),entry.heads))fail('续场完整历史与当前分支不一致');index.entries[row.at]=expanded;historySizes.set(key,row.bytes);
    }
  }
  // Full original predecessor ordering, duplicate detection and quotas remain.
  validateSceneIndex(index,namespace,scope);await check();return {root:value,index,metadataBytes:sceneBytes(value)+historyBytes,historyBytes,tails,historySizes};
}
