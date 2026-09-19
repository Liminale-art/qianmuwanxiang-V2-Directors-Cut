import {textCollectionRecord,textCollectionText,updateTextCollection} from './qianmu-text-collection.js';

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

// Explicit operations prevent editing captured names/ranges or sending prose with deletion.
export function textCollectionSyncMutation(value){
  const keys=['version','expectedAccount','mutationId','operation','id','baseRevision'];
  const extra=value?.operation==='create'?['record']:value?.operation==='edit'?['text']:[];
  if(!fields(value,[...keys,...extra])||value.version!==TEXT_COLLECTION_SYNC_VERSION||!account(value.expectedAccount)
    ||!id(value.mutationId)||!id(value.id)||!integer(value.baseRevision)||!['create','edit','delete'].includes(value.operation))fail('收藏保存请求格式无效');
  const base={version:1,expectedAccount:value.expectedAccount,mutationId:value.mutationId,operation:value.operation,id:value.id,baseRevision:value.baseRevision};
  if(value.operation==='create'){
    const item=record(value.record);
    if(value.baseRevision!==0||item.id!==value.id||item.source.account!==value.expectedAccount||item.revision!==1||item.updatedAt!==item.createdAt)fail('新收藏的账户、编号或初始版本不一致');
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
  if(item.id!==value.id||item.source.account!==expectedAccount||item.revision!==value.revision||item.updatedAt!==value.updatedAt)fail('收藏储存条目与账户或正文版本不一致');
  return Object.freeze({id:value.id,revision:value.revision,updatedAt:value.updatedAt,deleted:false,record:item});
}

// Pure state transition. Persistence must authorize the host account and serialize this CAS with the write.
// Repeated mutation receipts must be checked by the persistence layer before invoking this transition.
export function applyTextCollectionMutation(previous,input,now){
  const request=textCollectionSyncMutation(input),current=previous===null?null:textCollectionSyncEntry(previous,request.expectedAccount);
  if(current&&current.id!==request.id)fail('收藏变更目标与已读取条目不一致');
  if((current?.revision||0)!==request.baseRevision||current?.deleted)throw textCollectionSyncError('conflict','收藏已在其他设备变更，请重新载入；本机内容仍保留');
  if(!timestamp(now))throw textCollectionSyncError('clock','收藏保存时钟无效，未写入',503);
  if(request.operation==='create')return textCollectionSyncEntry({id:request.id,revision:1,updatedAt:request.record.updatedAt,deleted:false,record:request.record},request.expectedAccount);
  const updatedAt=Math.max(now,current.updatedAt+1),revision=current.revision+1;
  if(!timestamp(updatedAt)||!integer(revision))throw textCollectionSyncError('clock','收藏版本或保存时钟无效，未写入',503);
  const item=request.operation==='edit'?updateTextCollection(current.record,{text:request.text},current.revision,updatedAt):null;
  return textCollectionSyncEntry({id:request.id,revision,updatedAt,deleted:request.operation==='delete',record:item},request.expectedAccount);
}
