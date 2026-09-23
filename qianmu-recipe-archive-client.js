import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {chatGalleryReceiptText,chatGalleryReceiptSummary} from './qianmu-chat-gallery-receipt.js';
import {chatGalleryDigest,galleryDigestRecord,galleryDigestRows,galleryDigestRow,scanChatGallery} from './qianmu-chat-gallery-digest.js';
import {galleryRecordFingerprintText} from './qianmu-gallery-record-fingerprint.js';
import {recipeArchiveBatchRequest,recipeArchiveBatchResponse,recipeArchiveBatchCapabilities,RECIPE_BATCH_LIMITS} from './qianmu-recipe-batch-contract.js';
import {recipeArchiveRequest,recipeArchiveResponse,recipeArchiveReference,recipeArchiveError,RECIPE_ARCHIVE_LIMITS} from './qianmu-recipe-archive-contract.js';
import {chatCharacterReceiptTarget} from './qianmu-chat-character-receipt.js';

const fail=message=>recipeArchiveError('client',message);
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),n=>n.toString(16).padStart(2,'0')).join('');
const equal=(a,b)=>chatGalleryReceiptText([a]).text===chatGalleryReceiptText([b]).text;

// A short-lived borrower of one actual host gallery. Never uploads a recipe or reads
// an unscoped local cache. Every returned recipe/ref must come from the saved source.
export function createCurrentRecipeArchiveClient(options={}){
  const {getContext,epoch}=options,source=captureCurrentChatSource({getContext,epoch});
  try{return createRecipeArchiveClient({...options,source,headers:options.headers||(()=>getContext().getRequestHeaders?.()||{})});}
  catch(error){source.close();throw error;}
}

// Exact saved-file reader. It cannot preserve/upload or impersonate an open host
// chat. The caller owns the account/session guard; records are detached immediately.
export function createHistoricalRecipeArchiveClient({namespace,target,records,guard,...options}={}){
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)||typeof guard!=='function')throw fail('历史配方读取缺少账户或会话保护');
  const selected=chatCharacterReceiptTarget(target);chatGalleryReceiptText(records);
  if(!Array.isArray(records))throw fail('历史配方缺少原聊天画面');
  const rows=structuredClone(records),source={target:selected,assertCurrent(){},close(){}};
  return createRecipeArchiveClient({...options,source,getGallery:()=>rows,account:async()=>namespace,guard},false);
}

// Archive-session reader: the saved summary is an exact source selector, never
// evidence by itself. The server rehashes the saved source before/after reading.
// Only one selected record is captured, not a detached copy of the whole library.
export function createSelectedRecipeArchiveClient({namespace,target,summary,verifyRecord,guard,...options}={}){
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)
    ||typeof guard!=='function'||typeof verifyRecord!=='function')throw fail('原配方读取缺少来源或会话保护');
  const source={target:chatCharacterReceiptTarget(target),assertCurrent(){},close(){}};
  return createRecipeArchiveClient({...options,source,sourceSummary:chatGalleryReceiptSummary(summary),verifyRecord,account:async()=>namespace,guard},false);
}

