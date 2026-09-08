import {validateStoryboardMutation} from './qianmu-storyboard-package-mutation.js';
// Asset checkpoints are identity-only; the separate mutation store holds local before/after configuration.
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_package_journal',submissionState:'not_submitted'});};
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const phases=['prepared','staging','assets_ready'];
const key=row=>JSON.stringify([row.namespace,row.chatHash,row.fileHash]);
const fields=['key','version','namespace','sourceNamespace','chatHash','fileHash','fileBytes','assetIds','phase','revision','createdAt','updatedAt'];
export function validateStoryboardPackageCheckpoint(row){
  if(!row||typeof row!=='object'||Object.keys(row).some(name=>!fields.includes(name))||row.version!==1||!account(row.namespace)||!account(row.sourceNamespace)||!hash(row.chatHash)||!hash(row.fileHash)
    ||row.key!==key(row)||!Number.isSafeInteger(row.fileBytes)||row.fileBytes<1||row.fileBytes>128*1024*1024||!Array.isArray(row.assetIds)||row.assetIds.length>1024||row.assetIds.some(id=>!hash(id))||new Set(row.assetIds).size!==row.assetIds.length
    ||!phases.includes(row.phase)||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.createdAt)||row.createdAt<0||!Number.isSafeInteger(row.updatedAt)||row.updatedAt<row.createdAt)fail('分镜导入恢复记录损坏，请保留原包和本机数据');
  return row;
}

