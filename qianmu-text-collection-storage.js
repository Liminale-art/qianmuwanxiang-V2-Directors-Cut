import {createTextCollectionSession} from './qianmu-text-collection-session.js';

const stale=()=>Object.assign(new Error('收藏储存账户或页面已变化，请重新盘点'),{code:'text_collection_storage_stale'});
// Server originals, not browser quota, chat state or automatically recoverable cache.
export async function collectTextCollectionStorage({resolveNamespace,isCurrent,headers,fetchImpl,timeoutMs=6000}={}){
  let session,namespace;
  const guard=async()=>{
    if(isCurrent()!==true)throw stale();const current=await resolveNamespace();
    if(isCurrent()!==true||namespace!==undefined&&namespace!==current)throw stale();namespace=current;
  };
  try{
    await guard();session=await createTextCollectionSession({resolveNamespace:async()=>{await guard();return namespace;},isCurrent,headers,fetchImpl,timeoutMs});
    const result=await session.inventory();await guard();
    return {namespace,status:'ready',state:result.state,count:result.count,deletedCount:result.deletedCount,bytes:result.bytes,textBytes:result.textBytes,libraryRevision:result.libraryRevision};
  }catch(cause){
    await guard();if(cause?.code==='text_collection_storage_stale')throw cause;
    return {namespace,status:'unavailable',bytes:null,count:null,error:'服务器正文收藏暂未读取；请确认千幕后端可用后刷新。未读取不代表零占用。'};
  }finally{session?.close();}
}
