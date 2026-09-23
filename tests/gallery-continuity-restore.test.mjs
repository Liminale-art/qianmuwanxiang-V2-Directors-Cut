import test from 'node:test';
import assert from 'node:assert/strict';
import {galleryChatSaveFixture,pagedConsent} from './helpers/gallery-chat-save-fixture.mjs';
import {attachGalleryContinuity} from './helpers/gallery-continuity-fixture.mjs';
import {GALLERY_CONTINUITY_FIELDS} from '../qianmu-gallery-continuity.js';
import {createGalleryLocation} from '../qianmu-gallery-location.js';
import {storyboardFloorTakeReceiptSupersedes} from '../qianmu-storyboard-floor-take-receipt.js?v=1.59.334';
import {stageStoryboardContinuationLinks} from '../qianmu-storyboard-continuation-proof.js?v=1.59.334';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';

async function fixture(t){let original;const f=await galleryChatSaveFixture(t,{count:1,clearArchivedFields:GALLERY_CONTINUITY_FIELDS,prepareStore:async input=>{
  const source=await attachGalleryContinuity(input);Object.assign(input.rows[0],source.record);original=structuredClone(Object.fromEntries(GALLERY_CONTINUITY_FIELDS.map(key=>[key,input.store[key]])));
}});return Object.assign(f,{original});}
test('real saved sources survive archive/plan/readback and explicit ST restoration, then unlock only verified old continuation',async t=>{
  const f=await fixture(t);for(const key of GALLERY_CONTINUITY_FIELDS)assert.equal(Object.hasOwn(f.store,key),false);
  const beforeBody=JSON.stringify(f.context.chat),scope=f.selection.scope;
  const locate=()=>createGalleryLocation({...f.options,scope,record:f.rows[0],paragraphs:text=>text.split('\n\n')});await assert.rejects(locate());
  assert.deepEqual(f.source.metadata.saved,f.original);const result=await f.openWriter().save(pagedConsent);assert.equal(result.status,'saved');assert.equal(f.saves,1);
  for(const key of GALLERY_CONTINUITY_FIELDS)assert.deepEqual(f.store[key],f.original[key]);assert.equal(JSON.stringify(f.context.chat),beforeBody);
  const location=await locate();t.after(()=>location.close());assert.equal(location.assertCurrent().kind,'continuation');
  assert.equal(storyboardFloorTakeReceiptSupersedes(f.rows[0],f.store.storyboardFloorTakeReceipts),true);assert.equal(result.canPrune,false);
});
test('new local source facts and active saves block restoration and preservation, not overwrite them',async t=>{
  const f=await fixture(t);f.store.storyboardContinuations=[];await assert.rejects(f.openWriter().save(pagedConsent),/基线/);assert.equal(f.saves,0);delete f.store.storyboardContinuations;
  const finish=stageStoryboardContinuationLinks(f.store,[]);try{
    await assert.rejects(f.openWriter().save(pagedConsent),/保存/);await assert.rejects(createCurrentGalleryArchiveSession(f.options),/保存/);assert.equal(f.saves,0);
  }finally{finish(false);}
});
