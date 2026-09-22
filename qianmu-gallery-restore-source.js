import {galleryArchiveSourceVersion} from './qianmu-gallery-archive-version.js';
import {GALLERY_PAGE_INDEX_LIMITS as LIMIT} from './qianmu-gallery-page-index.js';
import {galleryCatalogTags} from './qianmu-gallery-catalog-contract.js';
import {galleryEvidenceMatchesSupplement} from './qianmu-gallery-archive-evidence.js';
import {createChatGalleryDigest} from './qianmu-chat-gallery-digest.js';
import {recipeArchiveEnvelope,recipeArchiveReference} from './qianmu-recipe-archive-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_restore_source',writeState:'not_started'});};
// Read-only, independently saved source. Keep an ID/reference index, not all
// records/recipes/images. Original ordering is independent of newest-first UI.
// The caller owns storage and supplies its live account/page guard and deadline.
export async function createGalleryRestoreSource({selection,archive,guard,signal,yieldWork=async()=>{}}={}){
  const selected=galleryArchiveSourceVersion(selection,selection?.scope,selection?.sourceReceipt);
  if(typeof guard!=='function'||typeof yieldWork!=='function'||typeof archive?.readRecoveryRecord!=='function')fail('恢复资料缺少受保护的归档读取器');
  if(!selected.supplement||!selected.evidence)fail('此旧版本尚未保全原顺序或正文依据，仍可浏览，不能猜补恢复资料');
  let closed=false,busy=false,version,companion,body;const rows=new Map();
  function close(){closed=true;version?.close();rows.clear();companion=null;body=null;}
  async function check(){if(closed||signal?.aborted)fail('恢复资料核对已取消');if(await guard()!==true)fail('恢复资料来源已变化');if(closed||signal?.aborted)fail('恢复资料核对已取消');}
  async function yieldNow(){await check();await new Promise(resolve=>setTimeout(resolve,0));await yieldWork();await check();}
  async function openVersion(){
    await check();const opened=await archive.openSourceVersion(selected.sourceReceipt,selected.supplement,selected.evidence);
    try{await check();if(!same(opened.reference,selected.manifest)||opened.total!==selected.sourceReceipt.count)fail('归档目录与所选版本不一致');return opened;}
    catch(error){opened.close();throw error;}
  }
  async function readAt(index){
    await check();if(!Number.isSafeInteger(index)||index<0||index>=companion.order.length)fail('恢复资料序号超出原保存范围');
    const row=rows.get(companion.order[index]),result=await archive.readRecoveryRecord(row.record,{signal});await check();
    const record=result.record;
    if(!same(result.reference,row.record)||record.id!==row.recordId||record.createdAt!==row.createdAt||!same(galleryCatalogTags(record.tags),row.tags))fail('恢复画面与原目录不符');
    // A mutable sidecar must still prove the original server recipe envelope.
    if(result.recipe.state==='available'&&record.snapshot==null){
      const ref=recipeArchiveReference(record.snapshotServerRef),envelope=recipeArchiveEnvelope({version:1,expectedAccount:companion.expectedAccount,
        source:{target:companion.target,recordId:record.id,createdAt:record.createdAt},snapshot:result.recipe.snapshot});
      if(result.recipe.origin!=='server-copy'||new TextEncoder().encode(envelope.text).length!==ref.bytes||await vibeDigest(envelope.text)!==ref.sha256)fail('原配方副本与生成时引用不符，未用当前配置补齐');await check();
    }
    return {index,...result,originalVerified:false,canPrune:false};
  }
  async function exclusive(work){await check();if(busy)fail('恢复资料正在核对');busy=true;
    try{const result=await work();await check();return result;}finally{busy=false;}}
  try{
    await check();version=await openVersion();
    companion=(await archive.readSupplement(selected.supplement,{signal})).receipt;await check();
    body=await archive.readEvidence(selected.evidence,{signal});await check();
    if(['count','bytes','sha256'].some(key=>companion.gallery[key]!==selected.sourceReceipt[key])||!same(body.supplement,selected.supplement)||!galleryEvidenceMatchesSupplement(body.receipt,companion))fail('恢复资料的图库、关联资料与正文依据不属于同一版本');
    const wanted=new Set(companion.order),cursors=new Set();let cursor=null;
    do{
      await yieldNow();const page=await version.page({limit:LIMIT.result,cursor});await check();
      for(const row of page.rows){if(!wanted.has(row.recordId)||rows.has(row.recordId))fail('恢复目录存在重复或额外画面');rows.set(row.recordId,row);}
      cursor=page.cursor;
      if(cursor){const key=JSON.stringify(cursor);if(cursors.has(key)||cursors.size>=LIMIT.rows*LIMIT.pages)fail('恢复目录游标重复或超限');cursors.add(key);}
    }while(cursor);
    if(rows.size!==companion.order.length||rows.size!==version.total)fail('恢复目录未覆盖全部原顺序，未截断为部分资料');
    const summary={scope:structuredClone(selected.scope),target:structuredClone(companion.target),total:rows.size,
      collections:companion.saved.storyboardCollections?.length??0,characterDrafts:companion.saved.characterDrafts?.items?.length??0,
      continuity:{state:companion.version===2?'recorded':'legacy-unknown',continuations:companion.saved.storyboardContinuations?.length??0,retakes:companion.saved.storyboardFloorTakeReceipts?.length??0},
      evidenceFloors:body.receipt.chatEvidence.messages.length,originalVerified:false,canPrune:false};
    return Object.freeze({get summary(){return structuredClone(summary);},
      metadata:()=>exclusive(async()=>structuredClone({selection:selected,supplement:companion,evidence:body.receipt})),
      verify:()=>exclusive(async()=>{const checked=await openVersion();checked.close();await check();return true;}),
      read:index=>exclusive(()=>readAt(index)),
      scan({visit=async()=>{},onProgress=()=>{}}={}){return exclusive(async()=>{
        if(typeof visit!=='function'||typeof onProgress!=='function')fail('恢复资料核对回调无效');
        const digest=createChatGalleryDigest(),recipes={available:0,missing:0},originals={referenced:0,missing:0};
        try{
          for(let index=0;index<summary.total;index++){
            if(index%16===0){await yieldNow();await onProgress({completed:index,total:summary.total});await check();}
            const item=await readAt(index);digest.append(item.record);
            recipes[item.recipe.state==='available'?'available':'missing']++;
            originals[item.media.state==='available'?'referenced':'missing']++;
            await visit(item);await check();
          }
          const result=digest.finish(),expected=selected.sourceReceipt;
          if(['count','bytes','sha256'].some(key=>result[key]!==expected[key]))fail('恢复资料与完整原图库摘要不一致，未确认部分内容');
          const checked=await openVersion();checked.close();await check();
          await onProgress({completed:summary.total,total:summary.total});await check();
          return {...structuredClone(summary),recipes,originals,galleryVerified:true,proof:'archive-source-readback-only',restoreReady:false};
        }finally{digest.close();}
      });},close,
    });
  }catch(error){close();throw error;}
}
