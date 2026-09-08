export const BUNDLE_CARRIER_SCHEMA='qianmu.storyboard.bundle-carrier.v1';
export const BUNDLE_CARRIER_SCOPE='manifest-and-mapping-membership';
export const BUNDLE_CARRIER_LIMITS=Object.freeze({proof:5*1048576,manifest:1048576,index:1048576,count:256,total:32*1048576});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const fail=()=>{throw Object.assign(new Error('备份来源关联凭据不完整或超限，请保留原包'),{code:'storyboard_bundle_carrier'});};
export function validateBundleCarrierProofShape(value,namespace){
  if(!exact(value,['schema','scope','namespace','carrierDigest','manifestText','mappingIndexText','digest'])||value.schema!==BUNDLE_CARRIER_SCHEMA||value.scope!==BUNDLE_CARRIER_SCOPE||!account(namespace)||value.namespace!==namespace||!hash(value.carrierDigest)||!hash(value.digest)
    ||typeof value.manifestText!=='string'||!value.manifestText||value.manifestText.length>BUNDLE_CARRIER_LIMITS.manifest
    ||value.mappingIndexText!==null&&(typeof value.mappingIndexText!=='string'||!value.mappingIndexText||value.mappingIndexText.length>BUNDLE_CARRIER_LIMITS.index))fail();return value;
}
export function validateBundleCarrierSummary(value,namespace){
  if(!exact(value,['version','namespace','carrierDigest','digest','chatHash','createdAt','fileBytes','manifestBytes','indexBytes','receiptCount','indexState','bytes','identityVerified','restoreAuthorized'])||value.version!==1||!account(namespace)||value.namespace!==namespace||![value.carrierDigest,value.digest,value.chatHash].every(hash)
    ||!['createdAt','fileBytes','manifestBytes','indexBytes','receiptCount','bytes'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||!value.fileBytes||value.fileBytes>512*1048576||!value.manifestBytes||value.manifestBytes>BUNDLE_CARRIER_LIMITS.manifest||value.indexBytes>BUNDLE_CARRIER_LIMITS.index||value.receiptCount>512||!value.bytes||value.bytes>BUNDLE_CARRIER_LIMITS.proof
    ||!['absent','empty','recorded'].includes(value.indexState)||value.indexState==='absent'&&(value.indexBytes!==0||value.receiptCount!==0)||value.indexState==='empty'&&(!value.indexBytes||value.receiptCount!==0)||value.indexState==='recorded'&&(!value.indexBytes||value.receiptCount===0)
    ||value.identityVerified!==false||value.restoreAuthorized!==false)fail();return value;
}
