import test from 'node:test';import assert from 'node:assert/strict';
import {aliasFixture,namespace,chatKey,chatHash,targetKey} from './fixtures/storyboard-user-aliases.mjs';
import {canonicalUserSubjectKey,inspectUserAliasTargets} from '../qianmu-user-identity.js';
import {planUserAliases,inspectUserAliasReview} from '../qianmu-user-alias.js';
import {runUserAliasOperation} from '../qianmu-user-alias-runtime.js';
import {selectCharacterBinding} from '../qianmu-character-archive.js';
import {prepareCharacterCasting} from '../qianmu-character-casting.js';
import {inspectStoryboardSubjectMapReview} from '../qianmu-storyboard-subject-map.js';
import {comfyLibraryBackupDigest as digest} from '../qianmu-comfy-library-backup.js';
import {mappingHead,validateMappingDetail} from '../qianmu-storyboard-mapping-contract.js';
import {runMappingRegistry} from '../qianmu-storyboard-mapping-registry.js';
import {renderUserAliasReview} from '../qianmu-user-alias-view.js';
import {renderCharacterArchive} from '../qianmu-character-archive-view.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
const resolveTargets=async targets=>inspectUserAliasTargets(targets,{'A B.png':'User'}),subject={category:'user',subjectKey:targetKey,name:'User'};
const plan=(library,choices={})=>planUserAliases({namespace,chatHash,bindings:library.bindings,choices,resolveTargets});
async function approved(library){const p=await plan(library),row=p.display.find(row=>row.conflict&&row.archiveId==='bob'),choices={[row.groupId]:row.candidateId};return {plan:await plan(library,choices),choices};}
test('USER canonicalization decodes once without case folding, Unicode normalization or collapsing percent filenames',()=>{
  for(const key of [targetKey,'user:/User%20Avatars/A B.png','user:/User Avatars/A%20B%2Epng'])assert.equal(canonicalUserSubjectKey(key),targetKey);
  for(const key of ['user:/User Avatars/%2fetc','user:/User Avatars/%GG','user:/User Avatars/..','user:/User Avatars/%00','user:/User Avatars/\uD800'])assert.equal(canonicalUserSubjectKey(key),null);
  assert.notEqual(canonicalUserSubjectKey('user:/User Avatars/a%20B.png'),targetKey);assert.notEqual(canonicalUserSubjectKey('user:/User Avatars/A%2520B.png'),targetKey);
  assert.deepEqual(inspectUserAliasTargets([targetKey],{'A B.png':'User'}),[{subjectKey:targetKey,present:true}]);assert.deepEqual(inspectUserAliasTargets([],null),[]);
});
test('unique aliases resolve current casting while explicit chat null wins and conflicting defaults stop before archive loads',async()=>{
  const library=aliasFixture();assert.equal(selectCharacterBinding(library.bindings,subject,chatKey).archiveId,'');assert.equal(selectCharacterBinding(library.bindings,subject,'other-chat').revision,'unchanged');
  assert.throws(()=>selectCharacterBinding(library.bindings,subject,'new-chat'),/核对USER地址/);
  let loaded=0;await assert.rejects(prepareCharacterCasting({namespace,subjects:[subject],chatKey:'new-chat',text:'User',guard:async()=>{},store:{list:async()=>library.archives.map(row=>row.head),bindings:async()=>library.bindings,load:async()=>{loaded++;}}}),/核对USER地址/);assert.equal(loaded,0);
});
test('alias planning requires an explicit conflicting archive choice and retains unaffected/chat/null records and full originals',async()=>{
  const library=aliasFixture(),before=structuredClone(library),p=await plan(library);assert.equal(p.ready,false);assert.equal(p.groups,2);assert.equal(p.unresolved,1);assert.equal(p.display.length,3);
  const {plan:next}=await approved(library);assert.equal(next.ready,true);assert.equal(next.after.length,3);assert.equal(next.review.lineage.length,3);assert.deepEqual(library,before);
  assert.equal(selectCharacterBinding(next.after,subject,'new-chat').archiveId,'bob');assert.equal(selectCharacterBinding(next.after,subject,chatKey).archiveId,'');assert.equal(next.after.find(row=>row.chatKey==='other-chat').revision,'unchanged');
  assert.deepEqual(await inspectUserAliasReview(next.review),next.review);assert.deepEqual(await inspectStoryboardSubjectMapReview(next.review),next.review);
});

