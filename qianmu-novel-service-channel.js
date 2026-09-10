import {randomUUID} from 'node:crypto';
import {createImageServiceStore} from './qianmu-image-service-store.js';
import {imageServiceChannelKey} from './qianmu-image-service-queue.js';
import {normalizeNovelServiceChannel} from './qianmu-novel-service-channel-state.js';

const fail=(code,message)=>Object.assign(new Error(message),{code:`image_service_channel_${code}`,status:409,submissionState:'not_submitted',retryable:false});
const same=(a,b)=>a?.namespace===b.namespace&&a?.kind===b.kind&&a?.attemptId===b.attemptId&&a?.requestDigest===b.requestDigest;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Separate instances/processes sharing the ST data directory see the same atomically claimed occupancy.
// There is no expiry, lock stealing or automatic replay. Unknown remote work remains fenced.
export function createNovelServiceChannel({dataRoot,store=createImageServiceStore({dataRoot,scope:'novel-channel',lockWaitMs:2000}),
  waitTimeoutMs=240000,pollMs=250,now=Date.now}={}){
  const ownerId=randomUUID(),pending=new Set();let closed=false;
  const deadline=Math.max(100,Math.min(240000,Number(waitTimeoutMs)||240000)),interval=Math.max(10,Math.min(1000,Number(pollMs)||250));
  const check=(valid,signal)=>{if(closed||signal?.aborted||!valid())throw fail('cancelled','NAI 渠道等待已取消，未提交本次请求');};
  async function transaction(key,reduce,{waiting=false,valid=()=>true,signal}={}){
    const end=Date.now()+(waiting?deadline:2000);
    while(true){
      if(waiting)check(valid,signal);
      try{return await store.transaction(key,raw=>{const state=normalizeNovelServiceChannel(raw,key);return {state,result:reduce(state)};});}
      catch(error){
        // Only retry failed lock acquisition / occupied-channel reads. Never retry an ambiguous committed write.
        if(!['image_service_storage_busy',...(waiting?['image_service_channel_waiting']:[])].includes(error?.code))throw error;
        if(Date.now()>=end)throw fail('busy','NAI 共用渠道仍在使用或待恢复；本次尚未提交，请核查原任务');
        await delay(interval);
      }
    }
  }
  async function execute(input,operation){
    const {apiKey,namespace,kind,attemptId,requestDigest,valid=()=>true,signal,onWarning=()=>{}}=input;
    check(valid,signal);const key=imageServiceChannelKey(apiKey),fence=randomUUID(),at=now();
    const row={namespace,kind,attemptId,requestDigest,fence,ownerId,status:'reserved',createdAt:at,updatedAt:at};
    normalizeNovelServiceChannel({schema:'qianmu.novel-occupancy.v1',channelKey:key,entries:[row]},key);
    await transaction(key,state=>{
      const old=state.entries[0];
      if(old?.status==='uncertain')throw fail('uncertain','NAI 共用渠道有结果未确认的原请求；请先领取原结果或核查，未提交本次请求');
      if(old&&old.status!=='released')throw fail('waiting','NAI 共用渠道正在处理原请求');
      state.entries=[row];
    },{waiting:true,valid,signal});
    let submitted=false,submitStarted=false,authorization,complete=false,failure;
    try{
      check(valid,signal);
      const result=await operation(Object.freeze({beforeSubmit:async()=>{
        if(submitStarted)throw Object.assign(fail('already_submitted','同一 NAI 渠道授权不可再次提交，请核查原请求'),{submissionState:'unknown'});
        submitStarted=true;
        authorization=(async()=>{
          check(valid,signal);
          await transaction(key,state=>{
            const current=state.entries[0];
            if(current?.fence!==fence||current.ownerId!==ownerId||current.status!=='reserved')throw fail('changed','原 NAI 渠道授权已变化，未再次提交');
            current.status='submitting';current.updatedAt=Math.max(now(),current.updatedAt);
          });
          check(valid,signal);submitted=true;
        })();return authorization;
      }}));
      complete=true;return result;
    }catch(error){failure=error;throw error;}
    finally{
      // Do not release occupancy while an earlier concurrent authorization callback can still complete.
      if(authorization)await authorization.catch(()=>{});
      try{await transaction(key,state=>{
        const current=state.entries[0];
        if(current?.fence!==fence||current.ownerId!==ownerId||current.status==='released')return;
        current.status=complete||!submitted||['not_submitted','rejected'].includes(failure?.submissionState)?'released':'uncertain';
        current.updatedAt=Math.max(now(),current.updatedAt);
      });}catch(_){try{onWarning();}catch(_){} }
    }
  }
  return {
    run(input,operation){
      if(closed||pending.size>=32||typeof operation!=='function')return Promise.reject(fail('capacity','NAI 共用渠道等待已满或服务正在停止'));
      const work=execute(input,operation);pending.add(work);return work.finally(()=>pending.delete(work));
    },
    async completeFromCache(identity){
      // Called only by an authenticated service AFTER validating its exact immutable result. Never exposed as a client assertion.
      const probe={...identity,fence:'evidence',ownerId:'evidence',status:'released',createdAt:0,updatedAt:0};
      normalizeNovelServiceChannel({schema:'qianmu.novel-occupancy.v1',channelKey:'0'.repeat(64),entries:[probe]},'0'.repeat(64));
      let cursor=null;
      for(let page=0;page<3;page++){
        const rows=await store.inspectAccount(identity.namespace,{cursor,limit:50});
        for(const old of rows.entries.filter(row=>same(row,identity)&&row.status!=='released')){
          await transaction(old.channelKey,state=>{const current=state.entries[0];if(!same(current,identity)||current.fence!==old.fence)return;
            current.status='released';current.updatedAt=Math.max(now(),current.updatedAt);});
        }
        cursor=rows.nextCursor;if(!cursor)return;
      }throw fail('capacity','NAI 渠道目录过大，请先核查');
    },
    async close(){closed=true;await Promise.allSettled([...pending]);await store.close();},
    inspect(){return {closed,pending:pending.size};},
  };
}
