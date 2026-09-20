// Observe only an explicit host continue. No polling, raw-token interpretation,
// generation requests, timestamp edits or whole-chat direct writes.
import {captureStoryboardContinuation,saveStoryboardContinuation} from './qianmu-storyboard-continuation.js?v=1.59.239';
import {acquireChatSaveLock,releaseChatSaveLock} from './qianmu-chat-save-lock.js';
import {storyboardStreamGeneration} from './qianmu-storyboard-stream-reference.js?v=1.59.239';

export function createStoryboardContinuationHost(d){
  let active=null,closed=false;const bindings=[];
  const context=d.getContext(),source=context.eventSource,types=context.eventTypes||context.event_types||{};
  const remove=source?.removeListener||source?.off;
  const generation=message=>JSON.stringify(storyboardStreamGeneration(message));
  const current=entry=>!closed&&active===entry&&d.epoch()===entry.epoch&&d.enabled()
    &&d.getContext().chatMetadata===entry.metadata&&d.getContext().chat===entry.chat&&entry.chat[entry.floor]===entry.message;
  const notice=entry=>{
    if(entry.notified||!current(entry))return;entry.notified=true;
    d.notify('续写来源或保存尚未确认，未自动补图；旧图保留，可稍后手动重新提取');
  };
  const reset=()=>{active?.handle?.close();active=null;};
  function start(type,options={},dryRun=false){
    if(closed||dryRun!==false)return;
    reset();if(type!=='continue'||!d.enabled())return;
    const host=d.getContext(),floor=host.chat?.length-1,message=host.chat?.[floor];
    const entry={epoch:d.epoch(),metadata:host.chatMetadata,chat:host.chat,floor,message,handle:null,pending:null,failed:false,notified:false};
    active=entry;
    try{
      d.ensureStore?.();
      entry.handle=captureStoryboardContinuation({type,dryRun,signal:options?.signal,getContext:d.getContext,epoch:d.epoch,createReference:d.createReference});
      if(!entry.handle)entry.failed=true;
    }catch(_){entry.failed=true;}
  }
  async function persist(entry){
    let timer,token={},locked=false;
    try{
      if(!current(entry)||entry.failed||!entry.handle)throw Error('unavailable');
      entry.handle.assertCurrent();
      const host=d.getContext(),store=host.chatMetadata?.story_director_liminale,saveHost=host.saveMetadata;
      const body=entry.message.mes,revision=generation(entry.message);entry.body=body;entry.revision=revision;
      if(!store||typeof saveHost!=='function'||!acquireChatSaveLock(store,token))throw Error('save unavailable');
      locked=true;
      const operation=saveStoryboardContinuation(entry.handle,d.resolveNamespace,store,()=>{
        entry.handle.assertCurrent();
        if(!current(entry)||d.getContext().saveMetadata!==saveHost||entry.message.mes!==body||generation(entry.message)!==revision)throw Error('source changed');
        // This is the captured ST API, not a wrapper which silently succeeds
        // when the host is absent. Its return is not a server readback receipt.
        return saveHost.call(host);
      });
      const settled=operation.then(value=>({value}),()=>({error:true})).finally(()=>{
        releaseChatSaveLock(store,token);entry.handle.close();
      });
      locked=false; // The issued operation now owns the lock until it settles.
      const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve({error:true}),Math.max(100,Math.min(30000,d.timeoutMs??10000)));});
      const result=await Promise.race([settled,timeout]);
      if(result.error||!result.value||!current(entry)||entry.message.mes!==body||generation(entry.message)!==revision)throw Error('unconfirmed');
      d.onSaved?.(entry.floor);return true;
    }catch(_){entry.failed=true;entry.handle?.close();notice(entry);return false;}
    finally{clearTimeout(timer);if(locked){releaseChatSaveLock(entry.metadata?.story_director_liminale,token);entry.handle?.close();}}
  }
  function beforeAutomatic(floor,message,type){
    if(closed)return false;
    const entry=active;
    if(entry&&entry.message===message&&entry.floor===floor){
      if(!current(entry))return false;
      if(entry.failed){notice(entry);return false;}
      entry.pending||=persist(entry);return entry.pending.then(ok=>ok&&current(entry)&&entry.message.mes===entry.body&&generation(entry.message)===entry.revision);
    }
    // A terminal continue seen after hot reload has no captured original. It
    // must not fall through to the ordinary path and mint another allowance.
    if(type==='continue'){
      const host=d.getContext();active={epoch:d.epoch(),metadata:host.chatMetadata,chat:host.chat,floor,message,failed:true,notified:false};notice(active);return false;
    }
    return null;
  }
  if(typeof source?.on==='function'&&typeof remove==='function'){
    const event=types.GENERATION_AFTER_COMMANDS||'generation_after_commands';source.on(event,start);bindings.push([event,start]);
    const received=types.MESSAGE_RECEIVED||'message_received',finish=(floor,type)=>{
      const index=typeof floor==='string'&&/^\d+$/.test(floor)?Number(floor):floor;
      if(!Number.isSafeInteger(index)||index<0)return;
      // Source links also preserve old images when automatic extraction is off.
      // Never return this promise to the host's awaited event dispatcher.
      void Promise.resolve(beforeAutomatic(index,d.getContext().chat?.[index],type)).catch(()=>{});
    };
    source.on(received,finish);bindings.push([received,finish]);
  }
  return Object.freeze({beforeAutomatic,reset,close(){closed=true;reset();for(const [event,handler]of bindings.splice(0))remove.call(source,event,handler);}});
}
