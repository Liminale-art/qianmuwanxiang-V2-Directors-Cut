import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {comfySceneScope,comfySceneScopeKey} from './qianmu-comfy-scene-lock.js';
import {COMFY_SCENE_NATIVE_SCHEMA,validateSceneIndex,validateSceneMetadata,sceneLeaves,sceneSame,sceneBytes,sceneNativeFail as fail} from './qianmu-comfy-scene-native-contract.js';

// Read-compatibility stage only. No v2 writer, migration or deletion is exposed.
// A root retains every current branch. Linked immutable pages retain the full
// chronological metadata catalogue; transition originals remain unchanged.
export const COMFY_SCENE_DIRECTORY_SCHEMA='qianmu.comfy.scene-runtime.v2';
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
// path intentionally does not claim lazy/history-free reads or enable v2 writes.
export async function readSceneDirectory(value,{namespace,scope,readImmutable,check=async()=>{}}={}){
  value=structuredClone(value);
  validateSceneDirectory(value,namespace,scope);await check();
  if(value.schema!==COMFY_SCENE_DIRECTORY_SCHEMA)return {index:value,metadataBytes:sceneBytes(value),readOnly:false};
  if(typeof readImmutable!=='function')fail('续场历史读取器不可用');
  const index={...structuredClone(value),schema:COMFY_SCENE_NATIVE_SCHEMA,entries:[]};let historyBytes=0;
  for(const entry of value.entries){
    const pages=[],seen=new Set();let locator=sceneHistoryLocator(entry.history,scope);
    while(locator){
      if(seen.has(locator.reference.fingerprint))fail('续场历史分页循环引用');seen.add(locator.reference.fingerprint);await check();
      const saved=await readImmutable(locator.reference),original=structuredClone(saved.value);await check();const page=validateSceneHistoryPage(original,{namespace,scope:entry.scope,storageScope:scope,count:locator.count});
      historyBytes+=sceneBytes(page);if(historyBytes>COMFY_SCENE_HISTORY_LIMITS.totalBytes)fail('续场完整历史超过本版兼容读取范围，未截断');pages.push(page.versions);
      locator=page.previous===null?null:sceneHistoryLocator(page.previous,scope);
    }
    const expanded={scope:entry.scope,blocked:entry.blocked,versions:pages.reverse().flat()};
    if(expanded.versions.length!==entry.history.count||!sceneSame(sceneLeaves(expanded),entry.heads))fail('续场完整历史与当前分支不一致');index.entries.push(expanded);
  }
  // Full original predecessor ordering, duplicate detection and quotas remain.
  validateSceneIndex(index,namespace,scope);await check();return {index,metadataBytes:sceneBytes(value)+historyBytes,readOnly:true};
}
