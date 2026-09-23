import {createConfiguredStAccountStorage,stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {validateStoryboardPackageCheckpoint as validate,prepareVibeStageCheckpoint,sameVibeStageDefinition,VIBE_STAGE_PHASES} from './qianmu-vibe-stage-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const VIBE_STAGE_SLOT='vibe-stage-journal';
const schema='qianmu.vibe.stage-journal.v1',legacySlot='vibe-stage-legacy',endedSlot='vibe-stage-ended',maxOriginal=256*1024,maxIndex=8*1048576;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=message=>{throw Object.assign(Error(message),{code:'vibe_stage_native',submissionState:'not_submitted'});};
const empty=namespace=>({schema,namespace,revision:0,active:[],ended:[]});

// Stage metadata is not permission, proof of existing assets or saved settings.
// Keep all old rows and ended generations; never delete IDB or replay a stage.
// The native transport provides optimistic readback, NOT cross-device CAS.
export function createNativeVibeStageJournal({legacy,createStorage=createConfiguredStAccountStorage,now=Date.now}={}){
  let opening,storage,closed=false,busy=false,known=false;
  async function operation(namespace,options,work){
    options={...options};
    if(closed||busy)fail('素材暂存记录正在核对或已关闭');
    if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))fail('素材暂存账户无效');
    busy=true;
    const check=async()=>{if(closed||options.signal?.aborted||options.isCurrent&&options.isCurrent()!==true)fail('素材暂存账户或页面已变化');
      if(await options.guard?.()===false)fail('素材暂存账户核对未通过');
      if(closed||options.signal?.aborted||options.isCurrent&&options.isCurrent()!==true)fail('素材暂存账户或页面已变化');return true;};
    try{
      await check();opening??=Promise.resolve().then(()=>createStorage({maxBytes:maxIndex,isCurrent:()=>!closed})).then(value=>{
        if(closed||value.namespace!==namespace){value.close();fail('素材暂存账户不符');}storage=value;return value;
      }).catch(error=>{opening=null;throw error;});const client=await opening;await check();if(client.namespace!==namespace)fail('素材暂存会话不能切换账户');
      const transport={guard:check,signal:options.signal};
      const reference=(ref,slot)=>stAccountImmutableReference(ref,{scope:client.scope,slot,maxBytes:maxOriginal+1024});
      function entry(value){
        if(!exact(value,['row','legacy','prior'])||!Array.isArray(value.legacy)||value.legacy.length>256||size(value)>maxOriginal)fail('素材暂存原件目录无效');
        validate(value.row);if(value.row.namespace!==namespace)fail('素材暂存原件账户不符');if(value.prior!==null)reference(value.prior,endedSlot);
        const seen=new Set();for(const source of value.legacy){
          if(!exact(source,['digest','reference'])||typeof source.digest!=='string'||!/^[a-f0-9]{64}$/.test(source.digest)||seen.has(source.digest))fail('素材暂存旧源目录无效');
          seen.add(source.digest);reference(source.reference,legacySlot);
        }return value;
      }
      function index(value){
        if(!exact(value,['schema','namespace','revision','active','ended'])||value.schema!==schema||value.namespace!==namespace||!Number.isSafeInteger(value.revision)||value.revision<0
          ||!Array.isArray(value.active)||value.active.length>8||!Array.isArray(value.ended)||value.ended.length>8192||size(value)>maxIndex)fail('素材暂存目录损坏或超限，原资料保留');
        const seen=new Set();for(const valueEntry of value.active){entry(valueEntry);if(seen.has(valueEntry.row.key))fail('素材暂存记录重复');seen.add(valueEntry.row.key);}
        for(const ended of value.ended){
          if(!exact(ended,['key','revision','reference'])||typeof ended.key!=='string'||!Number.isSafeInteger(ended.revision)||ended.revision<1)fail('素材暂存结束依据无效');
          let parts;try{parts=JSON.parse(ended.key);}catch{fail('素材暂存结束编号损坏');}
          if(!Array.isArray(parts)||parts.length!==3||parts[0]!==namespace||parts.slice(1).some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))||JSON.stringify(parts)!==ended.key||seen.has(ended.key))fail('素材暂存结束归属不符');
          seen.add(ended.key);reference(ended.reference,endedSlot);
        }return value;
      }
      async function read(){const result=await client.read(VIBE_STAGE_SLOT,transport);await check();if(!result.exists&&known)fail('已确认的素材暂存目录缺失，未重建空库');
        if(result.exists){index(result.value);known=true;}return result;}
      async function old(){const rows=structuredClone(await legacy.list(namespace));await check();
        if(!Array.isArray(rows)||rows.length>8||new Set(rows.map(row=>validate(row).key)).size!==rows.length||rows.some(row=>row.namespace!==namespace))fail('旧素材暂存记录损坏或超限');
        if(rows.some(row=>Object.is(row.createdAt,-0)||Object.is(row.updatedAt,-0)||Object.keys(row.assetIds).length!==row.assetIds.length))fail('旧素材暂存记录不能无损保存，原记录保留');return rows;}
      let found=await read(),value=found.exists?structuredClone(found.value):empty(namespace);const baseline=await old();
      const unchanged=async()=>{await check();if(!same(await old(),baseline))fail('旧页面修改了素材暂存记录，请重新核对');return true;};
      async function save(next){index(next);await unchanged();const result=await client.write(VIBE_STAGE_SLOT,next,{...transport,guard:unchanged,expectedFingerprint:found.fingerprint});known=true;await check();
        if(!same(result.value,next))fail('素材暂存目录尚未完整读回');found=result;value=structuredClone(next);await unchanged();
        if((await read()).fingerprint!==found.fingerprint)fail('另一端修改了素材暂存目录，请重新核对');}
      async function endedEntry(marker){const result=await client.readImmutable(marker.reference,transport);await check();const saved=entry(result.value);
        if(saved.row.key!==marker.key||saved.row.revision!==marker.revision)fail('素材暂存结束原件不符');return structuredClone(saved);}
      async function preserveEnded(saved){entry(saved);const result=await client.preserveImmutable(endedSlot,saved,transport);await check();if(!same(result.value,saved))fail('素材暂存结束原件未完整保全');
        return {key:saved.row.key,revision:saved.row.revision,reference:result.reference};}
      const activeKeys=new Set(value.active.map(item=>item.row.key)),endedKeys=new Set(value.ended.map(item=>item.key));
      if(value.active.length+baseline.filter(row=>!activeKeys.has(row.key)&&!endedKeys.has(row.key)).length>8)fail('合并后超过8份待核对素材暂存，双方记录保留，未裁剪');
      for(const row of baseline){
        const next=structuredClone(value),at=next.active.findIndex(item=>item.row.key===row.key),endAt=next.ended.findIndex(item=>item.key===row.key);
        const saved=at>=0?next.active[at]:endAt>=0?await endedEntry(next.ended[endAt]):{row,legacy:[],prior:null};
        const digest=await vibeDigest(JSON.stringify(row)),source=saved.legacy.find(item=>item.digest===digest);await check();
        if(source){const original=await client.readImmutable(source.reference,transport);await check();if(!same(original.value,row))fail('素材暂存旧源原件不符');continue;}
        // Progress differences are retained as history, not adopted as current
        // progress or allowed to resurrect a deliberately ended operation.
        const original=await client.preserveImmutable(legacySlot,row,transport);await check();if(!same(original.value,row))fail('旧素材暂存未完整保全');
        saved.legacy.push({digest,reference:original.reference});entry(saved);
        if(endAt>=0)next.ended[endAt]=await preserveEnded(saved);else if(at<0)next.active.push(saved);
        next.revision++;await save(next);
      }
      const state={get value(){return value;},check,endedEntry,preserveEnded,save:async next=>{next.revision=value.revision+1;await save(next);}};
      const result=await work(state);await unchanged();if((await read()).fingerprint!==found.fingerprint)fail('素材暂存目录在核对期间变化');return result;
    }finally{busy=false;}
  }
  return Object.freeze({...legacy,
    list(namespace,options={}){return operation(namespace,options,state=>structuredClone(state.value.active.map(item=>item.row)));},
    async prepare(input,options={}){
      const candidate=prepareVibeStageCheckpoint(input,now());
      return operation(candidate.namespace,options,async state=>{
        const existing=state.value.active.find(item=>item.row.key===candidate.key);if(existing){if(!sameVibeStageDefinition(existing.row,candidate))fail('分镜包与原暂存记录不符');return structuredClone(existing.row);}
        if(state.value.active.length>=8)fail('已有8份待核对素材暂存，未自动清除');
        const next=structuredClone(state.value),at=next.ended.findIndex(item=>item.key===candidate.key);let saved={row:candidate,legacy:[],prior:null};
        if(at>=0){const marker=next.ended[at],previous=await state.endedEntry(marker);if(!sameVibeStageDefinition(previous.row,candidate))fail('分镜包与原结束记录不符');
          saved={row:validate({...candidate,revision:previous.row.revision+1,createdAt:previous.row.createdAt,updatedAt:Math.max(candidate.updatedAt,previous.row.updatedAt)}),legacy:previous.legacy,prior:marker.reference};next.ended.splice(at,1);}
        next.active.push(saved);await state.save(next);return structuredClone(saved.row);
      });
    },
    async checkpoint(input,phase,options={}){
      const previous=structuredClone(validate(input));if(!VIBE_STAGE_PHASES.includes(phase)||phase==='prepared'||previous.phase==='prepared'&&phase!=='staging')fail('必须先暂存素材再标记核对完成');
      return operation(previous.namespace,options,async state=>{const next=structuredClone(state.value),saved=next.active.find(item=>item.row.key===previous.key);
        if(!same(saved?.row,previous))fail('素材暂存记录已变化，请重新核对');saved.row=validate({...previous,phase,revision:previous.revision+1,updatedAt:Math.max(previous.updatedAt,now())});
        await state.save(next);return structuredClone(saved.row);
      });
    },
    async dismissCheckpoint(input,{confirmed=false,...options}={}){
      const previous=structuredClone(validate(input));if(confirmed!==true)fail('尚未确认结束素材暂存核对');
      return operation(previous.namespace,options,async state=>{const next=structuredClone(state.value),at=next.active.findIndex(item=>item.row.key===previous.key);
        if(at<0||!same(next.active[at].row,previous))fail('素材暂存记录已变化，未结束');const marker=await state.preserveEnded(next.active[at]);next.active.splice(at,1);next.ended.push(marker);await state.save(next);return true;
      });
    },
    close(){closed=true;storage?.close();legacy.close();},
  });
}
