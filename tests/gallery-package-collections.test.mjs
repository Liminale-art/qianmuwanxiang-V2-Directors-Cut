import test from 'node:test';
import assert from 'node:assert/strict';
import {assertGalleryPackageCollections,GALLERY_PACKAGE_COLLECTION_LIMIT} from '../qianmu-gallery-package-collections.js';
import {buildStoryboardVibePackage} from '../qianmu-storyboard-package-assets.js';
import {inspectStoryboardPackageFile} from '../qianmu-storyboard-package-input.js';
import {prepareStoryboardPackageDraft} from '../qianmu-storyboard-package-draft.js';
import {createStoryboardDefaults} from '../qianmu-storyboard.js';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';
import {mergeGallerySupplement} from '../qianmu-gallery-merge-supplement.js';

const rows=(n=141,start=0)=>Array.from({length:n},(_,i)=>({id:'collection-'+(i+start),name:'Collection '+(i+start),future:{keep:i+start}}));
const packet=collections=>({type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:{},chat:{images:[],collections},media:[]});
const file=value=>new Blob([JSON.stringify(value)]);
const request=()=>({settings:createStoryboardDefaults(),chat:{},incoming:{},images:[],collections:[],chatKey:'chat'});
test('package collection scope matches the existing 10000-row gallery restoration limit without trimming',async()=>{
  const collections=rows(10000),before=JSON.stringify(collections);assert.equal(GALLERY_PACKAGE_COLLECTION_LIMIT,10000);
  assert.equal(assertGalleryPackageCollections(collections),collections);
  const result=prepareStoryboardPackageDraft({...request(),collections});assert.deepEqual(result.chat.storyboardCollections,collections);
  assert.notEqual(result.chat.storyboardCollections[0],collections[0]);assert.equal(JSON.stringify(collections),before);
});
for(const version of [6,7])test(`v${version} actual package import preserves 141 collections and 141 image memberships`,async()=>{
  const collections=rows(),payload=packet(collections),members=collections.map(row=>row.id);
  payload.chat.images=[{id:'image',source:'novel',collectionIds:members,collectionId:members.at(-1),future:{keep:true}}];
  const f=createPackageImportFixture();f.e.store.storyboardCollections=[{id:'old',name:'Old',future:{local:true}}];
  const before=JSON.stringify(payload),input=version===6?file(payload):(await buildStoryboardVibePackage(payload,{namespace:'st-user:source',load:()=>assert.fail('no assets')})).file;
  await f.import(input);assert.equal(f.e.store.storyboardCollections.length,142,JSON.stringify(f.e.notices));
  assert.deepEqual(f.e.store.storyboardCollections.slice(1),collections);assert.deepEqual(f.e.store.storyboardImages[0].collectionIds,members);
  assert.equal(f.e.store.storyboardImages[0].collectionId,members.at(-1));assert.equal(JSON.stringify(payload),before);assert.equal(f.e.pending.phase,'applied');
  f.e.choice='2';await f.recover();assert.deepEqual(f.e.store.storyboardCollections,[{id:'old',name:'Old',future:{local:true}}]);assert.equal(Object.hasOwn(f.e.store,'storyboardImages'),false);
});
test('the same complete collection originals survive package inspection and gallery supplement merge',async()=>{
  const collections=rows(1000),payload=packet(collections),built=await buildStoryboardVibePackage(payload,{namespace:'st-user:source',load:()=>assert.fail('no assets')});
  const inspected=await inspectStoryboardPackageFile(built.file);
  const owner={namespace:'st-user:source',chatKey:'chat'};
  const result=await mergeGallerySupplement({}, {storyboardCollections:inspected.payload.chat.collections},owner);
  assert.deepEqual(result.saved.storyboardCollections,collections);
});
test('over-count and malformed collections refuse before import confirmation, journal, settings or asset writes',async()=>{
  for(const collections of [rows(10001),[...rows(1),...rows(1)],[{id:'id',name:''}],[{id:'id',name:'x'.repeat(81)}],[{id:'bad\nvalue',name:'Bad'}]]){
    const f=createPackageImportFixture(),before=JSON.stringify(f.e.state);let confirms=0;f.e.confirm=()=>{confirms++;return true;};
    await f.import(file(packet(collections)));assert.equal(confirms,0);assert.deepEqual(f.e.events,[]);assert.equal(f.e.pending,null);assert.equal(JSON.stringify(f.e.state),before);assert.deepEqual(f.e.store,{});
  }
});
test('merged collection count and complete metadata bytes are checked without altering local originals',()=>{
  const args={...request(),chat:{storyboardCollections:rows(10000)},collections:rows(1,10000)},before=JSON.stringify(args);
  assert.throws(()=>prepareStoryboardPackageDraft(args),/合并后超过 10000/);assert.equal(JSON.stringify(args),before);
  const large=rows(3);large.forEach(row=>row.future={body:'x'.repeat(800000)});
  assert.throws(()=>assertGalleryPackageCollections(large),/上限/);
});
test('v7 export rejects excess collections or images before loading assets and does not enlarge existing media limits',async()=>{
  for(const payload of [packet(rows(10001)),{...packet(rows(1)),chat:{collections:rows(1),images:Array.from({length:401},(_,i)=>({id:'image-'+i}))}}]){
    let loads=0;const before=JSON.stringify(payload);
    await assert.rejects(()=>buildStoryboardVibePackage(payload,{namespace:'st-user:source',load:()=>{loads++;}}),/10000|400/);
    assert.equal(loads,0);assert.equal(JSON.stringify(payload),before);
  }
  const legacy=packet([]);legacy.chat.images=Array.from({length:401},(_,i)=>({id:String(i)}));
  await assert.rejects(()=>inspectStoryboardPackageFile(file(legacy),{legacy:true}),/超限/);
});
