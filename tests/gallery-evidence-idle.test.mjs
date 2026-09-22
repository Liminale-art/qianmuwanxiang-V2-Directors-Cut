import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {scanGalleryEvidenceSource} from '../qianmu-gallery-evidence-source.js';
import {captureStoryboardChatEvidence} from '../qianmu-storyboard-chat-evidence.js';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {createGalleryArchiveCoordinator} from '../qianmu-gallery-archive-coordinator.js';
import {galleryOriginalHttpFixture} from './helpers/gallery-original-http-fixture.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const until=async predicate=>{const end=Date.now()+10000;while(!predicate()){assert.ok(Date.now()<end,'operation did not settle');await new Promise(r=>setTimeout(r,5));}};
const documents=f=>[...f.transport.files.values()].map(JSON.parse).filter(v=>v.schema==='qianmu.st-account-document.v1').map(v=>v.value);
const versions=f=>documents(f).filter(v=>/^qianmu\.gallery\.source-version\./.test(v.schema));
async function fixture(t){
  const f=await galleryOriginalHttpFixture(t),transport=streamCheckpointTransport(f.account),state={epoch:0,account:f.account,hook:null,calls:[]};
  f.context.chat.push({mes:'角色正文🌸\n第二行',name:'Alice',is_user:false,swipe_id:0,swipes:['PRIVATE_HIDDEN'],extra:{apiKey:'PRIVATE_KEY'}},
    {mes:'USER 的选择',name:'User',is_user:true,send_date:123});
  f.context.chatMetadata.story_director_liminale.storyboardCollections=[];
  f.context.eventSource=new EventEmitter();f.context.eventSource.setMaxListeners(100);
  f.context.event_types={MESSAGE_EDITED:'host_edit',CHAT_CHANGED:'host_chat',CHAT_LOADED:'host_loaded'};
  const save=async()=>fs.writeFile(f.file,[JSON.stringify({chat_metadata:f.context.chatMetadata}),...f.context.chat.map(v=>JSON.stringify(v))].join('\n')+'\n');await save();
  const fetchImpl=async(url,options)=>{
    assert.ok(url.startsWith('/api/plugins/qianmu-tts/'));state.calls.push({url,options});
    if(state.hook){const result=await state.hook(url,options);if(result)return result;}
    return fetch(f.origin+url.slice('/api/plugins/qianmu-tts'.length),options);
  };
  const result={...f,transport,state,save,fetchImpl,
    async open(options={}){const session=await createCurrentGalleryArchiveSession({getContext:()=>f.context,epoch:()=>state.epoch,account:async()=>state.account,fetchImpl,createStorage:transport.createStorage,...options});t.after(()=>session.close());return session;},
    coordinator(options={}){const errors=[],c=createGalleryArchiveCoordinator({getContext:()=>f.context,epoch:()=>state.epoch,account:async()=>state.account,isCurrent:()=>true,
      connect:args=>result.open(args),window:{setTimeout,clearTimeout,navigator:{onLine:true},addEventListener(){},removeEventListener(){}},
      document:{readyState:'complete',addEventListener(){},removeEventListener(){}},quietMs:5,onError:error=>errors.push(error),...options});t.after(()=>c.close());return {c,errors};},
  };return result;
}

test('incremental local identity is byte-equivalent to existing evidence capture without reading unrelated fields',async()=>{
  let hidden=0;const rows=[{mes:'中文🌸\n正文',name:'A',swipe_id:2,send_date:123,original_avatar:'A.png',get extra(){hidden++;throw Error();},get swipes(){hidden++;throw Error();}},
    {mes:'',is_user:true},{mes:'系统',is_system:true,name:4},...Array.from({length:64},(_,i)=>({mes:'content '+i}))];
  for(const messages of [[],rows]){const existing=await captureStoryboardChatEvidence(messages,'chat'),scanned=await scanGalleryEvidenceSource(messages,'chat');assert.deepEqual(scanned,{count:messages.length,digest:existing.digest});}
  assert.equal(hidden,0);
});

test('local scan yields bounded work and retains only count and digest for large chat identity',async()=>{
  const rows=Array.from({length:5000},(_,i)=>({mes:'段落'+i+'x'.repeat(800),is_user:i%3===0}));let yielded=0,heartbeat=false,checks=0;
  const timer=setTimeout(()=>{heartbeat=true;},0),result=await scanGalleryEvidenceSource(rows,'long',{guard:()=>{checks++;return true;},yieldWork:async()=>{yielded++;}});clearTimeout(timer);
  assert.equal(result.count,5000);assert.deepEqual(Object.keys(result),['count','digest']);assert.ok(yielded>=157);assert.equal(heartbeat,true);assert.ok(checks<=yielded*3+2);
});

