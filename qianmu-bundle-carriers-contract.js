import {summarizeBundleCarrierStorage,summarizeBundleCarrierOriginals,validateBundleCarrierOriginalHead} from './qianmu-bundle-carrier-storage-contract.js';
import {isBundleMappingEntry} from './qianmu-bundle-mapping-contract.js';
export const BUNDLE_CARRIERS_SCHEMA='qianmu.storyboard.bundle-carriers.v1';
export const bundleCarrierEntryId=head=>`carrier:${head.carrierDigest}`;
export const isBundleCarrierEntry=id=>typeof id==='string'&&/^carrier:[a-f0-9]{64}$/.test(id);
export const isBundleCarrierOriginalEntry=id=>typeof id==='string'&&/^carrier-original:[a-f0-9]{64}$/.test(id);
const fail=()=>{throw Object.assign(new Error('来源关联联包清单不完整、重复或超限，请保留原包'),{code:'storyboard_bundle_carriers'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validateBundleCarriersIndex(value,namespace){
  if(!exact(value,['schema','scope','namespace','heads','originals','digest'])||value.schema!==BUNDLE_CARRIERS_SCHEMA||value.scope!=='historical-carriers-only'||value.namespace!==namespace||!hash(value.digest))fail();
  summarizeBundleCarrierStorage(value.heads,namespace);
  const ids=value.heads.map(bundleCarrierEntryId);if(ids.some((id,index)=>index>0&&id<=ids[index-1]))fail();
  if(!Array.isArray(value.originals))fail();
  const raw=value.originals.map(row=>{const {entryId,...head}=row;validateBundleCarrierOriginalHead(head,namespace);
    if(!isBundleMappingEntry(entryId)&&entryId!==`carrier-original:${head.sha256}`)fail();return head;});
  summarizeBundleCarrierOriginals(raw,namespace);
  if(raw.some((row,index)=>index>0&&row.sha256<=raw[index-1].sha256))fail();return value;
}
export function bundleCarriersSummary(index){
  validateBundleCarriersIndex(index,index.namespace);const extra=index.originals.filter(row=>isBundleCarrierOriginalEntry(row.entryId));
  return {version:1,recorded:true,count:index.heads.length,originalCount:index.originals.length,extraOriginalCount:extra.length,
    proofBytes:index.heads.reduce((sum,row)=>sum+row.bytes,0),originalBytes:index.originals.reduce((sum,row)=>sum+row.bytes,0),extraOriginalBytes:extra.reduce((sum,row)=>sum+row.bytes,0),digest:index.digest,restoreAuthorized:false};
}
export function validateBundleCarriersTransportSummary(value,manifest){
  const entries=manifest?.entries||[],indexes=entries.filter(row=>row.id==='bundle-carriers'),proofs=entries.filter(row=>isBundleCarrierEntry(row.id)),originals=entries.filter(row=>isBundleCarrierOriginalEntry(row.id));
  if(value===undefined){if(indexes.length||proofs.length||originals.length)fail();return;}
  if(!exact(value,['version','recorded','count','originalCount','extraOriginalCount','proofBytes','originalBytes','extraOriginalBytes','digest','restoreAuthorized'])||value.version!==1||value.recorded!==true||value.restoreAuthorized!==false||!hash(value.digest)
    ||!['count','originalCount','extraOriginalCount','proofBytes','originalBytes','extraOriginalBytes'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||value.count>256||value.originalCount>1024||value.proofBytes>32*1048576||value.originalBytes>70*1048576
    ||value.extraOriginalCount>value.originalCount||value.extraOriginalBytes>value.originalBytes||Boolean(value.count)!==Boolean(value.proofBytes)||Boolean(value.originalCount)!==Boolean(value.originalBytes)||Boolean(value.extraOriginalCount)!==Boolean(value.extraOriginalBytes)
    ||indexes.length!==1||proofs.length!==value.count||originals.length!==value.extraOriginalCount||proofs.reduce((sum,row)=>sum+row.bytes,0)!==value.proofBytes||originals.reduce((sum,row)=>sum+row.bytes,0)!==value.extraOriginalBytes)fail();return value;
}
