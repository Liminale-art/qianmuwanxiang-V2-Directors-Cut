import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {inspectStoryboardEnvironmentReview} from './qianmu-storyboard-environment-map.js';
import {inspectStoryboardSubjectMapReview} from './qianmu-storyboard-subject-map.js';
import {inspectBundleMappingReceipt} from './qianmu-bundle-mappings.js';
import {mappingHead,mappingBytes} from './qianmu-storyboard-mapping-contract.js';
import {BUNDLE_MAPPING_LIMITS,validateBundleMappingHeads,sameBundleMappingHead} from './qianmu-bundle-mapping-contract.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
import {MAPPING_NATIVE_SLOT,MAPPING_RECORD_SLOT,mappingNativeFail as fail,mappingNativeAccount,emptyMappingNativeIndex,validateMappingNativeIndex,planMappingNativeSources} from './qianmu-mapping-native-contract.js';

// Append-only native receipts. Recovery checkpoints remain a separate journal;
// storing a receipt never replays a binding, grants consent, or submits a model.
export function createNativeMappingJournal({legacy,createStorage=createConfiguredStAccountStorage,now=Date.now}={}){
  let opening,storage,closed=false,known=false;
  const find=(index,kind,id)=>index.records.find(row=>row.head.kind===kind&&row.head.digest===id);
  async function operation(namespace,options,work){
    mappingNativeAccount(namespace);
    const current=options?.isCurrent??(()=>true),guard=options?.guard??(async()=>{});
    if(typeof current!=='function'||typeof guard!=='function')fail('迁移凭据缺少身份保护');
    const check=async()=>{if(closed||options?.signal?.aborted||current()!==true)fail('迁移凭据页面或账户已变化');await guard();if(closed||options?.signal?.aborted||current()!==true)fail('迁移凭据页面或账户已变化');return true;};
    await check();
    if(!opening)opening=Promise.resolve().then(()=>createStorage({isCurrent:()=>!closed,maxBytes:BUNDLE_MAPPING_LIMITS.receipt})).then(value=>{
      if(closed){value.close();fail('迁移凭据会话已关闭');}storage=value;return value;
    }).catch(error=>{opening=null;throw error;});
    const client=await opening;await check();if(client.namespace!==namespace)fail('迁移凭据不属于当前 ST 账户');
    let committed=false;
    const transport={guard:check,signal:options?.signal},validate=value=>validateMappingNativeIndex(value,{namespace,scope:client.scope});
    const read=async()=>{const result=await client.read(MAPPING_NATIVE_SLOT,transport);await check();
      if(!result.exists&&known)fail('已确认的 ST 迁移凭据目录缺失，未重建空库');if(result.exists)known=true;
      return {index:validate(result.exists?result.value:emptyMappingNativeIndex(namespace)),fingerprint:result.fingerprint};};
    const load=async descriptor=>{const result=await client.readImmutable(descriptor.reference,transport);await check();
      await inspectBundleMappingReceipt(result.value,descriptor.head,namespace);await check();return result.value;};
    const preserve=async(row,head)=>{await inspectBundleMappingReceipt(row,head,namespace);await check();
      const saved=await client.preserveImmutable(MAPPING_RECORD_SLOT,row,transport);await check();
      await inspectBundleMappingReceipt(saved.value,head,namespace);if(await digest(saved.value)!==await digest(row))fail('迁移凭据原件读回不符');
      return {head,reference:saved.reference};};
    const update=async(transform,extraGuard)=>{const saved=await client.update(MAPPING_NATIVE_SLOT,value=>{
      if(value===null&&known)fail('已确认的 ST 迁移凭据目录缺失，未覆盖为空库');
      const index=validate(value??emptyMappingNativeIndex(namespace)),before=JSON.stringify(index);transform(index);
      if(JSON.stringify(index)!==before)index.revision++;return validate(index);
    },{...transport,guard:extraGuard??check});committed=true;known=true;await check();return validate(saved.value);};
    // Read only local keys/heads on ordinary calls. Full old bodies are read one
    // at a time only for unpreserved sources; never delete or rewrite old IDB.
    const localHeads=async()=>{await check();const heads=structuredClone(await legacy.listMappingHeads(namespace,{guard:check,isCurrent:current,readOnly:true}));validateBundleMappingHeads(heads,namespace);await check();return heads.sort((a,b)=>a.key.localeCompare(b.key));};
    try{
    let {index}=await read();const heads=await localHeads(),pending=[];
    const missing=heads.filter(head=>![...index.records,...index.retained].some(row=>sameBundleMappingHead(row.head,head)));
    const sourceGuard=missing.length?await legacy.createMappingMigrationGuard(namespace,heads,{isCurrent:current}):null;
    for(const head of missing){
      const row=await legacy.loadMappingReceipt(namespace,head.kind,head.digest,{isCurrent:current});await check();
      pending.push(await preserve(row,head));await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(pending.length){
      const publishGuard=async()=>{await check();await sourceGuard();await check();return true;};
      await publishGuard();index=await update(value=>{
        for(const row of pending){
          const existing=find(value,row.head.kind,row.head.digest);
          if(!existing)value.records.push(row);
          else if(!sameBundleMappingHead(existing.head,row.head)&&!value.retained.some(item=>sameBundleMappingHead(item.head,row.head)))value.retained.push(row);
        }
      },publishGuard);
    }
    // A native-only client still reads the directory: a failed GET is never an
    // empty local fallback. The same adapter is used in main and worker paths.
    const result=await work({index,read,load,preserve,update,check});await check();return result;
    }catch(error){if(committed&&error instanceof Error)error.writeState='unconfirmed';throw error;}
  }
  const locate=(namespace,kind,id,options)=>{
    if(!['environment','subjects'].includes(kind)||typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))fail('迁移凭据类型或编号无效');
    return operation(namespace,options,async({index,load})=>{const row=find(index,kind,id);return row?load(row):null;});
  };
  async function inspect(input,kind,options){
    const review=await (kind==='subjects'?inspectStoryboardSubjectMapReview(structuredClone(input)):inspectStoryboardEnvironmentReview(structuredClone(input)));
    if(kind==='environment'&&review.state!=='mapping-required')fail('无需保存相同环境的映射');
    return operation(review.namespace,options,async({index,load})=>{
      const existing=find(index,kind,review.digest),receipt=existing?await load(existing):null;
      const rows=index.records.filter(row=>row.head.kind===kind);
      return {receipt,fits:Boolean(receipt)||rows.length<BUNDLE_MAPPING_LIMITS.perKind&&(kind!=='subjects'||rows.reduce((sum,row)=>sum+row.head.reviewBytes,mappingBytes(review))<=BUNDLE_MAPPING_LIMITS.subjectReviews)};
    });
  }
  async function prepare(input,kind,options={}){
    if(options.confirmed!==true)fail('请先明确确认来源或角色映射');
    const review=await (kind==='subjects'?inspectStoryboardSubjectMapReview(structuredClone(input)):inspectStoryboardEnvironmentReview(structuredClone(input)));
    if(kind==='environment'&&review.state!=='mapping-required')fail('无需保存相同环境的映射');
    return operation(review.namespace,options,async({index,load,preserve,update})=>{
      const existing=find(index,kind,review.digest);if(existing)return load(existing);
      const bytes=mappingBytes(review),row=kind==='subjects'?{key:JSON.stringify([review.namespace,review.digest,bytes]),namespace:review.namespace,review,bytes,createdAt:now()}:{key:review.digest,namespace:review.namespace,review,createdAt:now()};
      const head=mappingHead(kind,row);validateBundleMappingHeads([...index.records.map(item=>item.head),head],review.namespace);
      const descriptor=await preserve(row,head);
      const after=await update(value=>{if(!find(value,kind,review.digest))value.records.push(descriptor);});
      return load(find(after,kind,review.digest));
    });
  }
  return Object.freeze({...legacy,mappingPersistence:'st-account-file',mappingConcurrency:'optimistic-non-cas',
    listMappingHeads(namespace,options){return operation(namespace,options,async({index})=>structuredClone(index.records.map(row=>row.head)));},
    loadMappingReceipt:locate,
    loadSubjectMap(namespace,id,options){return locate(namespace,'subjects',id,options);},
    inspectSubjectMap(input,options){return inspect(input,'subjects',options);},
    inspectEnvironmentMap(input,options){return inspect(input,'environment',options);},
    prepareSubjectMap(input,options){return prepare(input,'subjects',options);},
    prepareEnvironmentMap(input,options){return prepare(input,'environment',options);},
    async importMappingReceipt(input,{head:inputHead,confirmed=false,...options}={}){
      if(confirmed!==true)fail('请先确认导入历史迁移凭据');const row=structuredClone(input),head=structuredClone(inputHead);
      await inspectBundleMappingReceipt(row,head,head?.namespace);
      return operation(head.namespace,options,async({index,load,preserve,update})=>{
        const existing=find(index,head.kind,head.digest);
        if(existing){const previous=await load(existing);if(await digest(previous)!==await digest(row))fail('已有不同的首次迁移凭据，原记录未覆盖');return previous;}
        validateBundleMappingHeads([...index.records.map(item=>item.head),head],head.namespace);
        const descriptor=await preserve(row,head);
        const after=await update(value=>{const previous=find(value,head.kind,head.digest);
          if(previous&&!sameBundleMappingHead(previous.head,head))fail('迁移凭据已被另一页面保存，请重新核对');if(!previous)value.records.push(descriptor);});
        const saved=await load(find(after,head.kind,head.digest));if(await digest(saved)!==await digest(row))fail('迁移凭据原文与读回不符');return saved;
      });
    },
    // Source APIs include the exact first-save variants. Normal registry remains
    // the active receipt per review; source preservation never changes that pick.
    listMappingSourceHeads(namespace,options){return operation(namespace,options,async({index})=>structuredClone([...index.records,...index.retained].map(row=>row.head)));},
    inspectMappingSources(namespace,input,{reservations=[],...options}={}){
      const heads=structuredClone(input),reserved=structuredClone(reservations);
      return operation(namespace,options,async({index})=>({...planMappingNativeSources(index,heads,reserved),digest:await digest({index,heads,reserved})}));
    },
    loadMappingSource(namespace,input,options){
      const head=structuredClone(input);
      return operation(namespace,options,async({index,load})=>{
        planMappingNativeSources(index,[head]);const row=[...index.records,...index.retained].find(row=>sameBundleMappingHead(row.head,head));return row?load(row):null;
      });
    },
    async importMappingSource(input,{head:inputHead,confirmed=false,...options}={}){
      if(confirmed!==true)fail('请明确确认保全原始迁移凭据');const row=structuredClone(input),head=structuredClone(inputHead);
      await inspectBundleMappingReceipt(row,head,head?.namespace);
      return operation(head.namespace,options,async({index,load,preserve,update})=>{
        planMappingNativeSources(index,[head]);const locate=value=>[...value.records,...value.retained].find(item=>sameBundleMappingHead(item.head,head));
        let saved=locate(index);
        if(!saved){const descriptor=await preserve(row,head);const after=await update(value=>{
          planMappingNativeSources(value,[head]);if(locate(value))return;
          if(find(value,head.kind,head.digest))value.retained.push(descriptor);else value.records.push(descriptor);
        });saved=locate(after);}
        const receipt=await load(saved);if(await digest(receipt)!==await digest(row))fail('来源凭据读回不符，原件保留');return receipt;
      });
    },
    mappingPreservedSources(namespace,options){return operation(namespace,options,async({index})=>structuredClone(index.retained));},
    close(){closed=true;storage?.close();legacy.close();}
  });
}
