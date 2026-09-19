import {textCollectionRecord,textCollectionRecordAccount,restoreTextCollectionCopy,textCollectionText,updateTextCollection} from './qianmu-text-collection.js';
import {validateTextCollectionBackup} from './qianmu-text-collection-backup.js';

export const TEXT_COLLECTION_SYNC_VERSION=1;
export const TEXT_COLLECTION_SYNC_LIMITS=Object.freeze({records:10000,mutations:100000,bytes:64*1024*1024,page:50});
const fields=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const account=value=>typeof value==='string'&&/^st-user:[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(value);
const timestamp=value=>integer(value)&&value<=253402214400000;
export const textCollectionSyncError=(code,message,status=409)=>Object.assign(new Error(message),{code:`text_collection_sync_${code}`,status,writeState:'not_started'});
const fail=(message)=>{throw textCollectionSyncError('contract',message,400);};
function record(value){try{return textCollectionRecord(value);}catch(_){fail('收藏记录无效；未截断或改写内容');}}
function text(value){try{return textCollectionText(value);}catch(_){fail('收藏文字为空、过长或编码无效；未截断原文');}}

// Restore makes a new owned copy; it never edits captured names/ranges on existing records.
export function textCollectionSyncMutation(value){
  const keys=['version','expectedAccount','mutationId','operation','id','baseRevision'];
  const extra=['create','restore'].includes(value?.operation)?['record']:value?.operation==='edit'?['text']:[];
  if(!fields(value,[...keys,...extra])||value.version!==TEXT_COLLECTION_SYNC_VERSION||!account(value.expectedAccount)
    ||!id(value.mutationId)||!id(value.id)||!integer(value.baseRevision)||!['create','restore','edit','delete'].includes(value.operation))fail('收藏保存请求格式无效');
  const base={version:1,expectedAccount:value.expectedAccount,mutationId:value.mutationId,operation:value.operation,id:value.id,baseRevision:value.baseRevision};
  if(value.operation==='restore'){
    const item=record(value.record);if(value.baseRevision!==0||item.id===value.id)fail('恢复收藏须使用新的副本编号，不能覆盖原件');
    return Object.freeze({...base,record:item});
  }
  if(value.operation==='create'){
    const item=record(value.record);
    if(value.baseRevision!==0||item.id!==value.id||item.schemaVersion!==1||item.source.account!==value.expectedAccount||item.revision!==1||item.updatedAt!==item.createdAt)fail('新收藏的账户、编号或初始版本不一致');
    return Object.freeze({...base,record:item});
  }
  if(value.baseRevision<1)fail('只能编辑或删除已确认保存的收藏');
  return Object.freeze(value.operation==='edit'?{...base,text:text(value.text)}:base);
}

// Tombstones contain no original text or source metadata; IDs cannot be resurrected by an old client.
export function textCollectionSyncEntry(value,expectedAccount){
  if(!account(expectedAccount)||!fields(value,['id','revision','updatedAt','deleted','record'])||!id(value.id)||!integer(value.revision)
    ||value.revision<1||!timestamp(value.updatedAt)||typeof value.deleted!=='boolean')fail('收藏储存条目格式无效');
  if(value.deleted){
    if(value.record!==null||value.revision<2)fail('收藏删除标记不得携带原文');
    return Object.freeze({...value});
  }
  const item=record(value.record);
  if(item.id!==value.id||textCollectionRecordAccount(item)!==expectedAccount||item.revision!==value.revision||item.updatedAt!==value.updatedAt)fail('收藏储存条目与账户或正文版本不一致');
  return Object.freeze({id:value.id,revision:value.revision,updatedAt:value.updatedAt,deleted:false,record:item});
}

// Pure state transition. Persistence must authorize the host account and serialize this CAS with the write.
// Repeated mutation receipts must be checked by the persistence layer before invoking this transition.
export function applyTextCollectionMutation(previous,input,now){
  const request=textCollectionSyncMutation(input),current=previous===null?null:textCollectionSyncEntry(previous,request.expectedAccount);
  if(current&&current.id!==request.id)fail('收藏变更目标与已读取条目不一致');
  if((current?.revision||0)!==request.baseRevision||current?.deleted)throw textCollectionSyncError('conflict','收藏已在其他设备变更，请重新载入；本机内容仍保留');
  if(!timestamp(now))throw textCollectionSyncError('clock','收藏保存时钟无效，未写入',503);
  if(request.operation==='restore'){
    const item=restoreTextCollectionCopy(request.record,{id:request.id,ownerAccount:request.expectedAccount,restoredAt:now});
    return textCollectionSyncEntry({id:request.id,revision:1,updatedAt:item.updatedAt,deleted:false,record:item},request.expectedAccount);
  }
  if(request.operation==='create')return textCollectionSyncEntry({id:request.id,revision:1,updatedAt:request.record.updatedAt,deleted:false,record:request.record},request.expectedAccount);
  const updatedAt=Math.max(now,current.updatedAt+1),revision=current.revision+1;
  if(!timestamp(updatedAt)||!integer(revision))throw textCollectionSyncError('clock','收藏版本或保存时钟无效，未写入',503);
  const item=request.operation==='edit'?updateTextCollection(current.record,{text:request.text},current.revision,updatedAt):null;
  return textCollectionSyncEntry({id:request.id,revision,updatedAt,deleted:request.operation==='delete',record:item},request.expectedAccount);
}

export function textCollectionSyncQuery(value,method){
  const filtered=method==='list'&&Object.hasOwn(value||{},'search');let search;
  if(filtered){if(typeof value.search!=='string'||value.search.length>160||value.search.includes('\0'))fail('收藏搜索词无效或过长');search=value.search.trim();if(search)text(search);}
  if(!['list','get','snapshot'].includes(method)||!fields(value,['version','expectedAccount',...(method==='snapshot'?[]:method==='get'?['id']:['cursor','limit']),...(filtered?['search']:[])])
    ||value.version!==1||!account(value.expectedAccount))fail('收藏读取请求格式无效');
  if(method==='snapshot')return Object.freeze({...value});
  if(method==='get'){if(!id(value.id))fail('收藏编号无效');return Object.freeze({...value});}
  if(!integer(value.limit)||value.limit<1||value.limit>TEXT_COLLECTION_SYNC_LIMITS.page||value.cursor!==null&&(!fields(value.cursor,['revision','offset',...(filtered?['search']:[])])
    ||!integer(value.cursor.revision)||!integer(value.cursor.offset)||filtered&&value.cursor.search!==search))fail('收藏分页参数或搜索范围无效');
  return Object.freeze({...value,...filtered?{search}:{},cursor:value.cursor===null?null:Object.freeze({...value.cursor})});
}

export function textCollectionSyncResponse(value,method,input){
  const request=method==='write'?textCollectionSyncMutation(input):textCollectionSyncQuery(input,method);
  const extra=method==='write'?['mutationId','id','revision','updatedAt']:method==='snapshot'?['backup']:method==='get'?['record']:['items','total','nextCursor'];
  const filtered=method==='list'&&Object.hasOwn(request,'search');if(filtered)extra.push('search');
  if(!fields(value,['ok','version','expectedAccount','libraryRevision',...extra])||value.ok!==true||value.version!==1
    ||value.expectedAccount!==request.expectedAccount||!integer(value.libraryRevision))fail('收藏返回账户或格式不一致');
  if(method==='snapshot'){
    let backup;try{backup=validateTextCollectionBackup(value.backup);}catch{fail('收藏快照不完整或格式无效');}
    if(backup.sourceAccount!==request.expectedAccount||backup.libraryRevision!==value.libraryRevision)fail('收藏快照账户或版本不一致');
    return Object.freeze({...value,backup});
  }
  if(method==='write'){
    if(value.mutationId!==request.mutationId||value.id!==request.id||value.revision!==request.baseRevision+1||value.revision>value.libraryRevision
      ||!timestamp(value.updatedAt)||['create','restore'].includes(request.operation)&&value.updatedAt!==request.record.updatedAt)fail('收藏保存确认与请求不一致');
    return Object.freeze({...value});
  }
  if(method==='get'){
    const item=value.record===null?null:record(value.record);
    if(item&&(item.id!==request.id||textCollectionRecordAccount(item)!==request.expectedAccount||item.revision>value.libraryRevision))fail('收藏详情与请求不一致');
    return Object.freeze({...value,record:item});
  }
  if(filtered&&value.search!==request.search)fail('收藏返回与当前搜索不一致');
  const offset=request.cursor?.offset||0;
  if(!integer(value.total)||value.total>TEXT_COLLECTION_SYNC_LIMITS.records||offset>value.total||!Array.isArray(value.items)
    ||value.items.length!==Math.min(request.limit,value.total-offset)||request.cursor&&request.cursor.revision!==value.libraryRevision)fail('收藏目录版本或分页范围不一致');
  const next=offset+value.items.length,ids=new Set();
  if(next<value.total? !fields(value.nextCursor,['revision','offset',...(filtered?['search']:[])])||value.nextCursor.revision!==value.libraryRevision||value.nextCursor.offset!==next||filtered&&value.nextCursor.search!==request.search : value.nextCursor!==null)fail('收藏目录缺失后续分页或游标无效');
  const items=value.items.map(item=>{
    if(!fields(item,['id','revision','createdAt','updatedAt','charName','userName','mode','preview'])||!id(item.id)||ids.has(item.id)
      ||!integer(item.revision)||item.revision<1||item.revision>value.libraryRevision||!timestamp(item.createdAt)||!timestamp(item.updatedAt)||item.updatedAt<item.createdAt
      ||!['full','selection'].includes(item.mode)||![item.charName,item.userName].every(name=>typeof name==='string'&&name.length<=256&&name.trim())
      ||typeof item.preview!=='string'||Array.from(item.preview).length>101)fail('收藏目录条目格式无效');
    text(item.charName);text(item.userName);text(item.preview);ids.add(item.id);return Object.freeze({...item});
  });
  return Object.freeze({...value,items:Object.freeze(items),nextCursor:value.nextCursor===null?null:Object.freeze({...value.nextCursor})});
}

export function textCollectionSyncErrorPayload(cause){
  const known=/^text_collection_sync_[a-z_]+$/.test(cause?.code||'')&&typeof cause?.message==='string'&&cause.message.length<=240;
  return {status:known&&Number.isInteger(cause.status)&&cause.status>=400&&cause.status<=599?cause.status:503,
    body:{ok:false,version:1,code:known?cause.code:'text_collection_sync_storage',message:known?cause.message:'收藏储存暂不可用，请保留当前内容后重试',
      writeState:cause?.writeState==='unconfirmed'?'unconfirmed':'not_started'}};
}
