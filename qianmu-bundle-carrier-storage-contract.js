import {BUNDLE_CARRIER_LIMITS,validateBundleCarrierSummary} from './qianmu-bundle-carrier-contract.js';
const fail=()=>{throw Object.assign(new Error('备份来源关联库目录不符或超限，请保留原记录'),{code:'storyboard_bundle_carrier_storage'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
export const BUNDLE_CARRIER_ORIGINAL_LIMITS=Object.freeze({count:1024,record:9*1048576,total:70*1048576});
export const sameCarrierFields=(a,b)=>Boolean(a&&b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>a[key]===b[key]);
export function bundleCarrierKey(namespace,carrierDigest){
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)||typeof carrierDigest!=='string'||!/^[a-f0-9]{64}$/.test(carrierDigest))fail();
  return JSON.stringify([namespace,carrierDigest]);
}
export function bundleCarrierHead(summary){
  validateBundleCarrierSummary(summary,summary?.namespace);const key=bundleCarrierKey(summary.namespace,summary.carrierDigest);
  return {...summary,key,recordBytes:summary.bytes+bytes({key,namespace:summary.namespace,proof:null})-4};
}
export function validateBundleCarrierHead(head,namespace){
  if(!head||head.namespace!==namespace)fail();const {key,recordBytes,...summary}=head;
  validateBundleCarrierSummary(summary,namespace);if(!sameCarrierFields(head,bundleCarrierHead(summary)))fail();return head;
}
export function summarizeBundleCarrierStorage(heads,namespace){
  bundleCarrierKey(namespace,'0'.repeat(64));
  if(!Array.isArray(heads)||heads.length>BUNDLE_CARRIER_LIMITS.count||new Set(heads.map(row=>row?.key)).size!==heads.length)fail();
  let recordBytes=0,indexBytes=0;for(const head of heads){validateBundleCarrierHead(head,namespace);recordBytes+=head.recordBytes;indexBytes+=bytes(head);}
  return validateBundleCarrierStorage({version:1,namespace,count:heads.length,recordBytes,indexBytes,bytes:recordBytes+indexBytes},namespace);
}
export function validateBundleCarrierStorage(value,namespace){
  bundleCarrierKey(namespace,'0'.repeat(64));
  if(!exact(value,['version','namespace','count','recordBytes','indexBytes','bytes'])||value.version!==1||value.namespace!==namespace
    ||!['count','recordBytes','indexBytes','bytes'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||value.count>BUNDLE_CARRIER_LIMITS.count||value.bytes>BUNDLE_CARRIER_LIMITS.total||value.bytes!==value.recordBytes+value.indexBytes
    ||(!value.count?value.bytes!==0:!value.recordBytes||!value.indexBytes))fail();return value;
}
export function bundleCarrierOriginalHead(namespace,sha256,size){
  const key=bundleCarrierKey(namespace,sha256);
  if(!Number.isSafeInteger(size)||size<1||size>BUNDLE_CARRIER_ORIGINAL_LIMITS.record)fail();
  // Blob bytes plus serialized wrapper metadata; this is logical usage, not browser physical disk allocation.
  const recordBytes=size+bytes({key,namespace,file:null})-4;
  return {version:1,key,namespace,sha256,bytes:size,recordBytes};
}
export function validateBundleCarrierOriginalHead(head,namespace){
  if(!head||head.namespace!==namespace||!sameCarrierFields(head,bundleCarrierOriginalHead(namespace,head.sha256,head.bytes)))fail();return head;
}
export function summarizeBundleCarrierOriginals(heads,namespace){
  bundleCarrierKey(namespace,'0'.repeat(64));
  if(!Array.isArray(heads)||heads.length>BUNDLE_CARRIER_ORIGINAL_LIMITS.count||new Set(heads.map(row=>row?.key)).size!==heads.length)fail();
  let recordBytes=0,indexBytes=0,payloadBytes=0;
  for(const head of heads){validateBundleCarrierOriginalHead(head,namespace);recordBytes+=head.recordBytes;indexBytes+=bytes(head);payloadBytes+=head.bytes;}
  if(recordBytes+indexBytes>BUNDLE_CARRIER_ORIGINAL_LIMITS.total)fail();
  return {version:1,namespace,count:heads.length,payloadBytes,recordBytes,indexBytes,bytes:recordBytes+indexBytes};
}
