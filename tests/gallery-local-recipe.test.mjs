import test from 'node:test';
import assert from 'node:assert/strict';
import {vibeDigest} from '../qianmu-vibe-file.js';
import {galleryLocalRecipeReference,encodeGalleryLocalRecipe,inspectGalleryLocalRecipe,galleryLocalRecipeSlot} from '../qianmu-gallery-local-recipe.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

const scope={namespace:'st-user:fixture',ownerKey:'char:Alice.png',chatKey:'chat'};
async function fixture(){
  const snapshot={source:'comfy',prompt:' 原词\r\n',negative:'',profile:{z:0,a:1},payload:{nodes:{z:[0,false,null],a:1}},future:{z:'保留',a:0}};
  const key=`chat\u241fone\u241frevision:${await vibeDigest(JSON.stringify(['chat','one',snapshot]))}`;
  return {record:{id:'one',createdAt:1,chatKey:'chat',url:'/user/images/one.png',snapshotRef:key,future:{raw:true}},row:{key,chatKey:'chat',recordId:'one',snapshot,updatedAt:4}};
}
test('legacy revision digest preserves exact snapshot ordering and unknown fields, without modifying the original',async()=>{
  const f=await fixture(),before=JSON.stringify(f),saved=await encodeGalleryLocalRecipe(scope,f.record,f.row);
  assert.equal(JSON.stringify((await inspectGalleryLocalRecipe(scope,f.record,saved.value)).snapshot),JSON.stringify(f.row.snapshot));
  assert.equal(JSON.stringify(f),before);assert.equal(saved.value.content,JSON.stringify(f.row.snapshot));
  assert.equal(saved.record.recipeState,'local-reference');assert.equal(saved.value.scope.namespace,scope.namespace);
});
for(const kind of ['plain-key','wrong-key','chat','id','digest','snapshot','secret','unavailable','inline','server-reference'])test(`legacy ${kind} cannot be linked or silently normalized`,async()=>{
  const f=await fixture();
  if(kind==='plain-key')f.record.snapshotRef=f.row.key='chat\u241fone';
  if(kind==='wrong-key')f.row.key='elsewhere';if(kind==='chat')f.row.chatKey='other';if(kind==='id')f.row.recordId='other';
  if(kind==='digest')f.record.snapshotRef=f.row.key=f.row.key.slice(0,-64)+'0'.repeat(64);
  if(kind==='snapshot')f.row.snapshot.profile.a=9;if(kind==='secret')f.row.snapshot.profile.apiKey='not-a-real-secret';
  if(kind==='unavailable')f.record.recipeUnavailable=true;if(kind==='inline')f.record.snapshot=f.row.snapshot;
  if(kind==='server-reference')f.record.snapshotServerRef={};
  await assert.rejects(encodeGalleryLocalRecipe(scope,f.record,f.row));
});
test('saved copy rejects foreign scope, identity, reference, extra fields and corrupt content',async()=>{
  const f=await fixture(),saved=await encodeGalleryLocalRecipe(scope,f.record,f.row);
  for(const mutate of [v=>v.scope.namespace='st-user:other',v=>v.scope.ownerKey='char:Other.png',v=>v.identity.createdAt++,v=>v.reference+='x',v=>v.extra=1,v=>v.content='{}']){
    const value=structuredClone(saved.value);mutate(value);await assert.rejects(inspectGalleryLocalRecipe(scope,f.record,value));
  }
});
test('tag or collection edits retain the exact recipe slot; changed creation time or account cannot reuse it',async()=>{
  const f=await fixture(),saved=await encodeGalleryLocalRecipe(scope,f.record,f.row),changed={...f.record,tags:['new'],collectionIds:['album']};
  assert.equal(await galleryLocalRecipeSlot(scope,f.record),await galleryLocalRecipeSlot(scope,changed));
  assert.deepEqual((await inspectGalleryLocalRecipe(scope,changed,saved.value)).snapshot,f.row.snapshot);
  assert.notEqual(await galleryLocalRecipeSlot({...scope,namespace:'st-user:other'},f.record),await galleryLocalRecipeSlot(scope,f.record));
  assert.notEqual(await galleryLocalRecipeSlot(scope,{...f.record,createdAt:2}),await galleryLocalRecipeSlot(scope,f.record));
});
test('native preservation needs the exact already-read-back record and verifier; no legacy row is removed',async()=>{
  const f=await fixture(),before=structuredClone(f.row),transport=streamCheckpointTransport(scope.namespace);let approved=true;
  const store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>approved,createStorage:transport.createStorage});
  try{
    await assert.rejects(store.preserveLocalRecipe(f.record,f.row),/缺失/);assert.equal(transport.files.size,0);
    const record=await store.preserveRecord(f.record);assert.equal((await store.readRecipe(record.reference)).state,'local-reference');
    await store.preserveLocalRecipe(f.record,f.row);assert.deepEqual(f.row,before);assert.equal((await store.readRecipe(record.reference)).origin,'verified-local-copy');
    const count=transport.calls.filter(c=>c.options.method==='POST').length;await store.preserveLocalRecipe(f.record,f.row);
    assert.equal(transport.calls.filter(c=>c.options.method==='POST').length,count);
    approved=false;await assert.rejects(store.preserveLocalRecipe(f.record,f.row));assert.equal(transport.calls.filter(c=>c.options.method==='POST').length,count);
    approved=true;transport.namespace='st-user:other';await assert.rejects(store.preserveLocalRecipe(f.record,f.row));
  }finally{store.close();}
});
test('unknown plain keys are not treated as account ownership or as content-addressed revisions',async()=>{
  const f=await fixture();assert.equal(galleryLocalRecipeReference(scope,{...f.record,snapshotRef:'chat\u241fone'}),null);
  assert.equal(galleryLocalRecipeReference(scope,{...f.record,chatKey:'another'}),null);
});
test('asynchronous validation uses captured original bytes, never a caller edit during hashing',async()=>{
  const f=await fixture(),savedRow=structuredClone(f.row),savedRecord=structuredClone(f.record),owner={...scope};
  const pending=encodeGalleryLocalRecipe(owner,f.record,f.row);f.row.snapshot.prompt='late';f.record.id='late';owner.namespace='st-user:late';
  const result=await pending;assert.deepEqual((await inspectGalleryLocalRecipe(scope,savedRecord,result.value)).snapshot,savedRow.snapshot);
});
