import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {galleryLocationFixture} from './helpers/gallery-location-fixture.mjs';
import {attachGalleryContinuity} from './helpers/gallery-continuity-fixture.mjs';
import {chatStateFixture} from './helpers/chat-state-fixture.mjs';
import {projectGalleryContinuity,GALLERY_CONTINUITY_FIELDS,galleryContinuitySavePending} from '../qianmu-gallery-continuity.js';
import {projectChatGallerySupplement,chatGallerySupplementResponse} from '../qianmu-chat-gallery-supplement.js';
import {mergeGallerySupplement} from '../qianmu-gallery-merge-supplement.js';
import {stageStoryboardContinuationLinks} from '../qianmu-storyboard-continuation-proof.js?v=1.59.322';
import {saveStoryboardFloorTakes} from '../qianmu-storyboard-floor-take.js?v=1.59.322';
import {createChatGalleryHeaderCapture} from '../qianmu-chat-gallery-header.js';
import {galleryArchiveReviewHtml} from '../qianmu-gallery-archive-view.js';
import {vibeDigest} from '../qianmu-vibe-file.js';
import {storyboardContinuationIdentityInput} from '../qianmu-storyboard-continuation-proof.js?v=1.59.322';

async function fixture(t){const f=galleryLocationFixture(t),store=f.context.chatMetadata.story_director_liminale;
  await attachGalleryContinuity({context:f.context,namespace:f.scope.namespace});return {...f,store,owner:{namespace:f.scope.namespace,chatKey:'chat'}};}

test('known source semantics are validated while original unknown portable fields and missing/empty distinctions survive',async t=>{
  const f=await fixture(t);assert.deepEqual(await projectGalleryContinuity(f.store,f.owner),f.store);
  assert.deepEqual(await projectGalleryContinuity({},f.owner),{});assert.deepEqual(await projectGalleryContinuity({storyboardContinuations:[]},f.owner),{storyboardContinuations:[]});
  assert.deepEqual(await projectChatGallerySupplement(f.store,f.owner),f.store);
});
for(const kind of ['account','chat','digest-id','fork','future-version','receipt-chat','receipt-duplicate','credentials','oversize'])test(`${kind} fails intact rather than dropping or reassigning source evidence`,async t=>{
  const f=await fixture(t),copy=structuredClone(f.store),row=copy.storyboardContinuations[0];
  if(kind==='account')row.namespace='st-user:bob';if(kind==='chat')row.chatKey='other';if(kind==='digest-id')row.id='0'.repeat(64);
  if(kind==='fork'){const other=structuredClone(row);other.to.generation.id='another';other.id=await vibeDigest(storyboardContinuationIdentityInput(other));copy.storyboardContinuations.push(other);}
  if(kind==='future-version')row.version=3;if(kind==='receipt-chat')copy.storyboardFloorTakeReceipts[0].chatKey='other';
  if(kind==='receipt-duplicate')copy.storyboardFloorTakeReceipts.push(structuredClone(copy.storyboardFloorTakeReceipts[0]));
  if(kind==='credentials')row.future.apiKey='not-exportable';if(kind==='oversize')row.future.text='x'.repeat(2*1048576);
  const before=JSON.stringify(copy);await assert.rejects(projectChatGallerySupplement(copy,f.owner));assert.equal(JSON.stringify(copy),before);
});
test('same source facts merge without rewriting raw data; different same-scope receipts or same-ID paths conflict',async t=>{
  const f=await fixture(t),result=await mergeGallerySupplement({},f.store,f.owner);assert.deepEqual(result.saved,f.store);assert.equal(result.added.storyboardContinuations,1);
  const same=await mergeGallerySupplement(f.store,f.store,f.owner);assert.equal(same.added.storyboardFloorTakeReceipts,0);
  for(const field of GALLERY_CONTINUITY_FIELDS){const next=structuredClone(f.store);next[field][0].future.changed=true;
    const conflict=await mergeGallerySupplement(f.store,next,f.owner);assert.equal(conflict.saved,null);assert.ok(conflict.conflicts.some(row=>row.field===field));}
});
test('in-flight continuation and retake writes cannot be mistaken for committed archive source',async t=>{
  const f=await fixture(t),finish=stageStoryboardContinuationLinks(f.store,[...f.store.storyboardContinuations]);assert.equal(galleryContinuitySavePending(f.store),true);finish(false);
  let release,entered;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r),receipts=f.store.storyboardFloorTakeReceipts;
  const save=saveStoryboardFloorTakes([],async()=>{entered();await held;},()=>true,()=>true,receipts);await started;
  assert.equal(galleryContinuitySavePending(f.store),true);release();await save;assert.equal(galleryContinuitySavePending(f.store),false);
});
test('actual saved header and response v2 preserve source fields, v1 remains legacy and cannot claim new evidence',async t=>{
  const f=await fixture(t),host=await chatStateFixture(t),proof=structuredClone(f.store);
  for(const row of proof.storyboardContinuations){row.chatKey=host.target.chatId;row.id=await vibeDigest(storyboardContinuationIdentityInput(row));}
  proof.storyboardFloorTakeReceipts[0].chatKey=host.target.chatId;Object.assign(host.saved,proof);const before=await host.write();
  const result=await host.service.readGallerySupplement(host.req,host.request());assert.equal(result.version,2);for(const key of GALLERY_CONTINUITY_FIELDS)assert.deepEqual(result.saved[key],proof[key]);
  assert.deepEqual(await readFile(host.file),before);await assert.rejects(chatGallerySupplementResponse({...result,version:1},{namespace:'st-user:alice'}));
  for(const key of GALLERY_CONTINUITY_FIELDS)delete host.saved[key];await host.write();const empty=await host.service.readGallerySupplement(host.req,host.request());
  assert.equal(empty.version,2);assert.equal((await chatGallerySupplementResponse({...empty,version:1},{namespace:'st-user:alice'})).version,1);
});
test('incremental header includes only exact root source fields and rejects malformed selected types',async t=>{
  const f=await fixture(t),text=JSON.stringify({chat_metadata:{story_director_liminale:{storyboardImages:[],...f.store}},private:{storyboardContinuations:['private']}});
  const parser=createChatGalleryHeaderCapture({supplement:true});for(const c of text)parser.write(c);assert.deepEqual(parser.finish().saved,f.store);
  for(const key of GALLERY_CONTINUITY_FIELDS){const p=createChatGalleryHeaderCapture({supplement:true});assert.throws(()=>p.write(JSON.stringify({chat_metadata:{story_director_liminale:{storyboardImages:[],[key]:null}}})));}
});
test('review differentiates old unknown evidence from confirmed absence and actual source counts',()=>{
  const base={total:0,recipes:{available:0,missing:0},originals:{referenced:0,missing:0},collections:0,characterDrafts:0,evidenceFloors:0};
  assert.match(galleryArchiveReviewHtml(base),/旧版本未记录/);assert.match(galleryArchiveReviewHtml({...base,continuity:{state:'recorded',continuations:2,retakes:3}}),/续写依据 2 · 换版依据 3/);
});
