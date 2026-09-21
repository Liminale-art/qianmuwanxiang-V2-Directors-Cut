// Connect immutable record/page storage to the exact SAVED current-chat source.
// Idle application preservation. No host save, original-record mutation, live-head replacement,
// pruning, browser image download or generation; observed equality is not a server lock.
import {createCurrentChatGalleryReceiptClient} from './qianmu-chat-character-receipt-client.js';
import {createGalleryArchiveStorage} from './qianmu-gallery-archive-storage.js?v=1.59.294';
import {captureGalleryArchiveJson,GALLERY_PAGE_INDEX_LIMITS as LIMIT} from './qianmu-gallery-page-index.js';
import {scanChatGallery,galleryDigestRecord,galleryDigestRow} from './qianmu-chat-gallery-digest.js';
import {createSelectedRecipeArchiveClient} from './qianmu-recipe-archive-client.js?v=1.59.294';
import {galleryArchiveRecipeState} from './qianmu-gallery-archive-record.js';
import {createGalleryOriginalClient} from './qianmu-gallery-original-client.js';
import {GALLERY_ORIGINAL_BATCH_LIMIT} from './qianmu-gallery-original-contract.js';
import {comfyReferencePath} from './qianmu-comfy-reference-contract.js';

const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_source',writeState:'not_started'});};
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
export async function createCurrentGalleryArchiveSession({getContext,epoch,account,headers,fetchImpl,timeoutMs,
  guard=()=>true,createStorage,yieldWork=async()=>{},preserveOriginals=true}={}){
  if(typeof getContext!=='function'||typeof epoch!=='function'||typeof guard!=='function')fail('画面保全缺少准确的当前聊天来源');
  if(typeof preserveOriginals!=='boolean')fail('原图保全模式无效');
  let client,archive,recipes,originals,closed=false,busy=false,live,summary;const records=new Map();
  function external(){
    const value=guard();if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});fail('画面保全需要同步切换保护');}
    if(value!==true)fail('画面保全来源保护已失效');
  }
  function close(){closed=true;originals?.close();recipes?.close();archive?.close();client?.close();records.clear();live=null;}
  function check(){
    if(closed)fail('画面保全来源会话已结束');
    try{external();client.assertCurrent();
      if(getContext().chatMetadata.story_director_liminale?.storyboardImages!==live)fail('当前画面列表已替换，请重新核对来源');
    }catch(error){close();throw error;}return true;
  }
  async function unchanged(){
    check();
    // Yielding, per-record scan at operation boundaries. Keep only fingerprints;
    // unknown fields still participate, without retaining a second full gallery.
    const current=await scanChatGallery(live,{guard:check,yieldWork});check();
    if(!same(current,summary)){close();fail('当前画面资料已修改，请先保存聊天后重新核对');}
  }
  async function saved(){
    await unchanged();const receipt=await client.inspect();await unchanged();
    if(receipt.state!=='present'||!same(receipt.gallery,summary)){close();fail('原聊天尚未保存相同画面资料，未确认保全');}
    return {...receipt.gallery,proof:receipt.proof};
  }
  function currentRecord(id){
    check();const expected=records.get(id);if(!expected)fail('画面保全选择不属于原聊天，未猜测记录');
    const record=galleryDigestRecord(galleryDigestRow(live,expected.index));
    if(record.sha256!==expected.sha256){close();fail('当前画面资料已修改，请先保存聊天后重新核对');}
    return record.value;
  }
  function selected(ids){
    check();const keys=captureGalleryArchiveJson(ids,64*1024);
    if(!Array.isArray(keys)||!keys.length||keys.length>LIMIT.rows||new Set(keys).size!==keys.length)fail('画面保全须选择1至128个不同的原记录');
    return keys.map(id=>currentRecord(id));
  }
  async function preserve(work){
    check();if(busy)fail('原聊天画面正在保全，请勿重复提交');busy=true;let started=false;
    try{
      await yieldWork();const before=await saved();check();started=true;
      const result=await work(before);await yieldWork();const sourceReceipt=await saved();check();
      return {...result,sourceReceipt,originalVerified:false,canPrune:false};
    }catch(error){if(started)error.writeState='unconfirmed';else error.writeState??='not_started';throw error;}
    finally{busy=false;}
  }
  async function preservePageOriginals(batch,references,progress){
    let queue=[];
    async function flush(){
      if(!queue.length)return;
      await yieldWork();check();const selected=queue;queue=[];
      for(const record of selected)currentRecord(record.id);
      let result;
      try{
        originals??=createGalleryOriginalClient({account:async()=>client.owner.namespace,
          headers:headers||(()=>getContext().getRequestHeaders?.()||{}),fetchImpl,timeoutMs,
          guard:async()=>{check();await client.guard();check();return true;}});
        result=await originals.preserveBatch({target:client.target,gallerySha256:summary.sha256,
          records:selected.map(({id:recordId,createdAt,url})=>({recordId,createdAt,url}))});check();
        for(const record of selected)currentRecord(record.id);
      }catch{
        check();for(const record of selected)currentRecord(record.id);
        // No fallback, per-image retry or service-error storm. Finish the record
        // and recipe directory, with explicit incomplete media coverage.
        progress.failed+=selected.length;progress.stopped=true;originals?.close();originals=null;return;
      }
      for(let index=0;index<selected.length;index++){
        await yieldWork();check();const record=selected[index];currentRecord(record.id);
        try{await archive.preserveStagedOriginalReference(references.get(record.id),result.records[index]);check();
          progress.available++;progress.preserved++;
        }catch{check();currentRecord(record.id);progress.failed++;}
      }
    }
    for(const record of batch){
      await yieldWork();check();currentRecord(record.id);
      let eligible=false;try{eligible=comfyReferencePath(record.url)===record.url;}catch{}
      if(!eligible){progress.skipped++;continue;}
      if(progress.stopped){progress.deferred++;continue;}
      let existing;
      try{existing=await archive.readStagedOriginal(references.get(record.id));check();}
      catch{check();currentRecord(record.id);progress.failed++;continue;}
      if(existing.state==='available'){progress.available++;continue;}
      if(existing.state!=='not-preserved'){progress.failed++;continue;}
      queue.push(record);if(queue.length===GALLERY_ORIGINAL_BATCH_LIMIT)await flush();
    }
    await flush();
  }
  try{
    external();client=await createCurrentChatGalleryReceiptClient({getContext,epoch,account,headers,fetchImpl,timeoutMs,guard:external});
    live=getContext().chatMetadata.story_director_liminale?.storyboardImages;check();
    summary=await scanChatGallery(live,{guard:check,yieldWork,visit:(record,index)=>{
      const {id,createdAt}=record.value;
      if(typeof id!=='string'||!id||records.has(id))fail('原聊天画面编号缺失或重复，未选择或合并记录');
      records.set(id,{id,createdAt,index,bytes:record.bytes,sha256:record.sha256});
    }});
    archive=await createGalleryArchiveStorage({scope:{namespace:client.owner.namespace,...client.source},guard:check,createStorage,yieldWork,
      verifyRecord:record=>{check();currentRecord(record.id);return records.get(record.id)?.sha256===galleryDigestRecord(record).sha256;}});check();
    const identity=JSON.stringify([archive.scope,summary.sha256]);await unchanged();
    return Object.freeze({scope:archive.scope,identity,
      async preserveRecord(id){const [record]=selected([id]);return preserve(()=>archive.preserveRecord(record));},
      async stagePage(ids){const rows=selected(ids);return preserve(()=>archive.stagePage(rows));},
      preserveAll(){return preserve(async sourceReceipt=>{
        // Only lightweight keys are sorted. Anchor bounded pages at the oldest
        // end, respecting bytes as well as row count (large inline workflows).
        const ordered=[...records.values()].sort((a,b)=>b.createdAt-a.createdAt||(a.id<b.id?1:a.id>b.id?-1:0)),batches=[],pages=[];
        let ids=[],batchBytes=2,recipeCopies=0;
        const originalProgress={total:ordered.length,available:0,preserved:0,failed:0,deferred:0,skipped:0,stopped:false};
        for(let at=ordered.length-1;at>=0;at--){
          const row=ordered[at];
          if(row.bytes+2>LIMIT.recordBytes)fail('单个画面超过保全批次大小，未裁剪原件');
          if(ids.length&&(ids.length===LIMIT.rows||batchBytes+row.bytes+1>LIMIT.recordBytes)){batches.push(ids.reverse());ids=[];batchBytes=2;}
          batchBytes+=row.bytes+(ids.length?1:0);ids.push(row.id);
        }
        if(ids.length)batches.push(ids.reverse());batches.reverse();
        if(batches.length>LIMIT.pages)fail('完整图库超过分页范围，未发布部分目录');
        for(const ids of batches){
          await yieldWork();check();const batch=selected(ids),result=await archive.stagePage(batch);check();pages.push(result.descriptor);
          const references=new Map(result.records.map(record=>[record.recordId,record.reference]));
          for(const record of batch){
            if(galleryArchiveRecipeState(record)!=='server-reference')continue;
            await yieldWork();check();const existing=await archive.readStagedRecipe(references.get(record.id));check();
            if(existing.state==='available'&&existing.origin==='server-copy'){recipeCopies++;continue;}
            if(existing.state!=='not-preserved')fail('原配方副本状态不兼容，未重新覆盖');
            await yieldWork();check();recipes??=createSelectedRecipeArchiveClient({namespace:client.owner.namespace,target:client.target,summary,headers,fetchImpl,timeoutMs,
              verifyRecord:record=>{currentRecord(record.id);return records.get(record.id)?.sha256===galleryDigestRecord(record).sha256;},guard:async()=>{check();await client.guard();check();}});
            const read=await recipes.read(record);check();
            if(read.selection.gallerySha256!==sourceReceipt.sha256)fail('配方读取来源版本与本次保全不符');
            await archive.preserveServerRecipe(record,read);check();recipeCopies++;
            await new Promise(resolve=>setTimeout(resolve,0));check();
          }
          if(preserveOriginals)await preservePageOriginals(batch,references,originalProgress);
        }
        await yieldWork();await unchanged();const version=await archive.publishSourceVersion(sourceReceipt,pages);check();
        const {stopped,...coverage}=originalProgress;
        return {...version,recipeCopies,...(preserveOriginals?{originals:{...coverage,
          state:coverage.available===coverage.total?'complete':'partial',proof:'original-reference-only',originalVerified:false,canPrune:false}}:{})};
      });},
      openSourceVersion:receipt=>{check();return archive.openSourceVersion(receipt);},
      readRecord:ref=>{check();return archive.readRecord(ref);},
      readRecipe:(ref,options)=>{check();return archive.readRecipe(ref,options);},
      openStagedPage:descriptor=>{check();return archive.openStagedPage(descriptor);},close,
    });
  }catch(error){close();throw error;}
}
