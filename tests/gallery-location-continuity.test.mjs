import test from 'node:test';
import assert from 'node:assert/strict';
import {galleryLocationFixture,locationGate} from './helpers/gallery-location-fixture.mjs';
import {attachGalleryContinuity} from './helpers/gallery-continuity-fixture.mjs';
import {stageStoryboardContinuationLinks,storyboardContinuationIdentityInput} from '../qianmu-storyboard-continuation-proof.js?v=1.59.360';
import {vibeDigest} from '../qianmu-vibe-file.js';
import {captureStoryboardStreamFrame,createStoryboardStreamMessageReference} from '../qianmu-storyboard-stream-source.js?v=1.59.360';

async function fixture(t){const f=galleryLocationFixture(t),store=f.context.chatMetadata.story_director_liminale;
  const {record}=await attachGalleryContinuity({context:f.context,namespace:f.scope.namespace});Object.assign(f.record,record);
  const archived={scope:structuredClone(f.scope),links:structuredClone(store.storyboardContinuations)};delete store.storyboardContinuations;
  let reads=0;return Object.assign(f,{store,archived,loadContinuity:async()=>{reads++;return archived;},reads:()=>reads});}

test('archive paths locate continued originals without installing anything into metadata, and are fetched once per click',async t=>{
  const f=await fixture(t),before=JSON.stringify([f.context.chat,f.store,f.record]);const lease=await f.open({loadContinuity:f.loadContinuity});
  assert.equal(lease.assertCurrent().kind,'continuation');assert.equal(f.reads(),1);await lease.verify();assert.equal(f.reads(),1);
  assert.equal(JSON.stringify([f.context.chat,f.store,f.record]),before);assert.equal(Object.hasOwn(f.store,'storyboardContinuations'),false);
  f.archived.links.length=0;assert.equal(lease.assertCurrent().floor,0,'borrowed response cannot mutate the detached lease');
});
test('exact ordinary or existing current continuation needs no archive I/O',async t=>{
  const ordinary=galleryLocationFixture(t);await ordinary.open({loadContinuity:()=>assert.fail('unnecessary read')});
  const f=await fixture(t);f.store.storyboardContinuations=structuredClone(f.archived.links);await f.open({loadContinuity:()=>assert.fail('unnecessary read')});
});
for(const kind of ['scope','account','chat','id','prefix','fork','unknown-version','missing','unplaced','duplicate'])test(`archive ${kind} cannot bypass exact source checks or authorize a write`,async t=>{
  const f=await fixture(t),before=JSON.stringify(f.store),link=f.archived.links[0];
  if(kind==='scope')f.archived.scope.ownerKey='char:Bob.png';if(kind==='account')link.namespace='st-user:bob';if(kind==='chat')link.chatKey='elsewhere';
  if(kind==='id')link.id='0'.repeat(64);if(kind==='prefix')f.context.chat[0].mes='changed prefix'+f.context.chat[0].mes;
  if(kind==='fork'){const next=structuredClone(link);next.to.generation.id='fork';next.id=await vibeDigest(storyboardContinuationIdentityInput(next));f.archived.links.push(next);}
  if(kind==='unknown-version')link.version=3;if(kind==='missing')f.archived.links=[];if(kind==='unplaced')f.record.target='gallery';
  if(kind==='duplicate')f.context.chat.push(structuredClone(f.context.chat[0]));
  await assert.rejects(f.open({loadContinuity:f.loadContinuity}));assert.equal(JSON.stringify(f.store),before);assert.equal(f.context.eventSource.eventNames().length,0);
});
test('legacy absent evidence remains absent and is not fetched again as a repair attempt',async t=>{
  const f=await fixture(t);let calls=0;await assert.rejects(f.open({loadContinuity:async()=>{calls++;return null;}}));assert.equal(calls,1);assert.equal(Object.hasOwn(f.store,'storyboardContinuations'),false);
});
test('malformed or in-flight current links cannot be bypassed with valid archive links',async t=>{
  const f=await fixture(t);f.store.storyboardContinuations={bad:true};await assert.rejects(f.open({loadContinuity:f.loadContinuity}));assert.equal(f.reads(),0);
  delete f.store.storyboardContinuations;const done=stageStoryboardContinuationLinks(f.store,[]);try{await assert.rejects(f.open({loadContinuity:f.loadContinuity}));assert.equal(f.reads(),0);}finally{done(false);}
});
test('incompatible live facts arriving during archive read are not overwritten or ignored',async t=>{
  const f=await fixture(t);await assert.rejects(f.open({loadContinuity:async()=>{f.store.storyboardContinuations=structuredClone(f.archived.links);f.store.storyboardContinuations[0].future.changed=true;return f.archived;}}),/冲突/);
  assert.equal(f.store.storyboardContinuations[0].future.changed,true);
});
test('account switch, cancellation and deadline discard late archive evidence without leaking listeners',async t=>{
  for(const kind of ['account','cancel','timeout']){const f=await fixture(t),held=locationGate(),entered=locationGate(),controller=new AbortController();
    const work=f.open({signal:controller.signal,timeoutMs:kind==='timeout'?25:1000,loadContinuity:()=>{entered.resolve();return held.promise;}});await entered.promise;
    if(kind==='account'){f.account='st-user:bob';held.resolve(f.archived);}if(kind==='cancel')controller.abort();
    await assert.rejects(work);held.resolve(f.archived);await new Promise(done=>setTimeout(done,5));assert.equal(f.context.eventSource.eventNames().length,0);assert.equal(Object.hasOwn(f.store,'storyboardContinuations'),false);
  }
});
test('saved stream prefix can follow archived continuation but still requires its strong digest',async t=>{
  const f=galleryLocationFixture(t),message=f.context.chat[0];message.mes='A steady light.\n\nIncomplete';message.send_date='before';message.gen_started='generation-before';
  const frame=await captureStoryboardStreamFrame({...f.input,resolveNamespace:f.input.account,floor:0}),reference=await createStoryboardStreamMessageReference(frame);frame.close();
  await attachGalleryContinuity({context:f.context,namespace:f.scope.namespace});f.record.messageRef=reference;f.record.paragraphAnchor=null;f.record.messageHash='';
  const store=f.context.chatMetadata.story_director_liminale,links=structuredClone(store.storyboardContinuations);delete store.storyboardContinuations;
  const loadContinuity=async()=>({scope:f.scope,links});const lease=await f.open({loadContinuity});assert.equal(lease.assertCurrent().kind,'stream');
  f.record.messageRef=structuredClone(reference);f.record.messageRef.stream.prefixDigest='0'.repeat(64);await assert.rejects(f.open({loadContinuity}));
});
