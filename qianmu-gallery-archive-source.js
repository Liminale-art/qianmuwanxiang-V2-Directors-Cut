// Connect immutable record/page storage to the exact SAVED current-chat source.
// Idle application preservation. No host save, original-record mutation, live-head replacement,
// pruning, browser image download or generation; observed equality is not a server lock.
import {createCurrentChatGalleryReceiptClient,createChatGallerySupplementClient,createChatGalleryEvidenceSourceClient} from './qianmu-chat-character-receipt-client.js';
import {createGalleryArchiveStorage} from './qianmu-gallery-archive-storage.js?v=1.59.340';
import {captureGalleryArchiveJson,GALLERY_PAGE_INDEX_LIMITS as LIMIT} from './qianmu-gallery-page-index.js';
import {scanChatGallery,galleryDigestRecord,galleryDigestRow} from './qianmu-chat-gallery-digest.js';
import {createSelectedRecipeArchiveClient} from './qianmu-recipe-archive-client.js?v=1.59.340';
import {galleryArchiveRecipeState} from './qianmu-gallery-archive-record.js';
import {galleryLocalRecipeReference,readLegacyGalleryRecipe} from './qianmu-gallery-local-recipe.js';
import {galleryLegacyRecipeReference,captureGalleryRecipeReview} from './qianmu-gallery-reviewed-recipe.js';
import {createGalleryOriginalClient} from './qianmu-gallery-original-client.js';
import {GALLERY_ORIGINAL_BATCH_LIMIT} from './qianmu-gallery-original-contract.js';
import {comfyReferencePath} from './qianmu-comfy-reference-contract.js';
import {captureGallerySupplement} from './qianmu-gallery-archive-supplement.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {scanGalleryEvidenceSource} from './qianmu-gallery-evidence-source.js';
import {galleryEvidenceSummary} from './qianmu-gallery-archive-evidence.js';
import {GALLERY_SUPPLEMENT_FIELDS,galleryContinuitySavePending} from './qianmu-gallery-continuity.js?v=1.59.340';

