import {captureTextCollectionSource} from './qianmu-text-collection.js';
import {openTextCollectionCapture} from './qianmu-text-collection-view.js';
import {createTextCollectionSession} from './qianmu-text-collection-session.js';

// Explicit floor actions use this adapter. Importing it installs no page listeners.
export async function openPersistentTextCollectionCapture({parent,source,resolveNamespace,isCurrent,headers}={}){
  if(!parent?.isConnected||typeof isCurrent!=='function')throw new TypeError('收藏页面环境不可用');
  const snapshot={...source};let session,chooser,operation;
  const current=()=>parent.isConnected&&isCurrent()===true;
  try{
    session=await createTextCollectionSession({resolveNamespace,isCurrent:current,headers,cryptoImpl:parent.ownerDocument.defaultView.crypto});
    const captured=captureTextCollectionSource({...snapshot,account:session.expectedAccount});
    await session.guard();
    chooser=openTextCollectionCapture({parent,source:captured,isCurrent:current,onSave:async(record,options)=>{
      try{
        await session.guard();
        if(operation?.request.id!==record.id)operation=session.prepareCreate(record);
        return await operation.submit(options);
      }catch(cause){
        // Account loss closes the old chooser; ordinary connection errors retain
        // the draft so an explicit retry can confirm the same operation.
        try{await session.guard();}catch{chooser?.stop();}
        throw cause;
      }
    }});
    chooser.finished.then(()=>session.close());
    return chooser;
  }catch(cause){session?.close();throw cause;}
}
