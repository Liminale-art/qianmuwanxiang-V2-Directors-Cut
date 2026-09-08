import {validateMappingHead} from './qianmu-storyboard-mapping-contract.js';

export const BUNDLE_MAPPING_SCHEMA='qianmu.storyboard.bundle-mappings.v1';
export const BUNDLE_MAPPING_LIMITS=Object.freeze({count:512,perKind:256,index:1048576,receipt:9*1048576,records:70*1048576,subjectReviews:64*1048576});
export const bundleMappingEntryId=head=>`mapping:${head.kind}:${head.digest}`;
export const isBundleMappingEntry=id=>typeof id==='string'&&/^mapping:(environment|subjects):[a-f0-9]{64}$/.test(id);
export const sameBundleMappingHead=(a,b)=>Boolean(a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>a[key]===b[key]));
const fail=()=>{throw Object.assign(new Error('资源包迁移凭据清单不完整、重复或超限，请保留原文件'),{code:'storyboard_bundle_mappings'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validateBundleMappingHeads(heads,namespace){
  if(!Array.isArray(heads)||heads.length>BUNDLE_MAPPING_LIMITS.count)fail();
  const keys=new Set(),counts={environment:0,subjects:0};let bytes=0,subjectBytes=0;
  for(const head of heads){
    validateMappingHead(head,namespace);if(keys.has(head.key))fail();keys.add(head.key);counts[head.kind]++;bytes+=head.bytes;
    if(head.kind==='subjects')subjectBytes+=head.reviewBytes;
  }
  if(Object.values(counts).some(count=>count>BUNDLE_MAPPING_LIMITS.perKind)||bytes>BUNDLE_MAPPING_LIMITS.records||subjectBytes>BUNDLE_MAPPING_LIMITS.subjectReviews)fail();
  return {count:heads.length,...counts,bytes};
}
export function validateBundleMappingIndex(value,namespace){
  if(!exact(value,['schema','scope','namespace','heads','digest'])||value.schema!==BUNDLE_MAPPING_SCHEMA||value.scope!=='historical-records-only'||value.namespace!==namespace||!hash(value.digest))fail();
  // The index also covers an explicitly empty journal; absence in an old package is not proof of emptiness.
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))fail();
  validateBundleMappingHeads(value.heads,namespace);
  const ids=value.heads.map(bundleMappingEntryId);
  if(ids.some((id,index)=>index>0&&id<=ids[index-1]))fail();
  return value;
}
export function bundleMappingSummary(index){
  return {version:1,recorded:true,...validateBundleMappingHeads(index.heads,index.namespace),digest:index.digest,restoreAuthorized:false};
}
export function validateBundleMappingSummary(value){
  if(!exact(value,['version','recorded','count','environment','subjects','bytes','digest','restoreAuthorized'])||value.version!==1||value.recorded!==true||value.restoreAuthorized!==false||!hash(value.digest)
    ||!['count','environment','subjects','bytes'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||value.count!==value.environment+value.subjects
    ||value.environment>256||value.subjects>256||value.bytes>BUNDLE_MAPPING_LIMITS.records||Boolean(value.bytes)!==Boolean(value.count))fail();return value;
}
export function validateBundleMappingTransportSummary(value,manifest){
  const entries=Array.isArray(manifest?.entries)?manifest.entries:[],index=entries.filter(row=>row.id==='mapping-receipts'),parts=entries.filter(row=>isBundleMappingEntry(row.id));
  if(value===undefined){if(index.length||parts.length)fail();return;}
  validateBundleMappingSummary(value);
  if(index.length!==1||parts.length!==value.count||parts.filter(row=>row.id.startsWith('mapping:environment:')).length!==value.environment
    ||parts.reduce((sum,row)=>sum+row.bytes,0)!==value.bytes)fail();
}
export function validateBundleMappingRestoreSummary(value,source){
  validateBundleMappingSummary(source);
  if(!exact(value,['version','indexDigest','count','added','existing','addedBytes','restoreAuthorized','digest'])||value.version!==1||value.indexDigest!==source.digest||value.count!==source.count||value.restoreAuthorized!==false||!hash(value.digest)
    ||!['added','existing','addedBytes'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||value.added+value.existing!==value.count||value.addedBytes>source.bytes||Boolean(value.added)!==Boolean(value.addedBytes))fail();return value;
}
export function validateBundleMappingPageInput(input){if(!exact(input,['offset'])||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>504||input.offset%24)fail();return input;}
export function bundleMappingPage(index,sourceDigest,input){
  validateBundleMappingPageInput(input);validateBundleMappingIndex(index,index.namespace);
  if(!hash(sourceDigest)||input.offset&&input.offset>=index.heads.length)fail();
  return {version:1,namespace:index.namespace,sourceDigest,indexDigest:index.digest,total:index.heads.length,offset:input.offset,rows:structuredClone(index.heads.slice(input.offset,input.offset+24))};
}
export function validateBundleMappingPage(value,namespace,sourceDigest,input){
  validateBundleMappingPageInput(input);
  if(!exact(value,['version','namespace','sourceDigest','indexDigest','total','offset','rows'])||value.version!==1||value.namespace!==namespace||value.sourceDigest!==sourceDigest||!hash(value.indexDigest)
    ||!Number.isSafeInteger(value.total)||value.total<0||value.total>512||value.offset!==input.offset||value.offset&&value.offset>=value.total
    ||!Array.isArray(value.rows)||value.rows.length!==Math.min(24,Math.max(0,value.total-value.offset)))fail();validateBundleMappingHeads(value.rows,namespace);return value;
}