test('shared selector keeps already-saved local v2 receipt and approval digests byte-compatible with faeca17',async()=>{
  const {plan:p}=await approved(aliasFixture());
  assert.equal(p.review.digest,'895f8a62b2a15ec72da31fe03671afc096c00d24e31cc2982d72a9b57a88a722');
  assert.equal(p.digest,'a398827453cd2b2348acd0a9ffdb986e11c1ffbdfd598a182350f1245ddb4a9b');
});
test('forged winner, changed namespace, lineage loss, rewritten scope or unknown fields cannot be made valid by rehashing',async()=>{
  const {plan:p}=await approved(aliasFixture());
  for(const change of [r=>r.lineage[0].target.archiveId='alice',r=>r.lineage[0].source.scope=r.lineage[0].source.scope==='chat'?'default':'chat',r=>r.lineage.pop(),r=>r.namespace='st-user:other',r=>r.extra='secret',r=>r.selections[0].candidateId='f'.repeat(64)]){
    const row=structuredClone(p.review);change(row);const {digest:_,...core}=row;row.digest=await digest(core);await assert.rejects(inspectUserAliasReview(row));
  }
});
test('missing actual persona targets, stale choices, duplicate rows and extra binding payloads fail without writes',async()=>{
  const library=aliasFixture(),{choices}=await approved(library);
  const p=await planUserAliases({namespace,chatHash,bindings:library.bindings,choices,resolveTargets:async keys=>keys.map(subjectKey=>({subjectKey,present:false}))});assert.equal(p.ready,false);
  await assert.rejects(plan(library,{['f'.repeat(64)]:'e'.repeat(64)}),/过期/);
  for(const rows of [[...library.bindings,library.bindings[0]],[{...library.bindings[0],apiKey:'private'}]])await assert.rejects(plan({...library,bindings:rows}));
});
async function fixture(){
  const e={library:aliasFixture(),maps:new Map(),writes:0,live:true,locked:false,fits:true,receiptFail:false,writeFail:false};
  const store={bindings:async()=>structuredClone(e.library.bindings),list:async()=>e.library.archives.map(row=>structuredClone(row.head)),applyUserAliasReview:async(_ns,review,options)=>{
    assert.ok(e.maps.has(review.digest));assert.equal(options.confirmed,true);e.writes++;if(e.writeFail)throw Error('synthetic lost result');
    const choices=Object.fromEntries(review.selections.map(row=>[row.groupId,row.candidateId])),p=await plan(e.library,choices);e.library.bindings=p.after;e.library.usage.bindings=p.after.length;
  }};
  const journal={inspectSubjectMap:async review=>({fits:e.fits,receipt:e.maps.get(review.digest)||null}),prepareSubjectMap:async review=>{if(e.receiptFail)throw Error('receipt write failed');e.maps.set(review.digest,{review});}};
  const options={store,journal,namespace,chatHash,guard:async()=>{if(!e.live)throw Error('changed');},resolveTargets,locks:{request:async(_name,_options,work)=>work(e.locked?null:{})}};return {e,options};
}
test('coordinator keeps preview read-only, saves original proof before atomic binding write and supports safe reinspection',async()=>{
  const {e,options}=await fixture(),{choices}=await approved(e.library),archives=structuredClone(e.library.archives);
  const preview=await runUserAliasOperation('user-alias-preview',{...options,input:{choices,offset:0}});assert.equal(e.maps.size,0);assert.equal(e.writes,0);
  const result=await runUserAliasOperation('user-alias-apply',{...options,input:{choices,digest:preview.digest,confirmed:true}});assert.equal(result.before,3);assert.equal(result.after,2);assert.equal(e.maps.size,1);assert.deepEqual(e.library.archives,archives);
  const again=await runUserAliasOperation('user-alias-preview',{...options,input:{choices:{},offset:0}});assert.equal(again.total,0);assert.equal(e.writes,1);
});
test('stale heads, missing confirmations, busy locks and failed receipt save prevent the binding write',async()=>{
  for(const reason of ['stale','unconfirmed','locked','receiptFail','capacity']){
    const {e,options}=await fixture(),{choices}=await approved(e.library),p=await runUserAliasOperation('user-alias-preview',{...options,input:{choices,offset:0}});
    if(reason==='stale')e.library.archives[0].head.revision='changed';if(reason==='locked')e.locked=true;if(reason==='receiptFail')e.receiptFail=true;if(reason==='capacity')e.fits=false;
    await assert.rejects(runUserAliasOperation('user-alias-apply',{...options,input:{choices,digest:p.digest,confirmed:reason!=='unconfirmed'}}));assert.equal(e.writes,0);
  }
});
test('an uncertain binding result retains the saved proof, never retries and explicitly requires reinspection',async()=>{
  const {e,options}=await fixture(),{choices}=await approved(e.library),p=await runUserAliasOperation('user-alias-preview',{...options,input:{choices,offset:0}});e.writeFail=true;
  await assert.rejects(runUserAliasOperation('user-alias-apply',{...options,input:{choices,digest:p.digest,confirmed:true}}),/未全部确认.*不会自动重试/);assert.equal(e.maps.size,1);assert.equal(e.writes,1);
});
test('v2 alias receipts share the existing export/accounting registry while preserving both losing and winning archives',async()=>{
  const {plan:p}=await approved(aliasFixture()),bytes=new TextEncoder().encode(JSON.stringify(p.review)).length,receipt={key:JSON.stringify([namespace,p.review.digest,bytes]),namespace,review:p.review,bytes,createdAt:1},head=mappingHead('subjects',receipt);
  assert.equal(head.version,2);const options={namespace,journal:{listMappingHeads:async()=>[head],loadMappingReceipt:async()=>receipt}},input={kind:'subjects',digest:p.review.digest,offset:0};
  const detail=await runMappingRegistry('mapping-detail',{...options,input});validateMappingDetail(detail,namespace,input);assert.equal(detail.rows.length,3);assert.ok(detail.rows.some(pair=>pair.source.archiveId!==pair.target.archiveId));
  const result=await runMappingRegistry('mapping-export',{...options,input:{kind:'subjects',digest:p.review.digest}});assert.deepEqual(JSON.parse(await result.file.text()).receipt,receipt);
});
test('2048 local bindings retain all 2047 affected originals, preserve the unaffected row and paginate the final seven only',async()=>{
  const {e,options}=await fixture();e.library=aliasFixture({extra:2044});const {plan:p,choices}=await approved(e.library);
  assert.equal(p.before.length,2048);assert.equal(p.review.lineage.length,2047);assert.equal(p.after.length,2047);assert.equal(p.after.find(row=>row.chatKey==='other-chat').revision,'unchanged');
  assert.deepEqual(await inspectUserAliasReview(p.review),p.review);
  const view=await runUserAliasOperation('user-alias-preview',{...options,input:{choices,offset:2040}});assert.equal(view.rows.length,7);assert.equal(view.total,2047);assert.ok(JSON.stringify(view).length<24000);assert.equal(e.writes,0);
});
test('both the archive and alias review UI stay usable during ambiguous USER bindings, escape data and require confirmation',async()=>{
  const {options}=await fixture(),preview=await runUserAliasOperation('user-alias-preview',{...options,input:{choices:{},offset:0}});
  const html=renderUserAliasReview({preview,busy:false,accepted:false,notice:'<private>'});assert.match(html,/data-alias-action="apply" disabled/);assert.match(html,/&lt;private&gt;/);assert.match(html,/待选择 1 组/);
  const library=aliasFixture(),view=renderCharacterArchive({rows:library.archives.map(row=>row.head),bindings:library.bindings,subjects:[subject],chatKey:'new-chat',search:'',collapsed:{},shown:{}});
  assert.match(view,/地址待核对/);assert.match(view,/data-archive-action="user-aliases"/);
});
class WorkerFixture{static handler;static last;constructor(){this.events={};WorkerFixture.last=this;}addEventListener(name,fn){this.events[name]=fn;}postMessage(value){queueMicrotask(()=>WorkerFixture.handler(this,value));}emit(value){this.events.message({data:value});}terminate(){this.closed=true;}}
test('worker target RPC is bounded, ordered and restricted to alias operations; cancellation never silently retries apply',async()=>{
  const {options}=await fixture(),input={choices:{},offset:0},preview=await runUserAliasOperation('user-alias-preview',{...options,input});
  WorkerFixture.handler=(w,value)=>{if(value.action){w.id=value.id;w.emit({id:w.id,aliasTargets:{request:1,targets:[targetKey]}});}else{assert.deepEqual(value.aliasTargets.rows,[{subjectKey:targetKey,present:true}]);w.emit({id:w.id,result:preview});}};
  assert.deepEqual(await runRestoreStorage('user-alias-preview',{namespace,chatHash,input,guard:async()=>{},resolveAliasTargets:resolveTargets,WorkerClass:WorkerFixture}),preview);assert.equal(WorkerFixture.last.closed,true);
  WorkerFixture.handler=(w,value)=>w.emit({id:value.id,aliasTargets:{request:1,targets:['bad']}});await assert.rejects(runRestoreStorage('user-alias-preview',{namespace,chatHash,input,guard:async()=>{},resolveAliasTargets:resolveTargets,WorkerClass:WorkerFixture}));
  WorkerFixture.handler=()=>{};const controller=new AbortController(),request=runRestoreStorage('user-alias-apply',{namespace,chatHash,input:{choices:{},digest:'f'.repeat(64),confirmed:true},guard:async()=>{},resolveAliasTargets:resolveTargets,WorkerClass:WorkerFixture,signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(request,/原绑定可能已调整/);assert.equal(WorkerFixture.last.closed,true);
});
