import {captureTextCollectionSource} from './qianmu-text-collection.js';
import {openTextCollectionCapture} from './qianmu-text-collection-view.js';
import {createTextCollectionSession} from './qianmu-text-collection-session.js';
import {createTextCollectionOutboxRuntime} from './qianmu-text-collection-outbox-runtime.js';

// Explicit floor actions use this adapter. Importing it installs no page listeners.
export async function openPersistentTextCollectionCapture({parent,source,resolveNamespace,isCurrent,headers}={}){
  if(!parent?.isConnected||typeof isCurrent!=='function')throw new TypeError('收藏页面环境不可用');
  const snapshot={...source};let session,outbox,chooser,operation;
  const current=()=>parent.isConnected&&isCurrent()===true;
  try{
    session=await createTextCollectionSession({resolveNamespace,isCurrent:current,headers,cryptoImpl:parent.ownerDocument.defaultView.crypto});
    outbox=createTextCollectionOutboxRuntime({session,isCurrent:current});
    const captured=captureTextCollectionSource({...snapshot,account:session.expectedAccount});
    await session.guard();
    chooser=openTextCollectionCapture({parent,source:captured,isCurrent:current,onSave:async(record,options)=>{
      try{
        await session.guard();
        if(operation?.request.id!==record.id)operation=session.prepareCreate(record);
        return await outbox.save(operation.request,options);
      }catch(cause){
        // Account loss closes the old chooser; ordinary connection errors retain
        // the draft so an explicit retry can confirm the same operation.
        try{await session.guard();}catch{chooser?.stop();}
        throw cause;
      }
    }});
    chooser.finished.then(()=>{outbox.close();session.close();});
    return chooser;
  }catch(cause){outbox?.close();session?.close();throw cause;}
}
