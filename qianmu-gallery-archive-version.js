// Shared, path-free source-version contract for native storage and discovery.
import {galleryArchiveScope,galleryArchiveObjectReference} from './qianmu-gallery-archive-record.js';
import {captureGalleryArchiveJson,GALLERY_PAGE_INDEX_LIMITS} from './qianmu-gallery-page-index.js';
import {CHAT_GALLERY_RECEIPT_LIMITS} from './qianmu-chat-gallery-receipt.js';
import {vibeDigest} from './qianmu-vibe-file.js';
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_version'});};
export function galleryArchiveSourceReceipt(raw){
  const value=captureGalleryArchiveJson(raw,4096),keys=Object.keys(value||{});
  if(!value||Array.isArray(value)||keys.length!==4||!['count','bytes','sha256','proof'].every(key=>keys.includes(key))
    ||value.proof!=='read-only-snapshot'||!Number.isSafeInteger(value.count)||value.count<0||value.count>CHAT_GALLERY_RECEIPT_LIMITS.records
    ||!Number.isSafeInteger(value.bytes)||value.bytes<2||value.bytes>CHAT_GALLERY_RECEIPT_LIMITS.bytes||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))fail('图库版本缺少准确已保存来源摘要');
  return {count:value.count,bytes:value.bytes,sha256:value.sha256,proof:value.proof};
}
export async function galleryArchiveSourceSlot(scope,receipt){
  return `gallery-source-${await vibeDigest(JSON.stringify({scope:galleryArchiveScope(scope),receipt:galleryArchiveSourceReceipt(receipt)}))}`;
}
export function galleryArchiveSourceVersion(raw,scope,receipt){
  const copy=captureGalleryArchiveJson(raw,8192),owner=galleryArchiveScope(scope),expected=galleryArchiveSourceReceipt(receipt);
  if(!copy||Array.isArray(copy)||Object.keys(copy).length!==4||copy.schema!=='qianmu.gallery.source-version.v1'
    ||JSON.stringify(galleryArchiveScope(copy.scope))!==JSON.stringify(owner)||JSON.stringify(galleryArchiveSourceReceipt(copy.sourceReceipt))!==JSON.stringify(expected))fail('图库版本来源不符，未改写已有目录');
  return {schema:copy.schema,scope:owner,sourceReceipt:expected,manifest:galleryArchiveObjectReference(copy.manifest,GALLERY_PAGE_INDEX_LIMITS.manifestBytes)};
}