test('local scan rejects holes, inherited/getter fields, invalid rows, excess bounds and changed guards',async()=>{
  let reads=0;const getter={get mes(){reads++;return 'private';}};
  for(const messages of [[getter],[,],Array(100001),[{mes:'x',swipe_id:-1}],[Object.create({mes:'inherited'})],[{mes:'x'.repeat(2*1048576)}],[{}]])await assert.rejects(scanGalleryEvidenceSource(messages,'chat'));
  assert.equal(reads,0);await assert.rejects(scanGalleryEvidenceSource([{mes:'x'}],'chat',{guard:async()=>{throw Error('asynchronous');}}));
  const rows=[{mes:'x'}];await assert.rejects(scanGalleryEvidenceSource(rows,'chat',{yieldWork:async()=>{rows.push({mes:'late'});}}));
});

test('default idle runtime preserves original, companions and evidence through local HTTP then reads source3 without the original chat',async t=>{
  const f=await fixture(t),raw=await fs.readFile(f.file),expected=await captureStoryboardChatEvidence(f.context.chat,'chat'),session=await f.open();
  assert.equal(f.state.calls.length,0);assert.equal(f.transport.calls.length,0);const saved=await session.preserveAll();
  assert.equal(saved.originals.state,'complete');assert.equal(saved.supplements.state,'complete');assert.equal(saved.evidences.state,'complete');
  assert.equal(versions(f)[0].schema,'qianmu.gallery.source-version.v3');assert.equal(f.state.calls.filter(c=>c.url.endsWith('/evidence-source')).length,2);
  assert.deepEqual(await fs.readFile(f.file),raw);session.close();await fs.unlink(f.file);
  const reader=await createGalleryArchiveStorage({scope:{namespace:f.account,ownerKey:'char:Alice.png',chatKey:'chat'},guard:()=>true,verifyRecord:()=>false,createStorage:f.transport.createStorage});t.after(()=>reader.close());
  const version=await reader.openSourceVersion(saved.sourceReceipt,saved.supplement,saved.evidence);assert.equal((await version.page()).rows.length,1);version.close();
  const body=await reader.readEvidence(saved.evidence);assert.deepEqual(body.receipt.chatEvidence,expected);assert.equal(body.originalVerified,false);assert.equal(body.canPrune,false);
  for(const call of f.state.calls.filter(c=>c.url.endsWith('/evidence-source'))){assert.doesNotMatch(call.options.body,/角色正文|PRIVATE|messages/);assert.equal(call.options.headers.Authorization,undefined);}
  const stored=JSON.stringify(documents(f).filter(v=>/evidence/.test(v.schema)));assert.doesNotMatch(stored,/角色正文|PRIVATE_KEY|PRIVATE_HIDDEN/);
});

test('body-only edits create new version identities and reuse unchanged image originals and companions',async t=>{
  const f=await fixture(t),first=await f.open(),a=await first.preserveAll(),identity=first.identity;first.close();
  const imageCalls=f.state.calls.filter(c=>c.url.includes('/original/')).length;
  f.context.chat[0].mes+='新段落';await f.save();const second=await f.open(),b=await second.preserveAll();
  assert.notEqual(second.identity,identity);assert.notEqual(a.evidence.sha256,b.evidence.sha256);assert.deepEqual(a.supplement,b.supplement);assert.deepEqual(a.sourceReceipt,b.sourceReceipt);
  assert.equal(f.state.calls.filter(c=>c.url.includes('/original/')).length,imageCalls);assert.equal(versions(f).length,2);
});

test('unsaved local body stays partial; source2 survives, no timer retries, real edit event after save can complete',async t=>{
  const f=await fixture(t);f.context.chat[0].mes='未保存正文';const {c,errors}=f.coordinator();f.context.eventSource.emit('host_edit');
  await until(()=>!c.status().running&&c.status().state==='partial');assert.equal(versions(f)[0].schema,'qianmu.gallery.source-version.v2');
  assert.equal(documents(f).filter(v=>v.schema==='qianmu.gallery.evidence-manifest.v1').length,0);assert.equal(errors.at(-1).code,'gallery_evidence_incomplete');
  const calls=f.state.calls.length;await new Promise(r=>setTimeout(r,30));assert.equal(f.state.calls.length,calls);assert.equal(c.status().pending,false);
  await f.save();f.context.eventSource.emit('host_edit');await until(()=>c.status().state==='saved'&&!c.status().running);
  assert.ok(versions(f).some(v=>v.schema==='qianmu.gallery.source-version.v3'));
});

