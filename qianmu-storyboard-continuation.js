// Only an observed host "continue" may bridge reply generations. No text-only
// guessing, changes to ST's timestamps/body, copied prose in metadata or HTTP.
import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {normalizeStoryboardContinuationLinks,storyboardContinuationEndpoint as endpoint,storyboardContinuationSignature as signature,stageStoryboardContinuationLinks,storyboardContinuationSource,storyboardContinuationIdentityInput} from './qianmu-storyboard-continuation-proof.js?v=1.59.343';
export {normalizeStoryboardContinuationLinks,storyboardContinuationPath} from './qianmu-storyboard-continuation-proof.js?v=1.59.343';
import {storyboardStreamGeneration,storyboardStreamDigest,storyboardStreamFingerprint} from './qianmu-storyboard-stream-reference.js?v=1.59.343';
const handles=new WeakMap(),writers=new WeakMap();
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const stop=()=>{throw Object.assign(new Error('续写来源未能完整核对，未沿用旧任务身份'),{code:'storyboard_continuation'});};
const copy=value=>JSON.parse(JSON.stringify(value));

// Synchronous snapshot at GENERATION_AFTER_COMMANDS, before ST rewrites its
// dates. Account lookup/hash/save are deferred and never block text generation.
export function captureStoryboardContinuation({type,dryRun=false,signal,getContext,epoch,createReference}={}){
  if(type!=='continue'||dryRun!==false||signal?.aborted)return null;
  if(typeof createReference!=='function')stop();
  const host=captureCurrentChatSource({getContext,epoch}),context=getContext(),floor=context.chat.length-1,message=context.chat[floor];
  let closed=false,handle;const bindings=[];
  const emitter=context.eventSource,remove=emitter?.removeListener||emitter?.off;
  const close=()=>{closed=true;host.close();handles.delete(handle);signal?.removeEventListener('abort',close);
    for(const [type,fn] of bindings.splice(0))try{remove.call(emitter,type,fn);}catch(_){}};
  try{
    if(!message||message.is_user||message.is_system||typeof message.mes!=='string'||!message.mes.trim()||message.mes.length>200000){close();return null;}
    const raw=message.mes,name=String(message.name||''),swipe=message.swipe_id??0;
    const before=createReference({message,chatKey:host.source.chatKey,floor});
    if(!before.baseSendDate&&!before.baseGenerationId){close();return null;}
    const from=endpoint({messageKey:before.messageKey,swipeId:before.swipeId,generation:storyboardStreamGeneration(message)});
    const check=()=>{
      try{
        if(closed||signal?.aborted)stop();host.assertCurrent();
        if(getContext().chat[floor]!==message||getContext().chat.length!==floor+1||message.is_user||message.is_system
          ||String(message.name||'')!==name||(message.swipe_id??0)!==swipe||typeof message.mes!=='string'||!message.mes.startsWith(raw))stop();
        return true;
      }catch(error){close();throw error;}
    };
    signal?.addEventListener('abort',close,{once:true});
    if(typeof emitter?.on==='function'&&typeof remove==='function'){
      for(const event of ['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','GENERATION_AFTER_COMMANDS']){
        const type=(context.eventTypes||context.event_types||{})[event]||event.toLowerCase();
        const fn=value=>{if(event==='GENERATION_AFTER_COMMANDS'||event==='MESSAGE_DELETED'||!Number.isSafeInteger(value)||value===floor)close();};
        bindings.push([type,fn]);emitter.on(type,fn);
      }
    }
    check();handle=Object.freeze({floor,close,assertCurrent:check});
    handles.set(handle,{host,getContext,createReference,message,raw,name,from,source:storyboardContinuationSource(before),check});return handle;
  }catch(error){close();throw error;}
}

// Produces a detached proposal, not a generation permission or a new budget.
export async function prepareStoryboardContinuation(handle,resolveNamespace){
  const source=handles.get(handle);if(!source||typeof resolveNamespace!=='function')stop();source.check();
  const namespace=await resolveNamespace();source.check();
  if(!text(namespace,512)||!namespace.startsWith('st-user:')||!namespace.slice(8).trim())stop();
  const ref=source.createReference({message:source.message,chatKey:source.host.source.chatKey,floor:handle.floor});
  const to=endpoint({messageKey:ref.messageKey,swipeId:ref.swipeId,generation:storyboardStreamGeneration(source.message)});
  if(signature(source.from)===signature(to))return null; // Host has not updated the generation yet.
  const digest=await storyboardStreamDigest(source.raw);source.check();
  const row={version:2,namespace,chatKey:source.host.source.chatKey,name:source.name,from:copy(source.from),to,source:copy(source.source),
    length:source.raw.length,hash:storyboardStreamFingerprint(source.raw),digest,createdAt:Date.now()};
  row.id=await storyboardStreamDigest(storyboardContinuationIdentityInput(row));source.check();
  if(signature(to)!==signature({messageKey:source.createReference({message:source.message,chatKey:row.chatKey,floor:handle.floor}).messageKey,
    swipeId:source.message.swipe_id??0,generation:storyboardStreamGeneration(source.message)}))stop();
  if(namespace!==await resolveNamespace())stop();source.check();
  if(signature(to)!==signature({messageKey:source.createReference({message:source.message,chatKey:row.chatKey,floor:handle.floor}).messageKey,
    swipeId:source.message.swipe_id??0,generation:storyboardStreamGeneration(source.message)}))stop();
  return normalizeStoryboardContinuationLinks([row])[0];
}

export async function saveStoryboardContinuation(handle,resolveNamespace,store,save){
  const source=handles.get(handle);if(!source||!object(store)||typeof save!=='function')stop();
  const old=writers.get(store),pending=(old?old.catch(()=>{}):Promise.resolve()).then(async()=>{
    source.check();if(source.getContext().chatMetadata.story_director_liminale!==store)stop();
    const proposal=await prepareStoryboardContinuation(handle,resolveNamespace);if(!proposal)return null;
    source.check();const had=Object.hasOwn(store,'storyboardContinuations'),before=store.storyboardContinuations;
    const rows=normalizeStoryboardContinuationLinks(had?before:[]),same=rows.find(row=>row.id===proposal.id);
    if(same)return copy(same);
    const next=normalizeStoryboardContinuationLinks([...rows,proposal]);source.check();const finish=stageStoryboardContinuationLinks(store,next);
    let saved=false;
    try{await save();saved=true;source.check();return copy(proposal);}
    finally{finish(saved);}
  });
  writers.set(store,pending);try{return await pending;}finally{if(writers.get(store)===pending)writers.delete(store);}
}
