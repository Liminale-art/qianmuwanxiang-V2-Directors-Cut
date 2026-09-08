import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createStoryboardEnvironmentReview, inspectStoryboardEnvironmentReview, validStoryboardEnvironmentReview, validateStoryboardEnvironmentReceipt, storyboardEnvironmentReviewsEqual } from '../qianmu-storyboard-environment-map.js';
import { validateResourceRestoreCheckpoint } from '../qianmu-storyboard-package-journal.js';
const namespace='st-user:test';
const identity=()=>({ok:true,version:1,state:'ready',expectedAccount:'st-user:'+createHash('sha256').update('test').digest('hex'),instanceId:randomUUID(),accountId:randomUUID(),proof:'installation-labels',automaticRebinding:false});
const input=()=>({namespace,sourceDigest:'a'.repeat(64),chatHash:'b'.repeat(64),source:identity(),target:identity()});
test('installation mapping is source/file/chat/target bound and labels are not identity proof',async()=>{
  const value=input(),review=await createStoryboardEnvironmentReview(value);assert.equal(review.state,'mapping-required');assert.equal(review.source.automaticRebinding,false);
  assert.deepEqual(await inspectStoryboardEnvironmentReview(review),review);assert.equal(validStoryboardEnvironmentReview(review),true);
  const reordered=Object.fromEntries(Object.entries(review).reverse());reordered.target=Object.fromEntries(Object.entries(review.target).reverse());
  assert.equal(storyboardEnvironmentReviewsEqual(review,reordered),true);assert.equal((await inspectStoryboardEnvironmentReview(reordered)).digest,review.digest);
  assert.equal((await createStoryboardEnvironmentReview({...value,target:value.source})).state,'matched');
  for(const [key,change] of [['sourceDigest','c'.repeat(64)],['chatHash','d'.repeat(64)],['target',identity()],['source',identity()]]){
    assert.notEqual((await createStoryboardEnvironmentReview({...value,[key]:change})).digest,review.digest);
    await assert.rejects(inspectStoryboardEnvironmentReview({...review,[key]:change}));
  }
  assert.throws(()=>validateStoryboardEnvironmentReceipt({key:review.digest,namespace,review,createdAt:1,secret:'extra'}));
  assert.equal(validateStoryboardEnvironmentReceipt({key:review.digest,namespace,review,createdAt:1}).review,review);
});
test('mappings refuse uninitialized targets, different handles, incomplete fields or embedded credentials',async()=>{
  const value=input();
  for(const target of [{...value.target,state:'uninitialized',accountId:null},{...value.target,expectedAccount:'st-user:'+'e'.repeat(64)},{...value.target,authorization:'private'}])await assert.rejects(createStoryboardEnvironmentReview({...value,target}));
  const review=await createStoryboardEnvironmentReview(value);
  for(const invalid of [{...review,state:'matched'},{...review,credentialId:'private'},{...review,namespace:'st-user:test\n'}])assert.equal(validStoryboardEnvironmentReview(invalid),false);
});
test('optional resource checkpoint mapping is validated while v3 journals remain structurally readable',()=>{
  const row={key:JSON.stringify([namespace,'bundle']),version:1,namespace,kind:'bundle',chatHash:'a'.repeat(64),sourceDigest:'b'.repeat(64),planDigest:'c'.repeat(64),phase:'prepared',revision:1,createdAt:1,updatedAt:1};
  assert.equal(validateResourceRestoreCheckpoint(row),row);assert.equal(validateResourceRestoreCheckpoint({...row,environmentDigest:'d'.repeat(64)}).environmentDigest,'d'.repeat(64));
  assert.throws(()=>validateResourceRestoreCheckpoint({...row,environmentDigest:''}));
  assert.throws(()=>validateResourceRestoreCheckpoint({...row,kind:'characters',environmentDigest:'d'.repeat(64)}));
});
