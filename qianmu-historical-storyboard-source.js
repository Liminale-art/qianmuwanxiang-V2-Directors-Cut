import {createChatGalleryStateClient,createChatGalleryEvidenceClient} from './qianmu-chat-character-receipt-client.js';
import {createHistoricalRecipeArchiveClient} from './qianmu-recipe-archive-client.js';
import {chatCharacterReceiptTarget} from './qianmu-chat-character-receipt.js';
import {chatGalleryRecordSelection} from './qianmu-chat-gallery-record.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {recipeArchiveSnapshot,recipeArchiveReference} from './qianmu-recipe-archive-contract.js';
import {assertPortableStoryboardData} from './qianmu-storyboard-package-security.js';

export const HISTORICAL_STORYBOARD_SOURCE_LIMITS=Object.freeze({records:400,bytes:64*1048576,durationMs:180000});
const fail=message=>{throw Object.assign(new Error(message),{code:'historical_storyboard_source',submissionState:'not_submitted'});};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
const equal=(a,b)=>chatGalleryReceiptText([a]).text===chatGalleryReceiptText([b]).text;
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

// Ephemeral, read-only source for a future portable-package consumer. No image
// downloads, IndexedDB, current ctx/settings, host mutations or bundle completion claim.
// Repeated observations are not a filesystem lock; verify again before handoff.
export async function captureHistoricalStoryboardSource({namespace,target,gallerySha256,recordIds,account,guard,headers=()=>({}),fetchImpl=globalThis.fetch,
  signal,timeoutMs=180000,requestTimeoutMs=30000,maxBytes=HISTORICAL_STORYBOARD_SOURCE_LIMITS.bytes}={}){
  const limit=HISTORICAL_STORYBOARD_SOURCE_LIMITS;
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)
    ||typeof account!=='function'||typeof guard!=='function'||typeof gallerySha256!=='string'||!/^[a-f0-9]{64}$/.test(gallerySha256)
    ||!Number.isFinite(timeoutMs)||!Number.isFinite(requestTimeoutMs)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>limit.bytes)fail('历史导出来源缺少准确范围、账户保护或有效读取上限');
  target=chatCharacterReceiptTarget(target);
  if(recordIds!==undefined&&(!Array.isArray(recordIds)||recordIds.length>limit.records||Array.from(recordIds).some(value=>!id(value))||new Set(recordIds).size!==recordIds.length))fail('所选历史画面编号无效或重复');
  const wanted=recordIds===undefined?null:[...recordIds],clients=[];let closed=false,busy=false,active=null,source;
  const close=()=>{closed=true;signal?.removeEventListener('abort',close);active?.abort();for(const client of clients)client.close();};
  const alive=()=>{if(closed||signal?.aborted||active?.signal.aborted)fail('历史资料读取已取消或超时，未交付不完整来源');};
  const check=async()=>{alive();await guard();alive();if(await account()!==namespace)fail('当前 ST 账户已变化，未采用原账户历史资料');alive();await guard();alive();};
  async function operation(task,options={}){
    alive();if(busy)fail('历史资料正在读取，请等待本次核对完成');busy=true;
    const controller=new AbortController();active=controller;let reject;
    const cancellation=new Promise((_,no)=>{reject=no;});
    const abort=()=>controller.abort();
    const onClose=()=>reject(Object.assign(new Error('历史资料读取已取消或超时，未交付不完整来源'),{code:'historical_storyboard_source',submissionState:'not_submitted'}));controller.signal.addEventListener('abort',onClose,{once:true});
    signal?.addEventListener('abort',abort,{once:true});options.signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,Math.max(100,Math.min(limit.durationMs,timeoutMs)));
    try{
      if(signal?.aborted||options.signal?.aborted)abort();
      return await Promise.race([(async()=>{await check();const value=await task(controller.signal);await check();return value;})(),cancellation]);
    }catch(error){close();throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);options.signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onClose);controller.abort();if(active===controller)active=null;busy=false;}
  }
  const options={namespace,target,headers,fetchImpl,guard:check,timeoutMs:Math.max(100,Math.min(30000,requestTimeoutMs))};
  const stateClient=createChatGalleryStateClient(options),evidenceClient=createChatGalleryEvidenceClient(options);clients.push(stateClient,evidenceClient);
  signal?.addEventListener('abort',close,{once:true});
  let baselineState,baselineEvidence;
  async function verify(readSignal){
    const state=await stateClient.read(gallerySha256,{signal:readSignal});await check();
    if(state.sha256!==baselineState.sha256||!equal(state.source,baselineState.source))fail('原聊天人物、相册或资料头已变化，请重新开始备份');
    const evidence=await evidenceClient.read(gallerySha256,{signal:readSignal});await check();
    if(evidence.chatEvidence.digest!==baselineEvidence.chatEvidence.digest||!equal(evidence.source,baselineEvidence.source))fail('原聊天正文或保存文件已变化，请重新开始备份');
    // Catch metadata edits during the body scan even if its body digest is unchanged.
    const after=await stateClient.read(gallerySha256,{signal:readSignal});await check();
    if(after.sha256!==baselineState.sha256||!equal(after.source,baselineState.source))fail('原聊天资料在正文核对期间已变化，请重新开始备份');
    return true;
  }
  try{
    await operation(async readSignal=>{
      baselineState=await stateClient.read(gallerySha256,{signal:readSignal});await check();
      const records=baselineState.saved.storyboardImages,byId=new Map();
      for(const row of records){if(!id(row.id)||byId.has(row.id))fail('原聊天画面编号无效或重复，未猜测备份范围');byId.set(row.id,row);}
      const ids=wanted??records.map(row=>row.id);
      if(ids.length>limit.records||records.length&&!ids.length||ids.some(value=>!byId.has(value)))fail('请选择 1 至 400 张本聊天画面，未采用空范围或其他聊天编号');
      const selected=new Set(ids),chosen=records.filter(row=>selected.has(row.id));
      for(const row of chosen){
        chatGalleryRecordSelection({recordId:row.id,createdAt:row.createdAt,gallerySha256});
        if(row.recipeUnavailable===true||row.snapshot==null&&row.snapshotServerRef==null)fail('所选画面未保留完整配方或只有旧设备引用；请先保全原图，未用当前设置补齐');
        if(row.snapshot!=null)recipeArchiveSnapshot(row.snapshot);else recipeArchiveReference(row.snapshotServerRef);
      }
      baselineEvidence=await evidenceClient.read(gallerySha256,{signal:readSignal});await check();
      source={schema:'qianmu.storyboard.historical-source.v1',namespace,target,gallerySha256,selection:{ids:chosen.map(row=>row.id),total:records.length},
        saved:{...baselineState.saved,storyboardImages:chosen},recipes:[],chatEvidence:baselineEvidence.chatEvidence,
        observed:{stateSha256:baselineState.sha256,header:baselineState.source,file:baselineEvidence.source}};
      let size=bytes(source);if(size>maxBytes)fail('历史原件合计超过来源读取上限，未截断资料');
      const recipes=createHistoricalRecipeArchiveClient({...options,records});clients.push(recipes);
      for(const row of chosen){
        await check();const result=await recipes.read(row,{signal:readSignal});await check();
        if(row.snapshot!=null&&(result.origin!=='saved-inline'||!equal(result.snapshot,recipeArchiveSnapshot(row.snapshot).snapshot)))fail('读回配方与原聊天内联原件不符');
        await assertPortableStoryboardData(result.snapshot);await check();
        const item={recordId:row.id,createdAt:row.createdAt,origin:result.origin,reference:result.reference,snapshot:result.snapshot};
        size+=bytes(item)+(source.recipes.length?1:0);if(size>maxBytes)fail('历史配方合计超过来源读取上限，未交付缺件来源');source.recipes.push(item);
      }
      if(bytes(source)>maxBytes)fail('历史原件合计超过来源读取上限，未截断资料');
      await verify(readSignal);source=freeze(source);
    });
    return Object.freeze({source,verify:options=>operation(verify,options),close});
  }catch(error){close();throw error;}
}
