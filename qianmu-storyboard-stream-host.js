import {storyboardStreamGeneration,storyboardStreamFingerprint,storyboardStreamParagraphBoundary} from './qianmu-storyboard-stream-reference.js?v=1.59.387';
import {createStoryboardStreamScheduler} from './qianmu-storyboard-stream-scheduler.js?v=1.59.387';
import {createStoryboardMessageReference} from './qianmu-storyboard.js?v=1.59.387';

const kind=value=>value==null||value===''?'normal':value;
const identity=message=>JSON.stringify([message.name,message.is_user===true,message.is_system===true,message.swipe_id||0,
  storyboardStreamGeneration(message),message.swipe_info?.[0]?.send_date,message.swipe_info?.[0]?.extra?.gen_id]);

// Lifecycle adapter, not a generator. Raw token arguments are deliberately
// ignored. The public ST processor identifies the source; a delayed wake reads
// processed chat text. Explicit continue stays with the saved-lineage host
// until its growing bridge is integrated; quiet/impersonate never participate.
export function createStoryboardStreamHost(d){
  let active=null,closed=false;const bindings=[],setTimer=d.setTimer||setTimeout,clearTimer=d.clearTimer||clearTimeout;
  let host;try{host=d.getContext()||{};}catch(_){host={};}
  const source=host.eventSource,types=host.eventTypes||host.event_types||{},remove=source?.removeListener||source?.off;
  const optional=(fn,...args)=>{try{void Promise.resolve(fn?.(...args)).catch(()=>{});}catch(_){}};
  const clear=entry=>{const timer=entry?.timer;if(entry)entry.timer=null;if(timer!=null)try{clearTimer(timer);}catch(_){}};
  const release=entry=>{if(!entry||entry.released)return;entry.released=true;clear(entry);entry.controller.abort();
    try{entry.scheduler?.close();}catch(_){}try{entry.frame?.dispose();}catch(_){}try{entry.signal?.removeEventListener('abort',entry.abort);}catch(_){}};
  const cancel=()=>{if(active){active.cancelled=true;release(active);}};
  const reset=()=>{release(active);active=null;};
  const sameContext=entry=>{const context=d.getContext();return !closed&&active===entry&&d.epoch()===entry.epoch&&context.chat===entry.chat&&context.chatMetadata===entry.metadata;};
  const current=entry=>{try{return !entry.cancelled&&!entry.controller.signal.aborted&&sameContext(entry)&&d.enabled()===true
    &&(!entry.processor||d.getContext().streamingProcessor===entry.processor&&!entry.processor.abortController.signal.aborted
      &&entry.chat[entry.floor]===entry.message&&identity(entry.message)===entry.identity);}catch(_){return false;}};
  // A compiled batch may outlive the compiler's preparation guard and this
  // host's final frame. Keep only its generation ownership, not the borrowed
  // processor or aborted frame, after a successful terminal handoff.
  const owns=entry=>{try{return !entry.cancelled&&entry.finalSucceeded!==false&&sameContext(entry)&&d.enabled()===true
    &&entry.chat[entry.floor]===entry.message&&identity(entry.message)===entry.identity; }catch(_){return false;}};
  function leaseFor(messageRef){
    const entry=active;
    // Final expression may need a fresh lease after the host has released its
    // processor/frame. That is safe only after a successful terminal handoff;
    // the immutable generation and paragraph proof are still verified below.
    if(!entry?.message||!(current(entry)||entry.finalSucceeded===true&&owns(entry))||typeof d.getChatKey!=='function')return null;
    let chatKey,reference;
    try{
      chatKey=String(d.getChatKey()||'');
      reference=createStoryboardMessageReference({message:entry.message,chatKey,floor:entry.floor});
    }catch(_){return null;}
    const proof=messageRef?.stream;
    if(!chatKey||messageRef?.chatKey!==chatKey||messageRef.messageKey!==reference.messageKey
      ||messageRef.role!=='assistant'||messageRef.lastKnownFloor!==entry.floor||messageRef.swipeId!==reference.swipeId
      ||!proof?.generation||!Number.isSafeInteger(proof.prefixLength)||proof.prefixLength<1
      ||JSON.stringify(proof.generation)!==JSON.stringify(storyboardStreamGeneration(entry.message)))return null;
    const sourceCurrent=()=>{try{const raw=entry.message.mes;
      return typeof raw==='string'&&storyboardStreamParagraphBoundary(raw,proof.prefixLength)
        &&storyboardStreamFingerprint(raw.slice(0,proof.prefixLength))===proof.prefixHash
        &&String(d.getChatKey()||'')===chatKey;
    }catch(_){return false;}};
    if(!sourceCurrent())return null;
    return Object.freeze({isCurrent:()=>owns(entry)&&sourceCurrent()});
  }
  const notice=entry=>{if(entry.notified)return;entry.notified=true;optional(d.notify,'提前取景已停止，已入队画面保留；可在正文完成后手动核对');};
  function start(type,options={},dryRun=false){
    if(closed||dryRun!==false)return;
    reset();type=kind(type);
    if(!['normal','swipe','regenerate'].includes(type)||d.enabled()!==true)return;
    const context=d.getContext();if(!Array.isArray(context.chat))return;
    const previousMessage=context.chat.at(-1);
    const entry={type,chat:context.chat,metadata:context.chatMetadata,epoch:d.epoch(),previous:context.streamingProcessor,previousMessage,
      previousIdentity:previousMessage?identity(previousMessage):null,
      signal:options?.signal,controller:new AbortController(),timer:null,cancelled:false,released:false,notified:false,terminal:false,finalSucceeded:null,frame:null,scheduler:null,final:null};
    entry.abort=()=>{if(active===entry)cancel();};active=entry;
    if(entry.signal?.aborted){cancel();return;}entry.signal?.addEventListener('abort',entry.abort,{once:true});
  }
  function select(entry){
    if(!current(entry))return false;
    const processor=d.getContext().streamingProcessor,floor=processor?.messageId,message=entry.chat[floor];
    if(!processor||processor===entry.previous||kind(processor.type)!==entry.type||!processor.abortController?.signal||processor.abortController.signal.aborted
      ||!Number.isSafeInteger(floor)||floor<0||floor!==entry.chat.length-1||!message||message.is_user||message.is_system)return false;
    const generation=storyboardStreamGeneration(message);if(!(generation.startedAt||generation.id||generation.activeId))return false;
    if(message===entry.previousMessage&&identity(message)===entry.previousIdentity)return false;
    entry.processor=processor;entry.floor=floor;entry.message=message;entry.identity=identity(message);
    entry.frame=d.openFrame({floor,message,signal:entry.controller.signal});
    if(!entry.frame||typeof entry.frame.assertCurrent!=='function'||typeof entry.frame.dispose!=='function')throw Error('stream source guard unavailable');
    entry.frame.assertCurrent();
    entry.scheduler=(d.createScheduler||createStoryboardStreamScheduler)({isCurrent:()=>current(entry),busy:d.busy,
      read:()=>{entry.frame.assertCurrent();return entry.message.mes;},
      run:async({signal})=>{entry.frame.assertCurrent();return d.run({floor,signal});},
      finish:async()=>{entry.frame.assertCurrent();return true;},setTimer,clearTimer,now:d.now,intervalMs:d.intervalMs});
    return true;
  }
  function pulse(){
    const entry=active;if(!entry||entry.terminal)return;
    if(!current(entry)){cancel();return;}
    if(entry.scheduler){entry.scheduler.pulse();return;}
    if(entry.timer!==null)return;
    entry.timer=setTimer(()=>{
      entry.timer=null;if(!current(entry)||entry.terminal)return;
      try{if(select(entry))entry.scheduler.pulse();}catch(_){cancel();notice(entry);}
    },120);
  }
  function beforeAutomatic(floor,message,type){
    try{
      const entry=active;if(!entry||!sameContext(entry)||kind(type)!==entry.type)return null;
      if(entry.message&&(entry.floor!==floor||entry.message!==message))return null;
      if(!entry.message&&(entry.chat[floor]!==message||floor!==entry.chat.length-1))return null;
      if(entry.cancelled)return false;
      if(entry.final)return entry.final;
      const processor=d.getContext().streamingProcessor;
      if(entry.cancelled||entry.signal?.aborted||processor&&processor!==entry.previous&&kind(processor.type)===entry.type&&processor.abortController?.signal?.aborted){cancel();return false;}
      entry.terminal=true;clear(entry);
      if(!entry.scheduler){release(entry);return null;}
      entry.final=entry.scheduler.finalize().then(ok=>{
        entry.finalSucceeded=Boolean(ok&&current(entry));
        if(!entry.finalSucceeded&&sameContext(entry))notice(entry);
        return entry.finalSucceeded;
      }).catch(()=>{entry.finalSucceeded=false;return false;}).finally(()=>release(entry));
      return entry.final;
    }catch(_){cancel();return false;}
  }
  const safe=fn=>(...args)=>{try{fn(...args);}catch(_){cancel();}};
  const input=safe(event=>{const target=event?.target;if(target?.closest?.('.sd-storyboard-root')&&target.matches?.('input, textarea, select')
    &&target.type!=='search'&&!/search/.test(String(target.className||'')))cancel();});
  const close=()=>{closed=true;reset();for(const [event,handler]of bindings.splice(0))try{remove.call(source,event,handler);}catch(_){}
    for(const event of ['input','change'])try{d.document?.removeEventListener(event,input,true);}catch(_){};};
  if(typeof source?.on==='function'&&typeof remove==='function'){
    try{
      for(const [name,fallback,handler] of [['GENERATION_AFTER_COMMANDS','generation_after_commands',safe(start)],['STREAM_TOKEN_RECEIVED','stream_token_received',safe(pulse)],
        ['GENERATION_STOPPED','generation_stopped',safe(cancel)],['CHAT_CHANGED','chat_id_changed',safe(reset)],
        ['MESSAGE_EDITED','message_edited',safe(cancel)],['MESSAGE_DELETED','message_deleted',safe(cancel)],['MESSAGE_SWIPED','message_swiped',safe(cancel)],
        ['MESSAGE_RECEIVED','message_received',safe((floor,type)=>{const index=typeof floor==='string'&&/^\d+$/.test(floor)?Number(floor):floor;
          if(Number.isSafeInteger(index)&&index>=0)optional(()=>beforeAutomatic(index,d.getContext().chat?.[index],type));})]]){
        const event=types[name]||fallback;bindings.push([event,handler]);source.on(event,handler);
      }
      d.document?.addEventListener('input',input,true);d.document?.addEventListener('change',input,true);
    }catch(_){close();}
  }
  return Object.freeze({beforeAutomatic,reset,close,takeover:cancel,leaseFor,wake(){try{active?.scheduler?.wake();}catch(_){cancel();}}});
}
