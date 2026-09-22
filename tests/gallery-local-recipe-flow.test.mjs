import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {galleryChatSaveFixture,pagedConsent,gate} from './helpers/gallery-chat-save-fixture.mjs';
import {galleryPreparedAssetsFixture} from './helpers/gallery-prepared-assets-fixture.mjs';
import {readCurrentGalleryLocalRecipe} from '../qianmu-gallery-local-recipe-current.js';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';
import {galleryLocalRecipeSlot} from '../qianmu-gallery-local-recipe.js';

test('real local recipe preservation -> paged restore -> host save -> different-device read, without recipe uploads or raw record mutation',async t=>{
  const f=await galleryChatSaveFixture(t,{count:1,localRecipe:true}),original=structuredClone(f.rows[0]),snapshot=structuredClone([...f.localRecipes.values()][0].snapshot),body=JSON.stringify(f.context.chat);
  f.localRecipes.clear();const result=await f.openWriter().save(pagedConsent);assert.equal(result.status,'saved');assert.equal(result.recipesVerified,0);assert.equal(f.saves,1);
  assert.deepEqual(f.store.storyboardImages,[original]);assert.equal(JSON.stringify(f.context.chat),body);
  assert.ok(f.calls.every(call=>!call.url.includes('/recipe/restore')));
  const options={...f.options,record:f.store.storyboardImages[0],readLocal:async()=>null};
  const before=await readFile(f.file),calls=f.transport.calls.length;assert.deepEqual(await readCurrentGalleryLocalRecipe(options),snapshot);
  assert.ok(f.transport.calls.slice(calls).every(call=>call.options.method==='GET'));assert.deepEqual(await readFile(f.file),before);
  f.store.storyboardImages[0].tags=['new tag'];assert.deepEqual(await readCurrentGalleryLocalRecipe({...options,record:f.store.storyboardImages[0]}),snapshot);
});
test('a missing preserved local recipe prevents final host save and never invokes an implicit restore',async t=>{
  const f=await galleryChatSaveFixture(t,{count:1,localRecipe:true});const slot=await galleryLocalRecipeSlot(f.selection.scope,f.rows[0]);
  const key=[...f.transport.files.keys()].find(key=>key.endsWith(slot+'.json'));assert.ok(key);f.transport.files.delete(key);const calls=f.calls.length;
  await assert.rejects(f.openWriter().save(pagedConsent));assert.equal(f.saves,0);assert.deepEqual(f.store.storyboardImages,[]);
  assert.ok(f.calls.slice(calls).every(call=>!call.url.endsWith('/restore')));
});
test('fresh preservation reuses the verified native copy without asking the old device again',async t=>{
  const f=await galleryPreparedAssetsFixture(t,{count:1,localRecipe:true});f.store.storyboardImages=f.rows;await f.save();f.localRecipes.clear();
  const session=f.own(await createCurrentGalleryArchiveSession({...f.options,readLocalRecipe:()=>assert.fail('copy already exists')}));
  const result=await session.preserveAll();assert.deepEqual(result.localRecipes,{available:1,missing:0,unverified:0,state:'complete'});
});
test('unproven keys never read or upload old cache; valid-key bad bytes remain partial and retain originals',async t=>{
  for(const kind of ['plain','changed','absent']){const f=await galleryPreparedAssetsFixture(t,{count:1,localRecipe:true});
    const record=structuredClone(f.rows[0]);record.id+='-new';record.snapshotRef=kind==='plain'?'chat\u241f'+record.id:f.rows[0].snapshotRef.replace('record-0','record-0-new');
    f.store.storyboardImages=[record];await f.save();let reads=0;
    const session=f.own(await createCurrentGalleryArchiveSession({...f.options,readLocalRecipe:async()=>{reads++;return kind==='absent'?null:{key:record.snapshotRef,chatKey:'chat',recordId:record.id,snapshot:{source:'novel',prompt:'wrong',negative:'',profile:{},payload:{}}};}}));
    const before=await readFile(f.file),result=await session.preserveAll();assert.equal(result.localRecipes.state,'partial');assert.equal(result.localRecipes.available,0);
    assert.equal(reads,kind==='plain'?0:1);assert.deepEqual(await readFile(f.file),before);
  }
});
test('current recipe loader rejects switched scope, changed record, corrupt cache and late timeout without writes',async t=>{
  const f=await galleryPreparedAssetsFixture(t,{count:1,localRecipe:true});f.store.storyboardImages=f.rows;
  for(const kind of ['account','record','corrupt','timeout']){
    const held=gate(),entered=gate(),original=structuredClone(f.rows[0]);let namespace=f.account;
    const work=readCurrentGalleryLocalRecipe({...f.options,record:f.rows[0],account:async()=>namespace,timeoutMs:kind==='timeout'?20:1000,readLocal:async()=>{entered.resolve();return held.promise;}});
    await entered.promise;if(kind==='account')namespace='st-user:other';if(kind==='record')f.rows[0].future.changed=true;
    if(kind==='corrupt'){const row=structuredClone([...f.localRecipes.values()][0]);row.snapshot.prompt='changed';held.resolve(row);}else if(kind!=='timeout')held.resolve(null);
    await assert.rejects(work);held.resolve(null);Object.keys(f.rows[0]).forEach(key=>delete f.rows[0][key]);Object.assign(f.rows[0],original);
  }
});
test('actual current-gallery entry consumes the native copy before an unscoped memory cache and does not rebuild a recipe',async t=>{
  const f=await galleryPreparedAssetsFixture(t,{count:1,localRecipe:true});f.store.storyboardImages=f.rows;
  const snapshot=structuredClone([...f.localRecipes.values()][0].snapshot);f.localRecipes.clear();
  const text=await readFile(new URL('../index.js',import.meta.url),'utf8'),start=text.indexOf('async function storyboardReadSnapshotForRecord('),end=text.indexOf('async function storyboardStoreSnapshotForRecord(',start);
  let loads=0;const context=vm.createContext({storyboardSnapshotForRecord:()=>({source:'stale-unscoped-cache'}),ctx:()=>f.context,storyboardSnapshotEpoch:0,
    featureRuntime:{load:async key=>{assert.equal(key,'imageAdmission');return {resolveImageAccountNamespace:async()=>f.account};}},
    loadLocalChunk:async path=>{assert.match(path,/qianmu-gallery-local-recipe-current\.js\?v=/);loads++;return {readCurrentGalleryLocalRecipe:input=>readCurrentGalleryLocalRecipe({...input,createStorage:f.transport.createStorage,readLocal:async()=>null})};}});
  vm.runInContext(text.slice(start,end),context);assert.deepEqual(await context.storyboardReadSnapshotForRecord(f.rows[0]),snapshot);assert.equal(loads,1);
});
test('verified original-device content needs no native read and is returned detached from the old row',async t=>{
  const f=await galleryPreparedAssetsFixture(t,{count:1,localRecipe:true});f.store.storyboardImages=f.rows;
  const local=[...f.localRecipes.values()][0],saved=JSON.stringify(local),result=await readCurrentGalleryLocalRecipe({...f.options,record:f.rows[0],
    readLocal:async()=>local,createStorage:()=>assert.fail('verified local content needs no network')});
  result.prompt='edited by caller';assert.equal(JSON.stringify(local),saved);
});

