// Lossless single-record envelopes, independent of the live gallery and media.
// Preserving a URL/reference does not mean its image or recipe bytes were saved.
import {captureGalleryArchiveJson,GALLERY_PAGE_INDEX_LIMITS} from './qianmu-gallery-page-index.js';
import {galleryCatalogAccount,galleryCatalogSource} from './qianmu-gallery-catalog-contract.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {recipeArchiveSnapshot,recipeArchiveReference} from './qianmu-recipe-archive-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const GALLERY_ARCHIVE_RECORD_SCHEMA='qianmu.gallery.record.v1';
export const GALLERY_ARCHIVE_RECORD_BYTES=1024*1024;
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_record'});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
export function galleryArchiveScope(value){
  const copy=captureGalleryArchiveJson(value,4096);
  if(!exact(copy,['namespace','ownerKey','chatKey']))fail('画面保全来源不完整');
  return {namespace:galleryCatalogAccount(copy.namespace),...galleryCatalogSource({ownerKey:copy.ownerKey,chatKey:copy.chatKey})};
}
export function galleryArchiveObjectReference(value,maxBytes=GALLERY_PAGE_INDEX_LIMITS.recordBytes){
  const copy=captureGalleryArchiveJson(value,4096);
  if(!exact(copy,['sha256','bytes'])||typeof copy.sha256!=='string'||!/^[a-f0-9]{64}$/.test(copy.sha256)
    ||!Number.isSafeInteger(copy.bytes)||copy.bytes<2||copy.bytes>maxBytes)fail('画面保全引用无效，未猜测路径');
  return copy;
}
export function galleryArchiveRecordEnvelope(source,raw){
  const owner=galleryArchiveScope(source),input=captureGalleryArchiveJson(raw,GALLERY_ARCHIVE_RECORD_BYTES);
  if(!object(input)||!text(input.id,240)||!Number.isSafeInteger(input.createdAt)||input.createdAt<0||!text(input.url,8192))fail('画面原记录缺少准确编号、时间或原地址');
  for(const item of [input,input.messageRef,input.snapshot]){
    if(object(item)&&Object.hasOwn(item,'chatKey')&&item.chatKey!==owner.chatKey)fail('画面原记录与保全聊天不一致');
  }
  // Reuse the established credential-field/URL rejection through a validator
  // envelope, NOT a fabricated recipe. Only its unchanged raw record is saved;
  // the validator's synthetic source/prompt/profile are never persisted.
  const checked=recipeArchiveSnapshot({source:'gallery-record-validation',prompt:'',negative:'',profile:{},payload:{record:input}}).snapshot.payload.record;
  const value={schema:GALLERY_ARCHIVE_RECORD_SCHEMA,scope:owner,record:checked};
  const content=chatGalleryReceiptText([value]).text.slice(1,-1);
  if(new TextEncoder().encode(content).length>GALLERY_ARCHIVE_RECORD_BYTES)fail('画面原记录超过保全上限，未裁剪或覆盖');
  return {value:JSON.parse(content),text:content};
}
export function galleryArchiveRecipeState(record){
  if(record.recipeUnavailable===true)return 'unavailable';
  if(record.snapshot!=null){try{recipeArchiveSnapshot(record.snapshot);return 'inline';}catch{return 'unresolved';}}
  if(record.snapshotServerRef!=null){try{recipeArchiveReference(record.snapshotServerRef);return 'server-reference';}catch{return 'unresolved';}}
  if(typeof record.snapshotRef==='string'&&record.snapshotRef)return 'local-reference';
  return 'not-recorded';
}
export async function encodeGalleryArchiveRecord(source,record){
  const encoded=galleryArchiveRecordEnvelope(source,record);
  return {...encoded,reference:{sha256:await vibeDigest(encoded.text),bytes:new TextEncoder().encode(encoded.text).length},recipeState:galleryArchiveRecipeState(encoded.value.record)};
}
export async function inspectGalleryArchiveRecord(source,raw,expected){
  const value=captureGalleryArchiveJson(raw,GALLERY_ARCHIVE_RECORD_BYTES),owner=galleryArchiveScope(source),reference=galleryArchiveObjectReference(expected,GALLERY_ARCHIVE_RECORD_BYTES);
  if(!exact(value,['schema','scope','record'])||value.schema!==GALLERY_ARCHIVE_RECORD_SCHEMA
    ||JSON.stringify(galleryArchiveScope(value.scope))!==JSON.stringify(owner))fail('画面保全返回的账户或聊天不符');
  const encoded=await encodeGalleryArchiveRecord(owner,value.record);
  if(encoded.reference.sha256!==reference.sha256||encoded.reference.bytes!==reference.bytes)fail('画面保全内容校验失败，未采用或覆盖原副本');
  return encoded;
}
