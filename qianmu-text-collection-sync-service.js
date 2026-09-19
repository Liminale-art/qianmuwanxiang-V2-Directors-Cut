import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAccountDocumentFiles} from './qianmu-account-document-files.js';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {textCollectionPreview} from './qianmu-text-collection.js';
import {TEXT_COLLECTION_SYNC_LIMITS as limits,textCollectionSyncError as error,textCollectionSyncMutation,textCollectionSyncEntry,applyTextCollectionMutation,textCollectionSyncQuery} from './qianmu-text-collection-sync-contract.js';

const schema='qianmu.text-collection-sync.v1',filename='.qianmu-text-collection-v1.json';
const sha=value=>createHash('sha256').update(value).digest('hex');
const fields=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(value);
const child=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const fail=(code,message,status)=>{throw error(code,message,status);};

// Independent account originals: no chat-file reads, chat deletion hooks or note-file reuse.
export function createTextCollectionSyncService({dataRoot,io,now=Date.now,processStatus}={}){
  if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||dataRoot.includes('\0')||path.resolve(dataRoot)===path.parse(dataRoot).root)fail('setup','收藏缺少可信 ST 数据目录',503);
  const root=path.resolve(dataRoot),pending=new Set(),tails=new Map();let closed=false;
  const disk=createAccountDocumentFiles({root,filename,lockname:'.qianmu-text-collection-v1.lock',temporaryPrefix:'.qianmu-text-collection-write-',
    bytes:limits.bytes,errorFactory:error,label:'收藏',validate,empty,io,processStatus});
  function capture(request,input,signal){
    let account;try{account=imageServiceAccount(request);}catch{fail('account','请先登录 ST 账户使用收藏',401);}
    if(input?.expectedAccount!==account.namespace)fail('account','收藏请求与当前 ST 账户不一致',401);
    const original=request.user?.directories?.root;
    if(typeof original!=='string'||!path.isAbsolute(original)||original.includes('\0'))fail('path','ST 未提供有效的收藏目录',503);
    const folder=path.resolve(original);if(!child(root,folder))fail('path','收藏目录不属于当前 ST 数据范围',403);
    const context={account,folder,roots:new Map(),writeState:'not_started',guard(){
      if(closed||signal?.aborted)fail('closed','收藏操作已中止',409);
      if(!imageServiceAccountStillMatches(request,account)||request.user?.directories?.root!==original)fail('account','ST 账户或目录已变化，请重新打开收藏',401);
    }};context.guard();return context;
  }
  function empty(context){return {schema,expectedAccount:context.account.namespace,revision:0,entries:[],mutations:[]};}
  function validate(raw,context){
    if(!fields(raw,['schema','expectedAccount','revision','entries','mutations','checksum'])||raw.schema!==schema||raw.expectedAccount!==context.account.namespace
      ||!integer(raw.revision)||!Array.isArray(raw.entries)||raw.entries.length>limits.records||!Array.isArray(raw.mutations)
      ||raw.mutations.length>limits.mutations||raw.mutations.length!==raw.revision)fail('corrupt','收藏文件格式或账户不一致，请保留原件核对',503);
    const {checksum,...state}=raw;if(sha(JSON.stringify(state))!==checksum)fail('corrupt','收藏文件校验失败，未覆盖',503);
    const mutations=new Set(),latest=new Map();
    for(const receipt of state.mutations){
      const prior=latest.get(receipt?.id);
      if(!fields(receipt,['mutationId','hash','id','revision','updatedAt','operation'])||!identifier(receipt.mutationId)||!identifier(receipt.id)
        ||typeof receipt.hash!=='string'||!/^[a-f0-9]{64}$/.test(receipt.hash)||mutations.has(receipt.mutationId)||!integer(receipt.revision)
        ||receipt.revision!==(prior?.revision||0)+1||!integer(receipt.updatedAt)||receipt.updatedAt>253402214400000
        ||(prior? !['edit','delete'].includes(receipt.operation)||prior.operation==='delete'||receipt.updatedAt<=prior.updatedAt : receipt.operation!=='create'))fail('corrupt','收藏保存凭据损坏，未覆盖',503);
      mutations.add(receipt.mutationId);latest.set(receipt.id,receipt);
    }
    if(latest.size!==state.entries.length)fail('corrupt','收藏条目与保存凭据数量不一致',503);
    const ids=new Set();
    for(const rawEntry of state.entries){
      const entry=textCollectionSyncEntry(rawEntry,context.account.namespace),receipt=latest.get(entry.id);
      if(ids.has(entry.id)||!receipt||entry.revision!==receipt.revision||entry.updatedAt!==receipt.updatedAt||entry.deleted!==(receipt.operation==='delete'))fail('corrupt','收藏正文与保存凭据不一致',503);
      ids.add(entry.id);
    }
    return state;
  }
  const ack=(context,receipt,revision)=>({ok:true,version:1,expectedAccount:context.account.namespace,mutationId:receipt.mutationId,id:receipt.id,revision:receipt.revision,updatedAt:receipt.updatedAt,libraryRevision:revision});
  async function mutate(context,input){
    return disk.exclusive(context,async()=>{
      const {state,fingerprint}=await disk.read(context),hash=sha(JSON.stringify(input)),index=state.mutations.findIndex(row=>row.mutationId===input.mutationId);
      if(index>=0){const receipt=state.mutations[index];if(receipt.hash!==hash)fail('mutation_conflict','收藏操作编号已用于不同内容，未重复保存');return ack(context,receipt,index+1);}
      const previous=state.entries.find(row=>row.id===input.id)||null;
      if(!previous&&state.entries.length>=limits.records||state.mutations.length>=limits.mutations)fail('capacity','收藏已达当前容量上限，请先导出管理；未清理或截断内容',507);
      const entry=applyTextCollectionMutation(previous,input,now()),receipt={mutationId:input.mutationId,hash,id:entry.id,revision:entry.revision,updatedAt:entry.updatedAt,operation:input.operation};
      const next={...state,revision:state.revision+1,entries:previous?state.entries.map(row=>row.id===entry.id?entry:row):[...state.entries,entry],mutations:[...state.mutations,receipt]};
      await disk.writeAtomic(context,next,fingerprint);context.guard();return ack(context,receipt,next.revision);
    });
  }
  async function inspect(context,input,method){
    const {state}=await disk.read(context),base={ok:true,version:1,expectedAccount:context.account.namespace,libraryRevision:state.revision};
    if(method==='get'){const entry=state.entries.find(row=>row.id===input.id);return {...base,record:entry&&!entry.deleted?entry.record:null};}
    if(input.cursor&&input.cursor.revision!==state.revision)fail('changed','收藏目录已变化，请刷新后继续浏览');
    const term=(input.search||'').toLowerCase(),filter=Object.hasOwn(input,'search')?{search:input.search}:{};
    const entries=state.entries.filter(row=>!row.deleted&&(!term||[row.record.text,row.record.source.charName,row.record.source.userName].some(value=>value.toLowerCase().includes(term))))
      .sort((a,b)=>b.record.createdAt-a.record.createdAt||(a.id<b.id?-1:a.id>b.id?1:0)),offset=input.cursor?.offset||0;
    if(offset>entries.length)fail('contract','收藏分页位置无效',400);
    const items=entries.slice(offset,offset+input.limit).map(({record})=>({id:record.id,revision:record.revision,createdAt:record.createdAt,updatedAt:record.updatedAt,
      charName:record.source.charName,userName:record.source.userName,mode:record.mode,preview:textCollectionPreview(record)}));
    const next=offset+items.length;return {...base,...filter,items,total:entries.length,nextCursor:next<entries.length?{revision:state.revision,offset:next,...filter}:null};
  }
  function track(request,body,options,method){
    let context,input;
    try{context=capture(request,body,options?.signal);input=method==='write'?textCollectionSyncMutation(body):textCollectionSyncQuery(body,method);if(pending.size>=64)fail('busy','收藏请求过多，请稍后重试',429);}
    catch(cause){return Promise.reject(cause);}
    const key=context.account.namespace,prior=tails.get(key)||Promise.resolve();
    const task=prior.catch(()=>{}).then(async()=>{
      try{context.guard();const result=method==='write'?await mutate(context,input):await inspect(context,input,method);context.guard();return result;}
      catch(cause){try{context.guard();}catch(changed){cause=changed;}
        const known=String(cause?.code||'').startsWith('text_collection_sync_')?cause:error('storage','收藏储存暂不可用，请保留当前内容后重试',503);known.writeState=context.writeState;throw known;}
    });
    pending.add(task);tails.set(key,task);void task.finally(()=>{pending.delete(task);if(tails.get(key)===task)tails.delete(key);}).catch(()=>{});return task;
  }
  return Object.freeze({list:(request,input,options)=>track(request,input,options,'list'),get:(request,input,options)=>track(request,input,options,'get'),
    write:(request,input,options)=>track(request,input,options,'write'),async close(){closed=true;await Promise.allSettled([...pending]);}});
}
