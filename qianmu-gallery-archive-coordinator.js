// One idle, add-only preservation pass per settled source. No startup scan,
// generation, pruning, retry storm or background queue of complete chat copies.
export function createGalleryArchiveCoordinator({getContext,epoch,account,headers,isCurrent,canRun=()=>true,admit=async()=>true,
  connect=async options=>(await import('./qianmu-gallery-archive-source.js?v=1.59.356')).createCurrentGalleryArchiveSession(options),
  window=globalThis.window,document=globalThis.document,now=Date.now,quietMs=5000,onError=()=>{}}={}){
  if(typeof getContext!=='function'||typeof isCurrent!=='function'||typeof epoch!=='function'||!window?.setTimeout)throw Error('图库保全缺少宿主保护');
  let closed=false,pending=false,running=false,timer=null,revision=0,session=null,controller=null,lastActivity=now(),lastSuccess=null;
  let hostSource=null,hostSignature='';const hostBindings=[];
  let state='idle';
  const cancelled=()=>Object.assign(Error('图库保全已取消'),{name:'AbortError'});
  const valid=turn=>{try{return !closed&&turn===revision&&isCurrent()===true;}catch{return false;}};
  const busy=()=>{try{return document?.hidden||document?.readyState==='loading'||window.navigator?.onLine===false||window.navigator?.connection?.saveData
    ||/^(slow-)?2g$/.test(window.navigator?.connection?.effectiveType||'')||window.navigator?.scheduling?.isInputPending?.()
    ||now()-lastActivity<quietMs||canRun()!==true;}catch{return true;}};
  function clearTimer(){if(timer!==null)window.clearTimeout(timer);timer=null;}
  function arm(delay=quietMs){clearTimer();if(!closed&&pending&&!running)timer=window.setTimeout(()=>{timer=null;void run();},delay);}
  function stopPass(){controller?.abort();session?.close();session=null;}
  function reset(){revision++;pending=false;lastSuccess=null;state='idle';clearTimer();stopPass();}
  function schedule(){if(closed)return;try{bindHost();}catch{reset();state='error';try{onError({code:'gallery_preservation_failed',writeState:'not_started'});}catch{}return;}revision++;pending=true;lastActivity=now();stopPass();arm();}
  function unbindHost(){for(const [source,remove,type,handler] of hostBindings.splice(0))try{remove.call(source,type,handler);}catch{}hostSource=null;hostSignature='';}
  function bindHost(){
    const context=getContext(),source=context?.eventSource,types=context?.event_types||context?.eventTypes||{},remove=source?.off||source?.removeListener;
    const names=[['APP_READY','app_ready'],['CHAT_CHANGED','chat_id_changed'],['CHAT_LOADED','chatLoaded'],['CHAT_RENAMED','chat_renamed'],
      ['CHAT_DELETED','chat_deleted'],['GROUP_CHAT_DELETED','group_chat_deleted'],['MESSAGE_SENT','message_sent'],['MESSAGE_RECEIVED','message_received'],
      ['MESSAGE_EDITED','message_edited'],['MESSAGE_UPDATED','message_updated'],['MESSAGE_DELETED','message_deleted'],['MESSAGE_SWIPED','message_swiped'],
      ['MESSAGE_SWIPE_DELETED','message_swipe_deleted'],['GENERATION_ENDED','generation_ended']];
    const events=[...new Set(names.map(([key,fallback])=>types[key]||fallback))],signature=JSON.stringify(events);
    if(source===hostSource&&signature===hostSignature)return;unbindHost();
    if(typeof source?.on!=='function'||typeof remove!=='function')return;hostSource=source;hostSignature=signature;
    try{for(const type of events){const handler=()=>{if(!closed&&hostSource===source)schedule();};hostBindings.push([source,remove,type,handler]);source.on(type,handler);}}
    catch(error){unbindHost();throw error;}
  }
  const activity=()=>{lastActivity=now();};
  const events=['pointerdown','keydown','input','wheel'];
  for(const type of events)document?.addEventListener?.(type,activity,{capture:true,passive:true});
  function delay(signal){return new Promise((resolve,reject)=>{
    let handle;const abort=()=>{window.clearTimeout(handle);signal.removeEventListener('abort',abort);reject(cancelled());};
    handle=window.setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},quietMs);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });}
  async function run(){
    if(closed||running||!pending)return;
    const turn=revision;if(!valid(turn)){pending=false;return;}
    if(busy()){arm();return;}
    let rows,sourceEpoch,store;try{store=getContext()?.chatMetadata?.story_director_liminale;rows=store?.storyboardImages;sourceEpoch=epoch();}catch{pending=false;return;}
    if(!Array.isArray(rows)){pending=false;return;}
    if(!rows.length){
      if(!store||!['storyboardCollections','characterDrafts'].some(key=>Object.hasOwn(store,key))){pending=false;return;}}
    running=true;pending=false;controller=new AbortController();const signal=controller.signal;
    const check=()=>{if(!valid(turn)||signal.aborted||sourceEpoch!==epoch())throw cancelled();return true;};
    const yieldWork=async()=>{check();while(busy()){state='waiting';await delay(signal);check();}state='saving';};
    let opened;
    try{
      await yieldWork();if(!await admit()){check();pending=true;state='waiting';return;}check();await yieldWork();
      opened=await connect({getContext,epoch,account,headers,guard:check,yieldWork});
      check();session=opened;
      // Only an exact account/owner/chat/content identity, after successful
      // readback in this lifecycle, can avoid another unchanged pass.
      if(typeof opened.identity!=='string'||!opened.identity)throw Error('图库保全缺少来源版本');
      if(opened.identity!==lastSuccess){
        await yieldWork();const result=await opened.preserveAll();check();
        if(result?.originals?.state==='partial'||result?.supplements?.state==='partial'||result?.evidences?.state==='partial'||result?.localRecipes?.state==='partial'){
          state='partial';try{onError({code:result?.localRecipes?.state==='partial'?'gallery_local_recipes_incomplete':result?.evidences?.state==='partial'?'gallery_evidence_incomplete':result?.supplements?.state==='partial'?'gallery_supplements_incomplete':'gallery_originals_incomplete',writeState:'records_saved'});}catch{}return;
        }
        lastSuccess=opened.identity;
      }
      state='saved';
    }catch(error){
      if(valid(turn)&&!signal.aborted){if(error?.name==='AbortError')state='idle';else{state='error';try{onError({code:'gallery_preservation_failed',writeState:error?.writeState==='unconfirmed'?'unconfirmed':'not_started'});}catch{}}}
    }finally{opened?.close();if(session===opened)session=null;controller=null;running=false;arm();}
  }
  function close(){if(closed)return;reset();closed=true;unbindHost();for(const type of events)document?.removeEventListener?.(type,activity,true);window.removeEventListener?.('pagehide',close);}
  try{bindHost();}catch(error){close();throw error;}
  window.addEventListener?.('pagehide',close,{once:true});
  return Object.freeze({schedule,reset,close,status:()=>({state,pending,running,closed})});
}
