import test from 'node:test';
import assert from 'node:assert/strict';
import {galleryLocationFixture as fixture,locationGate as gate} from './helpers/gallery-location-fixture.mjs';
import {captureStoryboardStreamFrame,createStoryboardStreamMessageReference} from '../qianmu-storyboard-stream-source.js?v=1.59.384';
import {captureStoryboardContinuation,saveStoryboardContinuation} from '../qianmu-storyboard-continuation.js';
import {createStoryboardMessageReference,createStoryboardParagraphAnchor} from '../qianmu-storyboard.js';
import {stageStoryboardContinuationLinks} from '../qianmu-storyboard-continuation-proof.js?v=1.59.384';

test('preserved record absent from current gallery locates exact floor/paragraph without writing or media access',async t=>{
  const f=fixture(t),before=JSON.stringify([f.context.chat,f.context.chatMetadata,f.record]);
  Object.defineProperty(f.record,'url',{get(){throw Error('no media read');}});Object.defineProperty(f.record,'snapshot',{get(){throw Error('no recipe read');}});
  const lease=await f.open();assert.deepEqual(lease.assertCurrent(),{floor:0,paragraphIndex:1,paragraphText:'Alice reaches for the bowl.',kind:'exact',readOnly:true});
  assert.equal(JSON.stringify([f.context.chat,f.context.chatMetadata,f.record]),before);assert.equal(f.context.chatMetadata.story_director_liminale.storyboardImages,undefined);lease.close();assert.equal(f.context.eventSource.eventNames().length,0);
});
test('inserted floors relocate uniquely without rewriting original floor or retake fields',async t=>{
  const f=fixture(t);f.record.floorTake={id:'old-take',status:'superseded'};const before=JSON.stringify(f.record);
  f.context.chat.unshift({mes:'user inserted',is_user:true,name:'You'});const lease=await f.open();assert.equal(lease.assertCurrent().floor,1);assert.equal(JSON.stringify(f.record),before);
});
for(const kind of ['edit','swipe','deleted','duplicate','same-text-different-identity','user','system'])test(`${kind} cannot guess a source from floor proximity or matching text`,async t=>{
  const f=fixture(t);
  if(kind==='edit')f.message.mes+=' edit';if(kind==='swipe')f.message.swipe_id=1;if(kind==='deleted')f.context.chat.length=0;
  if(kind==='duplicate')f.context.chat.push(structuredClone(f.message));if(kind==='same-text-different-identity')f.message.send_date='other';
  if(kind==='user')f.message.is_user=true;if(kind==='system')f.message.is_system=true;
  await assert.rejects(f.open());assert.equal(f.context.eventSource.eventNames().length,0);
});
for(const kind of ['scope','account','group','record','anchor','world','legacy','future','review'])test(`${kind} boundary refuses without adopting another owner or upgrading weak data`,async t=>{
  const f=fixture(t);
  if(kind==='scope')f.scope.ownerKey='char:Bob.png';if(kind==='account')f.account='st-user:bob';
  if(kind==='group'){f.context.groupId='1';f.context.groups=[{id:'1',chat_id:'chat'}];}
  if(kind==='record')f.record.chatKey='other';if(kind==='anchor')f.record.paragraphAnchor.chatKey='other';
  if(kind==='world')f.record.worldReference={entryId:'r'};if(kind==='legacy')delete f.record.messageRef;if(kind==='future')f.record.messageRef.version=2;if(kind==='review')f.record.restoreLinkReview={};
  await assert.rejects(f.open());assert.equal(f.context.eventSource.eventNames().length,0);
});
test('invalid, oversized or ambiguous paragraph evidence falls back only to a verified floor',async t=>{
  for(const kind of ['hash','text','neighbour','large']){const f=fixture(t);
    if(kind==='hash')f.record.paragraphAnchor.messageHash='bad';if(kind==='text')f.record.paragraphAnchor.paragraphText='elsewhere';if(kind==='neighbour')f.record.paragraphAnchor.previousHash='bad';
    const lease=await f.open(kind==='large'?{paragraphs:()=>Array(241).fill('x')}:{});assert.equal(lease.assertCurrent().floor,0);assert.equal(lease.assertCurrent().paragraphIndex,null);
  }
});
test('chat events, replacement, in-place edits and duplicates invalidate an already prepared lease',async t=>{
  for(const kind of ['event','metadata','text','duplicate','epoch']){const f=fixture(t),lease=await f.open();
    if(kind==='event')f.context.eventSource.emit('chat_changed');if(kind==='metadata')f.context.chatMetadata={story_director_liminale:{}};
    if(kind==='text')f.message.mes+=' changed';if(kind==='duplicate')f.context.chat.push(structuredClone(f.message));if(kind==='epoch')f.epoch=2;
    assert.throws(()=>lease.assertCurrent());
  }
});
test('late account resolution after deadline cannot return a usable lease',async t=>{
  const f=fixture(t),held=gate();await assert.rejects(f.open({account:()=>held.promise,timeoutMs:10}),/超时/);held.resolve(f.scope.namespace);
  await new Promise(done=>setTimeout(done,10));assert.equal(f.context.eventSource.eventNames().length,0);
});
test('stream location requires original strong prefix; append stays valid, duplicate or digest changes fail',async t=>{
  const f=fixture(t);f.message.mes='Kitchen light.\n\nAlice reaches';
  const frame=await captureStoryboardStreamFrame({...f.input,resolveNamespace:f.input.account,floor:0});f.record.messageRef=await createStoryboardStreamMessageReference(frame);frame.close();
  f.record.paragraphAnchor=createStoryboardParagraphAnchor({messageText:'Kitchen light.\n\n',paragraphText:'Kitchen light.',paragraphIndex:0,chatKey:'chat',swipeId:0});
  f.message.mes+=' for a bowl.\n\n';const lease=await f.open();assert.equal(lease.assertCurrent().kind,'stream');assert.equal(lease.assertCurrent().paragraphIndex,0);
  f.context.chat.push(structuredClone(f.message));await assert.rejects(f.open());f.context.chat.pop();f.record.messageRef=structuredClone(f.record.messageRef);f.record.messageRef.stream.prefixDigest='0'.repeat(64);await assert.rejects(f.open());
});
test('ordinary continuation uses saved identity path, not a similar prefix or an in-flight staged path',async t=>{
  const f=fixture(t);const handle=captureStoryboardContinuation({type:'continue',getContext:f.input.getContext,epoch:f.input.epoch,createReference:createStoryboardMessageReference});
  f.message.mes+='\n\nBob joins.';f.message.send_date='day-2';f.message.gen_started='generation-2';
  await saveStoryboardContinuation(handle,f.input.account,f.context.chatMetadata.story_director_liminale,async()=>{});handle.close();
  const lease=await f.open();assert.equal(lease.assertCurrent().kind,'continuation');assert.equal(lease.assertCurrent().paragraphIndex,1);
  const store=f.context.chatMetadata.story_director_liminale,links=store.storyboardContinuations;delete store.storyboardContinuations;await assert.rejects(f.open());
  const finish=stageStoryboardContinuationLinks(store,links);await assert.rejects(f.open());finish(true);assert.equal((await f.open()).assertCurrent().kind,'continuation');
  f.context.chat.push(structuredClone(f.message));await assert.rejects(f.open());
});
test('conflicting saved swipe and invalid negative reference cannot locate any source kind',async t=>{
  const f=fixture(t);f.record.swipeId=1;await assert.rejects(f.open());f.record.swipeId=-1;f.record.messageRef.swipeId=-1;await assert.rejects(f.open());
});
test('exact group ownership also locates, but another group sharing a chat name cannot adopt it',async t=>{
  const f=fixture(t);f.context.groupId='7';f.context.groups=[{id:'7',chat_id:'chat'},{id:'8',chat_id:'chat'}];f.scope.ownerKey='group:7';
  const lease=await f.open();assert.equal(lease.assertCurrent().floor,0);f.context.groupId='8';assert.throws(()=>lease.assertCurrent());await assert.rejects(f.open());
});
