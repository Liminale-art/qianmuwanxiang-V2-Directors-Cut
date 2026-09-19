import {createTextCollectionClient} from './qianmu-text-collection-client.js';
import {textCollectionSyncError as error,textCollectionSyncMutation} from './qianmu-text-collection-sync-contract.js';
import {notesSyncOperationId} from './qianmu-notes-sync-contract.js';

// One explicit UI session, not an account-global cache or background write queue.
export async function createTextCollectionSession({resolveNamespace,isCurrent,headers,fetchImpl,timeoutMs,cryptoImpl=globalThis.crypto}={}){
  if(typeof resolveNamespace!=='function'||typeof isCurrent!=='function')throw error('setup','收藏账户环境尚未就绪',503);
  let closed=false;
  const namespace=await resolveNamespace();
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))throw error('account','尚未确认收藏账户',401);
  const guard=async()=>{
    if(closed||isCurrent()!==true||namespace!==await resolveNamespace()||closed||isCurrent()!==true)throw error('account','收藏账户或页面已变化，请重新打开',401);
    return true;
  };
  await guard();
  if(!cryptoImpl?.subtle?.digest)throw error('setup','收藏需要通过 HTTPS 或本机 localhost 打开 ST；当前内容尚未保存',503);
  const digest=await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(namespace.slice(8)));
  const expectedAccount='st-user:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  await guard();
  const client=createTextCollectionClient({expectedAccount,guard,headers,fetchImpl,timeoutMs});
  function prepare(operation,value){
    if(closed||isCurrent()!==true)throw error('cancelled','收藏会话已关闭，未准备新操作');
    const request=textCollectionSyncMutation({version:1,expectedAccount,mutationId:notesSyncOperationId(cryptoImpl),operation,...value});
    // Retrying this handle sends the identical operation. Reopening/editing makes
    // a new handle; neither a lost acknowledgement nor a conflict rebases it.
    return Object.freeze({request,submit:options=>client.write(request,options)});
  }
  return Object.freeze({expectedAccount,namespace,guard,list:(input,options)=>client.list(input,options),get:(id,options)=>client.get(id,options),
    prepareCreate:record=>prepare('create',{id:record.id,baseRevision:0,record}),
    prepareEdit:(id,baseRevision,text)=>prepare('edit',{id,baseRevision,text}),
    prepareDelete:(id,baseRevision)=>prepare('delete',{id,baseRevision}),
    close(){closed=true;client.close();}});
}
