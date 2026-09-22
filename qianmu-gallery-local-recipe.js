import {captureGalleryArchiveJson,GALLERY_PAGE_INDEX_LIMITS} from './qianmu-gallery-page-index.js';
import {encodeGalleryArchiveRecord,galleryArchiveScope,galleryArchiveRecipeState} from './qianmu-gallery-archive-record.js';
import {recipeArchiveSnapshot} from './qianmu-recipe-archive-contract.js';
import {assertPortableStoryboardData} from './qianmu-storyboard-package-security.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {galleryLegacyRecipeReference,galleryReviewedRecipeSlot,inspectGalleryReviewedRecipe} from './qianmu-gallery-reviewed-recipe.js';

const schema='qianmu.gallery.local-recipe.v1',limit=GALLERY_PAGE_INDEX_LIMITS.recordBytes;
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_local_recipe'});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));

// Old base keys contain no account or complete-content proof. Only a revision
// digest already selected by the saved ST record can bind the unscoped bytes.
export function galleryLocalRecipeReference(scope,record){
  const owner=galleryArchiveScope(scope);if(galleryArchiveRecipeState(record)!=='local-reference')return null;
  if(record.chatKey!=null&&record.chatKey!==owner.chatKey)return null;
  const prefix=`${owner.chatKey}\u241f${record.id}\u241frevision:`,ref=record.snapshotRef;
  return typeof ref==='string'&&ref.startsWith(prefix)&&/^[a-f0-9]{64}$/.test(ref.slice(prefix.length))?ref:null;
}
export async function galleryLocalRecipeSlot(scope,record){
  const owner=galleryArchiveScope(scope),ref=galleryLocalRecipeReference(owner,record);if(!ref)fail('旧本机配方缺少完整内容引用，未自动关联');
  return 'gallery-local-recipe-'+await vibeDigest(JSON.stringify([owner,record.id,record.createdAt,ref]));
}
export async function verifyGalleryLocalRecipe(scope,record,snapshot){
  const owner=galleryArchiveScope(scope),ref=galleryLocalRecipeReference(owner,record);
  if(!ref)fail('旧本机配方没有可核对的内容引用');
  const copy=captureGalleryArchiveJson(snapshot,1024*1024);recipeArchiveSnapshot(copy);await assertPortableStoryboardData(copy);
  // Preserve insertion order: the historical immutable writer hashed this
  // precise JSON tuple, not the canonical ordering of the archive envelope.
  if(await vibeDigest(JSON.stringify([owner.chatKey,record.id,copy]))!==ref.slice(-64))fail('旧本机配方与原记录完整摘要不符，未拼接或改写');
  return copy;
}
export async function encodeGalleryLocalRecipe(scope,record,row){
  const owner=galleryArchiveScope(scope),raw=captureGalleryArchiveJson(record,1024*1024),local=captureGalleryArchiveJson(row,limit);
  const ref=galleryLocalRecipeReference(owner,raw);
  if(!ref||local?.key!==ref||local.chatKey!==owner.chatKey||local.recordId!==raw.id)fail('旧本机配方的引用、聊天或画面编号不符');
  const snapshot=await verifyGalleryLocalRecipe(owner,raw,local.snapshot),original=await encodeGalleryArchiveRecord(owner,raw);
  const value={schema,scope:owner,identity:{id:raw.id,createdAt:raw.createdAt},reference:ref,content:JSON.stringify(snapshot)};
  const text=JSON.stringify(captureGalleryArchiveJson(value,limit));return {value:JSON.parse(text),text,record:original};
}
export async function inspectGalleryLocalRecipe(scope,record,raw){
  const owner=galleryArchiveScope(scope),saved=captureGalleryArchiveJson(raw,limit),input=captureGalleryArchiveJson(record,1024*1024);
  if(!exact(saved,['schema','scope','identity','reference','content'])||saved.schema!==schema||!same(galleryArchiveScope(saved.scope),owner)
    ||!same(saved.identity,{id:input.id,createdAt:input.createdAt})||saved.reference!==galleryLocalRecipeReference(owner,input)||typeof saved.content!=='string')fail('旧配方副本不属于此账户、聊天或画面');
  let snapshot;try{snapshot=JSON.parse(saved.content);}catch{fail('旧配方副本不完整');}
  const checked=await verifyGalleryLocalRecipe(owner,input,snapshot);
  return {snapshot:checked,origin:'verified-local-copy',proof:'recipe-readback-only',originalVerified:false,canPrune:false};
}
export async function readGalleryLocalRecipeCopy(storage,scope,record,{guard=()=>true,signal}={}){
  const check=()=>{if(signal?.aborted||guard()!==true)fail('旧配方读取已取消或来源变化');};check();
  const reviewed=Boolean(galleryLegacyRecipeReference(scope,record));
  if(!reviewed&&!galleryLocalRecipeReference(scope,record))return {state:'local-reference',snapshot:null,originalVerified:false,canPrune:false};
  const slot=await (reviewed?galleryReviewedRecipeSlot:galleryLocalRecipeSlot)(scope,record);check();const stored=await storage.read(slot,{guard,signal});check();
  if(stored?.persistence!=='st-account-file'||stored.concurrency!=='optimistic-non-cas'||typeof stored.exists!=='boolean'
    ||(stored.exists?!/^[a-f0-9]{64}$/.test(stored.fingerprint||''):stored.fingerprint!==null||stored.value!==null))fail('旧配方读取没有完整账户回执');
  if(!stored.exists)return {state:'local-reference',snapshot:null,originalVerified:false,canPrune:false};
  const result=await (reviewed?inspectGalleryReviewedRecipe:inspectGalleryLocalRecipe)(scope,record,stored.value);check();return {state:'available',...result};
}

export const isGalleryLocalRecipeCopy=recipe=>recipe?.state==='available'&&['verified-local-copy','reviewed-local-copy'].includes(recipe.origin);
export async function verifyGalleryLocalRecipeCopy(scope,record,recipe){
  if(recipe?.origin==='verified-local-copy')return verifyGalleryLocalRecipe(scope,record,recipe.snapshot);
  if(recipe?.origin!=='reviewed-local-copy')fail('旧配方缺少明确核对依据');
  const checked=await inspectGalleryReviewedRecipe(scope,record,recipe.review);
  if(JSON.stringify(checked.snapshot)!==JSON.stringify(recipe.snapshot))fail('旧配方与已核对副本不符');return checked.snapshot;
}

// One exact key, never an IDB scan or ownership inference from nearby entries.
export async function readLegacyGalleryRecipe(key,{timeoutMs=5000}={}){
  let timer;try{return await Promise.race([(async()=>{
    const store=await import('./qianmu-blobstore.js');if(!store.blobStoreAvailable())return null;
    const rows=await store.getStoryboardSnapshots([key]);return rows.find(row=>row?.key===key)??null;
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('旧本机配方读取超时')),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}
