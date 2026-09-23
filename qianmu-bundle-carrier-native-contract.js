import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {bundleCarrierKey,sameCarrierFields,summarizeBundleCarrierStorage,summarizeBundleCarrierOriginals} from './qianmu-bundle-carrier-storage-contract.js';

export const CARRIER_NATIVE_SLOT='carrier-library',CARRIER_PROOF_SLOT='carrier-proof',CARRIER_ORIGINAL_SLOT='carrier-original',CARRIER_PART_SLOT='carrier-original-part';
export const CARRIER_NATIVE_SCHEMA='qianmu.carrier-library.v1',CARRIER_RAW_SCHEMA='qianmu.carrier-original.v1',CARRIER_PART_SCHEMA='qianmu.carrier-part.v1';
export const CARRIER_NATIVE_BYTES=6*1048576,CARRIER_PART_BYTES=1048576;
export const carrierNativeFail=message=>{throw Object.assign(new Error(message),{code:'storyboard_bundle_carrier_native',submissionState:'not_submitted'});};
export const carrierExact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const emptyCarrierNativeIndex=namespace=>({schema:CARRIER_NATIVE_SCHEMA,namespace,revision:0,proofs:[],originals:[]});
export function carrierCatalog(index){
  const heads=index.proofs.map(row=>row.head),originals=index.originals.map(row=>row.head);
  return {heads,storage:summarizeBundleCarrierStorage(heads,index.namespace),originals,originalStorage:summarizeBundleCarrierOriginals(originals,index.namespace)};
}
export function validateCarrierNativeIndex(index,{namespace,scope}){
  bundleCarrierKey(namespace,'0'.repeat(64));
  if(!carrierExact(index,['schema','namespace','revision','proofs','originals'])||index.schema!==CARRIER_NATIVE_SCHEMA||index.namespace!==namespace
    ||!Number.isSafeInteger(index.revision)||index.revision<0||!Array.isArray(index.proofs)||!Array.isArray(index.originals)
    ||new TextEncoder().encode(JSON.stringify(index)).length>2*1048576)carrierNativeFail('ST来源目录损坏或超限，未建立空库');
  carrierCatalog(index);
  for(const [rows,slot,maxBytes] of [[index.proofs,CARRIER_PROOF_SLOT,5*1048576+1024],[index.originals,CARRIER_ORIGINAL_SLOT,16384]]){
    const refs=new Set();for(const row of rows){
      if(!carrierExact(row,['head','reference']))carrierNativeFail('ST来源原件引用不完整');
      stAccountImmutableReference(row.reference,{scope,slot,maxBytes});
      if(refs.has(row.reference.fingerprint))carrierNativeFail('ST来源目录原件重复');refs.add(row.reference.fingerprint);
    }
  }return index;
}
export function mergeCarrierHeads(existing,wanted){
  const rows=new Map(existing.map(head=>[head.key,head]));
  for(const head of wanted){const old=rows.get(head.key);if(old&&!sameCarrierFields(old,head))carrierNativeFail('来源目录与已有记录冲突，未覆盖');rows.set(head.key,head);}return [...rows.values()];
}
export function mergeCarrierDescriptors(existing,wanted){
  const rows=new Map(existing.map(row=>[row.head.key,row]));
  for(const row of wanted){const old=rows.get(row.head.key);if(old&&(!sameCarrierFields(old.head,row.head)||!sameCarrierFields(old.reference,row.reference)))carrierNativeFail('同一来源已有不同原件，未覆盖');rows.set(row.head.key,row);}return [...rows.values()];
}
