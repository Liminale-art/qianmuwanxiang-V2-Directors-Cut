// A current-chat index only: never retain collected text or one session per floor.
// A star describes the entire source floor, including its other swipe versions.
export function createTextCollectionFloorStatus({getScope,resolveNamespace,isCurrent,headers,onChange=()=>{},now=Date.now,maxAgeMs=30000,sessionFactory=async options=>(await import('./qianmu-text-collection-session.js')).createTextCollectionSession(options)}={}){
  if(typeof getScope!=='function'||typeof resolveNamespace!=='function'||typeof isCurrent!=='function')throw new TypeError('收藏楼层状态需要当前账户与聊天范围');
  const ttl=Number.isFinite(maxAgeMs)?Math.min(60000,Math.max(1000,maxAgeMs)):30000;
  let closed=false,epoch=0,flight=null,flightScope=null,again=false,controller=null,state=null;
  const same=(left,right)=>!!left&&!!right&&left.chatId===right.chatId&&left.chat===right.chat;
  const scopeNow=()=>{const value=getScope();return value&&typeof value.chatId==='string'&&value.chatId&&Array.isArray(value.chat)?value:null;};
  const current=(scope,token)=>!closed&&token===epoch&&isCurrent()===true&&same(scope,scopeNow());
  const announce=()=>{if(!closed)onChange();};
  async function read(){
    const scope=scopeNow(),token=epoch;
    if(!scope||closed||isCurrent()!==true){state=null;announce();return;}
    flightScope=scope;
    // If even identity is unavailable, render storms must not keep retrying
    // /api/users/me. This branch only reuses unknown, never another account's stars.
    if(state?.known===false&&state.namespace===undefined&&same(state.scope,scope)&&now()<state.expires){announce();return;}
    let namespace,session;
    const valid=()=>current(scope,token);
    const check=async()=>{if(!valid()||namespace!==await resolveNamespace()||!valid())throw new Error('收藏账户或聊天已变化');};
    try{
      namespace=await resolveNamespace();
      if(!valid()){again=!closed;return;}
      if(typeof namespace!=='string'||!namespace.startsWith('st-user:'))throw new Error('收藏账户尚未确认');
      if(state&&same(state.scope,scope)&&state.namespace===namespace&&now()<state.expires){announce();return;}
      state=null;announce();controller=new AbortController();
      session=await sessionFactory({resolveNamespace,isCurrent:valid,headers});await check();
      const result=await session.snapshot({signal:controller.signal});await session.guard?.();await check();
      if(result?.backup?.sourceAccount!==session.expectedAccount||!Array.isArray(result.backup.records)||result.backup.records.length>10000)throw new Error('收藏目录返回无效');
      const floors=new Set();
      for(const record of result.backup.records){
        const source=record?.source;
        // Cross-account restores preserve their original provenance. They must
        // not light an unrelated floor whose chat name happens to be identical.
        if(source?.account===session.expectedAccount&&source.chatId===scope.chatId&&Number.isSafeInteger(source.messageId)&&source.messageId>=0)floors.add(source.messageId);
      }
      state={scope,namespace,floors,known:true,expires:now()+ttl};announce();
    }catch{
      if(valid()){
        // Unknown is not an empty library. Back off repeat render attempts while
        // allowing an explicit change/focus refresh to retry immediately.
        state={scope,namespace,floors:new Set(),known:false,expires:now()+ttl};announce();
      }else again=!closed;
    }finally{session?.close();controller=null;}
  }
  function refresh({force=false}={}){
    if(closed)return Promise.resolve();
    if(force){epoch++;state=null;controller?.abort();announce();}
    if(flight){if(force||!same(flightScope,scopeNow()))again=true;return flight;}
    flight=(async()=>{do{again=false;await read();}while(again&&!closed);})();
    const pending=flight;
    return pending.finally(()=>{if(flight===pending)flight=null;});
  }
  return Object.freeze({refresh,status(floor){return !closed&&isCurrent()===true&&state?.known&&same(state.scope,scopeNow())?state.floors.has(floor):null;},dispose(){closed=true;epoch++;state=null;controller?.abort();}});
}
