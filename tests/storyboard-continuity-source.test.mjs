import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {captureStoryboardContinuitySource as capture} from '../qianmu-storyboard-continuity-source.js';
const roster={branches:[{id:'now',layer:'present'}],subjectIds:['A']};
const event={id:'coat',branchId:'now',paragraphId:'P1',subjectId:'A',category:'outfit',key:'coat',value:'off',persistence:'persistent',evidence:'A脱下外套。'};
const target={branchId:'now',paragraphId:'P1',evidence:'A脱下外套。'};
function fixture(){
 let account='st-user:alice',epoch=0,live=true;const emitter=new EventEmitter(),reads=[],paragraphs=[{id:'P1',text:'A脱下外套。'}];
 const context={chatId:'chat',characterId:0,characters:[{avatar:'A.png',chat:'chat'}],chatMetadata:{},eventSource:emitter,chat:[{mes:'A脱下外套。',swipe_id:0,name:'A',send_date:'original'}]};
 const options={getContext:()=>context,epoch:()=>epoch,resolveNamespace:async()=>account,isCurrent:()=>live,floor:0,readParagraphs:(message,floor)=>{reads.push(floor);return paragraphs;}};
 return {context,emitter,options,reads,paragraphs,set account(value){account=value;},set live(value){live=value;},advance(){epoch++;},listeners:()=>emitter.eventNames().reduce((n,key)=>n+emitter.listenerCount(key),0)};
}
test('captured source pins the exact floor and snapshots filtered paragraphs, without reading other floors or writing metadata',async()=>{
 const f=fixture(),before=JSON.stringify([f.context.chat,f.context.chatMetadata]),s=await capture(f.options);assert.deepEqual(f.reads,[0]);f.paragraphs[0].text='caller changed';
 assert.equal((await s.bind([event],roster)).events[0].fact.value,'off');assert.equal((await s.replay([event],roster,target)).activeFacts[0].value,'off');
 assert.equal(s.paragraphs[0].text,event.evidence);assert.ok(Object.isFrozen(s.paragraphs[0]));assert.equal('namespace' in s,false);assert.deepEqual(f.context.chatMetadata,{});
 s.close();assert.equal(f.listeners(),0);assert.doesNotMatch(JSON.stringify(s),/st-user:alice/);assert.equal(JSON.stringify([f.context.chat,f.context.chatMetadata]),before);
});

test('failure during listener subscription releases all registrations and late post-replay account changes refuse handoff',async()=>{
 const f=fixture(),on=f.emitter.on;f.emitter.on=function(type,handler){on.call(this,type,handler);if(type==='message_edited')handler(0);return this;};
 await assert.rejects(capture(f.options));assert.equal(f.listeners(),0);
 const g=fixture();let calls=0;g.options.resolveNamespace=async()=>++calls===4?'st-user:bob':'st-user:alice';const s=await capture(g.options);
 await assert.rejects(s.replay([event],roster,target));assert.equal(g.listeners(),0);
 const h=fixture();h.context.chat[0].swipe_id='invalid';await assert.rejects(capture(h.options));assert.equal(h.listeners(),0);
});
test('text edits, same-text swipe, changed generation identity, deletion, replacement and chat epoch invalidate results',async()=>{
 for(const change of [f=>{f.context.chat[0].mes='edited';},f=>{f.context.chat[0].swipe_id=1;},f=>{f.context.chat[0].extra={gen_id:'new'};},f=>f.context.chat.splice(0,1),f=>{f.context.chat[0]={...f.context.chat[0]};},f=>f.advance(),f=>{f.live=false;}]){
  const f=fixture(),s=await capture(f.options);change(f);await assert.rejects(s.replay([event],roster,target));assert.equal(f.listeners(),0);await assert.rejects(s.guard());
 }
});
test('edit-back and swipe-back notifications invalidate irreversibly; unrelated append or floor edit need not stop this source',async()=>{
 const f=fixture(),s=await capture(f.options);f.context.chat.push({mes:'new floor streaming'});f.emitter.emit('message_edited',1);assert.equal(await s.guard(),true);
 f.emitter.emit('message_edited',0);await assert.rejects(s.guard());assert.equal(f.listeners(),0);
 for(const event of ['message_swiped','message_deleted','chat_changed']){const f=fixture(),s=await capture(f.options);f.emitter.emit(event,0);await assert.rejects(s.guard());assert.equal(f.listeners(),0);}
});
test('account changes, abort and late identity resolution never deliver old-account state',async()=>{
 const f=fixture(),s=await capture(f.options);f.account='st-user:bob';await assert.rejects(s.bind([event],roster));f.account='st-user:alice';await assert.rejects(s.guard());assert.equal(f.listeners(),0);
 const g=fixture(),controller=new AbortController(),source=await capture({...g.options,signal:controller.signal});controller.abort();await assert.rejects(source.guard());assert.equal(g.listeners(),0);
 const h=fixture();let release,entered;const ready=new Promise(resolve=>{entered=resolve;});const pending=capture({...h.options,resolveNamespace:()=>{entered();return new Promise(resolve=>{release=resolve;});}}),rejected=assert.rejects(pending);
 await ready;h.emitter.emit('chat_changed');release('st-user:alice');await rejected;assert.equal(h.listeners(),0);
});
test('malformed or source-mutating readers clean up listeners; model format failure leaves a valid scope available for repair',async()=>{
 for(const patch of [{readParagraphs:()=>[]},{readParagraphs:()=>[{id:'P1',text:'\ud800'}]},{floor:-1},{resolveNamespace:async()=>''}]){const f=fixture();await assert.rejects(capture({...f.options,...patch}));assert.equal(f.listeners(),0);}
 const f=fixture();await assert.rejects(capture({...f.options,readParagraphs:()=>{f.context.chat[0].mes='changed';return f.paragraphs;}}));assert.equal(f.listeners(),0);
 const g=fixture(),s=await capture(g.options);await assert.rejects(s.bind([{...event,evidence:'absent'}],roster));assert.equal(await s.guard(),true);assert.equal((await s.bind([event],roster)).events.length,1);s.close();
});
