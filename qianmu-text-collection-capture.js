import {captureTextCollectionSource} from './qianmu-text-collection.js';
import {openTextCollectionCapture} from './qianmu-text-collection-view.js';

// Explicit floor actions use this adapter. Importing it installs no page listeners.
export async function openPersistentTextCollectionCapture({parent,source,sourceElement,resolveNamespace,isCurrent,headers}={}){
  if(!parent?.isConnected||typeof isCurrent!=='function')throw new TypeError('收藏页面环境不可用');
  const snapshot={...source};let session,outbox,chooser,operation,closed=false,initializing;
  const current=()=>!closed&&parent.isConnected&&isCurrent()===true;
  const setup=()=>initializing??=(async()=>{
    try{
      const [{createTextCollectionSession},{createTextCollectionOutboxRuntime}]=await Promise.all([import('./qianmu-text-collection-session.js'),import('./qianmu-text-collection-outbox-runtime.js')]);
      if(!current())throw Error('收藏页面已关闭');
      session=await createTextCollectionSession({resolveNamespace,isCurrent:current,headers,cryptoImpl:parent.ownerDocument.defaultView.crypto});
      if(!current()){session.close();throw Error('收藏页面已关闭');}
      outbox=createTextCollectionOutboxRuntime({session,isCurrent:current});return session;
    }catch(cause){session?.close();session=null;outbox?.close();outbox=null;initializing=null;return {failure:cause};}
  })();
  try{
    chooser=openTextCollectionCapture({parent,source:snapshot,sourceElement,isCurrent:current,resolveSource:async()=>{
      const ready=await setup();if(ready.failure)throw ready.failure;
      try{await ready.guard();}catch(cause){chooser?.stop();throw cause;}
      return captureTextCollectionSource({...snapshot,account:ready.expectedAccount});
    },onSave:async(record,options)=>{
      try{
        await session.guard();
        if(operation?.request.id!==record.id)operation=session.prepareCreate(record);
        return await outbox.save(operation.request,options);
      }catch(cause){
        // Account loss closes the old chooser; ordinary connection errors retain
        // the draft so an explicit retry can confirm the same operation.
        try{await session.guard();}catch{chooser?.stop();}
        if(record.schemaVersion===3&&cause?.code==='text_collection_sync_contract')cause.message='收藏服务需要更新，当前内容已保留。';
        throw cause;
      }
    }});
    chooser.finished.then(()=>{closed=true;outbox?.close();session?.close();});
    void setup();
    return chooser;
  }catch(cause){closed=true;outbox?.close();session?.close();throw cause;}
}
