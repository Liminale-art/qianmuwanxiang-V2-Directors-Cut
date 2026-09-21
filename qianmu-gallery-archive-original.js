import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {encodeGalleryArchiveRecord,galleryArchiveScope} from './qianmu-gallery-archive-record.js';
import {galleryOriginalPreserved,GALLERY_ORIGINAL_JSON_BYTES} from './qianmu-gallery-original-contract.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const schema='qianmu.gallery.original-copy.v1';
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_original'});};
const canonical=value=>chatGalleryReceiptText([value]).text.slice(1,-1),same=(a,b)=>canonical(a)===canonical(b);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
async function match(owner,original,raw){
    const source=galleryOriginalPreserved(raw),record=original.value.record;
    const target=owner.ownerKey.startsWith('char:')?{kind:'character',avatar:owner.ownerKey.slice(5),chatId:owner.chatKey}:{kind:'group',chatId:owner.chatKey};
    if(source.expectedAccount!==`st-user:${await vibeDigest(owner.namespace.slice(8))}`||!same(source.target,target)
        ||source.selection.recordId!==record.id||source.selection.createdAt!==record.createdAt||source.original.url!==record.url)
        fail('原图副本凭据与画面版本、账户或来源不符');return source;
}
// The old record stays byte-for-byte unchanged. The separately saved reference
// is bound to its full content hash, never just a reusable record id or URL.
export async function encodeGalleryArchiveOriginal(scope,record,response){
    const owner=galleryArchiveScope(scope),original=await encodeGalleryArchiveRecord(owner,record);
    const source=await match(owner,original,captureGalleryArchiveJson(response,GALLERY_ORIGINAL_JSON_BYTES));
    const value={schema,scope:owner,record:original.reference,source},text=canonical(value);
    if(new TextEncoder().encode(text).length>GALLERY_ORIGINAL_JSON_BYTES)fail('原图副本凭据超过保存范围');
    return {value:JSON.parse(text),text,record:original};
}
export async function inspectGalleryArchiveOriginal(scope,original,raw){
    const owner=galleryArchiveScope(scope),value=captureGalleryArchiveJson(raw,GALLERY_ORIGINAL_JSON_BYTES);
    if(!exact(value,['schema','scope','record','source'])||value.schema!==schema||!same(galleryArchiveScope(value.scope),owner)||!same(value.record,original.reference))
        fail('原图副本记录不属于此画面版本');
    const source=await match(owner,original,value.source);
    // A valid reference is not a current proof of the image bytes on disk.
    return {reference:source.reference,original:source.original,origin:'server-copy',proof:'original-reference-only',originalVerified:false,canPrune:false};
}
