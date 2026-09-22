import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {galleryPreparedAssetsFixture} from './helpers/gallery-prepared-assets-fixture.mjs';
import {galleryChatSaveFixture,pagedConsent,gate} from './helpers/gallery-chat-save-fixture.mjs';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';
import {readCurrentGalleryLocalRecipe} from '../qianmu-gallery-local-recipe-current.js';
import {galleryReviewedRecipeSlot} from '../qianmu-gallery-reviewed-recipe.js';

async function legacy(t){
  const f=await galleryPreparedAssetsFixture(t,{count:1,serverRecipe:false}),record=f.rows[0],snapshot=structuredClone(record.snapshot);
  delete record.snapshot;record.snapshotRef=`chat\u241f${record.id}`;f.store.storyboardImages=f.rows;await f.save();
  const row={key:record.snapshotRef,chatKey:'chat',recordId:record.id,snapshot};let reads=0;
  const session=f.own(await createCurrentGalleryArchiveSession({...f.options,readLocalRecipe:async()=>{reads++;return row;}}));
  return {...f,record,row,session,get reads(){return reads;}};
}
test('ordinary preservation never reads unowned base cache; explicit review is read-only until exact confirmation',async t=>{
  const f=await legacy(t),original=await readFile(f.file),before=JSON.stringify(f.record);
  const first=await f.session.preserveAll();assert.equal(first.localRecipes.unverified,1);assert.equal(f.reads,0);
  await assert.rejects(readCurrentGalleryLocalRecipe({...f.options,record:f.record,readLocal:()=>assert.fail('no unowned automatic read')}),/核对旧配方/);
  const posts=()=>f.transport.calls.filter(c=>c.options.method==='POST').length,prior=posts();
  await assert.rejects(f.session.confirmLegacyRecipe({confirmed:true,expectedDigest:'a'.repeat(64)}));
  const review=await f.session.reviewLegacyRecipe(f.record.id);assert.equal(f.reads,1);assert.equal(posts(),prior);
  await assert.rejects(f.session.confirmLegacyRecipe({confirmed:false,expectedDigest:review.digest}));assert.equal(posts(),prior);
  const expected=structuredClone(review.snapshot);review.snapshot.prompt='caller edit';f.row.snapshot.prompt='later cache edit';
  const result=await f.session.confirmLegacyRecipe({confirmed:true,expectedDigest:review.digest});assert.equal(result.origin,'reviewed-local-copy');assert.deepEqual(result.snapshot,expected);
  assert.equal(JSON.stringify(f.record),before);assert.deepEqual(await readFile(f.file),original);
  const saved=posts();await f.session.confirmLegacyRecipe({confirmed:true,expectedDigest:review.digest});assert.equal(posts(),saved);
  assert.deepEqual(await readCurrentGalleryLocalRecipe({...f.options,record:f.record,readLocal:()=>assert.fail('confirmed base never asks IDB again')}),expected);
  const again=await f.session.preserveAll();assert.equal(again.localRecipes.available,1);assert.equal(f.reads,1);
});
test('source changes after display stop confirmation before account-file writes',async t=>{
  for(const kind of ['record','account','close']){
    const f=await legacy(t),review=await f.session.reviewLegacyRecipe(f.record.id),posts=f.transport.calls.filter(c=>c.options.method==='POST').length;
    if(kind==='record')f.record.prompt='edited while reviewing';if(kind==='account')f.transport.namespace='st-user:other';if(kind==='close')f.session.close();
    await assert.rejects(f.session.confirmLegacyRecipe({confirmed:true,expectedDigest:review.digest}));
    assert.equal(f.transport.calls.filter(c=>c.options.method==='POST').length,posts);
  }
});
test('a conflicting previously reviewed copy is never overwritten by a new association',async t=>{
  const f=await legacy(t),review=await f.session.reviewLegacyRecipe(f.record.id);await f.session.confirmLegacyRecipe({confirmed:true,expectedDigest:review.digest});
  f.row.snapshot.prompt='different candidate';const second=await f.session.reviewLegacyRecipe(f.record.id),before=[...f.transport.files];
  await assert.rejects(f.session.confirmLegacyRecipe({confirmed:true,expectedDigest:second.digest}));assert.deepEqual([...f.transport.files],before);
});
test('user-reviewed base recipe survives full paged restore and host readback without changing raw references',async t=>{
  const f=await galleryChatSaveFixture(t,{count:1,localRecipe:'reviewed'}),original=structuredClone(f.rows[0]),snapshot=[...f.localRecipes.values()][0].snapshot;
  f.localRecipes.clear();const result=await f.openWriter().save(pagedConsent);assert.equal(result.status,'saved');assert.equal(f.saves,1);assert.deepEqual(f.store.storyboardImages,[original]);
  assert.deepEqual(await readCurrentGalleryLocalRecipe({...f.options,record:f.store.storyboardImages[0],readLocal:()=>assert.fail('no cache on second device')}),snapshot);
  assert.ok(f.calls.every(call=>!call.url.includes('/recipe/restore')));
});
test('missing or corrupted reviewed receipt blocks actual save and second-device read',async t=>{
  for(const missing of [true,false]){
    const f=await galleryChatSaveFixture(t,{count:1,localRecipe:'reviewed'}),slot=await galleryReviewedRecipeSlot(f.selection.scope,f.rows[0]);
    const key=[...f.transport.files.keys()].find(key=>key.endsWith(slot+'.json'));assert.ok(key);
    if(missing)f.transport.files.delete(key);else f.transport.files.set(key,'corrupt');
    await assert.rejects(f.openWriter().save(pagedConsent));assert.equal(f.saves,0);
    f.store.storyboardImages=f.rows;await assert.rejects(readCurrentGalleryLocalRecipe({...f.options,record:f.rows[0],readLocal:()=>assert.fail('no cache guessing')}));
  }
});
test('closing during legacy local lookup ignores late cache values and leaves no association',async t=>{
  const f=await legacy(t),held=gate(),entered=gate();f.session.close();
  const session=f.own(await createCurrentGalleryArchiveSession({...f.options,readLocalRecipe:async()=>{entered.resolve();return held.promise;}}));
  const before=[...f.transport.files],work=session.reviewLegacyRecipe(f.record.id);await entered.promise;session.close();held.resolve(f.row);
  await assert.rejects(work);assert.deepEqual([...f.transport.files],before);
});