export function createStoryboardPackageJournal({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-storyboard-package-journal',timeoutMs=8000,now=Date.now}={}){
  let database=null,opening=null,closed=false;const pending=new Set(),timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||8000));
  const error=message=>Object.assign(new Error(message),{code:'storyboard_package_journal',submissionState:'not_submitted'});
  const ended=()=>error('分镜导入恢复记录会话已结束');
  function open(){
    if(closed)return Promise.reject(ended());if(database)return Promise.resolve(database);if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      let done=false,request;const finish=(failure,value)=>{if(done){value?.close();return;}done=true;clearTimeout(timer);failure?reject(failure):resolve(value);};
      const timer=setTimeout(()=>finish(error('读取导入恢复记录超时')),timeout);
      try{request=indexedDB.open(dbName,2);}catch(_){finish(error('无法打开导入恢复记录'));return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction?.abort();return;}const db=request.result;
        if(!db.objectStoreNames.contains('checkpoints')){const store=db.createObjectStore('checkpoints',{keyPath:'key'});store.createIndex('namespace','namespace');}
        if(!db.objectStoreNames.contains('mutations'))db.createObjectStore('mutations',{keyPath:'namespace'});
      };
      request.onerror=()=>finish(error('导入恢复记录不可用'));request.onblocked=()=>finish(error('请关闭旧页面后重新核对导入恢复记录'));
      request.onsuccess=()=>{const db=request.result;if(done||closed){db.close();finish(ended());return;}database=db;
        const release=()=>{db.close();if(database===db){database=null;opening=null;}};db.onversionchange=release;db.onclose=()=>{if(database===db){database=null;opening=null;}};finish(null,db);};
    });const attempt=opening;void attempt.catch(()=>{if(opening===attempt)opening=null;});return attempt;
  }
  async function transaction(mode,isCurrent,work,storeName='checkpoints'){
    if(!isCurrent())fail('导入恢复记录的账户或页面已变化');const db=await open();if(closed)throw ended();if(!isCurrent())fail('导入恢复记录的账户或页面已变化');
    return new Promise((resolve,reject)=>{
      let tx,result,failure,done=false;const finish=err=>{if(done)return;done=true;clearTimeout(timer);pending.delete(tx);err?reject(err):resolve(result);};
      const abort=err=>{failure=err;try{tx.abort();}catch(_){finish(err);}};
      const timer=setTimeout(()=>{failure=error('导入恢复记录写入结果未确认，请重新核对');try{tx?.abort();}catch(_){}finish(failure);},timeout);
      try{tx=db.transaction(storeName,mode);pending.add(tx);}catch(_){finish(error('导入恢复记录暂不可用'));return;}
      tx.oncomplete=()=>{try{finish(closed?ended():!isCurrent()?error('恢复记录已写入但页面已变化，请重新核对'):null);}catch(err){finish(err);}};
      tx.onabort=()=>finish(failure||error('导入恢复记录未完成'));tx.onerror=()=>{failure||=error('导入恢复记录空间不足或写入失败');};
      const read=(request,next)=>{request.onsuccess=()=>{if(done)return;try{if(closed)throw ended();if(!isCurrent())fail('导入恢复记录的账户或页面已变化');next(request.result);}catch(err){abort(err);}};};
      try{work(tx.objectStore(storeName),read,value=>{result=value;});}catch(err){abort(err);}
    });
  }
  return Object.freeze({
    async list(namespace){if(!account(namespace))fail('无法确认恢复记录账户');return transaction('readonly',()=>true,(store,read,set)=>read(store.index('namespace').getAll(keyRange.only(namespace),9),rows=>{
      if(rows.length>8)fail('导入恢复记录超限，请先保全核对');for(const row of rows){validateStoryboardPackageCheckpoint(row);if(row.namespace!==namespace)fail('恢复记录账户不符');}set(rows);
    }));},
    async prepare(descriptor,{isCurrent=()=>true}={}){
      const stamp=now(),row=structuredClone(validateStoryboardPackageCheckpoint({...descriptor,key:key(descriptor),version:1,phase:'prepared',revision:1,createdAt:stamp,updatedAt:stamp}));
      return transaction('readwrite',isCurrent,(store,read,set)=>read(store.get(row.key),existing=>{
        if(existing){validateStoryboardPackageCheckpoint(existing);for(const field of ['namespace','sourceNamespace','chatHash','fileHash','fileBytes','assetIds'])if(JSON.stringify(existing[field])!==JSON.stringify(row[field]))fail('分镜包与原恢复记录不符');set(existing);return;}
        read(store.index('namespace').count(keyRange.only(row.namespace)),count=>{if(count>=8)fail('已有 8 份待核对导入记录，请先处理，不会自动清除');store.add(row);set(row);});
      }));
    },
    async checkpoint(previous,phase,{isCurrent=()=>true}={}){
      previous=structuredClone(validateStoryboardPackageCheckpoint(previous));if(!phases.includes(phase)||phase==='prepared')fail('恢复阶段无效');
      // assets_ready means only last verified, not durable settings commit. Retry re-enters staging.
      return transaction('readwrite',isCurrent,(store,read,set)=>read(store.get(previous.key),row=>{
        validateStoryboardPackageCheckpoint(row);if(JSON.stringify(row)!==JSON.stringify(previous))fail('导入恢复记录已被另一页面修改，请重新核对');
        if(row.phase==='prepared'&&phase!=='staging')fail('必须先暂存素材再标记核对完成');
        const next=validateStoryboardPackageCheckpoint({...row,phase,revision:row.revision+1,updatedAt:Math.max(row.updatedAt,now())});store.put(next);set(next);
      }));
    },
    async loadMutation(namespace){
      if(!account(namespace))fail('无法确认元数据恢复账户');return transaction('readonly',()=>true,(store,read,set)=>read(store.get(namespace),row=>set(row?validateStoryboardMutation(row):null)),'mutations');
    },
    async hasMutation(namespace){
      if(!account(namespace))fail('无法确认元数据恢复账户');return transaction('readonly',()=>true,(store,read,set)=>read(store.getKey(namespace),key=>set(key!==undefined)),'mutations');
    },
    async prepareMutation(input,{isCurrent=()=>true}={}){
      const row=structuredClone(validateStoryboardMutation(input));if(row.phase!=='prepared'||row.revision!==1)fail('元数据恢复记录必须从准备阶段开始');
      return transaction('readwrite',isCurrent,(store,read,set)=>read(store.get(row.namespace),existing=>{
        if(existing)fail('本账户已有待核对的分镜导入，请先处理恢复记录');store.add(row);set(row);
      }),'mutations');
    },
    async updateMutation(input,phase,{isCurrent=()=>true}={}){
      const previous=structuredClone(validateStoryboardMutation(input));if(!['applied','uncertain'].includes(phase))fail('元数据保存阶段无效');
      return transaction('readwrite',isCurrent,(store,read,set)=>read(store.get(previous.namespace),row=>{
        validateStoryboardMutation(row);if(JSON.stringify(row)!==JSON.stringify(previous))fail('元数据恢复记录已变化，请重新核对');
        const next=validateStoryboardMutation({...row,phase,revision:row.revision+1});store.put(next);set(next);
      }),'mutations');
    },
    async dismissMutation(input,{confirmed=false,isCurrent=()=>true}={}){
      const previous=structuredClone(validateStoryboardMutation(input));if(confirmed!==true)fail('尚未确认结束本次恢复核对');
      return transaction('readwrite',isCurrent,(store,read,set)=>read(store.get(previous.namespace),row=>{
        validateStoryboardMutation(row);if(JSON.stringify(row)!==JSON.stringify(previous))fail('元数据恢复记录已变化，请重新核对');store.delete(row.namespace);set(true);
      }),'mutations');
    },
    close(){closed=true;for(const tx of pending)try{tx.abort();}catch(_){}database?.close();database=null;opening=null;},
  });
}
