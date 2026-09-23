import {createVibeReceiptCatalogue} from './qianmu-vibe-receipt-catalogue.js';
import {vibeReceiptEvidenceText} from './qianmu-vibe-receipt-original.js';
import {resolveVibeReviewHistory} from './qianmu-vibe-history.js';

const fail=message=>{throw Object.assign(Error(message),{code:'vibe_encoding_cache_native',submissionState:'not_submitted'});};
const same=(a,b)=>vibeReceiptEvidenceText(a)===vibeReceiptEvidenceText(b),bytes=row=>new TextEncoder().encode(JSON.stringify(row)).length;
const key=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('费用记录编号无效');};
const source=(value,cacheKey)=>{for(const section of ['current','archived']){const receipt=value[section].find(row=>row.cacheKey===cacheKey);if(receipt)return {namespace:value.namespace,section,receipt,segments:value.reviewSegments.filter(row=>row.cacheKey===cacheKey)};}return null;};

// ST is the shared evidence source; IDB remains the atomic local reservation
// and original-account return sink. Neither optimistic native readback nor a
// browser-local lock is advertised as a cross-device CAS or upstream fee proof.
export function createNativeVibeEncodingStore({legacy,createStorage,onProgress,guard,isCurrent,signal}={}){
  if(typeof legacy?.materialize!=='function')fail('本机费用预留尚未就绪');
  const catalogue=createVibeReceiptCatalogue({legacy,createStorage,onProgress});let closed=false,queue=Promise.resolve();
  const check=async()=>{if(closed||signal?.aborted||isCurrent&&isCurrent()!==true)fail('费用会话已变化');if(await guard?.()===false)fail('费用账户核对未通过');if(closed||signal?.aborted||isCurrent&&isCurrent()!==true)fail('费用会话已变化');return true;};
  const options={guard:check,signal,isCurrent:()=>!closed&&(!isCurrent||isCurrent()===true)};
  function run(args,work){const captured=structuredClone(args),task=queue.catch(()=>{}).then(async()=>{await check();const result=await work(...captured);await check();return structuredClone(result);});queue=task.then(()=>{},()=>{});return task;}
  async function checkout(namespace,cacheKey){
    key(cacheKey);const state=await catalogue.checkout(namespace,cacheKey,options);await check();
    // A concurrent local update must not be overwritten, even if ST still
    // contains a valid older snapshot. materialize compares the captured old
    // receipt AND complete segment rows inside its readwrite transaction.
    if(state.snapshot&&!same(state.snapshot,state.local))await legacy.materialize(namespace,state.snapshot,state.local);
    await check();return state;
  }
  async function publish(namespace,cacheKey,state,expected){
    const next=source(await legacy.census(namespace),cacheKey);await check();
    if(!next||!same(next.receipt,expected))fail('本机编码在保存期间变化，未授权新请求');
    await catalogue.publish(namespace,next,state.heads,options);await check();return next;
  }
  function mutate(name,args){return run(args,async(namespace,cacheKey,...rest)=>{
    const state=await checkout(namespace,cacheKey),result=await legacy[name](namespace,cacheKey,...rest);await check();
    const expected=result?.receipt||result;await publish(namespace,cacheKey,state,expected);return result;
  });}
  async function history(namespace,cacheKey,expected){
    const row=await catalogue.get(namespace,cacheKey,options);if(!row||!same(row.receipt,expected))fail('核查记录已变化，请刷新');
    return {receipt:row.receipt,segments:row.segments,reviews:await resolveVibeReviewHistory(namespace,cacheKey,row.receipt.reviewArchive,row.segments)};
  }
  async function inventory(namespace){
    const {rows,metadata}=await catalogue.readAll(namespace,options),current=rows.filter(row=>row.section==='current'),archived=rows.filter(row=>row.section==='archived'),segments=rows.flatMap(row=>row.segments);
    return {persistence:'st-account-file',receipts:current.map(row=>row.receipt),archived:{namespace,count:archived.length,bytes:archived.reduce((n,row)=>n+bytes(row.receipt),0)},
      reviewHistory:{namespace,count:segments.length,bytes:segments.reduce((n,row)=>n+bytes(row),0),reviews:segments.reduce((n,row)=>n+row.reviews.length,0)},metadata};
  }
  return Object.freeze({
    get(namespace,cacheKey){return run([namespace,cacheKey],async(ns,id)=>(await catalogue.get(ns,id,options))?.receipt||null);},
    list(namespace){return run([namespace],async ns=>(await catalogue.readAll(ns,options)).rows.filter(row=>row.section==='current').map(row=>row.receipt));},
    inventory(namespace){return run([namespace],inventory);},
    archiveUsage(namespace){return run([namespace],async ns=>(await inventory(ns)).archived);},
    archivePage(namespace,{after=''}={}){return run([namespace,after],async(ns,cursor)=>{
      if(cursor!=='')key(cursor);const rows=(await catalogue.readAll(ns,options)).rows.filter(row=>row.section==='archived').map(row=>row.receipt).sort((a,b)=>a.cacheKey.localeCompare(b.cacheKey)),page=rows.filter(row=>row.cacheKey>cursor).slice(0,41);
      return {rows:page.slice(0,40),next:page.length>40?page[39].cacheKey:'',count:rows.length,bytes:rows.reduce((n,row)=>n+bytes(row),0)};
    });},
    reviewHistory(namespace,cacheKey,expected){return run([namespace,cacheKey,expected],history);},
    previewLocalReview(namespace,cacheKey,expected){return run([namespace,cacheKey,expected],async(ns,id,row)=>legacy.previewLocalReview.call({get:async()=> (await catalogue.get(ns,id,options))?.receipt||null},ns,id,row));},
    reserve(...args){return mutate('reserve',args);},
    transition(...args){return mutate('transition',args);},
    review(...args){return mutate('review',args);},
    reviewLocal(...args){return mutate('reviewLocal',args);},
    recover(...args){return mutate('recover',args);},
    remember(...args){return mutate('remember',args);},
    compactReviews(...args){return mutate('compactReviews',args);},
    archiveCompleted(namespace,expected,confirmed){return run([namespace,expected,confirmed],async(ns,rows,yes)=>{
      if(yes!==true||!Array.isArray(rows)||!rows.length||rows.length>40||new Set(rows.map(row=>row?.cacheKey)).size!==rows.length||rows.some(row=>row?.status!=='ready'))fail('请选择并确认 1～40 条已完成编码归档');
      for(const row of rows){const state=await checkout(ns,row.cacheKey);if(!same(state.snapshot?.receipt,row)||state.snapshot.section!=='current')fail('待归档记录已变化');}
      const result=await legacy.archiveCompleted(ns,rows,true);await check();
      // Archive is a same-attempt, semantics-preserving change. Reconcile the
      // whole local batch in ONE native adoption instead of separately linking
      // stale heads for rows already adopted by an earlier row's publication.
      const saved=(await catalogue.readAll(ns,options)).rows;
      for(const row of rows){const found=saved.find(item=>item.receipt.cacheKey===row.cacheKey);if(found?.section!=='archived'||!same(found.receipt,row))fail('归档尚未完整核对，请刷新；本机完整原件仍保留');}return result;
    });},
    close(){closed=true;catalogue.close();},
  });
}
