import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {createStoryboardMessageReference} from './qianmu-storyboard.js';
import {storyboardStreamGeneration,storyboardStreamGenerationInput,storyboardStreamDigest,storyboardStreamFingerprint,normalizeStoryboardStreamReference,storyboardStreamParagraphBoundary} from './qianmu-storyboard-stream-reference.js?v=1.59.360';

export const STORYBOARD_STREAM_SOURCE_LIMIT=200000;
const frames=new WeakMap();
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_stream_source'});};
const frozen=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};
const timestamp=value=>value instanceof Date?value.toISOString():value;
const swipeInfo=value=>value?{send_date:timestamp(value.send_date),extra:{gen_id:value.extra?.gen_id}}:undefined;
function snapshotMessage(message){
  const info=[];if(message.swipe_info?.[0])info[0]=swipeInfo(message.swipe_info[0]);
  if(message.swipe_info?.[message.swipe_id])info[message.swipe_id]=swipeInfo(message.swipe_info[message.swipe_id]);
  return frozen({mes:message.mes,name:message.name,is_user:message.is_user,is_system:message.is_system,swipe_id:message.swipe_id,
    send_date:timestamp(message.send_date),gen_started:timestamp(message.gen_started),extra:{gen_id:message.extra?.gen_id},swipe_info:info});
}