const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_source',writeState:'not_started'});};
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
export async function createCurrentGalleryArchiveSession({getContext,epoch,account,headers,fetchImpl,timeoutMs,
  guard=()=>true,createStorage,yieldWork=async()=>{},readLocalRecipe=readLegacyGalleryRecipe,preserveOriginals=true,preserveSupplements=true,preserveEvidence=preserveSupplements}={}){
  if(typeof getContext!=='function'||typeof epoch!=='function'||typeof guard!=='function')fail('画面保全缺少准确的当前聊天来源');
  if(typeof preserveOriginals!=='boolean'||typeof preserveSupplements!=='boolean')fail('原图或补充资料保全模式无效');
  if(typeof preserveEvidence!=='boolean'||preserveEvidence&&!preserveSupplements)fail('正文依据保全必须绑定关联资料');
  let client,archive,recipes,originals,supplementClient,localSupplement,supplementCaptureFailed=false,closed=false,busy=false,live,summary;const records=new Map();
  let evidenceClient,localEvidence,evidenceCaptureFailed=false,observedEvidence,pendingReview;
  function external(){
    const value=guard();if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});fail('画面保全需要同步切换保护');}
    if(value!==true)fail('画面保全来源保护已失效');
  }
  function close(){closed=true;pendingReview=null;evidenceClient?.close();supplementClient?.close();originals?.close();recipes?.close();archive?.close();client?.close();records.clear();live=null;}
  function check(){
    if(closed)fail('画面保全来源会话已结束');
    try{external();client.assertCurrent();
      const store=getContext().chatMetadata.story_director_liminale;
      if(store?.storyboardImages!==live)fail('当前画面列表已替换，请重新核对来源');
      if(galleryContinuitySavePending(store))fail('续写或换版依据仍在保存，请稍后重新核对');
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
  function captureSupplement(){
    check();const store=getContext().chatMetadata.story_director_liminale,saved={};
    for(const field of GALLERY_SUPPLEMENT_FIELDS)if(Object.hasOwn(store,field)){
      const property=Object.getOwnPropertyDescriptor(store,field);if(!Object.hasOwn(property,'value'))fail('补充资料含不支持的访问器');saved[field]=property.value;
    }
    return JSON.stringify(captureGallerySupplement({order:[...records.keys()],saved}));
  }
  function unchangedSupplement(){
    check();if(supplementCaptureFailed)fail('补充资料无法完整读取，未截断或猜补');
    let current;try{current=captureSupplement();}catch(error){close();throw error;}
    if(current!==localSupplement){close();fail('合集、角色草稿或来源依据已修改，请保存后重新核对');}
  }
  async function readSavedSupplement(){
    unchangedSupplement();supplementClient??=createChatGallerySupplementClient({namespace:client.owner.namespace,target:client.target,
      headers:headers||(()=>getContext().getRequestHeaders?.()||{}),fetchImpl,timeoutMs,
      guard:async()=>{unchangedSupplement();await client.guard();unchangedSupplement();}});
    const result=await supplementClient.read(summary.sha256);unchangedSupplement();
    if(JSON.stringify({order:result.order,saved:result.saved})!==localSupplement)fail('原聊天尚未保存相同合集、角色草稿或来源依据；也请确认后端版本');return result;
  }
  async function captureEvidence(){check();return scanGalleryEvidenceSource(getContext().chat,client.target.chatId,{guard:check,yieldWork});}
  async function unchangedEvidence(){
    check();if(evidenceCaptureFailed)fail('正文依据无法完整读取，未截断或猜补');
    let current;try{current=await captureEvidence();check();}catch(error){close();throw error;}
    if(!same(current,localEvidence)){close();fail('当前正文已修改，原保全会话作废');}
  }
  async function readSavedEvidence(){
    await unchangedEvidence();evidenceClient??=createChatGalleryEvidenceSourceClient({namespace:client.owner.namespace,target:client.target,
      headers:headers||(()=>getContext().getRequestHeaders?.()||{}),fetchImpl,timeoutMs,
      guard:async()=>{check();await client.guard();check();}});
    const result=await evidenceClient.read(summary.sha256);await unchangedEvidence();
    if(result.chatEvidence.digest!==localEvidence.digest||result.chatEvidence.messages.length!==localEvidence.count)fail('原聊天尚未保存相同正文，未确认正文依据');return result;
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
      if(result.evidences&&!evidenceCaptureFailed)await unchangedEvidence();check();
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
    if(preserveSupplements)try{localSupplement=captureSupplement();}catch{supplementCaptureFailed=true;}
    if(preserveEvidence)try{localEvidence=await captureEvidence();}catch{check();evidenceCaptureFailed=true;}
    archive=await createGalleryArchiveStorage({scope:{namespace:client.owner.namespace,...client.source},guard:check,createStorage,yieldWork,
      verifySupplement:receipt=>{unchangedSupplement();return same(receipt.gallery,summary)&&JSON.stringify({order:receipt.order,saved:receipt.saved})===localSupplement;},
      verifyEvidence:receipt=>{check();return !evidenceCaptureFailed&&same(receipt,observedEvidence)&&receipt.chatEvidence.digest===localEvidence?.digest&&receipt.chatEvidence.count===localEvidence?.count;},
      verifyRecord:record=>{check();currentRecord(record.id);return records.get(record.id)?.sha256===galleryDigestRecord(record).sha256;}});check();
    const identity=JSON.stringify([archive.scope,summary.sha256,...(preserveSupplements?[supplementCaptureFailed?'unreadable':await vibeDigest(localSupplement)]:[]),
      ...(preserveEvidence?[evidenceCaptureFailed?'unreadable-evidence':localEvidence]:[])]);await unchanged();
    return Object.freeze({scope:archive.scope,identity,
      async reviewLegacyRecipe(id){
        check();if(busy)fail('旧配方正在核对');busy=true;pendingReview=null;
        try{
          const record=currentRecord(id),key=galleryLegacyRecipeReference(archive.scope,record);if(!key)fail('此画面不需要旧配方关联');
          await saved();const row=await readLocalRecipe(key);check();currentRecord(id);
          if(!row)fail('此设备未找到对应旧配方；原记录保留，请在原设备核对');
          const review=await captureGalleryRecipeReview(archive.scope,record,row);await saved();check();
          pendingReview={id,review};return {digest:review.digest,snapshot:structuredClone(review.snapshot)};
        }finally{busy=false;}
      },
      async confirmLegacyRecipe({confirmed=false,expectedDigest}={}){
        check();if(confirmed!==true||!pendingReview||expectedDigest!==pendingReview.review.digest)fail('请先查看并确认此画面的完整旧配方');
        const chosen=pendingReview,record=currentRecord(chosen.id);
        return preserve(async()=>{
          await archive.preserveRecord(record);check();
          const result=await archive.preserveReviewedRecipe(record,chosen.review,{confirmed:true,expectedDigest});check();return result;
        });
      },
      async verifySavedSource(){
        check();if(busy)fail('原聊天画面正在保全，请勿重复提交');busy=true;
        try{
          const sourceReceipt=await saved(),supplement=await readSavedSupplement(),evidence=await readSavedEvidence();
          await unchanged();unchangedSupplement();await unchangedEvidence();check();
          return {sourceReceipt,supplement,evidence};
        }finally{busy=false;}
      },
      async preserveRecord(id){const [record]=selected([id]);return preserve(()=>archive.preserveRecord(record));},
      async stagePage(ids){const rows=selected(ids);return preserve(()=>archive.stagePage(rows));},
      preserveAll(){return preserve(async sourceReceipt=>{
        // Only lightweight keys are sorted. Anchor bounded pages at the oldest
        // end, respecting bytes as well as row count (large inline workflows).
        const ordered=[...records.values()].sort((a,b)=>b.createdAt-a.createdAt||(a.id<b.id?1:a.id>b.id?-1:0)),batches=[],pages=[];
        let ids=[],batchBytes=2,recipeCopies=0;
        const localRecipes={available:0,missing:0,unverified:0};
        let localReadFailed=false;
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
            if(galleryArchiveRecipeState(record)==='local-reference'){
              const key=galleryLocalRecipeReference(archive.scope,record);
              if(!key&&!galleryLegacyRecipeReference(archive.scope,record)){localRecipes.unverified++;continue;}
              await yieldWork();check();const existing=await archive.readStagedRecipe(references.get(record.id));check();
              if(existing.state==='available'){localRecipes.available++;continue;}
              if(existing.state!=='local-reference')fail('旧配方副本状态不兼容，未覆盖');
              if(!key){localRecipes.unverified++;continue;}
              if(localReadFailed){localRecipes.missing++;continue;}
              try{
                let local;try{local=await readLocalRecipe(key);}catch{check();localReadFailed=true;localRecipes.missing++;continue;}
                check();currentRecord(record.id);
                if(!local){localRecipes.missing++;continue;}
                await archive.preserveLocalRecipe(record,local);check();localRecipes.available++;
              }catch(error){check();currentRecord(record.id);localRecipes.missing++;}
              continue;
            }
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
        await yieldWork();await unchanged();let supplement,supplementState;
        if(preserveSupplements){
          try{
            const observed=await readSavedSupplement();check();
            const kept=await archive.preserveSupplement(observed);check();
            const confirmed=await readSavedSupplement();check();
            // Source/header changes retain any saved body but do not publish a
            // descriptor claiming a mixed snapshot. Never overwrite old copies.
            if(!same(confirmed,observed))fail('补充资料来源在保存期间已变化');
            supplement=kept.reference;supplementState='complete';
          }catch(error){check();if(!supplementCaptureFailed)unchangedSupplement();supplementState='partial';}
        }
        let evidence,evidenceState;
        if(preserveEvidence){
          evidenceState='partial';
          if(supplement)try{
            let observed=await readSavedEvidence();check();observedEvidence=galleryEvidenceSummary(observed);
            const kept=await archive.preserveEvidence(observed,supplement);check();observed=null;
            const confirmed=await readSavedEvidence();check();
            if(!same(galleryEvidenceSummary(confirmed),observedEvidence))fail('正文依据源文件在保存期间已变化');
            evidence=kept.reference;evidenceState='complete';
          }catch{check();if(!evidenceCaptureFailed)await unchangedEvidence();observedEvidence=null;}
        }
        const version=await archive.publishSourceVersion(sourceReceipt,pages,supplement,evidence);check();
        const {stopped,...coverage}=originalProgress;
        return {...version,recipeCopies,localRecipes:{...localRecipes,state:localRecipes.missing||localRecipes.unverified?'partial':'complete'},...(preserveEvidence?{evidences:{state:evidenceState,proof:evidenceState==='complete'?'evidence-readback-only':'not-confirmed',originalVerified:false,canPrune:false}}:{}),...(preserveSupplements?{supplements:{state:supplementState,proof:supplementState==='complete'?'supplement-readback-only':'not-confirmed',originalVerified:false,canPrune:false}}:{}),...(preserveOriginals?{originals:{...coverage,
          state:coverage.available===coverage.total?'complete':'partial',proof:'original-reference-only',originalVerified:false,canPrune:false}}:{})};
      });},
      openSourceVersion:(receipt,supplement,evidence)=>{check();return archive.openSourceVersion(receipt,supplement,evidence);},
      readRecord:ref=>{check();return archive.readRecord(ref);},
      readRecipe:(ref,options)=>{check();return archive.readRecipe(ref,options);},
      openStagedPage:descriptor=>{check();return archive.openStagedPage(descriptor);},close,
    });
  }catch(error){close();throw error;}
}
