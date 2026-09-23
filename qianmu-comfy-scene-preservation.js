import {createConfiguredStAccountStorage,stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';
import {comfySceneLockError} from './qianmu-comfy-scene-lock.js';
import {validateComfySceneSnapshot,comfySceneSnapshotDigest,comfySceneSnapshotBytes,sameComfySceneSnapshot} from './qianmu-comfy-scene-backup.js';

export const COMFY_SCENE_SOURCE_SLOT='comfy-scene-sources',COMFY_SCENE_ORIGINAL_SLOT='comfy-scene-original';
export const COMFY_SCENE_SOURCE_SCHEMA='qianmu.comfy.scene-sources.v1',COMFY_SCENE_ORIGINAL_SCHEMA='qianmu.comfy.scene-original.v1';
const fail=message=>{throw comfySceneLockError('preservation',message);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const ref=(value,scope)=>stAccountImmutableReference(value,{scope,slot:COMFY_SCENE_ORIGINAL_SLOT,maxBytes:8*1024*1024+1024});
function validateIndex(value,namespace,scope){
  if(!exact(value,['schema','namespace','revision','sources'])||value.schema!==COMFY_SCENE_SOURCE_SCHEMA||value.namespace!==namespace||!integer(value.revision)
    ||!Array.isArray(value.sources)||value.sources.length>256||comfySceneSnapshotBytes(value)>512*1024)fail('续场保全目录格式或账户无效');
  const ids=new Set();for(const source of value.sources){
    if(!exact(source,['digest','reference','count','documentBytes','generation'])||!digest(source.digest)||ids.has(source.digest)
      ||!['count','documentBytes','generation'].every(k=>integer(source[k]))||source.count>1024||source.documentBytes>4*1024*1024)fail('续场完整来源计值无效');
    ids.add(source.digest);ref(source.reference,scope);
  }return value;
}

// Preservation is NOT reconciliation or permission to execute. Conflicting
// complete sources coexist; no latest-by-time/revision choice is made here.
// The following runtime unit must also preserve local atomic reservation and
// late results before consuming a source on another device.
export function createComfyScenePreservation({local,createStorage=createConfiguredStAccountStorage,requireExisting=false}={}){
  if(!local||typeof local.snapshot!=='function'||typeof local.assertSnapshot!=='function')fail('缺少完整续场两表读取器');
  let client,opening,closed=false,known=requireExisting===true,queue=Promise.resolve();
  const operation=(namespace,options,work)=>{
    namespace=assertComfyRouteNamespace(namespace);const captured={...options},valid=()=>!closed&&!captured.signal?.aborted&&(!captured.isCurrent||captured.isCurrent()===true);
    const check=async()=>{if(!valid()||await captured.guard?.()===false||!valid())fail('续场原件保全账户或页面已变化');return true;};
    const task=queue.then(async()=>{
      await check();opening??=Promise.resolve().then(()=>createStorage({maxBytes:8*1024*1024,isCurrent:()=>!closed})).then(value=>{if(closed||value.namespace!==namespace){value.close();fail('续场原件保全账户不符');}client=value;return value;}).catch(error=>{opening=null;throw error;});
      await opening;await check();if(client.namespace!==namespace)fail('续场原件会话不能切换账户');
      const transport={guard:check,signal:captured.signal};
      const read=async()=>{const found=await client.read(COMFY_SCENE_SOURCE_SLOT,transport);await check();if(!found.exists&&known)fail('已确认的续场保全目录缺失，未建立空目录');
        if(found.exists){validateIndex(found.value,namespace,client.scope);known=true;}return found;};
      let found=await read(),index=found.exists?structuredClone(found.value):{schema:COMFY_SCENE_SOURCE_SCHEMA,namespace,revision:0,sources:[]};
      const original=async source=>{
        const result=await client.readImmutable(ref(source.reference,client.scope),transport),value=result.value;
        if(!exact(value,['schema','namespace','snapshot'])||value.schema!==COMFY_SCENE_ORIGINAL_SCHEMA||value.namespace!==namespace||value.snapshot?.namespace!==namespace)fail('完整续场原件账户或格式无效');
        const stats=validateComfySceneSnapshot(value.snapshot);if(await comfySceneSnapshotDigest(value.snapshot)!==source.digest||stats.count!==source.count||stats.documentBytes!==source.documentBytes||stats.generation!==source.generation)fail('完整续场原件与目录不符');
        await check();return value.snapshot;
      };
      const save=async next=>{next.revision=index.revision+1;validateIndex(next,namespace,client.scope);await check();known=true;
        found=await client.write(COMFY_SCENE_SOURCE_SLOT,next,{...transport,expectedFingerprint:found.fingerprint});await check();if(!sameComfySceneSnapshot(found.value,next))fail('续场保全目录尚未读回');index=structuredClone(found.value);};
      const result=await work({get index(){return index;},original,save,transport,check,valid});await check();if((await read()).fingerprint!==found.fingerprint)fail('续场保全目录在读取期间变化');return structuredClone(result);
    });queue=task.then(()=>{},()=>{});return task;
  };
  return Object.freeze({
    concurrency:'optimistic-non-cas',
    preserve(namespace,options={}){return operation(namespace,options,async ctx=>{
      const snapshot=await local.snapshot(namespace,{isCurrent:ctx.valid}),stats=validateComfySceneSnapshot(snapshot);await ctx.check();
      if(snapshot.namespace!==namespace)fail('本机续场来源账户不符');const sourceDigest=await comfySceneSnapshotDigest(snapshot);await ctx.check();
      const stable=async()=>{await local.assertSnapshot(snapshot,{isCurrent:ctx.valid});await ctx.check();};await stable();
      const existing=ctx.index.sources.find(row=>row.digest===sourceDigest);
      if(existing){const preserved=await ctx.original(existing);if(!sameComfySceneSnapshot(preserved,snapshot))fail('续场完整来源内容不一致');await stable();return {source:existing,snapshot:preserved,empty:false};}
      // Preserve an empty tombstone with a real usage row too; absent metadata
      // is a different source and cannot prove that another device was cleared.
      if(snapshot.usage===null&&!snapshot.rows.length)return {source:null,snapshot,empty:true};
      if(ctx.index.sources.length>=256)fail('续场保全来源达到上限，未删减旧来源');
      const value={schema:COMFY_SCENE_ORIGINAL_SCHEMA,namespace,snapshot},saved=await client.preserveImmutable(COMFY_SCENE_ORIGINAL_SLOT,value,ctx.transport);
      if(!sameComfySceneSnapshot(saved.value,value))fail('续场完整原件尚未读回');await stable();
      const source={digest:sourceDigest,reference:ref(saved.reference,client.scope),count:stats.count,documentBytes:stats.documentBytes,generation:stats.generation};
      const next=structuredClone(ctx.index);next.sources.push(source);await stable();await ctx.save(next);await stable();return {source,snapshot,empty:false};
    });},
    sources(namespace,options={}){return operation(namespace,options,async ctx=>ctx.index);},
    readSource(namespace,sourceDigest,options={}){if(!digest(sourceDigest))return Promise.reject(comfySceneLockError('preservation','续场来源编号无效'));
      return operation(namespace,options,async ctx=>{const source=ctx.index.sources.find(row=>row.digest===sourceDigest);if(!source)fail('完整续场来源不存在');return ctx.original(source);});},
    close(){closed=true;client?.close();},
  });
}
