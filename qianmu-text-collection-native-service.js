import {createHash} from 'node:crypto';
import {imageServiceAccount} from './qianmu-image-service-access.js';
import {createTextCollectionNativeFileStore} from './qianmu-text-collection-native-file-store.js';
import {nativeCollectionWriteRequest} from './qianmu-text-collection-native-contract.js';
import {validateNativeCollectionDocument} from './qianmu-text-collection-document.js';
import {writeIndexedCollection} from './qianmu-text-collection-index-write.js';
import {textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';

// Optional, same-origin acceleration of the native-v2 protocol. It cannot
// initialize/migrate a library, select another storage source, or retry through
// another transport. The original mutation IDs and receipts are the journal.
export function createTextCollectionNativeService({dataRoot,io,now=Date.now,timeoutMs=15000,processStatus}={}){
  if(typeof now!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>30000)throw error('native_setup','收藏保存参数无效',503);
  let closed=false;const pending=new Set(),controllers=new Set(),tails=new Map();
  function capabilities(req){
    if(closed)throw error('native_closed','收藏保存服务已停止',503);
    const account=imageServiceAccount(req);
    return {ok:true,version:1,expectedAccount:account.namespace,nativeProtocol:'qianmu.st-account-document.v1',indexVersion:2};
  }
  function write(req,raw,{signal}={}){
    let input,store,controller;
    try{
      if(closed||signal?.aborted)throw error('native_closed','收藏保存已停止');
      if(pending.size>=64)throw error('native_busy','收藏保存正忙，请稍后重试',429);
      input=nativeCollectionWriteRequest(raw);controller=new AbortController();
      store=createTextCollectionNativeFileStore({dataRoot,request:req,expectedAccount:input.expectedAccount,io,signal:controller.signal,
        isCurrent:()=>!closed,deadline:Date.now()+timeoutMs,processStatus});
    }catch(cause){return Promise.reject(cause);}
    let rejectStop;const stopped=new Promise((_,reject)=>{rejectStop=reject;});
    const abort=()=>{controller.abort();rejectStop(Object.assign(error('native_closed','收藏保存未确认，请保留当前内容'),{writeState:store.writeState}));};
    controllers.add(controller);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(abort,timeoutMs),prior=tails.get(input.expectedAccount)||Promise.resolve();
    const check=async()=>store.guard();
    const validate=value=>{
      if(value===null)throw error('native_missing','收藏目录尚未准备好，请刷新后重试',409);
      let state;try{state=validateNativeCollectionDocument(value,{expectedAccount:input.expectedAccount,scope:store.scope});}
      catch(cause){if(/^st_account_storage_/.test(cause?.code||''))throw error('native_content','收藏目录原件引用校验失败，未覆盖',503);throw cause;}
      if(state.version!==2)throw error('native_version','收藏目录版本暂不支持加速保存',409);return state;
    };
    const work=prior.catch(()=>{}).then(()=>store.exclusive(async()=>{
      await check();const hashes=input.mutations.map(item=>createHash('sha256').update(JSON.stringify(item)).digest('hex'));
      const {verified,acknowledgements}=await writeIndexedCollection({store,expectedAccount:input.expectedAccount,inputs:input.mutations,hashes,validate,check,now});
      await check();validate(verified.value);
      return {ok:true,version:1,expectedAccount:input.expectedAccount,scope:store.scope,verified:{value:verified.value,fingerprint:verified.fingerprint},acknowledgements};
    })).then(result=>{store.guard();return result;}).catch(cause=>{
      let known=cause;try{store.guard();}catch(changed){known=changed;}
      if(!/^text_collection_sync_[a-z_]+$/.test(known?.code||''))known=error('native_storage','收藏保存暂不可用，请保留当前内容',503);
      known.writeState=store.writeState;throw known;
    });
    pending.add(work);tails.set(input.expectedAccount,work);
    // Keep the slot until filesystem work really settles, including after a
    // timeout; repeated retries must not multiply hung I/O or bypass its guard.
    void work.finally(()=>{pending.delete(work);controllers.delete(controller);if(tails.get(input.expectedAccount)===work)tails.delete(input.expectedAccount);}).catch(()=>{});
    return Promise.race([work,stopped]).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);});
  }
  return Object.freeze({capabilities,write,async close(){closed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([...pending]);}});
}