test('old evidence backend makes one attempt and keeps metadata/media without falling back to truncated evidence',async t=>{
  const f=await fixture(t);f.state.hook=url=>url.endsWith('/evidence-source')?new Response('old',{status:404}):undefined;
  const session=await f.open(),saved=await session.preserveAll();assert.equal(saved.evidences.state,'partial');assert.equal(saved.originals.state,'complete');assert.equal(saved.supplements.state,'complete');
  assert.equal(f.state.calls.filter(c=>c.url.endsWith('/evidence-source')).length,1);assert.ok(!f.state.calls.some(c=>c.url.endsWith('/evidence')));assert.equal(versions(f)[0].schema,'qianmu.gallery.source-version.v2');
});

test('remote body change during page upload retains copies but cannot publish mixed source3',async t=>{
  const f=await fixture(t);let changed=false;
  f.transport.hook=async({path,options})=>{if(path==='/api/files/upload'&&!changed&&JSON.parse(options.body).name.includes('-gallery-evidence-page-')){
    changed=true;const body=structuredClone(f.context.chat);body[0].mes='remote edit';await fs.writeFile(f.file,[JSON.stringify({chat_metadata:f.context.chatMetadata}),...body.map(v=>JSON.stringify(v))].join('\n')+'\n');
  }};
  const session=await f.open(),saved=await session.preserveAll();assert.equal(changed,true);assert.equal(saved.evidences.state,'partial');assert.equal(saved.evidence,undefined);
  assert.equal(versions(f)[0].schema,'qianmu.gallery.source-version.v2');assert.equal(documents(f).filter(v=>v.schema==='qianmu.gallery.evidence-manifest.v1').length,1);
});

test('different server header after companion copy rejects evidence even when images and body still match',async t=>{
  const f=await fixture(t);let changed=false;
  f.state.hook=async url=>{if(url.endsWith('/evidence-source')&&!changed){changed=true;await fs.writeFile(f.file,[JSON.stringify({chat_metadata:f.context.chatMetadata,extra:'new header'}),...f.context.chat.map(v=>JSON.stringify(v))].join('\n')+'\n');}};
  const session=await f.open(),saved=await session.preserveAll();assert.equal(saved.evidences.state,'partial');assert.equal(saved.supplements.state,'complete');
  assert.equal(documents(f).filter(v=>v.schema==='qianmu.gallery.evidence-page.v1').length,0);assert.equal(versions(f)[0].schema,'qianmu.gallery.source-version.v2');
});

test('silent local edit and account switch during evidence upload invalidate the entire current pass',async t=>{
  for(const type of ['body','account','epoch']){
    const f=await fixture(t);let changed=false;f.transport.hook=({path,options})=>{if(path==='/api/files/upload'&&!changed&&JSON.parse(options.body).name.includes('-gallery-evidence-page-')){
      changed=true;if(type==='body')f.context.chat[0].mes='edited during write';else if(type==='epoch')f.state.epoch++;else{f.state.account='st-user:bob';f.transport.namespace='st-user:bob';}
    }};
    const session=await f.open();await assert.rejects(session.preserveAll());assert.equal(changed,true);assert.equal(versions(f).length,0);
  }
});

test('invalid local evidence does not block independent original and companion preservation',async t=>{
  const f=await fixture(t);Object.defineProperty(f.context.chat[0],'mes',{get(){throw Error('must not execute');},enumerable:true});
  const session=await f.open(),saved=await session.preserveAll();assert.equal(saved.evidences.state,'partial');assert.equal(saved.originals.state,'complete');assert.equal(saved.supplements.state,'complete');
  assert.equal(f.state.calls.filter(c=>c.url.endsWith('/evidence-source')).length,0);assert.equal(versions(f)[0].schema,'qianmu.gallery.source-version.v2');
});

test('header-only chat with existing image has a valid explicit zero-row evidence version',async t=>{
  const f=await fixture(t);f.context.chat.length=0;await f.save();const s=await f.open(),saved=await s.preserveAll();assert.equal(saved.evidences.state,'complete');
  const stored=documents(f).find(v=>v.schema==='qianmu.gallery.evidence-manifest.v1');assert.equal(stored.receipt.chatEvidence.count,0);assert.deepEqual(stored.pages,[]);
});

