import {createHash} from 'node:crypto';
import {createImageServiceStore} from './qianmu-image-service-store.js';
import {normalizeImageServiceChannel} from './qianmu-image-service-queue.js';
import {normalizeNovelServiceChannel} from './qianmu-novel-service-channel-state.js';
import {normalizeNativeReview} from './qianmu-native-review-contract.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,message)=>Object.assign(new Error(message),{code:`image_service_review_${code}`,status:409,submissionState:'not_submitted',retryable:false});

// Reviews do not run generators. A durable intent precedes releasing occupancy; the fee ledger
// retains the unknown-charge fact and an exact, resumable acknowledgement after partial failure.
export function createNativeRequestReview({dataRoot,store,kind,resultAvailable,channelStore=createImageServiceStore({dataRoot,scope:'novel-channel',lockWaitMs:2000}),now=Date.now}){
  if(!['image','vibe'].includes(kind)||typeof resultAvailable!=='function')throw fail('setup','原生请求核查尚未接通');
  let closed=false;const pending=new Set();
  const check=valid=>{if(closed||!valid())throw fail('account','ST 账户或服务会话已变化，请重新核查');};
  const owns=(row,value)=>row?.namespace===value.namespace&&row?.attemptId===value.attemptId;
  const matches=(row,value,fee)=>owns(row,value)&&row.kind===kind&&row.requestDigest===fee.requestDigest;
  async function occupancy(value,fee,valid){
    if(fee.nativeReceipt&&fee.nativeReceipt.kind!==kind)throw fail('identity','原请求的渠道类别不符');
    const key=fee.nativeReceipt?.channelKey||(kind==='image'?value.channelKey:null);
    if(key){
      const state=normalizeNovelServiceChannel(await channelStore.inspectChannel(key),key);check(valid);
      return matches(state.entries[0],value,fee)?{channelKey:key,...state.entries[0]}:null;
    }
    // Legacy Vibe rows did not retain the native channel key. Only bounded owned metadata is inspected.
    let cursor=null,found=[];
    for(let page=0;page<3;page++){
      const rows=await channelStore.inspectAccount(value.namespace,{cursor,limit:50});check(valid);
      found.push(...rows.entries.filter(row=>matches(row,value,fee)));cursor=rows.nextCursor;if(!cursor)break;
    }
    if(cursor||found.length>1)throw fail('ambiguous','旧请求渠道来源不唯一，请先保全并离线核查');
    return found[0]||null;
  }
  async function plan(value,valid){
    check(valid);const state=normalizeImageServiceChannel(await store.inspectChannel(value.channelKey),value.channelKey);check(valid);
    const fee=state.entries.find(row=>owns(row,value));if(!fee)throw fail('missing','未找到当前账户的原请求');
    if(fee.nativeReview?.occupancy&&!matches(fee.nativeReview.occupancy,value,fee))throw fail('identity','原核查凭据与费用记录不符');
    const cached=await resultAvailable(value,fee);check(valid);
    const native=fee.nativeReview?.occupancy??await occupancy(value,fee,valid);
    const reviewed=fee.nativeReview?.completedAt!==undefined;
    const pendingState=['reserved','submitting'].includes(fee.status)||native&&['reserved','submitting'].includes(native.status);
    const canReview=!reviewed&&!cached&&!pendingState&&['uncertain','acknowledged'].includes(fee.status);
    const confirmation=fee.nativeReview?.confirmation||(canReview?hash({version:1,kind,namespace:value.namespace,channelKey:value.channelKey,fee,occupancy:native}):'');
    const view={version:1,kind,attemptId:fee.attemptId,requestDigest:fee.requestDigest,status:fee.status,updatedAt:fee.updatedAt,
      resultAvailable:cached,canReview,reviewed,confirmation,
      message:reviewed?'原结果未知的费用事实已保留，已完成核查':cached?'原结果可领取，请先领取':pendingState?'原请求仍在途；遗留状态需先停止服务后离线核查':canReview?'请先核对渠道任务和账单；确认上游已结束，不代表退款或未收费':'此记录不需要解除未知请求限制',
      ...(fee.nativeReceipt?.clientAttemptId?{serviceDelivery:{version:1,channelKey:fee.nativeReceipt.channelKey,clientAttemptId:fee.nativeReceipt.clientAttemptId}}:{})};
    return {fee,native,view};
  }
  async function confirm(value,input,valid){
    if(input?.ended!==true||input?.possibleCharge!==true||typeof input.confirmation!=='string'||!/^[a-f0-9]{64}$/.test(input.confirmation))throw fail('consent','请明确确认上游已结束，并保留可能已收费的事实');
    const original=await plan(value,valid);if(original.view.confirmation!==input.confirmation)throw fail('changed','原请求已变化，请刷新后重新核查');
    if(original.view.reviewed)return original.view;
    if(!original.view.canReview)throw fail('pending',original.view.message);
    const intent=original.fee.nativeReview||normalizeNativeReview({version:1,confirmation:input.confirmation,previousStatus:'uncertain',at:Math.max(now(),original.fee.updatedAt),occupancy:original.native});
    // Commit intent BEFORE touching another store. No historical fee row is removed or marked rejected.
    await store.transaction(value.channelKey,raw=>{
      check(valid);const state=normalizeImageServiceChannel(raw,value.channelKey),row=state.entries.find(item=>owns(item,value));
      if(row?.nativeReview?.confirmation===intent.confirmation)return {state};
      if(!equal(row,original.fee))throw fail('changed','费用记录已变化，未覆盖');
      row.nativeReview=intent;row.updatedAt=Math.max(row.updatedAt,intent.at);return {state};
    });check(valid);
    if(intent.occupancy){
      const expected=intent.occupancy,key=expected.channelKey;
      await channelStore.transaction(key,raw=>{
        check(valid);const state=normalizeNovelServiceChannel(raw,key),row=state.entries[0];
        // An already-released gate may have a newer owner. Never touch that later task.
        if(!row||row.fence!==expected.fence||row.ownerId!==expected.ownerId)return {state};
        if(!matches(row,value,original.fee)||!['uncertain','released'].includes(row.status))throw fail('changed','共用渠道仍在途或已变化，未解除占用');
        row.status='released';row.updatedAt=Math.max(now(),row.updatedAt);return {state};
      });check(valid);
    }
    await store.transaction(value.channelKey,raw=>{
      check(valid);const state=normalizeImageServiceChannel(raw,value.channelKey),row=state.entries.find(item=>owns(item,value));
      if(row?.nativeReview?.confirmation!==intent.confirmation||!['uncertain','acknowledged','succeeded'].includes(row.status))throw fail('changed','原核查状态已变化，请刷新');
      if(row.status==='uncertain')row.status='acknowledged';
      row.nativeReview.completedAt??=Math.max(now(),row.nativeReview.at);row.updatedAt=Math.max(row.updatedAt,row.nativeReview.completedAt);return {state};
    });check(valid);return (await plan(value,valid)).view;
  }
  function track(work){if(closed||pending.size>=8)return Promise.reject(fail('busy','核查正在进行或服务正在停止'));const task=work();pending.add(task);return task.finally(()=>pending.delete(task));}
  return {
    inspect:(value,{valid=()=>true}={})=>track(async()=>(await plan(value,valid)).view),
    confirm:(value,input,{valid=()=>true}={})=>track(()=>confirm(value,input,valid)),
    async close(){closed=true;await Promise.allSettled([...pending]);await channelStore.close();},
  };
}
