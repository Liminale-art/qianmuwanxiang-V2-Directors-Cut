import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {galleryArchiveScope} from './qianmu-gallery-archive-record.js';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {createStoryboardMessageReference,createStoryboardParagraphAnchor,resolveStoryboardMessageReference,resolveStoryboardOrdinaryMessageContinuation} from './qianmu-storyboard.js';
import {hasStoryboardStreamReference,normalizeStoryboardStreamReference,verifyStoryboardStreamReference} from './qianmu-storyboard-stream-reference.js';
import {verifyStoryboardOrdinaryContinuation} from './qianmu-storyboard-ordinary-continuation.js';
import {readStoryboardContinuationLinks} from './qianmu-storyboard-continuation-proof.js?v=1.59.306';
import {hashText} from './qianmu-storyboard-utils.js';

const fail=message=>{throw Object.assign(Error(message),{code:'gallery_location'});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const identity=['messageKey','revisionId','revisionHash','swipeId','role','name','baseSendDate','baseGenerationId'];
const clean=value=>String(value??'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const eligible=message=>message&&!message.is_user&&!message.is_system&&typeof message.mes==='string'&&message.mes.trim();
function withoutFloor(reference){const ref=structuredClone(reference);ref.lastKnownFloor=null;
  if(ref.stream?.family?.reference)ref.stream.family.reference=withoutFloor(ref.stream.family.reference);return ref;}

// A one-click read-only location lease. No gallery membership requirement: a
// preserved record may be absent from the live gallery. Never attach or repair.
export async function createGalleryLocation({record,scope,getContext,epoch,account,isCurrent=()=>true,paragraphs=()=>[],signal,timeoutMs=30000}={}){
  const owner=galleryArchiveScope(scope);
  const saved=captureGalleryArchiveJson({chatKey:record?.chatKey??'',messageRef:record?.messageRef??null,paragraphAnchor:record?.paragraphAnchor??null,
    messageHash:record?.messageHash??'',swipeId:record?.swipeId??null,unplaced:Boolean(record?.restoreLinkReview||record?.worldReference||record?.target==='gallery')},65536);
  if(saved.unplaced||saved.messageRef?.version!==1||saved.messageRef?.role!=='assistant'||!identity.every(k=>Object.hasOwn(saved.messageRef,k))
    ||!saved.messageRef.messageKey||!saved.messageRef.revisionId||!saved.messageRef.revisionHash||!Number.isSafeInteger(saved.messageRef.swipeId)||saved.messageRef.swipeId<0
    ||(saved.swipeId!=null&&saved.swipeId!==saved.messageRef.swipeId)
    ||[saved.chatKey,saved.messageRef.chatKey,saved.paragraphAnchor?.chatKey].some(key=>key&&key!==owner.chatKey))fail('此画面没有可核对的正文位置；原画面保留，不按旧楼层号猜跳');
  if(typeof account!=='function'||typeof paragraphs!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('正文定位环境尚未就绪');
  const host=captureCurrentChatSource({getContext,epoch}),reference=withoutFloor(saved.messageRef);let closed=false,proof=null;
  function close(){closed=true;proof=null;host.close();signal?.removeEventListener('abort',close);}
  function check(){if(closed||signal?.aborted||isCurrent()!==true)fail('正文定位已取消或页面变化');host.assertCurrent();
    if(!same(host.source,{ownerKey:owner.ownerKey,chatKey:owner.chatKey}))fail('请先打开这幅画面的原聊天；不会自动切换聊天');return true;}
  function resolve(){check();const context=getContext(),messages=context.chat,links=readStoryboardContinuationLinks(context.chatMetadata.story_director_liminale);
    const options={chatKey:owner.chatKey,namespace:owner.namespace,continuationLinks:links};
    if(hasStoryboardStreamReference(reference))return resolveStoryboardMessageReference(reference,messages,options);
    const matches=[];for(let floor=0;floor<messages.length;floor++)if(eligible(messages[floor])){
      const current=createStoryboardMessageReference({message:messages[floor],chatKey:owner.chatKey,floor,now:1});
      if(identity.every(key=>current[key]===reference[key]))matches.push({state:'active',floor,message:messages[floor],current,reference});
    }
    if(matches.length>1)fail('正文来源重复，无法唯一定位；未按距离或旧楼层号选择');
    return matches[0]||resolveStoryboardOrdinaryMessageContinuation(reference,messages,options);
  }
  function position(found){const anchor=saved.paragraphAnchor,raw=found.message.mes;
    const source=hasStoryboardStreamReference(reference)?raw.slice(0,normalizeStoryboardStreamReference(reference).prefixLength)
      :found.ordinaryContinuation?raw.slice(0,found.continuations[0].length):raw;
    let index=null,text='';
    if(anchor?.version===1&&source.length<=2*1048576&&anchor.swipeId===reference.swipeId
      &&anchor.messageHash===createStoryboardParagraphAnchor({messageText:source}).messageHash){
      let rows=[];try{rows=paragraphs(source);}catch{/* Source floor is still exact. */}
      const n=anchor.paragraphIndex;
      if(Array.isArray(rows)&&rows.length<=240&&rows.every(row=>typeof row==='string')&&Number.isSafeInteger(n)&&n>=0&&n<rows.length){
        const candidate=createStoryboardParagraphAnchor({paragraphText:rows[n],previousText:rows[n-1],nextText:rows[n+1]});
        if(candidate.paragraphHash===anchor.paragraphHash&&clean(rows[n]).slice(0,1200)===clean(anchor.paragraphText)
          &&(!anchor.previousHash||candidate.previousHash===anchor.previousHash)&&(!anchor.nextHash||candidate.nextHash===anchor.nextHash)){index=n;text=rows[n];}
      }
    }
    return {floor:found.floor,paragraphIndex:index,paragraphText:text,kind:hasStoryboardStreamReference(reference)?'stream':found.ordinaryContinuation?'continuation':'exact',readOnly:true};
  }
  function assertCurrent(){check();if(!proof)fail('正文定位尚未核对');const found=resolve();
    if(found?.state!=='active'||found.floor!==proof.floor||found.message!==proof.message||found.message.mes!==proof.raw
      ||!same(found.continuations||[],proof.continuations)||!same(found.family||null,proof.family))fail('定位期间正文或续写依据已变化');return structuredClone(proof.position);}
  async function verify(){check();if(await account()!==owner.namespace)fail('正文定位账户已变化');check();const found=resolve();
    if(found?.state!=='active'||!eligible(found.message))fail('原回复已修改、切换或无法唯一确认；画面保留，未猜跳');
    const raw=found.message.mes;
    if(hasStoryboardStreamReference(reference))await verifyStoryboardStreamReference(reference,resolve);
    else if(found.ordinaryContinuation)await verifyStoryboardOrdinaryContinuation(reference,resolve,{namespace:owner.namespace,required:true});
    else if(saved.messageHash&&hashText(raw)!==saved.messageHash)fail('画面记录与原回复版本不一致');
    check();if(await account()!==owner.namespace)fail('正文定位账户已变化');check();
    proof={floor:found.floor,message:found.message,raw,continuations:structuredClone(found.continuations||[]),family:structuredClone(found.family||null),position:position(found)};
    return assertCurrent();
  }
  signal?.addEventListener('abort',close,{once:true});
  let timer,stop;const aborted=new Promise((_,reject)=>{stop=()=>{close();reject(Error('正文定位已取消'));};});
  signal?.addEventListener('abort',stop,{once:true});
  try{
    await Promise.race([verify(),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>{close();reject(Error('正文定位核对超时，请重新打开'));},timeoutMs);})]);
    return Object.freeze({verify,assertCurrent,close});
  }catch(error){close();throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
}
