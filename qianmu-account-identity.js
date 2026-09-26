// Account identity is shared by ordinary tools as well as image generation.
// Keep this entry independent of admission ledgers, narrative/stream contracts
// and other feature graphs. It never persists a user or grants permission itself.
const error = (code, message) => Object.assign(new Error(message), { code: `image_attempt_${code}` });
const validHandle=handle=>typeof handle==='string'&&Boolean(handle.trim())&&handle.length<=160&&!/[\u0000-\u001f]/.test(handle);

// ST replays APP_READY to late listeners. Do not infer readiness from the
// initial accountsEnabled=false, DOM readiness, a default handle or a timer.
// Only a verified default owner in the explicitly ready single-account mode
// can be reused for this page; ordinary/multi-account fallback is never cached.
export function createImageAccountIdentityResolver({getContext=()=>globalThis.SillyTavern?.getContext?.(),window=globalThis.window}={}){
  let source=null,event=null,listener=null,ready=false,suspended=false,memo=null,pending=null,epoch=0;
  const invalidate=()=>{memo=null;pending=null;epoch++;};
  function detach(){if(source&&listener)(source.removeListener||source.off)?.call(source,event,listener);source=null;event=null;listener=null;ready=false;invalidate();}
  function observe(){
    if(suspended)return false;
    let context;try{context=getContext();}catch{}
    const next=context?.eventSource,type=context?.eventTypes?.APP_READY||context?.event_types?.APP_READY;
    if(!next||typeof next.on!=='function'||typeof type!=='string'||!type){if(source)detach();return false;}
    if(source!==next||event!==type){
      detach();source=next;event=type;listener=()=>{if(source===next){ready=true;invalidate();}};next.on(type,listener);
    }
    return ready;
  }
  const hidden=()=>{suspended=true;detach();},shown=()=>{suspended=false;observe();};
  window?.addEventListener?.('pagehide',hidden);window?.addEventListener?.('pageshow',shown);observe();
  async function resolve({loadUser=()=>import('/scripts/user.js'),fetchImpl=globalThis.fetch,timeoutMs=6000,forceRefresh=false}={}){
    if(forceRefresh)invalidate();
    let handle,expired=false,timer;
    const controller=new AbortController();
    const deadline=new Promise(done=>{timer=setTimeout(()=>{expired=true;controller.abort();done(null);},Math.max(100,Math.min(15000,Number(timeoutMs)||6000)));});
    try{
      observe();if(suspended)throw error('account','ST 页面已离开');
      const user=await Promise.race([Promise.resolve().then(loadUser).catch(()=>null),deadline]);
      handle=user?.currentUser?.handle;
      const single=()=>observe()&&user?.accountsEnabled===false&&!user.currentUser&&typeof user.getCurrentUserHandle==='function'&&user.getCurrentUserHandle()==='default-user';
      const reusable=single();
      if(handle||!reusable||memo&&memo.user!==user||pending&&pending.user!==user){if(memo||pending)invalidate();}
      if(!handle&&!expired){
        if(reusable&&memo?.user===user&&memo.fetchImpl===fetchImpl)handle=memo.handle;
        else{
          const token=epoch;
          const request=async()=>{
            const response=await Promise.race([fetchImpl('/api/users/me',{credentials:'same-origin',cache:'no-store',signal:controller.signal}),deadline]);
            const verified=response?.ok?(await Promise.race([response.json(),deadline]))?.handle:null;
            if(reusable){
              // observe() inside single() can itself invalidate a replaced
              // host/event source; compare the epoch only after that check.
              if(!single()||expired||token!==epoch)throw error('account','ST 账户状态已变化');
              if(verified==='default-user')memo={user,fetchImpl,handle:verified};
            }
            // An initialized live account changed during the fallback request.
            if(user?.currentUser?.handle&&user.currentUser.handle!==verified)throw error('account','ST 账户已变化');
            return verified;
          };
          if(reusable){
            if(!pending||pending.user!==user||pending.fetchImpl!==fetchImpl){
              const flight={user,fetchImpl,promise:null};flight.promise=request().finally(()=>{if(pending===flight)pending=null;});pending=flight;
            }
            handle=await Promise.race([pending.promise,deadline]);
          }else handle=await request();
        }
      }
    }catch(_){invalidate();handle=null;/* Never invent an owner on failure. */}
    finally{clearTimeout(timer);}
    if(!validHandle(handle)||expired||suspended)throw error('account','暂未确认当前 ST 账户，未提交生图，请稍后重试');
    return `st-user:${handle}`;
  }
  return Object.freeze({resolve,invalidate,close(){detach();window?.removeEventListener?.('pagehide',hidden);window?.removeEventListener?.('pageshow',shown);suspended=true;}});
}

const pageIdentity=createImageAccountIdentityResolver();
export const resolveImageAccountNamespace=pageIdentity.resolve;
// Native authorization failures actively revoke this page memo. It is only an
// identity accelerator, never a substitute for authenticated file operations.
export const invalidateImageAccountIdentity=pageIdentity.invalidate;