// This finds a syntactically closed paragraph prefix, NOT semantic readiness.
// The director must still prove presence, scene and action before buying a shot.
// Ignore the host's raw token argument: it can contain unprocessed reasoning and
// ST emits that event before updating chat[].mes.
export function storyboardStableStreamBoundary(text){
  if(typeof text!=='string'||text.length>STORYBOARD_STREAM_SOURCE_LIMIT||/\r(?!\n)/.test(text))return 0;
  let offset=0,end=0,fence='',width=0,content=false;
  for(const line of text.matchAll(/([^\r\n]*)(\r?\n|$)/g)){
    if(!line[0])break;
    const body=line[1],marker=/^ {0,3}(`{3,}|~{3,})/.exec(body);
    if(marker){
      if(!fence){fence=marker[1][0];width=marker[1].length;}
      else if(marker[1][0]===fence&&marker[1].length>=width&&body.slice(marker[0].length).trim()==='')fence='';
    }
    offset+=line[0].length;
    if(!fence&&line[2]&&body.trim()===''&&content)end=offset;
    if(body.trim())content=true;
  }
  return end;
}

// A short-lived, borrowed host view. It never changes chat[].mes, the stored
// message identity, or the user's selected earlier-floor window.
export async function captureStoryboardStreamFrame({getContext,epoch,resolveNamespace,isCurrent,floor,signal}={}){
  if(typeof getContext!=='function'||typeof epoch!=='function'||typeof resolveNamespace!=='function'||typeof isCurrent!=='function'
    ||!Number.isSafeInteger(floor)||floor<0)fail('流式来源范围无效');
  const host=captureCurrentChatSource({getContext,epoch}),listeners=[];
  let closed=false,handle,message,raw,prefix,namespace,view,reference,identity,borrowed=false;
  let context,emitter,remove;
  const close=()=>{closed=true;host.close();frames.delete(handle);signal?.removeEventListener('abort',close);
    for(const [type,handler] of listeners.splice(0))try{remove.call(emitter,type,handler);}catch(_){}
    message=null;raw=null;prefix=null;view=null;};
  const readIdentity=item=>{
    const ref=createStoryboardMessageReference({message:item,chatKey:host.source.chatKey,floor,now:1});
    return JSON.stringify([ref.messageKey,ref.role,ref.name,ref.swipeId,ref.baseSendDate,ref.baseGenerationId,
      timestamp(item.send_date),timestamp(item.gen_started),item.extra?.gen_id,
      swipeInfo(item.swipe_info?.[item.swipe_id||0])]);
  };
  const assertCurrent=()=>{
    try{
      if(closed||signal?.aborted||isCurrent()!==true)fail('流式来源已关闭或切换');host.assertCurrent();
      const current=getContext().chat[floor];
      if(message&&(current!==message||current.is_user||current.is_system||typeof current.mes!=='string'
        ||!current.mes.startsWith(prefix)||!storyboardStreamParagraphBoundary(current.mes,prefix.length)||readIdentity(current)!==identity))fail('已确认片段或回复版本已变化');
      return true;
    }catch(error){close();throw error;}
  };
  const guard=async()=>{try{assertCurrent();const account=await resolveNamespace();assertCurrent();if(account!==namespace)fail('流式来源账户已切换');return true;}catch(error){close();throw error;}};
  try{
    context=getContext();emitter=context.eventSource;remove=typeof emitter?.removeListener==='function'?emitter.removeListener:emitter?.off;
    signal?.addEventListener('abort',close,{once:true});assertCurrent();
    message=context.chat[floor];
    if(!message||message.is_user||message.is_system||typeof message.mes!=='string')fail('流式取景仅接受当前角色正文');
    if(message.mes.length>STORYBOARD_STREAM_SOURCE_LIMIT)fail('流式正文超过单次容量，未截断或发送');
    if(!Number.isSafeInteger(message.swipe_id??0)||(message.swipe_id??0)<0||(message.swipe_id??0)>10000)fail('流式回复编号无效');
    raw=message.mes;const paragraphLength=storyboardStableStreamBoundary(raw);
    if(!paragraphLength){close();return null;}
    prefix=raw.slice(0,paragraphLength).trimEnd();const stableLength=prefix.length;
    if(!stableLength){close();return null;}
    reference=createStoryboardMessageReference({message,chatKey:host.source.chatKey,floor});
    if(!reference.baseSendDate&&!reference.baseGenerationId){close();return null;} // No guessed text-only identity.
    identity=readIdentity(message);const snapshot=snapshotMessage(message);
    const generation=storyboardStreamGeneration(snapshot);
    if(!generation.startedAt&&!generation.id&&!generation.activeId){close();return null;}
    if(typeof emitter?.on==='function'&&typeof remove==='function'){
      const types=context.eventTypes||{};
      for(const [name,fallback] of [['MESSAGE_EDITED','message_edited'],['MESSAGE_SWIPED','message_swiped'],['MESSAGE_DELETED','message_deleted']]){
        const handler=value=>{if(name==='MESSAGE_DELETED'||!Number.isSafeInteger(value)||value===floor)close();};
        const type=types[name]||fallback;listeners.push([type,handler]);emitter.on(type,handler);assertCurrent();
      }
    }
    namespace=await resolveNamespace();assertCurrent();
    if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))fail('流式来源账户尚未确认');
    if(!globalThis.crypto?.subtle)fail('当前环境不能核对流式来源，未提前取景');
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(prefix))),byte=>byte.toString(16).padStart(2,'0')).join('');
    assertCurrent();
    const refuse=()=>fail('流式来源视图只读');
    view=new Proxy(context.chat,{get(target,key,receiver){return key===String(floor)?snapshot:Reflect.get(target,key,receiver);},set:refuse,defineProperty:refuse,deleteProperty:refuse});
    const getView=()=>{assertCurrent();return {...getContext(),chat:view};};
    const proof=frozen({version:1,floor,stableLength,snapshotLength:raw.length,prefixDigest:digest,messageRef:{...reference}});
    await guard();handle=Object.freeze({proof,assertCurrent,guard,close});
    frames.set(handle,{getContext,epoch,resolveNamespace,getView,snapshot,prefix,paragraphLength,claim(){assertCurrent();if(borrowed)fail('流式片段已被另一次取景借用');borrowed=true;}});
    return handle;
  }catch(error){close();throw error;}
}

export function borrowStoryboardStreamFrame(frame,{getContext,epoch,resolveNamespace,floor}={}){
  const entry=frames.get(frame);
  if(!entry||entry.getContext!==getContext||entry.epoch!==epoch||entry.resolveNamespace!==resolveNamespace||frame.proof.floor!==floor)fail('流式片段不属于当前取景会话');
  entry.claim();
  return {getContext:entry.getView,assertCurrent:frame.assertCurrent,guard:frame.guard,close:frame.close,proof:frame.proof,
    stableParagraphs:read=>read({...entry.snapshot,mes:entry.snapshot.mes.slice(0,entry.paragraphLength)},floor)};
}

export async function createStoryboardStreamMessageReference(frame){
  const entry=frames.get(frame);if(!entry)fail('流式片段已关闭或并非当前来源');
  await frame.guard();
  const generation=storyboardStreamGeneration(entry.snapshot),ref={...frame.proof.messageRef};
  const generationKey=await storyboardStreamDigest(storyboardStreamGenerationInput(ref,generation));
  ref.revisionHash=storyboardStreamFingerprint(entry.prefix);ref.revisionId=`stream:${generationKey}`;
  ref.stream={version:1,generation,generationKey,prefixLength:frame.proof.stableLength,prefixDigest:frame.proof.prefixDigest,prefixHash:ref.revisionHash,closedParagraph:true};
  if(normalizeStoryboardStreamReference(ref).invalid)fail('当前回复缺少稳定的生成身份，等待正文完成');
  await frame.guard();return frozen(ref);
}
