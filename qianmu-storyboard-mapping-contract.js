// Compact metadata only. Full receipts are verified and serialized in a short-lived Worker.
import {canonicalUserSubjectKey} from './qianmu-user-identity.js';
export const MAPPING_PAGE_SIZE=24;
export const mappingBytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const fail=()=>{throw Object.assign(new Error('迁移凭据索引或查询不符，请保留原记录重新核对'),{code:'storyboard_mapping_registry'});};
export const mappingHeadKey=(namespace,kind,digest)=>JSON.stringify([namespace,kind,digest]);
export function mappingHead(kind,receipt){
  const {review,namespace,createdAt}=receipt;
  return validateMappingHead({version:review.scope==='local-user-alias-resolution'?2:1,...(review.scope==='local-user-alias-resolution'?{scope:review.scope}:{}),key:mappingHeadKey(namespace,kind,review.digest),namespace,kind,digest:review.digest,sourceDigest:review.sourceDigest,chatHash:review.chatHash,createdAt,
    bytes:mappingBytes(receipt),reviewBytes:mappingBytes(review),mappings:kind==='environment'?1:review.rows.length,bindings:kind==='environment'?0:review.lineage.length},namespace);
}
export function validateMappingHead(value,namespace){
  if(!exact(value,['version','key','namespace','kind','digest','sourceDigest','chatHash','createdAt','bytes','reviewBytes','mappings','bindings',...(value?.version===2?['scope']:[])])||![1,2].includes(value.version)||value.version===2&&(value.scope!=='local-user-alias-resolution'||value.kind!=='subjects')||!account(namespace)||value.namespace!==namespace
    ||!['environment','subjects'].includes(value.kind)||![value.digest,value.sourceDigest,value.chatHash].every(hash)||value.key!==mappingHeadKey(namespace,value.kind,value.digest)
    ||!integer(value.createdAt)||!integer(value.bytes,9*1048576)||!integer(value.reviewBytes,8*1048576)||value.reviewBytes<1||value.bytes<=value.reviewBytes
    ||!integer(value.mappings,2048)||value.mappings<1||!integer(value.bindings,2048)|| (value.kind==='environment'?(value.mappings!==1||value.bindings!==0):value.bindings<value.mappings))fail();
  return value;
}
export function validateMappingQuery(input){
  if(!exact(input,['kind','query','offset'])||!['all','environment','subjects'].includes(input.kind)||typeof input.query!=='string'||input.query.length>160||!integer(input.offset,504)||input.offset%24)fail();return input;
}
export function validateMappingSelection(input,{paged=false}={}){
  if(!exact(input,['kind','digest',...(paged?['offset']:[])])||!['environment','subjects'].includes(input.kind)||!hash(input.digest)||paged&&(!integer(input.offset,2040)||input.offset%24))fail();return input;
}
export function validateMappingStorage(value,namespace){
  if(!exact(value,['version','namespace','status','count','bytes','recordBytes','indexBytes'])||value.version!==1||value.namespace!==namespace||!account(namespace)||value.status!=='ready'
    ||!integer(value.count,512)||!integer(value.bytes,70*1048576)||!integer(value.recordBytes)||!integer(value.indexBytes)||value.bytes!==value.recordBytes+value.indexBytes
    ||!value.count&&value.bytes!==0||value.count>0&&(!value.recordBytes||!value.indexBytes))fail();return value;
}
const page=(rows,total,offset)=>Array.isArray(rows)&&integer(total,2048)&&integer(offset,2040)&&offset%24===0&&rows.length===Math.min(24,Math.max(0,total-offset))&&(!offset||offset<total);
export function validateMappingList(value,namespace,input){
  validateMappingQuery(input);
  if(!exact(value,['version','namespace','kind','query','offset','total','rows','storage'])||value.version!==1||value.namespace!==namespace||['kind','query','offset'].some(key=>value[key]!==input[key])||value.total>512||!page(value.rows,value.total,value.offset))fail();
  validateMappingStorage(value.storage,namespace);if(value.total>value.storage.count)fail();
  const keys=new Set();for(const row of value.rows){validateMappingHead(row,namespace);if(keys.has(row.key)||input.kind!=='all'&&row.kind!==input.kind||![row.digest,row.sourceDigest,row.chatHash].some(text=>text.includes(input.query.toLowerCase().trim())))fail();keys.add(row.key);}return value;
}
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const binding=value=>exact(value,['category','subjectKey','scope','chatKey','archiveId','revision','updatedAt'])&&['char','user'].includes(value.category)&&text(value.subjectKey,1024)&&!/[\u0000-\u001f\u007f]/.test(value.subjectKey)&&value.subjectKey.startsWith(value.category+':')
  &&['default','chat'].includes(value.scope)&&text(value.chatKey,512)&&(value.scope==='default'?value.chatKey==='':Boolean(value.chatKey))&&text(value.archiveId,160)&&/^[a-zA-Z0-9_-]*$/.test(value.archiveId)&&text(value.revision,160)&&/^[a-zA-Z0-9_-]+$/.test(value.revision)&&integer(value.updatedAt);
export function validateMappingDetail(value,namespace,input){
  validateMappingSelection(input,{paged:true});
  if(!exact(value,['version','namespace','head','offset','total','rows'])||value.version!==1||value.namespace!==namespace||value.offset!==input.offset||!page(value.rows,value.total,value.offset))fail();
  validateMappingHead(value.head,namespace);if(value.head.kind!==input.kind||value.head.digest!==input.digest||value.total!==(input.kind==='environment'?1:value.head.bindings))fail();
  for(const row of value.rows){
    if(input.kind==='environment'){
      if(!exact(row,['sourceInstance','sourceAccount','targetInstance','targetAccount'])||!Object.values(row).every(value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)))fail();
    }else if(value.head.scope==='local-user-alias-resolution'){
      if(!exact(row,['source','target'])||!binding(row.source)||!binding(row.target)||row.source.category!=='user'||row.target.category!=='user'||canonicalUserSubjectKey(row.source.subjectKey)!==row.target.subjectKey||canonicalUserSubjectKey(row.target.subjectKey)!==row.target.subjectKey||['scope','chatKey'].some(key=>row.source[key]!==row.target[key]))fail();
    }else if(!exact(row,['source','target','sourceState','sourceHash','targetHash'])||!binding(row.source)||!binding(row.target)||!['present','missing','unavailable'].includes(row.sourceState)
      ||(row.sourceState==='present'?!hash(row.sourceHash):row.sourceHash!==null)||!hash(row.targetHash)||['category','scope','chatKey','archiveId','updatedAt'].some(key=>row.source[key]!==row.target[key]))fail();
  }return value;
}
export function validateMappingExport(value,namespace,input){
  validateMappingSelection(input);
  if(!exact(value,['version','namespace','head','file','filename'])||value.version!==1||value.namespace!==namespace)fail();validateMappingHead(value.head,namespace);
  if(value.head.kind!==input.kind||value.head.digest!==input.digest||!(value.file instanceof Blob)||value.file.type!=='application/json'||value.file.size<value.head.bytes||value.file.size>value.head.bytes+1024
    ||value.filename!==`qianmu-${input.kind}-${input.digest.slice(0,12)}.mapping.json`)fail();return value;
}
