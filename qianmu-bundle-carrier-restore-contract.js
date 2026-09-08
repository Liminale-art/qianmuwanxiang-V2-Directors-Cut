import {validateBundleCarrierHead} from './qianmu-bundle-carrier-storage-contract.js';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=()=>{throw Object.assign(new Error('来源恢复核对结果不完整，请重新核对原包'),{code:'storyboard_bundle_carrier_restore'});};
export function validateBundleCarrierRestoreSummary(value,namespace,sourceDigest){
  if(!exact(value,['version','namespace','sourceDigest','descriptorDigest','count','added','existing','originalCount','addedOriginals','existingOriginals','addedBytes','totalBytes','digest','restoreAuthorized'])||value.version!==1||value.namespace!==namespace||value.sourceDigest!==sourceDigest||![value.sourceDigest,value.descriptorDigest,value.digest].every(hash)||value.restoreAuthorized!==false
    ||!['count','added','existing','originalCount','addedOriginals','existingOriginals','addedBytes','totalBytes'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||value.count<1||value.count>256||value.added+value.existing!==value.count||value.originalCount>1024||value.addedOriginals+value.existingOriginals!==value.originalCount
    ||value.totalBytes>102*1048576||value.addedBytes>value.totalBytes||Boolean(value.added+value.addedOriginals)!==Boolean(value.addedBytes))fail();return value;
}
export function validateBundleCarrierPageInput(input){if(!exact(input,['offset'])||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>240||input.offset%24)fail();return input;}
export function validateBundleCarrierPage(value,namespace,sourceDigest,input){
  validateBundleCarrierPageInput(input);
  if(!exact(value,['version','namespace','sourceDigest','descriptorDigest','offset','total','rows'])||value.version!==1||value.namespace!==namespace||value.sourceDigest!==sourceDigest||!hash(value.descriptorDigest)||!hash(sourceDigest)||value.offset!==input.offset
    ||!Number.isSafeInteger(value.total)||value.total<1||value.total>256||value.offset&&value.offset>=value.total||!Array.isArray(value.rows)||value.rows.length!==Math.min(24,Math.max(0,value.total-value.offset)))fail();
  const ids=new Set();for(const [index,row] of value.rows.entries()){const {current,...head}=row;validateBundleCarrierHead(head,namespace);if(typeof current!=='boolean'||current!==(head.carrierDigest===sourceDigest)||current!==(value.offset===0&&index===0)||ids.has(head.key))fail();ids.add(head.key);}return value;
}
