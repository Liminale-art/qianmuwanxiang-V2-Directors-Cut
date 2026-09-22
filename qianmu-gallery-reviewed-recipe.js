import {captureGalleryArchiveJson as capture} from './qianmu-gallery-page-index.js';
import {galleryArchiveScope,galleryArchiveRecipeState} from './qianmu-gallery-archive-record.js';
import {recipeArchiveSnapshot} from './qianmu-recipe-archive-contract.js';
import {assertPortableStoryboardData} from './qianmu-storyboard-package-security.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const schema='qianmu.gallery.reviewed-recipe.v1',limit=2*1024*1024;
const fail=()=>{throw Error('旧配方核对内容或来源不符，未替换原资料');};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function galleryLegacyRecipeReference(scope,record){
  const owner=galleryArchiveScope(scope),key=`${owner.chatKey}\u241f${record?.id}`;
  return galleryArchiveRecipeState(record)==='local-reference'&&(record.chatKey==null||record.chatKey===owner.chatKey)&&record.snapshotRef===key?key:null;
}
export async function galleryReviewedRecipeSlot(scope,record){
  const owner=galleryArchiveScope(scope),key=galleryLegacyRecipeReference(owner,record);if(!key)fail();
  return 'gallery-reviewed-recipe-'+await vibeDigest(JSON.stringify([owner,record.id,record.createdAt,key]));
}
async function payload(scope,record,snapshot){
  const owner=galleryArchiveScope(scope),ref=galleryLegacyRecipeReference(owner,record);if(!ref)fail();
  const copy=capture(snapshot,1024*1024);recipeArchiveSnapshot(copy);await assertPortableStoryboardData(copy);
  return {schema,scope:owner,identity:{id:record.id,createdAt:record.createdAt},reference:ref,content:JSON.stringify(copy)};
}
export async function captureGalleryRecipeReview(scope,record,row){
  const raw=capture(record,1024*1024),local=capture(row,limit),key=galleryLegacyRecipeReference(scope,raw);
  if(!key||local.key!==key||local.chatKey!==scope.chatKey||local.recordId!==raw.id)fail();
  const value=await payload(scope,raw,local.snapshot),digest=await vibeDigest(JSON.stringify(value));
  return {value,digest,snapshot:JSON.parse(value.content)};
}
export async function encodeGalleryReviewedRecipe(scope,record,review,{confirmed=false,expectedDigest}={}){
  const saved=capture(review,limit),raw=capture(record,1024*1024);
  if(confirmed!==true||expectedDigest!==saved.digest||!exact(saved,['value','digest','snapshot']))fail();
  const value=await payload(scope,raw,saved.snapshot),digest=await vibeDigest(JSON.stringify(value));
  if(digest!==saved.digest||JSON.stringify(value)!==JSON.stringify(saved.value))fail();
  // This is an explicit user's association, not retroactive proof of the old
  // cache's owner or of the recipe originally used by a model.
  const result={...value,review:{kind:'explicit-user-association',digest}};
  return {value:result,text:JSON.stringify(result)};
}
export async function inspectGalleryReviewedRecipe(scope,record,raw){
  const saved=capture(raw,limit),input=capture(record,1024*1024);
  if(!exact(saved,['schema','scope','identity','reference','content','review'])||saved.schema!==schema||!exact(saved.review,['kind','digest'])||saved.review.kind!=='explicit-user-association'||typeof saved.content!=='string')fail();
  let snapshot;try{snapshot=JSON.parse(saved.content);}catch{fail();}
  const value=await payload(scope,input,snapshot),digest=await vibeDigest(JSON.stringify(value));
  for(const key of ['scope','identity','reference','content'])if(JSON.stringify(saved[key])!==JSON.stringify(value[key]))fail();
  if(saved.review.digest!==digest)fail();
  return {snapshot:JSON.parse(value.content),origin:'reviewed-local-copy',review:structuredClone(saved),proof:'user-reviewed-copy-only',originalVerified:false,canPrune:false};
}
