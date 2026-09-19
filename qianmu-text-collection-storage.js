import {createTextCollectionSession} from './qianmu-text-collection-session.js';
import {createTextCollectionOutboxStore,summarizeTextCollectionOutbox} from './qianmu-text-collection-outbox-store.js';
import {createTextCollectionOutboxRuntime} from './qianmu-text-collection-outbox-runtime.js';

const stale=()=>Object.assign(new Error('收藏储存账户或页面已变化，请重新盘点'),{code:'text_collection_storage_stale'});
// Server originals, not browser quota, chat state or automatically recoverable cache.
export async function collectTextCollectionStorage({resolveNamespace,isCurrent,headers,fetchImpl,timeoutMs=6000,outboxStore=null}={}){
  let session,namespace,store=outboxStore,pending={status:'unavailable',bytes:null,count:null,error:'本机收藏待存暂未读取，未按零占用处理。'};const ownsStore=!store;
  const guard=async()=>{
    if(isCurrent()!==true)throw stale();const current=await resolveNamespace();
    if(isCurrent()!==true||namespace!==undefined&&namespace!==current)throw stale();namespace=current;
  };
  try{
    await guard();session=await createTextCollectionSession({resolveNamespace:async()=>{await guard();return namespace;},isCurrent,headers,fetchImpl,timeoutMs});
    try{store ||= createTextCollectionOutboxStore();pending=summarizeTextCollectionOutbox(await store.read(session.expectedAccount,{guard:isCurrent}));}
    catch{await guard();}await guard();
    const result=await session.inventory();await guard();
    return {namespace,status:'ready',state:result.state,count:result.count,deletedCount:result.deletedCount,bytes:result.bytes,textBytes:result.textBytes,libraryRevision:result.libraryRevision,pending};
  }catch(cause){
    await guard();if(cause?.code==='text_collection_storage_stale')throw cause;
    return {namespace,status:'unavailable',bytes:null,count:null,error:'服务器正文收藏暂未读取；请确认千幕后端可用后刷新。未读取不代表零占用。',pending};
  }finally{session?.close();if(ownsStore)store?.close();}
}

// Confirmation authorizes exactly the observed local requests, never server deletion.
export async function cleanupTextCollectionPending({resolveNamespace,isCurrent,headers,check,confirm,otherModules=0,outboxStore=null}={}){
  if(typeof check!=='function'||typeof confirm!=='function')throw TypeError('待存清理需要确认及页面校验');let session,outbox;
  const current=()=>{try{check();return isCurrent()===true;}catch{return false;}};
  try{
    check();session=await createTextCollectionSession({resolveNamespace,isCurrent:current,headers});check();
    outbox=createTextCollectionOutboxRuntime({session,store:outboxStore,isCurrent:current});const rows=await outbox.list();check();
    if(!rows.length)return {status:'empty',removed:0};
    const uncertain=rows.filter(row=>row.started&&row.state!=='conflict').length;
    const accepted=await confirm('清理本机收藏待存',`将不可恢复地移除此浏览器当前账户的 ${rows.length} 条待存文字、修改前原件及请求编号。请先在正文收藏→本机待存导出备份；不删除服务器收藏或聊天。${uncertain?`其中 ${uncertain} 条提交结果未知，服务器仍可能已保存；清理本机不等于取消请求。`:''}${otherModules>0?`同时勾选的其他 ${otherModules} 个模块本次不执行，需重新选择。`:''}确认期间条目变化将停止，之后新增不移除。确定清理吗？`);
    check();await session.guard();check();if(accepted!==true)return {status:'cancelled',removed:0};
    const result=await outbox.removeMany(rows,{confirmed:true,acceptUnconfirmed:true});return {status:'complete',...result};
  }finally{outbox?.close();session?.close();}
}
