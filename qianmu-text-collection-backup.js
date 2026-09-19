import {textCollectionRecord,textCollectionRecordAccount} from './qianmu-text-collection.js';
import {assertJsonInputBounds,parseBoundedJson} from './qianmu-json-input.js';

export const TEXT_COLLECTION_BACKUP_LIMITS=Object.freeze({bytes:64*1024*1024,records:10000});
const type='qianmu-text-collections';
const bounds={maxBytes:TEXT_COLLECTION_BACKUP_LIMITS.bytes,maxDepth:12,maxNodes:500000,label:'正文收藏备份'};
const fields=['type','version','sourceAccount','exportedAt','libraryRevision','records'];
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const fail=message=>{throw Object.assign(new Error(message+'；未截断或写入内容，请保留原件'),{code:'text_collection_backup_invalid'});};

// This format contains originals, not mutation receipts, account credentials or
// source-chat text. Reading it grants no authority to restore into any account.
export function validateTextCollectionBackup(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))
    ||value.type!==type||value.version!==1||typeof value.sourceAccount!=='string'||!/^st-user:[a-f0-9]{64}$/.test(value.sourceAccount)
    ||!integer(value.exportedAt)||value.exportedAt>253402214400000||!integer(value.libraryRevision)||!Array.isArray(value.records)
    ||value.records.length>TEXT_COLLECTION_BACKUP_LIMITS.records)fail('正文收藏备份格式或容量无效');
  const seen=new Set(),records=value.records.map((input,index)=>{
    let record;try{record=textCollectionRecord(input);}catch{fail(`第 ${index+1} 条收藏无效`);}
    if(textCollectionRecordAccount(record)!==value.sourceAccount||seen.has(record.id)||record.revision>value.libraryRevision)fail(`第 ${index+1} 条收藏账户、编号或版本不一致`);
    seen.add(record.id);return record;
  });
  return Object.freeze({type,version:1,sourceAccount:value.sourceAccount,exportedAt:value.exportedAt,libraryRevision:value.libraryRevision,records:Object.freeze(records)});
}

export function prepareTextCollectionBackup({sourceAccount,libraryRevision,records,exportedAt=Date.now()}={}){
  const payload=validateTextCollectionBackup({type,version:1,sourceAccount,exportedAt,libraryRevision,records});
  const json=JSON.stringify(payload);assertJsonInputBounds(json,bounds);
  return Object.freeze({payload,blob:new Blob([json],{type:'application/json'}),count:payload.records.length});
}

export async function readTextCollectionBackupFile(file,{check}={}){
  if(typeof check!=='function')throw TypeError('收藏备份读取需要当前账户/页面校验');
  check();
  if(!file||typeof file.text!=='function'||!Number.isSafeInteger(file.size)||file.size<1||file.size>TEXT_COLLECTION_BACKUP_LIMITS.bytes)fail('正文收藏备份为空或超过 64 MiB');
  const raw=await file.text();check();
  const payload=validateTextCollectionBackup(parseBoundedJson(raw,bounds));check();return payload;
}
