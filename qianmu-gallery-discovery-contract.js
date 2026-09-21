import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {galleryArchiveSourceSlot,galleryArchiveSourceVersion} from './qianmu-gallery-archive-version.js';

export const GALLERY_DISCOVERY_LIMITS=Object.freeze({page:32,scan:500000,pending:2,responseBytes:512*1024,timeoutMs:10000});
export const galleryDiscoveryError=(code,message,status=409)=>Object.assign(Error(message),{code:`gallery_discovery_${code}`,status});
const fail=message=>{throw galleryDiscoveryError('contract',message,400);};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function galleryDiscoveryRequest(raw){
  const value=captureGalleryArchiveJson(raw,4096);
  if(!exact(value,['version','expectedAccount','limit','cursor'])||![1,2].includes(value.version)||typeof value.expectedAccount!=='string'||!/^st-user:[a-f0-9]{64}$/.test(value.expectedAccount)
    ||!Number.isSafeInteger(value.limit)||value.limit<1||value.limit>GALLERY_DISCOVERY_LIMITS.page)fail('图库发现只接受账户核对和受限分页');
  const cursor=value.cursor;
  if(cursor!==null&&(!exact(cursor,['version','account','stamp','after'])||cursor.version!==value.version||cursor.account!==value.expectedAccount||!hash(cursor.stamp)||!hash(cursor.after)))fail('图库发现续页已失效');
  return value;
}
export async function galleryDiscoveryResponse(raw,{namespace,request}={}){
  const value=captureGalleryArchiveJson(raw,GALLERY_DISCOVERY_LIMITS.responseBytes),expected=galleryDiscoveryRequest(request);
  if(!exact(value,['ok','version','expectedAccount','entries','nextCursor','proof'])||value.ok!==true||value.version!==expected.version||value.expectedAccount!==expected.expectedAccount
    ||value.proof!=='read-only-directory'||!Array.isArray(value.entries)||value.entries.length>expected.limit)fail('图库发现返回不完整');
  let previous=expected.cursor?.after||'';
  for(const entry of value.entries){
    if(!exact(entry,['key','value'])||!hash(entry.key)||entry.key<=previous)fail('图库发现顺序或编号重复');
    const source=entry.value,checked=galleryArchiveSourceVersion(source,source?.scope,source?.sourceReceipt);
    if(checked.scope.namespace!==namespace||expected.version===1&&checked.supplement
      ||await galleryArchiveSourceSlot(checked.scope,checked.sourceReceipt,checked.supplement)!==`gallery-source${checked.supplement?'2':''}-${entry.key}`)fail('图库发现包含其他账户或错误来源');
    entry.value=checked;previous=entry.key;
  }
  if(value.nextCursor!==null){
    galleryDiscoveryRequest({...expected,cursor:value.nextCursor});
    if(!value.entries.length||value.nextCursor.after!==previous||expected.cursor&&value.nextCursor.stamp!==expected.cursor.stamp)fail('图库发现续页与本页不一致');
  }
  return value;
}
export function galleryDiscoveryErrorPayload(error){
  const known=/^gallery_discovery_[a-z_]+$/.test(error?.code||'');
  return {status:known&&Number.isInteger(error.status)&&error.status>=400&&error.status<600?error.status:503,
    body:{ok:false,code:known?error.code:'gallery_discovery_unavailable',message:known?error.message:'图库目录暂不可读取，原文件未修改'}};
}
