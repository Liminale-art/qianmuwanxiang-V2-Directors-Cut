import {createTextCollectionOutboxStore,createTextCollectionOutboxEntry,textCollectionOutboxAccount,summarizeTextCollectionOutbox} from './qianmu-text-collection-outbox-store.js';
import {textCollectionSyncError as error,textCollectionSyncResponse} from './qianmu-text-collection-sync-contract.js';

// Explicitly queued saves only. No timers, automatic retry, deferred deletion or
// revision rebasing. The same durable request is safe to resume after a lost ack.
export function createTextCollectionOutboxRuntime({session,store=null,isCurrent=()=>true,now=Date.now}={}){
  const namespace=textCollectionOutboxAccount(session?.expectedAccount),ownsStore=!store;
  if(typeof session.guard!=='function'||typeof session.resumePending!=='function'||typeof isCurrent!=='function')throw error('setup','收藏待存环境未就绪',503);
  store ||= createTextCollectionOutboxStore();let closed=false;const active=new Map(),controllers=new Set();
  const current=()=>!closed&&isCurrent()===true;
  const check=async()=>{if(!current())throw error('account','收藏待存页面或账户已变化',401);await session.guard();if(!current())throw error('account','收藏待存页面或账户已变化',401);};
  const read=async()=>{await check();const value=await store.read(namespace,{guard:current});await check();return value;};
  const update=async mutate=>{await check();const value=await store.update(namespace,mutate,{guard:current});await check();return value;};
  const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
  async function enqueue(input,{base=null}={}){
    const incoming=createTextCollectionOutboxEntry(input,{base,queuedAt:now()});let saved;
    if(incoming.request.expectedAccount!==namespace)throw error('account','不能在当前账户保存其他账户的待存内容',401);
    await update(state=>{
      const prior=state.entries.find(row=>row.request.mutationId===incoming.request.mutationId);
      if(prior){if(!same(prior.request,incoming.request)||!same(prior.base,incoming.base))throw error('local_conflict','待存编号已关联其他内容，原件未覆盖');saved=prior;}
      else{state.entries.push(incoming);saved=incoming;}
    });return structuredClone(saved);
  }
  async function send(mutationId,{signal}={}){
    const controller=new AbortController(),abort=()=>controller.abort();controllers.add(controller);signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();let row,started=false;
    const checkSignal=()=>{if(controller.signal.aborted)throw error('cancelled','收藏待存提交已停止；原请求仍保留');};
    try{
      checkSignal();await update(state=>{
        checkSignal();const target=state.entries.find(entry=>entry.request.mutationId===mutationId);
        if(!target)throw error('missing','此待存操作已不存在，请刷新列表');
        if(target.state==='conflict')throw error('conflict','此收藏存在版本冲突，请先保留副本或核对原件');
        target.started=true;row=structuredClone(target);
      });
      checkSignal();await check();started=true;
      const receipt=textCollectionSyncResponse(await session.resumePending(row.request).submit({signal:controller.signal}),'write',row.request);
      checkSignal();await update(state=>{
        checkSignal();const at=state.entries.findIndex(entry=>entry.request.mutationId===mutationId);
        if(at<0)return; // Another tab already accepted the identical receipt.
        if(!same(state.entries[at].request,row.request)||!same(state.entries[at].base,row.base))throw error('local_conflict','待存记录已变化，未清除原内容');
        state.entries.splice(at,1);
      });
      return Object.freeze({status:'confirmed',receipt});
    }catch(cause){
      if(started&&cause?.code==='text_collection_sync_conflict'){
        // Preserve the original edit and its base. Never issue a replacement write.
        await update(state=>{const target=state.entries.find(entry=>entry.request.mutationId===mutationId);
          if(target&&same(target.request,row.request)&&same(target.base,row.base))target.state='conflict';
        });
      }
      throw cause;
    }finally{signal?.removeEventListener('abort',abort);controllers.delete(controller);}
  }
  function submit(mutationId,options){
    if(active.has(mutationId))return active.get(mutationId);
    const promise=send(mutationId,options).finally(()=>active.delete(mutationId));active.set(mutationId,promise);return promise;
  }
  async function save(request,{base=null,signal}={}){
    await enqueue(request,{base});
    try{return (await submit(request.mutationId,{signal})).receipt;}
    catch(cause){
      const state=await read(),row=state.entries.find(entry=>entry.request.mutationId===request.mutationId);
      if(row&&same(row.request,request)){
        const failure=cause instanceof Error?cause:error('connection','收藏服务器保存未确认',503);
        Object.assign(failure,{localSaved:true,localMutationId:request.mutationId,localState:row.state});throw failure;
      }
      throw cause;
    }
  }
  return Object.freeze({namespace,enqueue,submit,save,list:async()=>structuredClone((await read()).entries),summary:async()=>summarizeTextCollectionOutbox(await read()),
    close(){closed=true;for(const controller of controllers)controller.abort();if(ownsStore)store.close();}});
}
