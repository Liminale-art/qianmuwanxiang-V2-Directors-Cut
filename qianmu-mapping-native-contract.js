import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {mappingBytes,validateMappingHead} from './qianmu-storyboard-mapping-contract.js';
import {BUNDLE_MAPPING_LIMITS,validateBundleMappingHeads,sameBundleMappingHead} from './qianmu-bundle-mapping-contract.js';

export const MAPPING_NATIVE_SLOT='mapping-library',MAPPING_RECORD_SLOT='mapping-record';
export const MAPPING_NATIVE_SCHEMA='qianmu.mapping-library.v1';
export const mappingNativeFail=message=>{throw Object.assign(new Error(message),{code:'storyboard_mapping_native',submissionState:'not_submitted'});};
export const mappingNativeExact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function mappingNativeAccount(namespace){if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))mappingNativeFail('迁移凭据账户无效');}
export const emptyMappingNativeIndex=namespace=>({schema:MAPPING_NATIVE_SCHEMA,namespace,revision:0,records:[],retained:[]});
export function validateMappingNativeIndex(index,{namespace,scope}){
  mappingNativeAccount(namespace);
  if(!mappingNativeExact(index,['schema','namespace','revision','records','retained'])||index.schema!==MAPPING_NATIVE_SCHEMA||index.namespace!==namespace
    ||!Number.isSafeInteger(index.revision)||index.revision<0||!Array.isArray(index.records)||!Array.isArray(index.retained)||index.retained.length>512||mappingBytes(index)>2*1048576)mappingNativeFail('ST 迁移凭据目录损坏或超限，未建立空库');
  validateBundleMappingHeads(index.records.map(row=>row?.head),namespace);
  const active=new Map(index.records.map(row=>[row.head.key,row.head])),refs=new Set();let retainedBytes=0;
  for(const [rows,retained] of [[index.records,false],[index.retained,true]])for(const row of rows){
    if(!mappingNativeExact(row,['head','reference']))mappingNativeFail('迁移凭据原件引用不完整');
    validateMappingHead(row.head,namespace);
    stAccountImmutableReference(row.reference,{scope,slot:MAPPING_RECORD_SLOT,maxBytes:BUNDLE_MAPPING_LIMITS.receipt+1024});
    if(refs.has(row.reference.fingerprint))mappingNativeFail('迁移凭据原件重复');refs.add(row.reference.fingerprint);
    if(retained){
      // Same verified review, different first-save metadata: retain both, never
      // change the active receipt's original timestamp or replay its choices.
      const current=active.get(row.head.key);
      if(!current||sameBundleMappingHead(current,row.head)||['sourceDigest','chatHash','reviewBytes','mappings','bindings','version','scope'].some(key=>current[key]!==row.head[key]))mappingNativeFail('旧端凭据与当前来源不符');
      retainedBytes+=row.head.bytes;
    }
  }
  if(retainedBytes>BUNDLE_MAPPING_LIMITS.records)mappingNativeFail('旧端凭据保全空间已满，不会自动删除历史');
  return index;
}