test('host edit, delete, swipe, send and generation events coalesce without stream-token listeners and cleanup fully',async t=>{
  const f=await fixture(t),{c}=f.coordinator();assert.equal(f.state.calls.length,0);assert.equal(f.context.eventSource.listenerCount('stream_token_received'),0);
  for(let i=0;i<20;i++)f.context.eventSource.emit('host_edit');await until(()=>c.status().state==='saved'&&!c.status().running);assert.equal(versions(f).length,1);
  const calls=f.state.calls.length;f.context.eventSource.emit('host_edit');await until(()=>!c.status().running&&!c.status().pending);assert.equal(f.state.calls.length,calls,'unchanged successful body identity skips network');
  for(const [event,mutate] of [['message_swiped',()=>{f.context.chat[0].swipe_id++;}],['message_deleted',()=>{f.context.chat.pop();}],['message_sent',()=>{f.context.chat.push({mes:'new USER',is_user:true});}],
    ['generation_ended',()=>{f.context.chat.push({mes:'new AI'});}]] ){
    const count=versions(f).length;mutate();await f.save();f.context.eventSource.emit(event);await until(()=>versions(f).length>count&&!c.status().running);assert.equal(c.status().state,'saved');
  }
  c.close();assert.equal(f.context.eventSource.eventNames().length,0);const after=f.state.calls.length;f.context.eventSource.emit('host_edit');await new Promise(r=>setTimeout(r,10));assert.equal(f.state.calls.length,after);
});

test('late evidence response after close cannot write an evidence manifest or version',async t=>{
  const f=await fixture(t),started=gate(),release=gate();
  f.state.hook=async(url,options)=>{if(url.endsWith('/evidence-source')){const response=await fetch(f.origin+url.slice('/api/plugins/qianmu-tts'.length),options);started.resolve();await release.promise;return response;}};
  const session=await f.open(),pending=session.preserveAll();await started.promise;session.close();release.resolve();await assert.rejects(pending);
  assert.equal(versions(f).length,0);assert.equal(documents(f).filter(v=>v.schema==='qianmu.gallery.evidence-manifest.v1').length,0);
});

test('actual metadata-save glue schedules only after confirmed host completion, never on failure or missing save API',async()=>{
  let scheduled=0;const wait=gate(),context=vm.createContext({ctx:()=>({saveMetadata:()=>wait.promise}),storyboardScheduleGalleryPreservation:()=>scheduled++});
  vm.runInContext(storyboardFunctionSource('saveMetadata'),context);const pending=context.saveMetadata();assert.equal(scheduled,0);wait.resolve();await pending;assert.equal(scheduled,1);
  context.ctx=()=>({saveMetadata:async()=>{throw Error('failure');}});await assert.rejects(context.saveMetadata());assert.equal(scheduled,1);
  context.ctx=()=>({});await context.saveMetadata();assert.equal(scheduled,1);
});

test('event source replacement unbinds previous host and respects custom types on the new host',async t=>{
  const f=await fixture(t),old=f.context.eventSource,{c}=f.coordinator();const next=new EventEmitter();next.setMaxListeners(100);
  f.context.eventSource=next;f.context.event_types={MESSAGE_EDITED:'next_edit'};c.schedule();assert.equal(old.eventNames().length,0);assert.equal(next.listenerCount('next_edit'),1);
  await until(()=>c.status().state==='saved'&&!c.status().running);const before=f.state.calls.length;old.emit('host_edit');await new Promise(r=>setTimeout(r,15));assert.equal(f.state.calls.length,before);
  c.close();assert.equal(next.eventNames().length,0);
});

test('background host subscription failure cannot turn a completed foreground save into an exception',async t=>{
  const f=await fixture(t),{c,errors}=f.coordinator(),old=f.context.eventSource;
  f.context.eventSource={on(){throw Error('PRIVATE_HOST_FAILURE');},off(){}};
  assert.doesNotThrow(()=>c.schedule());assert.equal(c.status().state,'error');assert.equal(c.status().running,false);assert.equal(old.eventNames().length,0);
  assert.deepEqual(errors,[{code:'gallery_preservation_failed',writeState:'not_started'}]);assert.equal(f.state.calls.length,0);
  f.context.eventSource=old;c.schedule();await until(()=>c.status().state==='saved'&&!c.status().running);assert.equal(versions(f).length,1);
});

test('local body mutation during final gallery receipt cannot escape the final evidence identity check',async t=>{
  const f=await fixture(t);let receipts=0;
  f.state.hook=url=>{if(url.endsWith('/receipt')&&++receipts===2)f.context.chat[0].mes='last moment unsaved edit';};
  const session=await f.open();await assert.rejects(session.preserveAll(),/正文已修改/);assert.equal(receipts,2);
  assert.equal(versions(f).length,1,'already verified older snapshot remains retained, not erased');
});
