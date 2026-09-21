// Connect immutable record/page storage to the exact SAVED current-chat source.
// Idle application preservation. No host save, original-record mutation, live-head replacement,
// pruning, image download or generation; observed equality is not a server lock.
import {createCurrentChatGalleryReceiptClient} from './qianmu-chat-character-receipt-client.js';
import {createGalleryArchiveStorage} from './qianmu-gallery-archive-storage.js?v=1.59.285';
import {captureGalleryArchiveJson,GALLERY_PAGE_INDEX_LIMITS as LIMIT} from './qianmu-gallery-page-index.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {createHistoricalRecipeArchiveClient} from './qianmu-recipe-archive-client.js?v=1.59.285';
import {vibeDigest} from './qianmu-vibe-file.js';
import {galleryArchiveRecipeState} from './qianmu-gallery-archive-record.js';

const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_source',writeState:'not_started'});};
const canonical=rows=>chatGalleryReceiptText(rows).text;
export async function createCurrentGalleryArchiveSession({getContext,epoch,account,headers,fetchImpl,timeoutMs,
  guard=()=>true,createStorage,yieldWork=async()=>{}}={}){
  if(typeof getContext!=='function'||typeof epoch!=='function'||typeof guard!=='function')fail('画面保全缺少准确的当前聊天来源');
  let client,archive,recipes,closed=false,busy=false,live,captured,sourceText;const records=new Map();
  function external(){
    const value=guard();if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});fail('画面保全需要同步切换保护');}
    if(value!==true)fail('画面保全来源保护已失效');
  }
  function close(){closed=true;recipes?.close();archive?.close();client?.close();}
  function check(){
    if(closed)fail('画面保全来源会话已结束');
    try{external();client.assertCurrent();
      if(getContext().chatMetadata.story_director_liminale?.storyboardImages!==live)fail('当前画面列表已替换，请重新核对来源');
    }catch(error){close();throw error;}return true;
  }
  function unchanged(){
    check();
    // Full JSON/unknown-field equality at operation boundaries, not one entire
    // library scan per native request. Writes remain add-only if a later check fails.
    if(canonical(captureGalleryArchiveJson(live,LIMIT.recordBytes))!==sourceText){close();fail('当前画面资料已修改，请先保存聊天后重新核对');}
  }
  async function saved(){
    unchanged();const receipt=await client.verify(captured);unchanged();
    if(receipt.matches!==true||receipt.state!=='present'){close();fail('原聊天尚未保存相同画面资料，未确认保全');}
    return {...receipt.gallery,proof:receipt.proof};
  }
  function selected(ids){
    check();const keys=captureGalleryArchiveJson(ids,64*1024);
    if(!Array.isArray(keys)||!keys.length||keys.length>LIMIT.rows||new Set(keys).size!==keys.length)fail('画面保全须选择1至128个不同的原记录');
    return keys.map(id=>{if(typeof id!=='string'||!records.has(id))fail('画面保全选择不属于原聊天，未猜测记录');return records.get(id).record;});
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
  try{
    external();client=await createCurrentChatGalleryReceiptClient({getContext,epoch,account,headers,fetchImpl,timeoutMs,guard:external});
    live=getContext().chatMetadata.story_director_liminale?.storyboardImages;check();
    captured=captureGalleryArchiveJson(live,LIMIT.recordBytes);sourceText=canonical(captured);
    for(const record of captured){
      if(typeof record.id!=='string'||!record.id||records.has(record.id))fail('原聊天画面编号缺失或重复，未选择或合并记录');
      records.set(record.id,{record,text:canonical([record])});
    }
    archive=await createGalleryArchiveStorage({scope:{namespace:client.owner.namespace,...client.source},guard:check,createStorage,yieldWork,
      verifyRecord:record=>{check();return records.get(record.id)?.text===canonical([record]);}});check();
    const identity=JSON.stringify([archive.scope,await vibeDigest(sourceText)]);unchanged();
    return Object.freeze({scope:archive.scope,identity,
      preserveRecord(id){const [record]=selected([id]);return preserve(()=>archive.preserveRecord(record));},
      stagePage(ids){const rows=selected(ids);return preserve(()=>archive.stagePage(rows));},
      preserveAll(){return preserve(async sourceReceipt=>{
        // Sorting is only for the independent chronological index; captured
        // source order and every original record stay untouched.
        const ordered=[...captured].sort((a,b)=>b.createdAt-a.createdAt||(a.id<b.id?1:a.id>b.id?-1:0)),pages=[];let recipeCopies=0;
        for(let at=0;at<ordered.length;at+=LIMIT.rows){
          const batch=ordered.slice(at,at+LIMIT.rows);
          await yieldWork();unchanged();const result=await archive.stagePage(batch);unchanged();pages.push(result.descriptor);
          for(const record of batch){
            if(galleryArchiveRecipeState(record)!=='server-reference')continue;
            await yieldWork();check();recipes??=createHistoricalRecipeArchiveClient({namespace:client.owner.namespace,target:client.target,records:captured,headers,fetchImpl,timeoutMs,guard:async()=>{check();await client.guard();check();}});
            const read=await recipes.read(record);check();
            if(read.selection.gallerySha256!==sourceReceipt.sha256)fail('配方读取来源版本与本次保全不符');
            await archive.preserveServerRecipe(record,read);check();recipeCopies++;
            await new Promise(resolve=>setTimeout(resolve,0));check();
          }
        }
        await yieldWork();unchanged();return {...await archive.publishSourceVersion(sourceReceipt,pages),recipeCopies};
      });},
      openSourceVersion:receipt=>{check();return archive.openSourceVersion(receipt);},
      readRecord:ref=>{check();return archive.readRecord(ref);},
      readRecipe:(ref,options)=>{check();return archive.readRecipe(ref,options);},
      openStagedPage:descriptor=>{check();return archive.openStagedPage(descriptor);},close,
    });
  }catch(error){close();throw error;}
}
