import {captureGalleryArchiveJson,GALLERY_PAGE_INDEX_LIMITS} from './qianmu-gallery-page-index.js';
import {encodeGalleryArchiveRecord,galleryArchiveScope} from './qianmu-gallery-archive-record.js';
import {recipeArchiveResponse,recipeArchiveSnapshot,recipeArchiveReference} from './qianmu-recipe-archive-contract.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const schema='qianmu.gallery.recipe-copy.v1';
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_recipe'});};
const canonical=value=>chatGalleryReceiptText([value]).text.slice(1,-1);
const same=(a,b)=>canonical(a)===canonical(b);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

// This sidecar leaves the exact original record untouched. It binds complete
// recipe bytes to one content-addressed record, not merely its reusable id.
export async function encodeGalleryArchiveRecipe(scope,record,response){
  const raw=captureGalleryArchiveJson(response,GALLERY_PAGE_INDEX_LIMITS.recordBytes);
  const owner=galleryArchiveScope(scope),original=await encodeGalleryArchiveRecord(owner,record),captured=original.value.record;
  if(original.recipeState!=='server-reference')fail('只有准确的服务器配方引用可另存配方副本');
  const source=recipeArchiveResponse(raw),target=owner.ownerKey.startsWith('char:')
    ?{kind:'character',avatar:owner.ownerKey.slice(5),chatId:owner.chatKey}:{kind:'group',chatId:owner.chatKey};
  if(source.proof!=='read-only-recipe'||source.origin!=='server-archive'
    ||source.expectedAccount!==`st-user:${await vibeDigest(owner.namespace.slice(8))}`||!same(source.target,target)
    ||source.selection.recordId!==captured.id||source.selection.createdAt!==captured.createdAt
    ||!same(source.reference,recipeArchiveReference(captured.snapshotServerRef)))fail('配方读取回执与原画面或账户不符');
  const value={schema,scope:owner,record:original.reference,serverReference:source.reference,snapshot:source.snapshot};
  const text=canonical(value);
  if(new TextEncoder().encode(text).length>GALLERY_PAGE_INDEX_LIMITS.recordBytes)fail('图库配方副本超过大小上限，未截断');
  return {value:JSON.parse(text),text,record:original};
}

export function inspectGalleryArchiveRecipe(scope,original,raw){
  const value=captureGalleryArchiveJson(raw,GALLERY_PAGE_INDEX_LIMITS.recordBytes),owner=galleryArchiveScope(scope);
  if(!exact(value,['schema','scope','record','serverReference','snapshot'])||value.schema!==schema
    ||!same(galleryArchiveScope(value.scope),owner)||!same(value.record,original.reference)
    ||original.recipeState!=='server-reference'
    ||!same(recipeArchiveReference(value.serverReference),recipeArchiveReference(original.value.record.snapshotServerRef)))fail('图库配方副本不属于此画面版本');
  const {snapshot}=recipeArchiveSnapshot(value.snapshot);
  return {snapshot,origin:'server-copy',proof:'recipe-readback-only',originalVerified:false,canPrune:false};
}
