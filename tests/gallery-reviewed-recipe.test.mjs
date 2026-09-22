import test from 'node:test';
import assert from 'node:assert/strict';
import {captureGalleryRecipeReview,encodeGalleryReviewedRecipe,inspectGalleryReviewedRecipe,galleryReviewedRecipeSlot,galleryLegacyRecipeReference} from '../qianmu-gallery-reviewed-recipe.js';
import {verifyGalleryLocalRecipeCopy} from '../qianmu-gallery-local-recipe.js';
const scope={namespace:'st-user:fixture',ownerKey:'char:Alice.png',chatKey:'chat'};
const fixture=()=>({record:{id:'one',createdAt:1,chatKey:'chat',snapshotRef:'chat\u241fone'},row:{key:'chat\u241fone',chatKey:'chat',recordId:'one',snapshot:{source:'novel',prompt:' 原词\r\n',negative:'',profile:{z:0,a:1},payload:{},future:{keep:[null,false,0]}}}});
test('review association preserves full raw recipe and honestly labels user confirmation, not original ownership proof',async()=>{
  const f=fixture(),before=JSON.stringify(f),review=await captureGalleryRecipeReview(scope,f.record,f.row);
  const encoded=await encodeGalleryReviewedRecipe(scope,f.record,review,{confirmed:true,expectedDigest:review.digest});
  const checked=await inspectGalleryReviewedRecipe(scope,f.record,encoded.value);
  assert.deepEqual(checked.snapshot,f.row.snapshot);assert.equal(checked.origin,'reviewed-local-copy');assert.equal(checked.proof,'user-reviewed-copy-only');
  assert.equal(checked.originalVerified,false);assert.equal(checked.canPrune,false);assert.equal(JSON.stringify(f),before);
  assert.deepEqual(await verifyGalleryLocalRecipeCopy(scope,f.record,{state:'available',...checked}),f.row.snapshot);
  checked.snapshot.prompt='forged';await assert.rejects(verifyGalleryLocalRecipeCopy(scope,f.record,checked));
});
for(const kind of ['confirmation','digest','changed-payload','changed-envelope','foreign-scope','secret','wrong-key','wrong-id','revision','inline'])test(`review rejects ${kind} without weakening strong-reference rules`,async()=>{
  const f=fixture();let target=scope;
  if(kind==='secret')f.row.snapshot.apiKey='fixture-only';if(kind==='wrong-key')f.row.key='other';if(kind==='wrong-id')f.row.recordId='other';
  if(kind==='revision')f.record.snapshotRef+='\u241frevision:'+'a'.repeat(64);if(kind==='inline')f.record.snapshot=f.row.snapshot;
  if(['secret','wrong-key','wrong-id','revision','inline'].includes(kind)){await assert.rejects(captureGalleryRecipeReview(scope,f.record,f.row));return;}
  const review=await captureGalleryRecipeReview(scope,f.record,f.row),consent={confirmed:true,expectedDigest:review.digest};
  if(kind==='confirmation')consent.confirmed=false;if(kind==='digest')consent.expectedDigest='a'.repeat(64);
  if(kind==='changed-payload')review.snapshot.prompt='changed';if(kind==='changed-envelope')review.value.content='{}';if(kind==='foreign-scope')target={...scope,namespace:'st-user:other'};
  await assert.rejects(encodeGalleryReviewedRecipe(target,f.record,review,consent));
});
test('reviewed copy is bound to account, owner, chat, record identity and content but tolerates tag edits',async()=>{
  const f=fixture(),review=await captureGalleryRecipeReview(scope,f.record,f.row),encoded=await encodeGalleryReviewedRecipe(scope,f.record,review,{confirmed:true,expectedDigest:review.digest});
  for(const mutate of [v=>v.scope.namespace='st-user:other',v=>v.scope.ownerKey='char:Other.png',v=>v.scope.chatKey='other',v=>v.identity.id='other',v=>v.identity.createdAt++,v=>v.content='{}',v=>v.review.kind='automatic',v=>v.review.digest='a'.repeat(64),v=>v.extra=1]){
    const copy=structuredClone(encoded.value);mutate(copy);await assert.rejects(inspectGalleryReviewedRecipe(scope,f.record,copy));
  }
  const edited={...f.record,tags:['tag'],collectionIds:['album']};assert.equal(await galleryReviewedRecipeSlot(scope,edited),await galleryReviewedRecipeSlot(scope,f.record));
  assert.deepEqual((await inspectGalleryReviewedRecipe(scope,edited,encoded.value)).snapshot,f.row.snapshot);
  assert.equal(galleryLegacyRecipeReference(scope,{...f.record,snapshotServerRef:{}}),null);
});
