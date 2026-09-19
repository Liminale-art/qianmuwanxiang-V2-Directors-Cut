import test from 'node:test';
import assert from 'node:assert/strict';
import {openProseAssistantHistory as open} from '../qianmu-prose-assistant-history-runtime.js';
import {emptyProseAssistantHistory,validateProseAssistantHistory} from '../qianmu-prose-assistant-history-contract.js';
const account='st-user:'+'a'.repeat(64),key=JSON.stringify(['qianmu-prose-assistant-v2',account,'char:A.png',{kind:'character',chatId:'A',avatar:'A.png'},null]);
const row=(id=1)=>({id,user:'问题',assistant:'答案',status:'complete',reference:{floor:0,replyId:'swipe:0',mode:'floor',range:{start:0,end:2}}});
const snapshot=(rows=[row()])=>({key,busy:false,rows});
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
function fixture(){
 const f={state:emptyProseAssistantHistory(key),live:true,writes:0,reads:0,reports:[],mode:'ok'};
 const check=options=>{if(!options.guard())throw Error('changed private account');};
 f.store={async read(a,k,options){assert.equal(a,account);assert.equal(k,key);check(options);f.reads++;return structuredClone(f.state);},async write(a,k,rev,rows,options){
  check(options);f.writes++;if(f.hold)await f.hold.promise;check(options);if(f.mode==='fail')throw Error('private-key private-url');
  if(rev!==f.state.revision)throw Object.assign(Error(),{code:'prose_assistant_history_conflict'});
  const next=validateProseAssistantHistory({version:1,namespace:key,revision:rev+1,updatedAt:1,rows:structuredClone(rows)},key);f.state=next;
  if(f.mode==='lost')throw Error('lost private acknowledgement');return structuredClone(next);
 },close(){throw Error('caller-owned store must not be closed');}};
 f.options={source:{key,scope:{namespace:account},assertCurrent:()=>f.live,guard:async()=>f.live},store:f.store,isCurrent:()=>f.live,onStatus:value=>f.reports.push(value)};return f;
}
test('opening reads only the scoped history and terminal save confirms after the actual store receipt without replaying work',async()=>{
 const f=fixture(),runtime=await open(f.options);assert.equal(f.reads,1);assert.equal(f.writes,0);assert.deepEqual(runtime.initialHistory().rows,[]);
 const input=snapshot();assert.deepEqual(await runtime.save(input),{status:'confirmed',revision:1,persistence:'local-transaction'});input.rows[0].user='external edit';assert.equal(f.state.rows[0].user,'问题');
 assert.equal(runtime.status().dirty,false);assert.equal(runtime.status().phase,'ready');assert.doesNotMatch(JSON.stringify(f.reports),/问题|答案|st-user:|apiKey/);
 await runtime.save(snapshot());assert.equal(f.writes,1,'identical content is checked, not written twice');runtime.close();assert.throws(runtime.initialHistory);assert.equal(runtime.status().phase,'closed');
});
test('duplicate save shares a single flight; different terminal snapshots wait without silently replacing a pending one',async()=>{
 const f=fixture(),runtime=await open(f.options);f.hold=deferred();const first=runtime.save(snapshot()),same=runtime.save(snapshot());assert.equal(first,same);await new Promise(r=>setImmediate(r));assert.equal(f.writes,1);
 await assert.rejects(runtime.save(snapshot([])),{code:'prose_assistant_history_busy'});f.hold.resolve();await first;assert.equal(f.state.rows.length,1);runtime.close();
});
test('failed write keeps the exact pending snapshot, requires explicit retry and never reveals raw storage errors',async()=>{
 const f=fixture(),runtime=await open(f.options);f.mode='fail';await assert.rejects(runtime.save(snapshot()),error=>{assert.equal(error.code,'prose_assistant_history_storage');assert.doesNotMatch(error.message,/private-key|private-url/);return true;});
 assert.equal(runtime.status().dirty,true);assert.equal(runtime.status().canRetry,true);assert.equal(f.state.revision,0);await assert.rejects(runtime.save(snapshot([row(2)])),{code:'prose_assistant_history_pending'});assert.equal(f.writes,1);
 f.mode='ok';await runtime.retry();assert.equal(f.writes,2);assert.equal(f.state.rows[0].id,1);assert.equal(runtime.status().dirty,false);runtime.close();
});
test('lost acknowledgement is reconciled against the exact committed content without another write',async()=>{
 const f=fixture(),runtime=await open(f.options);f.mode='lost';await assert.rejects(runtime.save(snapshot()));assert.equal(f.state.revision,1);assert.equal(runtime.status().revision,0);
 f.mode='ok';await runtime.retry();assert.equal(f.writes,1);assert.equal(runtime.status().revision,1);assert.equal(runtime.status().dirty,false);runtime.close();
});
test('another page edit or clear is a hard conflict and cannot be rebased or resurrected by retry',async()=>{
 const f=fixture(),runtime=await open(f.options);f.state={...f.state,revision:1,updatedAt:1,rows:[]};await assert.rejects(runtime.save(snapshot()),{code:'prose_assistant_history_conflict'});
 assert.equal(runtime.status().dirty,true);assert.equal(runtime.status().canRetry,false);await assert.rejects(runtime.retry(),{code:'prose_assistant_history_conflict'});assert.equal(f.writes,0);assert.deepEqual(f.state.rows,[]);runtime.close();
});
test('closed or changed sources cannot publish a late confirmation or enter a different namespace',async()=>{
 for(const change of [(f,r)=>r.close(),f=>{f.live=false;}]){
  const f=fixture(),runtime=await open(f.options);f.hold=deferred();const pending=runtime.save(snapshot()),rejected=assert.rejects(pending);await new Promise(r=>setImmediate(r));const seen=f.reports.length;change(f,runtime);f.hold.resolve();await rejected;assert.equal(f.reports.length,seen);assert.equal(f.state.revision,0);runtime.close();
 }
 const f=fixture();f.options.source.scope.namespace='st-user:'+'b'.repeat(64);await assert.rejects(open(f.options));assert.equal(f.reads,0);
});
test('corrupt reads, running snapshots and forged write acknowledgements fail closed without being advertised as saved',async()=>{
 const broken=fixture();broken.state.extra='forbidden';await assert.rejects(open(broken.options));assert.equal(broken.writes,0);
 const f=fixture(),runtime=await open(f.options);await assert.rejects(runtime.save({...snapshot(),busy:true}));assert.equal(f.writes,0);
 f.store.write=async()=>({...emptyProseAssistantHistory(key),revision:1,updatedAt:1,rows:[]});await assert.rejects(runtime.save(snapshot()),{code:'prose_assistant_history_invalid'});assert.equal(runtime.status().dirty,true);assert.equal(runtime.status().revision,0);runtime.close();
});
