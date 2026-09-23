import {textCollectionPreview} from './qianmu-text-collection.js';
import {textCollectionOriginalDescriptor} from './qianmu-text-collection-original.js';
import {TEXT_COLLECTION_SYNC_LIMITS as limits,textCollectionSyncEntry,textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';

export const nativeCollectionBytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
// Counts live originals as well as their index. Splitting must not evade the
// existing logical library budget. Retained historical files are not this total.
export const nativeCollectionLogicalBytes=value=>nativeCollectionBytes(value)+(value.version===2?value.entries.reduce((n,row)=>n+(row.deleted?0:row.recordBytes),0):0);
export function nativeCollectionSummary(row){
  if(row.original)return row.summary;
  const record=row.record;return {id:record.id,revision:record.revision,createdAt:record.createdAt,updatedAt:record.updatedAt,
    charName:record.source.charName,userName:record.source.userName,mode:record.mode,preview:textCollectionPreview(record)};
}
export function validateNativeCollectionDocument(value,{expectedAccount,scope}={}){
  if(!value||![1,2].includes(value.version)||value.expectedAccount!==expectedAccount||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision>limits.mutations
    ||!Array.isArray(value.entries)||value.entries.length>limits.records||!Array.isArray(value.receipts)||value.receipts.length>limits.mutations)throw error('corrupt','收藏资料校验失败，原件未覆盖',503);
  if(value.version===2&&Object.keys(value).some(key=>!['version','expectedAccount','revision','entries','receipts','migration'].includes(key)))throw error('corrupt','收藏目录含未识别字段，未改写原件',503);
  const ids=new Set();for(const entry of value.entries){
    if(value.version===1||entry?.deleted===true)textCollectionSyncEntry(entry,expectedAccount);
    else textCollectionOriginalDescriptor(entry,{expectedAccount,scope});
    if(ids.has(entry.id)||entry.revision>value.revision)throw error('corrupt','收藏编号或版本不一致',503);ids.add(entry.id);
  }
  const receipts=new Set();for(const row of value.receipts){if(!row||Object.keys(row).sort().join(',')!=='expectedAccount,hash,id,libraryRevision,mutationId,ok,revision,updatedAt,version'||row.ok!==true||row.version!==1
    ||!/^[A-Za-z0-9_-]{8,120}$/.test(row.mutationId)||!/^[A-Za-z0-9_-]{8,120}$/.test(row.id)||!ids.has(row.id)
    ||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.libraryRevision)||row.libraryRevision<row.revision||!Number.isSafeInteger(row.updatedAt)||row.updatedAt<0||row.updatedAt>253402214400000
    ||typeof row.hash!=='string'||!/^[a-f0-9]{64}$/.test(row.hash)||receipts.has(row.mutationId)||row.libraryRevision>value.revision||row.expectedAccount!==expectedAccount)throw error('corrupt','收藏保存凭据不一致',503);receipts.add(row.mutationId);}
  if(nativeCollectionLogicalBytes(value)>limits.bytes)throw error('capacity','收藏超过当前储存容量，未截断原文',507);return value;
}
