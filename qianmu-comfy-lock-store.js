// Independent lazy metadata store; never opens or upgrades voice, media or previous storyboard stores.
import {comfySceneScope,comfySceneScopeKey,comfySceneLockError,normalizeComfySceneRecord,inspectComfySceneRecord,changeComfySceneRecord,normalizeComfySceneReceipt,captureComfySceneAction,captureComfySceneStyleLink,copyComfySceneStyleRecord} from './qianmu-comfy-scene-lock.js';
import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';
export const COMFY_SCENE_STORE_LIMITS=Object.freeze({scopes:1024,bytes:4*1024*1024,rowBytes:32*1024});
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const copy=value=>JSON.parse(JSON.stringify(value));
const problem=()=>comfySceneLockError('storage','续场记录暂不可用，请核查存储空间及原任务');
export function createComfySceneLockStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-comfy-scene-locks',now=Date.now,timeoutMs=6000,limits=COMFY_SCENE_STORE_LIMITS}={}){
  const quota={};for(const key of Object.keys(COMFY_SCENE_STORE_LIMITS)){const value=limits[key]??COMFY_SCENE_STORE_LIMITS[key];if(!Number.isSafeInteger(value)||value<1||value>COMFY_SCENE_STORE_LIMITS[key])throw problem();quota[key]=value;}
  const timeout=Math.min(15000,Math.max(100,Number(timeoutMs)||6000)),transactions=new Set();let db=null,opening=null,closed=false;
  const closedError=()=>comfySceneLockError('closed','续场记录会话已结束');
  const open=()=>{
    if(closed)return Promise.reject(closedError());if(db)return Promise.resolve(db);if(opening)return opening;
    const promise=new Promise((resolve,reject)=>{
      let request,done=false;
      const finish=(error,value)=>{if(done){value?.close();return;}done=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(comfySceneLockError('timeout','续场记录读取超时，请关闭旧版页面后重试')),timeout);
      try{request=indexedDB.open(dbName,1);}catch(_){finish(problem());return;}
      request.onupgradeneeded=()=>{
        const connection=request.result;
        if(!connection.objectStoreNames.contains('scopes')){const store=connection.createObjectStore('scopes');store.createIndex('chat',['namespace','chatKey']);}
        if(!connection.objectStoreNames.contains('usage'))connection.createObjectStore('usage');
      };
      request.onerror=()=>finish(problem());request.onblocked=()=>finish(comfySceneLockError('blocked','续场记录被旧页面占用，请关闭旧页面重试'));
      request.onsuccess=()=>{
        const connection=request.result;if(done||closed){connection.close();finish(closedError());return;}
        db=connection;const release=()=>{if(db===connection){db=null;opening=null;}};
        connection.onversionchange=()=>{connection.close();release();};connection.onclose=release;finish(null,connection);
      };
    });opening=promise;void promise.catch(()=>{if(opening===promise)opening=null;});return promise;
  };
  const usage=value=>{
    const row=value??{count:0,bytes:0,generation:0};
    if(!Number.isSafeInteger(row.count)||row.count<0||row.count>quota.scopes||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>quota.bytes
      ||!Number.isSafeInteger(row.generation)||row.generation<0)throw problem();
    return {count:row.count,bytes:row.bytes,generation:row.generation};
  };
  async function transaction(mode,work,valid=()=>true){
    const connection=await open();if(closed||!valid())throw closedError();
    return new Promise((resolve,reject)=>{
      let tx,output,error,done=false;
      const finish=cause=>{if(done)return;done=true;clearTimeout(timer);transactions.delete(tx);cause?reject(cause):resolve(output);};
      const abort=cause=>{error=typeof cause?.code==='string'&&cause.code.startsWith('comfy_scene_')?cause:problem();try{tx?.abort();}catch(_){finish(error);}};
      const timer=setTimeout(()=>{abort(comfySceneLockError('timeout','续场写入未确认，请勿重复提交'));finish(error);},timeout);
      try{tx=connection.transaction(['scopes','usage'],mode);transactions.add(tx);}catch(_){finish(problem());return;}
      tx.oncomplete=()=>finish();tx.onabort=()=>finish(error||problem());tx.onerror=()=>{error||=problem();};
      try{work(tx,value=>{output=value;},abort);}catch(cause){abort(cause);}
    });
  }
  async function operate(rawScope,action=null,includeOwners=false){
    const scope=comfySceneScope(rawScope),key=comfySceneScopeKey(scope),captured=action?captureComfySceneAction(action,scope):null;
    const expectedGeneration=action?.expectedGeneration??0;
    if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0)throw problem();
    // Validate all request fields before opening IndexedDB. Conflicts still validate against the actual stored revision.
    if(captured?.receipt)normalizeComfySceneReceipt(captured.receipt);
    return transaction(captured?'readwrite':'readonly',(tx,output,abort)=>{
      const store=tx.objectStore('scopes'),meta=tx.objectStore('usage'),read=store.get(key);
      read.onsuccess=()=>{
        try{
          const value=read.result;
          if(value!==undefined&&(!value||value.namespace!==scope.namespace||value.chatKey!==scope.chatKey||value.bytes!==bytes(value.record)))throw problem();
          const previous=value?.record;normalizeComfySceneRecord(previous,scope);
          const readMeta=meta.get(scope.namespace);
          readMeta.onsuccess=()=>{
            try{
              const before=usage(readMeta.result);
              if(!captured){output({...inspectComfySceneRecord(previous,scope,now()),generation:before.generation,
                ...(includeOwners?{owners:[...new Set(normalizeComfySceneRecord(previous,scope).holders.filter(holder=>holder.status!=='uncertain').map(holder=>holder.ownerId))]}:{})});return;}
              if(['reserve','unlock','orphan'].includes(captured.type)&&expectedGeneration!==before.generation)throw comfySceneLockError('conflict','续场记录已被清理，请重新准备');
              const result=changeComfySceneRecord(previous,scope,captured,now()),size=bytes(result.row);
              if(size>quota.rowBytes)throw comfySceneLockError('capacity','本场景续场记录过大，请整理任务');
              const next={count:before.count+(value?0:1),bytes:before.bytes-(value?.bytes||0)+size,generation:before.generation};
              if(value&&(!before.count||before.bytes<value.bytes))throw problem();
              if(next.count>quota.scopes||next.bytes>quota.bytes)throw comfySceneLockError('capacity','续场存储已满，请先整理已结束场景');
              usage(next);store.put({namespace:scope.namespace,chatKey:scope.chatKey,bytes:size,record:result.row},key);meta.put(next,scope.namespace);
              output({view:{...inspectComfySceneRecord(result.row,scope,now()),generation:before.generation},...(result.receipt?{receipt:result.receipt}:{})});
            }catch(cause){abort(cause);}
          };
        }catch(cause){abort(cause);}
      };
    });
  }
  async function clearScope(namespace,chatKey,{expectedGeneration=0,valid=()=>true}={}){
    namespace=assertComfyRouteNamespace(namespace);
    if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0||typeof valid!=='function')throw problem();
    if(!valid())throw closedError();
    const range=chatKey===null?keyRange.bound([namespace],[namespace,[]]):[namespace,chatKey];
    return transaction('readwrite',(tx,output,abort)=>{
      let removed=0,removedBytes=0;const meta=tx.objectStore('usage'),read=meta.get(namespace);
      read.onsuccess=()=>{try{
        if(!valid())throw closedError();
        const before=usage(read.result);if(expectedGeneration!==before.generation)throw comfySceneLockError('conflict','续场记录已变化，请重新核对');
        const request=tx.objectStore('scopes').index('chat').openCursor(range);
        request.onsuccess=()=>{try{
          if(!valid())throw closedError();
          const cursor=request.result;
          if(!cursor){
            if(!removed){output({removed,bytes:0,generation:before.generation});return;}
            const next={count:before.count-removed,bytes:before.bytes-removedBytes,generation:before.generation+1};usage(next);meta.put(next,namespace);
            output({removed,bytes:removedBytes,generation:next.generation});return;
          }
          const value=cursor.value;
          if(++removed>quota.scopes||value.namespace!==namespace||chatKey!==null&&value.chatKey!==chatKey||value.bytes!==bytes(value.record))throw problem();
          const view=inspectComfySceneRecord(value.record,value.record.scope,now());
          if(view.scope.namespace!==namespace||view.scope.chatKey!==value.chatKey||comfySceneScopeKey(view.scope)!==cursor.primaryKey)throw problem();
          if(view.pending||view.uncertain)throw comfySceneLockError('busy','所选范围仍有在途或结果未明任务，未清理续场记录');
          removedBytes+=value.bytes;cursor.delete();cursor.continue();
        }catch(error){abort(error);}};
      }catch(error){abort(error);}};
    },valid);
  }
  return {
    inspect:scope=>operate(scope),
    pendingOwners:scope=>operate(scope,null,true),
    orphan:(scope,request)=>operate(scope,{...copy(request),type:'orphan'}),
    reserve(scope,request){return operate(scope,{...copy(request),type:'reserve'});},
    begin(receipt){const captured=normalizeComfySceneReceipt(receipt);return operate(captured.scope,{type:'begin',receipt:captured});},
    settle(receipt,outcome){const captured=normalizeComfySceneReceipt(receipt);return operate(captured.scope,{type:'settle',receipt:captured,outcome});},
    unlock(scope,request){return operate(scope,{...copy(request),type:'unlock'});},
    async linkStyle(sourceScope,targetScope,request){
      const captured=captureComfySceneStyleLink(sourceScope,targetScope,request),namespace=captured.targetScope.namespace;
      // Source validation and target write share one transaction: no stale copy after another page unlocks/clears.
      return transaction('readwrite',(tx,output,abort)=>{
        const store=tx.objectStore('scopes'),meta=tx.objectStore('usage');
        const readSource=store.get(comfySceneScopeKey(captured.sourceScope));
        readSource.onsuccess=()=>{
          const readTarget=store.get(comfySceneScopeKey(captured.targetScope));
          readTarget.onsuccess=()=>{
            const readMeta=meta.get(namespace);
            readMeta.onsuccess=()=>{try{
              const before=usage(readMeta.result),source=readSource.result,target=readTarget.result;
              if(before.generation!==captured.expectedGeneration)throw comfySceneLockError('conflict','续场记录已被清理，请重新选择');
              for(const [value,scope] of [[source,captured.sourceScope],[target,captured.targetScope]]){
                if(value!==undefined&&(!value||value.namespace!==scope.namespace||value.chatKey!==scope.chatKey||value.bytes!==bytes(value.record)))throw problem();
              }
              const result=copyComfySceneStyleRecord(source?.record,target?.record,captured,now()),size=bytes(result.row);
              if(size>quota.rowBytes)throw comfySceneLockError('capacity','本场景续场记录过大，请整理任务');
              if(!source||before.count<1+(target?1:0)||before.bytes<source.bytes+(target?.bytes||0))throw problem();
              const next={count:before.count+(target?0:1),bytes:before.bytes-(target?.bytes||0)+size,generation:before.generation};
              if(next.count>quota.scopes||next.bytes>quota.bytes)throw comfySceneLockError('capacity','续场存储已满，请先整理已结束场景');
              usage(next);store.put({namespace,chatKey:captured.targetScope.chatKey,bytes:size,record:result.row},comfySceneScopeKey(captured.targetScope));meta.put(next,namespace);
              output({view:{...inspectComfySceneRecord(result.row,captured.targetScope,now()),generation:before.generation}});
            }catch(error){abort(error);}};
          };
        };
      });
    },
    async list(namespace,chatKey){
      namespace=assertComfyRouteNamespace(namespace);const sample=comfySceneScope({namespace,chatKey,continuityId:'list',narrativeLayer:'present'});
      return transaction('readonly',(tx,output,abort)=>{
        const result=[],request=tx.objectStore('scopes').index('chat').openCursor([namespace,sample.chatKey]);
        request.onsuccess=()=>{try{
          const cursor=request.result;if(!cursor){output(result);return;}const value=cursor.value;
          if(result.length>=quota.scopes||value.namespace!==namespace||value.chatKey!==sample.chatKey||value.bytes!==bytes(value.record))throw problem();
          const record=normalizeComfySceneRecord(value.record,value.record.scope);
          if(comfySceneScopeKey(record.scope)!==cursor.primaryKey)throw problem();
          result.push(inspectComfySceneRecord(record,record.scope,now()));cursor.continue();
        }catch(cause){abort(cause);}};
      });
    },
    async storageSummary(namespace,{isCurrent=()=>true}={}){
      namespace=assertComfyRouteNamespace(namespace);if(!isCurrent())throw closedError();
      return transaction('readonly',(tx,output,abort)=>{
        const request=tx.objectStore('usage').get(namespace);
        request.onsuccess=()=>{try{
          if(!isCurrent())throw closedError();const raw=request.result,meta=usage(raw);let count=0,documentBytes=0,indexBytes=raw?bytes(raw):0;
          const scan=tx.objectStore('scopes').index('chat').openCursor(keyRange.bound([namespace],[namespace,[]]));
          scan.onsuccess=()=>{try{
            if(!isCurrent())throw closedError();const cursor=scan.result;
            if(!cursor){if(count!==meta.count||documentBytes!==meta.bytes)throw problem();output({status:'ready',count,documentBytes,indexBytes,bytes:documentBytes+indexBytes,generation:meta.generation});return;}
            const row=cursor.value;if(++count>quota.scopes||row.namespace!==namespace||row.bytes!==bytes(row.record)||row.bytes>quota.rowBytes)throw problem();
            const record=normalizeComfySceneRecord(row.record,row.record.scope);
            if(record.scope.namespace!==namespace||record.scope.chatKey!==row.chatKey||comfySceneScopeKey(record.scope)!==cursor.primaryKey)throw problem();
            documentBytes+=row.bytes;indexBytes+=bytes(row)-row.bytes;if(documentBytes>quota.bytes)throw problem();cursor.continue();
          }catch(cause){abort(cause);}};
        }catch(cause){abort(cause);}};
      },isCurrent);
    },
    async usage(namespace){namespace=assertComfyRouteNamespace(namespace);return transaction('readonly',(tx,output,abort)=>{const request=tx.objectStore('usage').get(namespace);request.onsuccess=()=>{try{output({...usage(request.result),limit:quota.bytes});}catch(error){abort(error);}};});},
    async clearChat(namespace,chatKey,options={}){
      namespace=assertComfyRouteNamespace(namespace);const sample=comfySceneScope({namespace,chatKey,continuityId:'clear',narrativeLayer:'present'});
      return clearScope(namespace,sample.chatKey,options);
    },
    clearAccount(namespace,options={}){return clearScope(namespace,null,options);},
    close(){closed=true;for(const tx of transactions){try{tx.abort();}catch(_){}}db?.close();db=null;opening=null;},
  };
}