test('exact detached export record reads its original recipe without attaching or changing metadata',async t=>{
  const f=await galleryPreparedAssetsFixture(t,{count:1,localRecipe:true});f.store.storyboardImages=f.rows;
  const copy=structuredClone(f.rows[0]),original=JSON.stringify(f.rows),snapshot=[...f.localRecipes.values()][0].snapshot;
  const result=await readCurrentGalleryLocalRecipe({...f.options,record:copy,readLocal:async()=>null});
  assert.deepEqual(result,snapshot);assert.equal(JSON.stringify(f.rows),original);assert.deepEqual(copy,f.rows[0]);assert.notEqual(copy,f.rows[0]);
});

test('detached export read refuses changed copies and replaced live identities even with identical contents',async t=>{
  const f=await galleryPreparedAssetsFixture(t,{count:1,localRecipe:true});f.store.storyboardImages=f.rows;
  const wrong=structuredClone(f.rows[0]);wrong.prompt='changed detached record';
  await assert.rejects(readCurrentGalleryLocalRecipe({...f.options,record:wrong,readLocal:()=>assert.fail('mismatch must stop before local read')}));
  for(const kind of ['copy','live']){
    const copy=structuredClone(f.rows[0]),held=gate(),entered=gate();
    const work=readCurrentGalleryLocalRecipe({...f.options,record:copy,readLocal:async()=>{entered.resolve();return held.promise;}});
    await entered.promise;if(kind==='copy')copy.prompt='changed while pending';else f.rows[0]=structuredClone(f.rows[0]);held.resolve(null);
    await assert.rejects(work);
  }
});
test('corrupt preserved payload cannot be returned to a second device or admitted by the writer',async t=>{
  const f=await galleryChatSaveFixture(t,{count:1,localRecipe:true}),slot=await galleryLocalRecipeSlot(f.selection.scope,f.rows[0]);
  const key=[...f.transport.files.keys()].find(key=>key.endsWith(slot+'.json'));assert.ok(key);f.transport.files.set(key,'corrupt');
  await assert.rejects(f.openWriter().save(pagedConsent));assert.equal(f.saves,0);
  f.store.storyboardImages=f.rows;const before=[...f.transport.files];
  await assert.rejects(readCurrentGalleryLocalRecipe({...f.options,record:f.rows[0],readLocal:async()=>null}));assert.deepEqual([...f.transport.files],before);
});
test('an unavailable legacy store is tried once per pass, not once per historical record',async t=>{
  const f=await galleryPreparedAssetsFixture(t,{count:1,localRecipe:true});
  f.store.storyboardImages=Array.from({length:4},(_,index)=>{const id='new-'+index;return {...f.rows[0],id,snapshotRef:f.rows[0].snapshotRef.replace('record-0',id)};});await f.save();let reads=0;
  const session=f.own(await createCurrentGalleryArchiveSession({...f.options,readLocalRecipe:async()=>{reads++;throw Error('legacy store blocked');}}));
  const result=await session.preserveAll();assert.equal(reads,1);assert.equal(result.localRecipes.missing,4);assert.equal(result.localRecipes.state,'partial');
});
