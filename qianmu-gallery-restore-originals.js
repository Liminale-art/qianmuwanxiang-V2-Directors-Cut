import {galleryOriginalReference,GALLERY_ORIGINAL_BATCH_LIMIT} from './qianmu-gallery-original-contract.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_restore_originals',writeState:'not_started'});};
// Read-only preparation. Only exact, independently saved copies are read; never
// mutable URLs, source chats, image generation, writes or a missing-image fallback.
// Per-row callbacks are provisional: only the final result proves the full scan.
export async function verifyGalleryRestoreOriginals({source,readBatch,guard,signal,onProgress=()=>{},onVerified=()=>{}}={}){
  if(typeof source?.scan!=='function'||typeof source?.verify!=='function'||typeof readBatch!=='function'||typeof guard!=='function'||typeof onProgress!=='function'||typeof onVerified!=='function')fail('原图核验缺少受保护的完整归档源');
  const known=new Map();let pending=[],verified=0,unique=0,bytes=0,visited=0;
  const total=source.summary.total;
  async function check(){if(signal?.aborted)fail('原图核验已取消');if(await guard()!==true)fail('原图核验来源已变化');if(signal?.aborted)fail('原图核验已取消');}
  async function progress(){await check();await onProgress({phase:'originals',completed:visited,total,verified,unique,bytes});await check();}
  async function flush(){
    await check();if(!pending.length)return;
    const wanted=new Map();
    for(const row of pending){
      const previous=known.get(row.reference.id)||wanted.get(row.reference.id);
      if(previous&&!same(previous,row.reference))fail('同一原图副本引用出现不同大小或格式，未复用');
      if(!known.has(row.reference.id))wanted.set(row.reference.id,row.reference);
    }
    const references=[...wanted.values()];
    if(references.length){
      let received=0;
      const result=await readBatch(references,{signal,visit:async(value,index)=>{
        await check();const reference=references[index];
        if(index!==received||!reference||value?.proof!=='original-copy-readback'||value.originalVerified!==true||value.canPrune!==false
          ||!same(value.reference,reference)||!(value.blob instanceof Blob)||value.blob.size!==reference.bytes||value.blob.type!==reference.mime)fail('原图字节读取未提供完整且有序的校验凭据');
        known.set(reference.id,reference);received++;unique++;bytes+=reference.bytes;
        // Keep only exact references, never the Blob returned by the byte verifier.
      }});await check();
      if(received!==references.length||result?.count!==received||result.proof!=='original-batch-readback'||result.originalVerified!==true||result.canPrune!==false)fail('原图批次未完整读回，不确认部分结果');
    }
    for(const row of pending){await check();await onVerified({...structuredClone(row),proof:'original-copy-readback',originalVerified:true,canPrune:false});verified++;}
    pending=[];await progress();await new Promise(resolve=>setTimeout(resolve,0));await check();
  }
  try{
    await check();const result=await source.scan({onProgress:async value=>{await check();await onProgress({...value,phase:'records',verified,unique,bytes});await check();},visit:async item=>{
      await check();visited++;
      if(item.media.state==='available'){
        const reference=galleryOriginalReference(item.media.reference);
        pending.push({index:item.index,recordId:item.record.id,createdAt:item.record.createdAt,record:structuredClone(item.reference),reference,original:structuredClone(item.media.original)});
        if(pending.length>=GALLERY_ORIGINAL_BATCH_LIMIT)await flush();
      }else if(item.media.state!=='not-preserved')fail('原图引用状态不兼容，未当作缺图跳过');
    }});await check();await flush();await check();
    if(visited!==total||result.total!==total||result.galleryVerified!==true||verified!==result.originals.referenced)fail('原图核验未覆盖完整已保存范围');
    if(await source.verify()!==true)fail('原图核验结束时归档来源未确认');await check();await progress();
    return {...result,originals:{...result.originals,verified,unique,bytes},originalVerified:verified===total,
      proof:'archive-originals-readback-only',restoreReady:false,canPrune:false};
  }finally{pending=[];known.clear();}
}
