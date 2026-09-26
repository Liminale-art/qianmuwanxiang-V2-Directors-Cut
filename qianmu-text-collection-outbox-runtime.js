import {createTextCollectionOutboxStore,createTextCollectionOutboxEntry,textCollectionOutboxEntry,textCollectionOutboxAccount,summarizeTextCollectionOutbox,validateTextCollectionOutbox} from './qianmu-text-collection-outbox-store.js';
import {textCollectionSyncError as error,textCollectionSyncResponse,textCollectionSyncMutation} from './qianmu-text-collection-sync-contract.js';
import {prepareTextCollectionOutboxBackup,mergeTextCollectionOutboxBackup} from './qianmu-text-collection-outbox-backup.js';

// UI and recovery own separate runtimes over the same default durable outbox.
// Merge only their in-flight exact operations, not histories or retry outcomes.
// Injected stores share only when they are the same object/truth source.
const defaultFlights=new Map(),injectedFlights=new WeakMap();
function outboxFlights(store,ownsStore){
  if(ownsStore)return defaultFlights;
  let flights=injectedFlights.get(store);if(!flights){flights=new Map();injectedFlights.set(store,flights);}return flights;
}

// Stable identity belongs to this exact conflicted save, not to an editor session.
// Keep the domain and canonical payload stable across refreshes and future versions.
export async function textCollectionConflictCopy(input,cryptoImpl=globalThis.crypto){
  const row=textCollectionOutboxEntry(input,input?.request?.expectedAccount);
  if(row.state!=='conflict')throw error('conflict','仅对已确认的版本冲突创建独立副本');
  if(!cryptoImpl?.subtle?.digest)throw error('setup','无法安全识别副本操作；请使用 HTTPS 或本机地址',503);
  const data='qianmu-text-collection-conflict-copy-v1\n'+JSON.stringify({request:row.request,base:row.base});
  const hash=Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(data))),byte=>byte.toString(16).padStart(2,'0')).join('');
  return textCollectionSyncMutation({version:1,expectedAccount:row.request.expectedAccount,mutationId:'copy-save-'+hash,operation:'restore',id:'copy-'+hash,baseRevision:0,
    record:row.base||row.request.record,text:Object.hasOwn(row.request,'text')?row.request.text:row.request.record.text});
}