function createRecipeArchiveClient({source,getGallery,sourceSummary,verifyRecord,
  account=async()=>(await import('./qianmu-image-admission.js')).resolveImageAccountNamespace(),
  headers=()=>({}),guard=async()=>{},fetchImpl=globalThis.fetch,timeoutMs=8000}={},writable=true){
  if((sourceSummary?(writable||typeof verifyRecord!=='function'):typeof getGallery!=='function')||typeof account!=='function'||!Number.isFinite(timeoutMs))throw fail('配方读取缺少聊天来源');
  let original,rows;
  try{if(sourceSummary)original=sourceSummary;else {rows=getGallery();original=chatGalleryDigest(rows);if(!original)throw fail('配方缺少原图库');}}catch(error){source.close();throw error;}
  const pending=new Set();let namespace,closed=false;
  function current(){
    if(closed)throw fail('配方会话已结束');source.assertCurrent();
    // Historical rows are private detached clones, never exposed to callers.
    // Rechecking that complete clone at every guarded await is quadratic work.
    if(!sourceSummary&&getGallery()!==rows)throw fail('原画面资料已变化，请重新打开后重试');
  }
  async function unchanged(alive){
    current();alive();if(!writable)return;
    const summary=await scanChatGallery(rows,{guard:()=>{current();alive();}});current();alive();
    if(summary.sha256!==original.sha256)throw fail('原画面资料已变化，请重新打开后重试');
  }
  async function check(){
    await guard();current();const active=await account();current();
    if(typeof active!=='string'||!/^st-user:.+/.test(active)||active.length>512||/[\u0000-\u001f\u007f]/.test(active))throw fail('无法确认当前 ST 账户');
    if(namespace!==undefined&&namespace!==active)throw fail('ST 账户已切换，未使用旧配方');namespace=active;
    await guard();current();
  }
  function selected(record){
    current();
    if(sourceSummary){const result=verifyRecord(record);if(result&&typeof result.then==='function')void Promise.resolve(result).catch(()=>{});
      if(result!==true)throw fail('原画面与保全来源不符');}
    else {const matches=rows.filter(item=>item?.id===record?.id);
      if(matches.length!==1||!equal(matches[0],record))throw fail('原画面已替换或编号重复，未猜测配方');}
    return {recordId:record.id,createdAt:record.createdAt};
  }
  async function bounded(task,{signal}={}){
    if(closed)throw fail('配方会话已结束');
    const controller=new AbortController();let reject;
    const cancellation=new Promise((_,no)=>{reject=no;});
    const abort=()=>{controller.abort();reject(fail('配方读取已取消或超时；原资料仍保留，请重试'));};
    const alive=()=>{if(controller.signal.aborted||closed)throw fail('配方会话已结束或超时');};
    pending.add(abort);signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,Math.max(100,Math.min(30000,timeoutMs)));
    try{
      if(signal?.aborted)abort();
      return await Promise.race([(async()=>{alive();await check();alive();return task(controller.signal,alive);})(),cancellation]);
    }finally{clearTimeout(timer);pending.delete(abort);signal?.removeEventListener('abort',abort);controller.abort();}
  }
  async function call(method,record,options){
    const capabilities=method==='batch-capabilities',batch=method==='preserve-batch';let selection,batchRecords;
    if(batch){
      const length=galleryDigestRows(record);if(length<1||length>RECIPE_BATCH_LIMITS.records)throw fail('配方批次须包含1至8份原画面');
      batchRecords=Array.from({length},(_,index)=>galleryDigestRow(record,index));
      selection=batchRecords.map(row=>{galleryRecordFingerprintText(row);return selected(row);});
      recipeArchiveBatchRequest({version:1,expectedAccount:'st-user:'+'0'.repeat(64),target:source.target,gallerySha256:original.sha256,selections:selection});
    }else if(!capabilities){if(sourceSummary)record=galleryDigestRecord(record).value;selection=selected(record);}
    const selectionsCurrent=()=>{if(batch&&batchRecords.some((row,index)=>!equal(selected(row),selection[index])))throw fail('配方批次画面选择已变化');};
    return bounded(async(signal,alive)=>{
      const expectedAccount='st-user:'+await digest(namespace.slice(8));
      const body=capabilities?{version:1,expectedAccount}:batch
        ?recipeArchiveBatchRequest({version:1,expectedAccount,target:source.target,gallerySha256:original.sha256,selections:selection})
        :recipeArchiveRequest({version:1,expectedAccount,target:source.target,selection:{...selection,gallerySha256:original.sha256}});
      const limit=capabilities||batch?RECIPE_BATCH_LIMITS.jsonBytes:RECIPE_ARCHIVE_LIMITS.fileBytes;
      const provided=new Headers(await headers());
      const requestHeaders={'Content-Type':'application/json',Accept:'application/json'};
      if(provided.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=provided.get('x-csrf-token');
      if(!capabilities)await unchanged(alive);await check();alive();if(sourceSummary)selected(record);selectionsCurrent();
      const response=await fetchImpl('/api/plugins/qianmu-tts/chat-gallery/recipe/'+method,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal,
        headers:requestHeaders,body:JSON.stringify(body)});
      const discard=()=>{void response.body?.cancel?.().catch(()=>{});};
      if(signal.aborted||closed){discard();alive();}
      if(response.redirected){discard();throw fail('配方服务发生重定向，未使用其他地址');}
      if(response.status===404||response.status===405){discard();if(capabilities){await check();alive();return null;}throw fail('配方服务不可用或原配方未找到，请更新配套后端或在原设备保全资料');}
      if(!/^application\/json\b/i.test(response.headers?.get?.('content-type')||'')||Number(response.headers.get('content-length'))>limit){discard();throw fail('配方返回不兼容或过大，未使用不完整内容');}
      const reader=response.body?.getReader?.();if(!reader)throw fail('配方返回不完整');
      const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
      let text='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
      try{while(true){alive();const part=await reader.read();alive();if(part.done)break;
        bytes+=part.value.byteLength;if(bytes>limit)throw fail('配方返回超过上限，未截断');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
      finally{signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
      let value;try{value=JSON.parse(text);}catch{throw fail('配方返回不完整，未替换原资料');}
      if(!response.ok||value?.ok!==true)throw fail('配方尚未核实或保全，请保留原设备资料后重试');
      const result=capabilities?recipeArchiveBatchCapabilities(value):batch?recipeArchiveBatchResponse(value):recipeArchiveResponse(value);
      if(capabilities||batch){
        if(result.expectedAccount!==body.expectedAccount||batch&&(!equal(result.target,body.target)||result.gallerySha256!==body.gallerySha256
          ||JSON.stringify(result.selections)!==JSON.stringify(body.selections)))throw fail('配方批次返回另一账户、来源或画面');
        if(batch)await unchanged(alive);await check();alive();selectionsCurrent();return result;
      }
      if(result.proof!==(method==='preserve'?'durable-recipe':'read-only-recipe')||result.expectedAccount!==body.expectedAccount
        ||!equal(result.target,body.target)||!equal(result.selection,body.selection))throw fail('配方返回另一账户、聊天或画面');
      if(method==='read'&&record.snapshotServerRef&&!record.snapshot&&(!result.reference||!equal(result.reference,recipeArchiveReference(record.snapshotServerRef))))throw fail('服务器配方不是此画面保存的版本');
      await unchanged(alive);await check();alive();if(sourceSummary)selected(record);return result;
    },options);
  }
  return Object.freeze({...writable?{preserve:(record,options)=>call('preserve',record,options),
    supportsBatch:async options=>Boolean(await call('batch-capabilities',null,options)),preserveBatch:(records,options)=>call('preserve-batch',records,options)}:{},read:(record,options)=>call('read',record,options),
    guard:options=>bounded(async(signal,alive)=>{await unchanged(alive);await check();alive();return true;},options),
    // After the caller installs acknowledged refs, its own gallery digest has
    // changed. Recheck identity/lifecycle only; this is NOT saved-content proof.
    guardIdentity:options=>bounded(async()=>true,options),
    close(){closed=true;source.close();for(const abort of pending)abort();rows=null;}});
}
