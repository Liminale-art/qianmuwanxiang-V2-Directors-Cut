import {validateStoryboardMutation} from './qianmu-storyboard-package-mutation.js';
import {inspectStoryboardEnvironmentReview,validateStoryboardEnvironmentReceipt,storyboardEnvironmentReviewsEqual,STORYBOARD_ENVIRONMENT_MAP_LIMIT} from './qianmu-storyboard-environment-map.js';
import {inspectStoryboardSubjectMapReview} from './qianmu-storyboard-subject-map.js';
import {mappingHead,validateMappingHead,mappingHeadKey} from './qianmu-storyboard-mapping-contract.js';
import {inspectBundleMappingReceipt} from './qianmu-bundle-mappings.js';
import {sameBundleMappingHead} from './qianmu-bundle-mapping-contract.js';
import {comfyLibraryBackupDigest as mappingDigest} from './qianmu-comfy-library-backup.js';
// Asset checkpoints are identity-only; the separate mutation store holds local before/after configuration.
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_package_journal',submissionState:'not_submitted'});};
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const phases=['prepared','staging','assets_ready'];
const key=row=>JSON.stringify([row.namespace,row.chatHash,row.fileHash]);
const fields=['key','version','namespace','sourceNamespace','chatHash','fileHash','fileBytes','assetIds','phase','revision','createdAt','updatedAt'];
const resourcePhases=['prepared','originals','workflows','metadata','verified'];
const bundlePhases=['prepared','originals','workflows','pools','metadata','vibes','verified'];
const resourceOrder=kind=>kind==='bundle'?bundlePhases:resourcePhases;
export function validateResourceRestoreCheckpoint(row){
  const keys=['key','version','namespace','kind','sourceDigest','planDigest','phase','revision','createdAt','updatedAt',...(row?.kind==='bundle'?['chatHash','environmentDigest','subjectMappingDigest']:[])];
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(name=>!keys.includes(name))||row.version!==1||!account(row.namespace)||!['characters','bundle'].includes(row.kind)
    ||(row.kind==='bundle'&&(!hash(row.chatHash)||['environmentDigest','subjectMappingDigest'].some(field=>Object.hasOwn(row,field)&&!hash(row[field]))))||row.key!==JSON.stringify([row.namespace,row.kind])||!hash(row.sourceDigest)||!hash(row.planDigest)||!resourceOrder(row.kind).includes(row.phase)
    ||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.createdAt)||row.createdAt<0||!Number.isSafeInteger(row.updatedAt)||row.updatedAt<row.createdAt)fail('资源恢复记录损坏，请保留原备份核对');
  return row;
}
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
      try{request=indexedDB.open(dbName,6);}catch(_){finish(error('无法打开导入恢复记录'));return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction?.abort();return;}const db=request.result;
        if(!db.objectStoreNames.contains('checkpoints')){const store=db.createObjectStore('checkpoints',{keyPath:'key'});store.createIndex('namespace','namespace');}
        if(!db.objectStoreNames.contains('mutations'))db.createObjectStore('mutations',{keyPath:'namespace'});
        if(!db.objectStoreNames.contains('resources'))db.createObjectStore('resources',{keyPath:'key'});
        if(!db.objectStoreNames.contains('environmentMaps')){const store=db.createObjectStore('environmentMaps',{keyPath:'key'});store.createIndex('namespace','namespace');}
        if(!db.objectStoreNames.contains('subjectMaps')){const store=db.createObjectStore('subjectMaps',{keyPath:'key'});store.createIndex('namespace','namespace');}
        // Old receipts stay untouched. Their small index is derived lazily outside the upgrade transaction.
        if(!db.objectStoreNames.contains('mappingHeads')){const store=db.createObjectStore('mappingHeads',{keyPath:'key'});store.createIndex('namespace','namespace');}
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
      try{work(tx.objectStore(Array.isArray(storeName)?storeName[0]:storeName),read,value=>{result=value;},tx);}catch(err){abort(err);}
    });
  }
  const mapBytes=review=>new TextEncoder().encode(JSON.stringify(review)).length;
  function subjectMapKeys(keys,namespace){
    if(keys.length>256)fail('角色映射记录数量超限，请先保全核对');
    return keys.map(key=>{let row;try{row=JSON.parse(key);}catch(_){fail('角色映射记录索引损坏');}
      if(!Array.isArray(row)||row.length!==3||row[0]!==namespace||!hash(row[1])||!Number.isSafeInteger(row[2])||row[2]<1||row[2]>8*1048576||JSON.stringify(row)!==key)fail('角色映射记录索引不符');return {key,digest:row[1],bytes:row[2]};});
  }
  async function checkedSubjectReceipt(row,namespace,expectedDigest){
    if(!row)return null;
    if(Object.keys(row).length!==5||!['key','namespace','review','bytes','createdAt'].every(key=>Object.hasOwn(row,key))||row.namespace!==namespace||!Number.isSafeInteger(row.createdAt)||row.createdAt<0)fail('角色映射凭据不完整');
    const review=await inspectStoryboardSubjectMapReview(row.review);
    if(review.namespace!==namespace||review.digest!==expectedDigest||row.bytes!==mapBytes(review)||row.key!==JSON.stringify([namespace,expectedDigest,row.bytes]))fail('角色映射凭据与索引不符');return row;
  }
  const mappingStore=kind=>kind==='environment'?'environmentMaps':'subjectMaps';
  async function mappingReferences(namespace,isCurrent){
    return transaction('readonly',isCurrent,(_store,read,set,tx)=>{
      read(tx.objectStore('environmentMaps').index('namespace').getAllKeys(keyRange.only(namespace),257),environment=>{
        if(environment.length>256||environment.some(key=>!hash(key)))fail('环境映射凭据索引损坏或超限');
        read(tx.objectStore('subjectMaps').index('namespace').getAllKeys(keyRange.only(namespace),257),subjects=>{
          const rows=subjectMapKeys(subjects,namespace);if(new Set(rows.map(row=>row.digest)).size!==rows.length)fail('角色映射凭据索引重复');
          read(tx.objectStore('mappingHeads').index('namespace').getAll(keyRange.only(namespace),513),heads=>{
            if(heads.length>512)fail('迁移凭据索引超限');
            const refs=[...environment.map(key=>({kind:'environment',digest:key,key})),...rows.map(row=>({...row,kind:'subjects'}))];
            const byKey=new Map(refs.map(row=>[mappingHeadKey(namespace,row.kind,row.digest),row]));
            for(const head of heads){validateMappingHead(head,namespace);const ref=byKey.get(head.key);if(!ref||ref.bytes&&ref.bytes!==head.reviewBytes)fail('迁移凭据索引与原记录不符');}
            set({refs,heads});
          });
        });
      });
    },['environmentMaps','subjectMaps','mappingHeads']);
  }
  async function loadMappingReceipt(namespace,kind,expectedDigest,{isCurrent=()=>true}={}){
    if(!account(namespace)||!['environment','subjects'].includes(kind)||!hash(expectedDigest))fail('迁移凭据归属无效');
    const row=await transaction('readonly',isCurrent,(store,read,set)=>{
      if(kind==='environment'){read(store.get(expectedDigest),set);return;}
      read(store.index('namespace').getAllKeys(keyRange.only(namespace),257),keys=>{
        const matches=subjectMapKeys(keys,namespace).filter(row=>row.digest===expectedDigest);if(matches.length>1)fail('角色映射凭据索引重复');
        if(matches.length)read(store.get(matches[0].key),set);else set(null);
      });
    },mappingStore(kind));
    if(!row)return null;
    if(kind==='subjects')return checkedSubjectReceipt(row,namespace,expectedDigest);
    validateStoryboardEnvironmentReceipt(row);await inspectStoryboardEnvironmentReview(row.review);
    if(row.namespace!==namespace||row.key!==expectedDigest)fail('环境映射凭据归属不符');return row;
  }
  return Object.freeze({
    loadMappingReceipt,
    async importMappingReceipt(input,{head:inputHead,confirmed=false,isCurrent=()=>true}={}){
      if(confirmed!==true)fail('请单独确认保存历史迁移凭据');
      if(!isCurrent())fail('导入恢复记录的账户或页面已变化');
      const row=structuredClone(input),head=structuredClone(inputHead),namespace=head?.namespace;
      await inspectBundleMappingReceipt(row,head,namespace);
      const previous=await loadMappingReceipt(namespace,head.kind,head.digest,{isCurrent});
      if(previous&&await mappingDigest(previous)!==await mappingDigest(row))fail('历史迁移凭据与本机首次记录不同，未覆盖');
      const expected=JSON.stringify(previous),storeName=mappingStore(head.kind);
      await transaction('readwrite',isCurrent,(store,read,set,tx)=>{
        read(store.index('namespace').getAllKeys(keyRange.only(namespace),257),keys=>{
          if(head.kind==='subjects'){
            const refs=subjectMapKeys(keys,namespace),matches=refs.filter(ref=>ref.digest===head.digest);
            if(matches.length>1||matches.length&&matches[0].key!==row.key)fail('角色映射索引已变化');
            if(!matches.length&&(refs.length>=256||refs.reduce((sum,ref)=>sum+ref.bytes,row.bytes)>64*1048576))fail('角色映射凭据空间不足，不会自动删除历史');
          }else if(keys.length>256||keys.some(key=>!hash(key))||!keys.includes(row.key)&&keys.length>=256)fail('环境映射凭据名额不足或索引损坏');
          read(store.get(row.key),current=>{
            if(JSON.stringify(current||null)!==expected)fail('历史迁移凭据已被另一页面修改，请重新核对');
            const heads=tx.objectStore('mappingHeads');read(heads.get(head.key),currentHead=>{
              if(currentHead){validateMappingHead(currentHead,namespace);if(!sameBundleMappingHead(currentHead,head)||!current)fail('历史迁移凭据索引冲突，原记录未覆盖');}
              if(!current)store.add(row);if(!currentHead)heads.add(head);set(true);
            });
          });
        });
      },[storeName,'mappingHeads']);
      return loadMappingReceipt(namespace,head.kind,head.digest,{isCurrent});
    },
    async listMappingHeads(namespace,{guard=async()=>{},isCurrent=()=>true}={}){
      if(!account(namespace))fail('迁移凭据账户无效');await guard();const before=await mappingReferences(namespace,isCurrent),existing=new Set(before.heads.map(row=>row.key));
      if(before.refs.length===before.heads.length){await guard();return before.heads;}
      for(const ref of before.refs){
        if(existing.has(mappingHeadKey(namespace,ref.kind,ref.digest)))continue;
        await guard();const receipt=await loadMappingReceipt(namespace,ref.kind,ref.digest,{isCurrent});if(!receipt)fail('迁移凭据已变化，请重新盘点');
        const head=mappingHead(ref.kind,receipt);await guard();
        await transaction('readwrite',isCurrent,(store,read,set,tx)=>read(store.get(ref.key),current=>{
          if(JSON.stringify(current)!==JSON.stringify(receipt))fail('原迁移凭据已变化，未改写历史');
          const heads=tx.objectStore('mappingHeads');read(heads.get(head.key),currentHead=>{
            if(currentHead){validateMappingHead(currentHead,namespace);if(JSON.stringify(currentHead)!==JSON.stringify(head))fail('迁移凭据目录已变化');}
            else heads.add(head);set(true);
          });
        }),[mappingStore(ref.kind),'mappingHeads']);
      }
      await guard();const after=await mappingReferences(namespace,isCurrent);
      if(after.refs.length!==after.heads.length)fail('另一个页面新增了迁移凭据，请刷新目录');return after.heads;
    },
    async loadSubjectMap(namespace,expectedDigest){
      if(!account(namespace)||!hash(expectedDigest))fail('角色映射凭据归属无效');
      const row=await transaction('readonly',()=>true,(store,read,set)=>read(store.index('namespace').getAllKeys(keyRange.only(namespace),257),keys=>{
        const matches=subjectMapKeys(keys,namespace).filter(row=>row.digest===expectedDigest);if(matches.length>1)fail('角色映射凭据索引重复');
        if(!matches.length){set(null);return;}read(store.get(matches[0].key),row=>set(row));
      }),'subjectMaps');return checkedSubjectReceipt(row,namespace,expectedDigest);
    },
    async inspectSubjectMap(input){
      const review=await inspectStoryboardSubjectMapReview(input),bytes=mapBytes(review);
      const result=await transaction('readonly',()=>true,(store,read,set)=>read(store.index('namespace').getAllKeys(keyRange.only(review.namespace),257),keys=>{
        const rows=subjectMapKeys(keys,review.namespace),matches=rows.filter(row=>row.digest===review.digest);if(matches.length>1)fail('角色映射凭据索引重复');
        const finish=receipt=>set({receipt,fits:Boolean(receipt)||rows.length<256&&rows.reduce((sum,row)=>sum+row.bytes,bytes)<=64*1048576});
        if(matches.length)read(store.get(matches[0].key),finish);else finish(null);
      }),'subjectMaps');result.receipt=await checkedSubjectReceipt(result.receipt,review.namespace,review.digest);return result;
    },
    async prepareSubjectMap(input,{confirmed=false,isCurrent=()=>true}={}){
      if(confirmed!==true)fail('请单独确认角色或人设目标映射');const review=await inspectStoryboardSubjectMapReview(input),bytes=mapBytes(review);
      const result=await transaction('readwrite',isCurrent,(store,read,set,tx)=>read(store.index('namespace').getAllKeys(keyRange.only(review.namespace),257),keys=>{
        const rows=subjectMapKeys(keys,review.namespace),matches=rows.filter(row=>row.digest===review.digest);if(matches.length>1)fail('角色映射凭据索引重复');
        if(matches.length){read(store.get(matches[0].key),set);return;}
        if(rows.length>=256||rows.reduce((sum,row)=>sum+row.bytes,bytes)>64*1048576)fail('角色映射凭据空间不足，不会自动删除历史');
        const row={key:JSON.stringify([review.namespace,review.digest,bytes]),namespace:review.namespace,review,bytes,createdAt:now()};store.add(row);tx.objectStore('mappingHeads').add(mappingHead('subjects',row));set(row);
      }),['subjectMaps','mappingHeads']);return checkedSubjectReceipt(result,review.namespace,review.digest);
    },
    async inspectEnvironmentMap(input){
      const review=await inspectStoryboardEnvironmentReview(input);if(review.state!=='mapping-required')fail('无需保存相同环境的映射');
      const result=await transaction('readonly',()=>true,(store,read,set)=>read(store.get(review.digest),row=>{
        if(row){validateStoryboardEnvironmentReceipt(row);if(!storyboardEnvironmentReviewsEqual(row.review,review))fail('环境映射记录与原包不符');}
        read(store.index('namespace').count(keyRange.only(review.namespace)),count=>set({receipt:row||null,fits:Boolean(row)||count<STORYBOARD_ENVIRONMENT_MAP_LIMIT}));
      }),'environmentMaps');return result;
    },
    async prepareEnvironmentMap(input,{confirmed=false,isCurrent=()=>true}={}){
      if(confirmed!==true)fail('请明确确认来源与目标环境映射');
      const review=await inspectStoryboardEnvironmentReview(input),row=validateStoryboardEnvironmentReceipt({key:review.digest,namespace:review.namespace,review,createdAt:now()});
      return transaction('readwrite',isCurrent,(store,read,set,tx)=>read(store.get(row.key),existing=>{
        if(existing){validateStoryboardEnvironmentReceipt(existing);if(!storyboardEnvironmentReviewsEqual(existing.review,review))fail('环境映射记录已变化');set(existing);return;}
        read(store.index('namespace').count(keyRange.only(row.namespace)),count=>{
          if(count>=STORYBOARD_ENVIRONMENT_MAP_LIMIT)fail('环境映射凭据已达上限，请先保全核对，不会自动删除历史');store.add(row);tx.objectStore('mappingHeads').add(mappingHead('environment',row));set(row);
        });
      }),['environmentMaps','mappingHeads']);
    },
    async loadResource(namespace,kind='characters'){
      if(!account(namespace)||!['characters','bundle'].includes(kind))fail('资源恢复账户或类型无效');
      return transaction('readonly',()=>true,(store,read,set)=>read(store.get(JSON.stringify([namespace,kind])),row=>{
        if(row){validateResourceRestoreCheckpoint(row);if(row.namespace!==namespace||row.kind!==kind)fail('资源恢复记录归属不符');}set(row||null);
      }),'resources');
    },
    async prepareResource(descriptor,{previous=null,confirmed=false,isCurrent=()=>true}={}){
      if(confirmed!==true)fail('请先确认资源恢复');
      const stamp=now(),row=structuredClone(validateResourceRestoreCheckpoint({...descriptor,key:JSON.stringify([descriptor.namespace,descriptor.kind]),version:1,phase:'prepared',revision:1,createdAt:stamp,updatedAt:stamp}));
      const approved=previous?structuredClone(validateResourceRestoreCheckpoint(previous)):null;
      return transaction('readwrite',isCurrent,(store,read,set)=>read(store.get(row.key),current=>{
        if(current)validateResourceRestoreCheckpoint(current);
        if(JSON.stringify(current||null)!==JSON.stringify(approved))fail('资源恢复记录已被另一页面修改，请重新核对');
        if(current&&(current.sourceDigest!==row.sourceDigest||current.chatHash!==row.chatHash)&&current.phase!=='verified')fail('本账户有未完成的资源恢复，请先选择原备份核对');
        if(current&&current.phase!=='verified'&&current.environmentDigest!==row.environmentDigest)fail('未完成恢复的目标环境已变化，请先核对原记录');
        if(current&&current.phase!=='verified'&&current.subjectMappingDigest!==row.subjectMappingDigest)fail('未完成恢复的角色映射已变化，请先核对原记录');
        if(current){row.revision=current.revision+1;row.createdAt=current.sourceDigest===row.sourceDigest?current.createdAt:stamp;row.updatedAt=Math.max(current.updatedAt,stamp);}
        validateResourceRestoreCheckpoint(row);store.put(row);set(row);
      }),'resources');
    },
    async updateResource(input,phase,{isCurrent=()=>true}={}){
      const previous=structuredClone(validateResourceRestoreCheckpoint(input));
      const order=resourceOrder(previous.kind);
      if(order.indexOf(phase)!==order.indexOf(previous.phase)+1)fail('资源恢复阶段次序无效');
      return transaction('readwrite',isCurrent,(store,read,set)=>read(store.get(previous.key),row=>{
        validateResourceRestoreCheckpoint(row);if(JSON.stringify(row)!==JSON.stringify(previous))fail('资源恢复记录已变化，请重新核对');
        const next=validateResourceRestoreCheckpoint({...row,phase,revision:row.revision+1,updatedAt:Math.max(row.updatedAt,now())});store.put(next);set(next);
      }),'resources');
    },
    async dismissResource(input,{confirmed=false,isCurrent=()=>true}={}){
      const previous=structuredClone(validateResourceRestoreCheckpoint(input));if(confirmed!==true)fail('请先确认结束资源恢复核对');
      return transaction('readwrite',isCurrent,(store,read,set)=>read(store.get(previous.key),row=>{
        validateResourceRestoreCheckpoint(row);if(JSON.stringify(row)!==JSON.stringify(previous))fail('资源恢复记录已变化，请重新核对');store.delete(row.key);set(true);
      }),'resources');
    },
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
    async dismissCheckpoint(input,{confirmed=false,isCurrent=()=>true}={}){
      const previous=structuredClone(validateStoryboardPackageCheckpoint(input));if(confirmed!==true)fail('尚未确认结束素材暂存核对');
      return transaction('readwrite',isCurrent,(store,read,set)=>read(store.get(previous.key),row=>{
        validateStoryboardPackageCheckpoint(row);if(JSON.stringify(row)!==JSON.stringify(previous))fail('素材暂存记录已变化，请重新核对');
        store.delete(row.key);set(true);
      }));
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