// Explicitly queued saves only. No timers, automatic retry, deferred deletion or
// revision rebasing. The same durable request is safe to resume after a lost ack.
export function createTextCollectionOutboxRuntime({session,store=null,isCurrent=()=>true,now=Date.now,cryptoImpl=globalThis.crypto}={}){
  const namespace=textCollectionOutboxAccount(session?.expectedAccount),ownsStore=!store;
  if(typeof session.guard!=='function'||typeof session.resumePending!=='function'||typeof isCurrent!=='function')throw error('setup','收藏待存环境未就绪',503);
  store ||= createTextCollectionOutboxStore();let closed=false;const active=new Map(),controllers=new Set();
  const flights=outboxFlights(store,ownsStore),flightKey=mutationId=>JSON.stringify([namespace,mutationId]),signature=row=>JSON.stringify({request:row.request,base:row.base});
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
    });
    // Payload-free wakeup: UI saves are still immediate; recovery waits briefly
    // and becomes dormant as soon as the durable queue is empty.
    if(typeof globalThis.dispatchEvent==='function'&&typeof globalThis.Event==='function')globalThis.dispatchEvent(new Event('qianmu-collection-save-queued'));
    return structuredClone(saved);
  }
  async function send(mutationId,{signal}={},prepared=()=>{}){
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
      prepared(signature(row));
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
  async function joinFlight(flight,mutationId,{signal}={}){
    const controller=new AbortController(),abort=()=>controller.abort();controllers.add(controller);signal?.addEventListener('abort',abort,{once:true});
    const cancelled=()=>error('cancelled','收藏待存提交已停止；原请求仍保留');
    let rejectStop;const stopped=new Promise((_,reject)=>{rejectStop=reject;});
    controller.signal.addEventListener('abort',()=>rejectStop(cancelled()),{once:true});if(signal?.aborted)abort();
    const checkSignal=()=>{if(controller.signal.aborted)throw cancelled();};
    try{
      return await Promise.race([(async()=>{
        checkSignal();const expected=await flight.prepared;checkSignal();const state=await read();checkSignal();
        const row=state.entries.find(entry=>entry.request.mutationId===mutationId);
        // Absence is allowed only for this exact shared in-flight operation: its
        // owner may already have retired the durable row after a valid receipt.
        if(row&&signature(row)!==expected)throw error('local_conflict','待存编号已关联其他内容，未采用其他提交的结果');
        const result=await flight.promise;checkSignal();await check();checkSignal();return result;
      })(),stopped]);
    }finally{signal?.removeEventListener('abort',abort);controllers.delete(controller);}
  }
  function submit(mutationId,options){
    if(active.has(mutationId))return active.get(mutationId);
    const key=flightKey(mutationId);let flight=flights.get(key),task;
    if(flight)task=joinFlight(flight,mutationId,options);
    else{
      let resolvePrepared,rejectPrepared;flight={prepared:new Promise((resolve,reject)=>{resolvePrepared=resolve;rejectPrepared=reject;}),promise:null};
      void flight.prepared.catch(()=>{});flights.set(key,flight);
      flight.promise=send(mutationId,options,resolvePrepared).catch(cause=>{rejectPrepared(cause);throw cause;}).finally(()=>{if(flights.get(key)===flight)flights.delete(key);});task=flight.promise;
    }
    const promise=task.finally(()=>active.delete(mutationId));active.set(mutationId,promise);return promise;
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
  async function removeMany(inputs,{confirmed=false,acceptUnconfirmed=false}={}){
    validateTextCollectionOutbox({version:1,namespace,entries:inputs},namespace);
    const snapshots=new Map(inputs.map(row=>{const value=textCollectionOutboxEntry(row,namespace);return [value.request.mutationId,value];}));let removed=0;
    if(confirmed!==true)throw error('consent','请确认只移除此机待存原件');
    if(inputs.some(row=>row.started&&row.state!=='conflict')&&acceptUnconfirmed!==true)throw error('consent','原提交结果未知；移除本机待存不会取消或删除服务器保存');
    await update(state=>{
      for(const id of snapshots.keys())if(active.has(id)||flights.has(flightKey(id)))throw error('busy','此待存仍在提交中，请等待后重新查看');
      for(const row of state.entries){const snapshot=snapshots.get(row.request.mutationId);if(!snapshot)continue;
        if(!same(row,snapshot))throw error('local_conflict','待存状态已在另一页面变化，未移除；请刷新核对');removed++;
      }
      state.entries=state.entries.filter(row=>!snapshots.has(row.request.mutationId));
    });return Object.freeze({removed,missing:snapshots.size-removed});
  }
  async function remove(input,options){const result=await removeMany([input],options);return Object.freeze({removed:result.removed===1});}
  async function keepCopy(input,{confirmed=false,signal}={}){
    if(confirmed!==true)throw error('consent','请确认将冲突内容保留为独立新副本');
    const source=textCollectionOutboxEntry(input,namespace);await check();const request=await textCollectionConflictCopy(source,cryptoImpl);
    await update(state=>{
      const row=state.entries.find(entry=>entry.request.mutationId===source.request.mutationId);
      if(!row||!same(row,source))throw error('local_conflict','原冲突记录已变化，未创建副本，请刷新核对');
      const prior=state.entries.find(entry=>entry.request.mutationId===request.mutationId);
      if(prior){if(!same(prior.request,request))throw error('local_conflict','副本编号关联了其他内容，未覆盖');}
      else state.entries.push(createTextCollectionOutboxEntry(request,{queuedAt:now()}));
    });
    const result=await submit(request.mutationId,{signal});
    await update(state=>{const at=state.entries.findIndex(entry=>entry.request.mutationId===source.request.mutationId);
      if(at>=0&&same(state.entries[at],source))state.entries.splice(at,1);
    });return result;
  }
  async function importBackup(payload,{confirmed=false}={}){
    if(confirmed!==true)throw error('consent','请确认仅将备份合并至当前账户的本机待存');let result;
    await update(state=>{result=mergeTextCollectionOutboxBackup(state,payload);state.entries=result.state.entries;});
    return Object.freeze({added:result.added,duplicates:result.duplicates});
  }
  return Object.freeze({namespace,enqueue,submit,save,remove,removeMany,keepCopy,importBackup,backup:async()=>prepareTextCollectionOutboxBackup(await read(),{exportedAt:now()}),list:async()=>structuredClone((await read()).entries),summary:async()=>summarizeTextCollectionOutbox(await read()),
    close(){closed=true;for(const controller of controllers)controller.abort();if(ownsStore)store.close();}});
}
