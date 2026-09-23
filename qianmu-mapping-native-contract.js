import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {mappingBytes,validateMappingHead} from './qianmu-storyboard-mapping-contract.js';
import {BUNDLE_MAPPING_LIMITS,validateBundleMappingHeads,sameBundleMappingHead,sameBundleMappingReview} from './qianmu-bundle-mapping-contract.js';

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
  const active=new Map(index.records.map(row=>[row.head.key,row.head])),refs=new Set(),heads=new Set();let retainedBytes=0;
  for(const [rows,retained] of [[index.records,false],[index.retained,true]])for(const row of rows){
    if(!mappingNativeExact(row,['head','reference']))mappingNativeFail('迁移凭据原件引用不完整');
    validateMappingHead(row.head,namespace);
    const identity=JSON.stringify([row.head.key,row.head.createdAt,row.head.bytes]);
    if(heads.has(identity))mappingNativeFail('迁移凭据来源目录重复');heads.add(identity);
    stAccountImmutableReference(row.reference,{scope,slot:MAPPING_RECORD_SLOT,maxBytes:BUNDLE_MAPPING_LIMITS.receipt+1024});
    if(refs.has(row.reference.fingerprint))mappingNativeFail('迁移凭据原件重复');refs.add(row.reference.fingerprint);
    if(retained){
      // Same verified review, different first-save metadata: retain both, never
      // change the active receipt's original timestamp or replay its choices.
      const current=active.get(row.head.key);
      if(!sameBundleMappingReview(current,row.head)||sameBundleMappingHead(current,row.head))mappingNativeFail('旧端凭据与当前来源不符');
      retainedBytes+=row.head.bytes;
    }
  }
  if(retainedBytes>BUNDLE_MAPPING_LIMITS.records)mappingNativeFail('旧端凭据保全空间已满，不会自动删除历史');
  return index;
}

export function planMappingNativeSources(index,incoming,reservations=[]){
  if(!Array.isArray(incoming)||incoming.length>1024||!Array.isArray(reservations)||reservations.length>2)mappingNativeFail('来源凭据核对数量无效');
  const active=index.records.map(row=>row.head),retained=index.retained.map(row=>row.head),added=[];
  for(const head of incoming){
    validateMappingHead(head,index.namespace);
    if([...active,...retained].some(row=>sameBundleMappingHead(row,head)))continue;
    const current=active.find(row=>row.key===head.key);
    if(current){if(!sameBundleMappingReview(current,head))mappingNativeFail('来源凭据与当前映射含义不同，未覆盖');retained.push(head);}
    else active.push(head);added.push(head);
  }
  for(const head of reservations){validateMappingHead(head,index.namespace);if(!active.some(row=>row.key===head.key))active.push(head);}
  validateBundleMappingHeads(active,index.namespace);
  if(retained.length>512||retained.reduce((sum,row)=>sum+row.bytes,0)>BUNDLE_MAPPING_LIMITS.records)mappingNativeFail('旧端凭据保全名额或空间不足，不会自动清理');
  return {added:added.length,existing:incoming.length-added.length,addedBytes:added.reduce((sum,row)=>sum+row.bytes,0)};
}
