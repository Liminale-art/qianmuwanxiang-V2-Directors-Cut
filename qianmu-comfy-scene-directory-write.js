import {comfySceneScopeKey} from './qianmu-comfy-scene-lock.js';
import {COMFY_SCENE_NATIVE_SCHEMA,validateSceneIndex,sceneSame,sceneBytes,sceneLeaves,sceneNativeFail as fail} from './qianmu-comfy-scene-native-contract.js';
import {COMFY_SCENE_HYBRID_SCHEMA as schema,COMFY_SCENE_HISTORY_SCHEMA as pageSchema,COMFY_SCENE_HISTORY_SLOT as slot,
  COMFY_SCENE_HISTORY_LIMITS as limits,validateSceneDirectory,validateSceneHistoryPage,sceneHistoryLocator} from './qianmu-comfy-scene-directory.js';

// No user-facing mode or background migration. Activation occurs only during an
// already-authorized ordinary save, once retained history outweighs current heads.
export const COMFY_SCENE_DIRECTORY_WRITE_POLICY=Object.freeze({minVersions:64,minBytes:16*1024});
export const shouldPageSceneEntry=entry=>entry.versions.length>=COMFY_SCENE_DIRECTORY_WRITE_POLICY.minVersions&&sceneBytes(entry)>=COMFY_SCENE_DIRECTORY_WRITE_POLICY.minBytes;
export function shouldPageSceneDirectory(index){
  return index.entries.some(shouldPageSceneEntry);
}
function appendOnly(before,after){
  const initial=before.revision===0&&before.generation===0&&!before.cleared&&!before.entries.length&&!before.sources.length;
  if(after.revision!==before.revision+1||after.generation<before.generation||!initial&&after.generation>before.generation+1||before.cleared&&!after.cleared
    ||after.sources.length<before.sources.length||!sceneSame(after.sources.slice(0,before.sources.length),before.sources)||after.entries.length<before.entries.length)fail('续场追加保存不能移除旧来源或改变前序');
  for(let i=0;i<before.entries.length;i++){
    const old=before.entries[i],next=after.entries[i];
    if(!sceneSame(old.scope,next.scope)||next.versions.length<old.versions.length||!sceneSame(next.versions.slice(0,old.versions.length),old.versions))fail('续场追加保存不能重写或截断历史');
  }
}
const unpaged=index=>({root:index,index,metadataBytes:sceneBytes(index),historyBytes:0,tails:new Map(),historySizes:new Map()});

// Produces immutable pages first, never publishes the shared root. The caller
// must still save with the original expected fingerprint and verify readback.
// Abandoned page bodies and all previous roots stay available for recovery.
export async function prepareSceneDirectoryWrite(next,{current,namespace,scope,preserveImmutable,check=async()=>{}}){
  next=structuredClone(next);current=structuredClone(current);
  validateSceneIndex(next,namespace,scope);validateSceneIndex(current.index,namespace,scope);validateSceneDirectory(current.root,namespace,scope);appendOnly(current.index,next);
  const paged=current.root.schema!==COMFY_SCENE_NATIVE_SCHEMA;
  if(paged?current.root.entries.length!==current.index.entries.length:!sceneSame(current.root,current.index))fail('续场追加目录来源不一致');await check();
  if(!shouldPageSceneDirectory(next))return unpaged(next);
  if(typeof preserveImmutable!=='function')fail('续场分页保存器不可用');
  // A huge explicit merge may have many parents. If even one metadata item
  // cannot fit a page, preserve the complete v1 contract rather than truncate it.
  const largestPrevious={reference:{version:1,scope,slot,fingerprint:'f'.repeat(64),bytes:limits.pageBytes+1024},count:8192};
  for(const entry of next.entries.filter(shouldPageSceneEntry))for(const meta of entry.versions){
    if(sceneBytes({schema:pageSchema,namespace,scope:entry.scope,start:8192,previous:largestPrevious,versions:[meta]})>limits.pageBytes)return unpaged(next);
  }
  const root={...next,schema,entries:[]},tails=new Map(),historySizes=new Map();let historyBytes=0;
  for(let i=0;i<next.entries.length;i++){
    const entry=next.entries[i],key=comfySceneScopeKey(entry.scope),old=current.index.entries[i],candidate=paged&&current.root.entries[i],prior=candidate&&Object.hasOwn(candidate,'history')?candidate:null,tail=prior&&current.tails.get(key);
    if(!shouldPageSceneEntry(entry)){root.entries.push(entry);continue;}
    let previous=null,start=0,versions=entry.versions,entryBytes=prior?current.historySizes.get(key):0;
    if(!Number.isSafeInteger(entryBytes)||entryBytes<0||entryBytes>limits.totalBytes)fail('续场分页计值无效');
    if(prior){
      if(!old||!tail||!sceneSame(prior.scope,entry.scope)||!sceneSame(tail.locator,prior.history)||old.versions.length!==prior.history.count
        ||!sceneSame(sceneLeaves(old),prior.heads))fail('续场分页写入缺少已核验原前序');
      validateSceneHistoryPage(tail.page,{namespace,scope:entry.scope,storageScope:scope,count:prior.history.count});sceneHistoryLocator(tail.locator,scope);
      if(!sceneSame(tail.page.versions,old.versions.slice(tail.page.start)))fail('续场尾页与原历史不一致');
      if(entry.versions.length===old.versions.length){root.entries.push({scope:entry.scope,blocked:entry.blocked,heads:sceneLeaves(entry),history:prior.history});tails.set(key,tail);historySizes.set(key,entryBytes);historyBytes+=entryBytes;if(historyBytes>limits.totalBytes)fail('续场完整历史超过分页容量，原目录未替换');continue;}
      if(tail.page.versions.length<limits.pageEntries){
        previous=tail.page.previous;start=tail.page.start;versions=entry.versions.slice(start);entryBytes-=sceneBytes(tail.page);if(entryBytes<0)fail('续场分页计值无效');
      }else{previous=prior.history;start=old.versions.length;versions=entry.versions.slice(start);}
    }
    for(let at=0;at<versions.length;){
      const page={schema:pageSchema,namespace,scope:entry.scope,start,previous,versions:[]};let bytes=sceneBytes(page);
      while(at<versions.length&&page.versions.length<limits.pageEntries){const size=sceneBytes(versions[at])+(page.versions.length?1:0);if(bytes+size>limits.pageBytes)break;bytes+=size;page.versions.push(versions[at++]);}
      if(!page.versions.length)fail('续场单项元数据超过分页容量，未截断');
      const count=start+page.versions.length;validateSceneHistoryPage(page,{namespace,scope:entry.scope,storageScope:scope,count});
      entryBytes+=bytes;if(historyBytes+entryBytes>limits.totalBytes)fail('续场完整历史超过分页容量，原目录未替换');await check();
      let reference;
      if(tail&&sceneSame(page,tail.page))reference=tail.locator.reference;
      else{const saved=await preserveImmutable(slot,page);await check();if(!sceneSame(saved.value,page))fail('续场历史分页尚未完整读回');reference=saved.reference;}
      previous=sceneHistoryLocator({reference,count},scope);tails.set(key,{page,locator:previous});start=count;
    }
    root.entries.push({scope:entry.scope,blocked:entry.blocked,heads:sceneLeaves(entry),history:previous});
    historyBytes+=entryBytes;historySizes.set(key,entryBytes);
  }
  validateSceneDirectory(root,namespace,scope);await check();return {root,index:next,metadataBytes:sceneBytes(root)+historyBytes,historyBytes,tails,historySizes};
}
