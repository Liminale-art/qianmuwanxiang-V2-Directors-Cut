import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorldSourceIndex} from '../qianmu-world-source.js';
import {WORLD_AUTOMATIC_APPROVAL_SCHEMA} from '../qianmu-world-automatic-approval.js';
import {createWorldAutomaticStorage} from '../qianmu-world-automatic-storage.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {normalizeQianmuProductionPacket} from '../qianmu-production-packet.js';
import {adaptProductionPacketToNarrativeLedgerEntry} from '../qianmu-narrative-ledger.js';
import {scoreNarrativeDirectorCandidate} from '../qianmu-director-candidate.js';
import {createAutomaticWorldDirectorDecision} from '../qianmu-director-decision.js';
import {createDirectorWorkOrder,directorWorkOrderToStoryboardShot} from '../qianmu-director-work-order.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
import {createImageAdmission,createImageAdmissionIdentity,createImageHistorySeeds} from '../qianmu-image-admission.js';
import {imageAttemptScopeKey,claimImageAttempt,beginImageAttempt,continueImageAttempt,settleImageAttempt,importImageAttempts,summarizeImageAttempts} from '../qianmu-image-attempts.js';
const namespace='st-user:world-test',chatKey='chat-a';
const copy=value=>structuredClone(value);
async function job(){
  const source=(await buildWorldSourceIndex({npc_updates:[{name:'Alice',action:'reads a letter'}]},{chatKey,revisionId:'plan-1'})).entries[0].source;
  const packet=normalizeQianmuProductionPacket({packetId:'packet-a',eventId:'event-a',timelineAnchor:{chatKey},sourceRef:{field:source.field,index:0,worldSource:source},visualIntent:{subject:'a letter',description:'Alice reads a letter'}});
  const ledgerEntry=adaptProductionPacketToNarrativeLedgerEntry(packet),candidate=scoreNarrativeDirectorCandidate(ledgerEntry,{chatKey,viewerId:'user'});
  const approval={schema:WORLD_AUTOMATIC_APPROVAL_SCHEMA,namespace,requestId:'wa-'+'a'.repeat(32),source};
  const result=createAutomaticWorldDirectorDecision(candidate,packet,{chatKey,namespace,ledgerEntry,ledgerEntryId:ledgerEntry.entryId,worldAutoEnabled:true,worldAutomation:approval,approvedAt:100});
  assert.equal(result.ok,true,result.issues.join(','));const order=createDirectorWorkOrder(result.decision,'storyboard',chatKey,{createdAt:100});
  const shotSpec=normalizeStoryboardShotSpec({...directorWorkOrderToStoryboardShot(order.workOrder,chatKey),directorDecision:result.decision});
  return {id:'job-a',chatKey,target:'gallery',floor:null,messageRef:null,inlineByDefault:false,paragraphAnchor:null,paragraphSelection:null,
    shotSpec,automatic:true,requestIndex:1,prompt:'a letter',profile:{count:'1'},payload:{parameters:{count:1}}};
}
function setup(options={}){
  const rows=new Map(),calls=[];let account=namespace;
  const run=(name,scope,apply)=>{calls.push(name);const key=imageAttemptScopeKey(scope),result=apply(rows.get(key));rows.set(key,copy(result.ledger));return result;};
  const store={claim:async(scope,input,seeds)=>{const result=run('claim',scope,value=>claimImageAttempt(importImageAttempts(value,scope,seeds,1000),scope,input,1000));await options.afterClaim?.();return result;},
    begin:async(scope,input)=>run('begin',scope,value=>beginImageAttempt(value,scope,input,1000)),continue:async(scope,input)=>run('continue',scope,value=>continueImageAttempt(value,scope,input,1000)),
    settle:async(scope,input)=>run('settle',scope,value=>settleImageAttempt(value,scope,input,1000)),close(){},
    inspect:scope=>summarizeImageAttempts(rows.get(imageAttemptScopeKey(scope)),scope,1000)};
  return {calls,store,runtime:createImageAdmission({store,account:async()=>account,ownerId:'page-a',confirm:()=>assert.fail('automatic requests never prompt for a retry'),...options}),set account(value){account=value;}};
}
const admit=(f,value,extra={})=>f.runtime.admit(value,{maxAutomatic:4,...extra});

test('world image identity is source-owned, separate from prose and stable across engines, prompts and request receipts',async()=>{
  const value=await job(),first=await createImageAdmissionIdentity(value,namespace);
  assert.match(first.scope.messageKey,/^world-item:npc_updates:witem-/);assert.match(first.scope.revisionId,/^wrev-/);
  assert.ok(Object.isFrozen(first.worldApproval));assert.ok(Object.isFrozen(first.worldApproval.source));
  const revised=copy(value);revised.prompt='new phrasing';revised.profile.model='different';revised.source='comfy';
  assert.equal((await createImageAdmissionIdentity(revised,namespace)).logicalShotId,first.logicalShotId);
  const manual=copy(value);manual.automatic=false;assert.equal((await createImageAdmissionIdentity(manual,namespace)).logicalShotId,first.logicalShotId);
  revised.shotSpec.directorDecision.approval.worldAutomation.requestId='wa-'+'b'.repeat(32);
  revised.shotSpec.directorDecision.decisionId='decision-'+revised.shotSpec.directorDecision.approval.worldAutomation.requestId;
  revised.shotSpec.productionContext.decisionId=revised.shotSpec.directorDecision.decisionId;
  assert.equal((await createImageAdmissionIdentity(revised,namespace)).logicalShotId,first.logicalShotId);
});

test('world receipts cannot be attached to a prose floor, manual-gallery fallback or a second automatic variant',async()=>{
  const value=await job();for(const patch of [{target:'floor'},{floor:0},{messageRef:{messageKey:'floor',revisionId:'rev'}},{inlineByDefault:true},
    {paragraphSelection:{}},{paragraphAnchor:{}},{floorTake:{}},{requestIndex:2},{requestIndex:1.5}])await assert.rejects(createImageAdmissionIdentity({...value,...patch},namespace),{code:'image_attempt_world_identity'});
  const bad=copy(value);bad.shotSpec.directorDecision.approval.worldAutomation=null;bad.automatic=false;
  await assert.rejects(createImageAdmissionIdentity(bad,namespace),{code:'image_attempt_world_identity'});
  await assert.rejects(createImageAdmissionIdentity(value,'st-user:other'),{code:'image_attempt_world_identity'});
});

test('invalid director decisions and mismatching production provenance block world admission before reserving',async()=>{
  for(const change of [v=>v.shotSpec.directorDecision.schema='future',v=>v.shotSpec.directorDecision.status='revoked',
    v=>v.shotSpec.directorDecision.outputs.film=true,v=>v.shotSpec.productionContext.decisionId='other',
    v=>v.shotSpec.productionContext.autoInsert=true,v=>v.shotSpec.productionContext.worldSource.itemId='witem-'+'f'.repeat(64)]){
    const value=await job(),f=setup({resolveWorldApproval:async()=>true});change(value);await assert.rejects(admit(f,value));assert.deepEqual(f.calls,[]);await f.runtime.close();
  }
});

test('a world authorization contract alone cannot replace the durable attempt verifier',async()=>{
  const value=await job(),f=setup();await assert.rejects(admit(f,value),{code:'image_attempt_world_claim'});assert.deepEqual(f.calls,[]);await f.runtime.close();
});

test('the real world ST claim is required and reverified on both sides of admission and submission',async()=>{
  const value=await job(),approval=value.shotSpec.directorDecision.approval.worldAutomation,transport=streamCheckpointTransport(namespace);
  const storage=await createWorldAutomaticStorage({scope:{namespace,source:approval.source},guard:()=>true,createStorage:transport.createStorage});let checks=0;
  const f=setup({resolveWorldApproval:async(_job,expected)=>{checks++;const saved=await storage.read();return Boolean(saved&&saved.requestId===expected.requestId&&['preparing','queued'].includes(saved.status));}});
  await assert.rejects(admit(f,value),{code:'image_attempt_world_claim'});assert.deepEqual(f.calls,[]);
  const started={version:1,requestId:approval.requestId,status:'preparing',updatedAt:100};await storage.prepare(started);checks=0;
  await admit(f,value);assert.equal(checks,2);await storage.settle(started,'queued');await f.runtime.beforeSubmit(value);assert.equal(checks,4);
  await f.runtime.settle(value,'succeeded');assert.deepEqual(f.calls,['claim','begin','settle']);
  const duplicate=copy(value);duplicate.id='second';await assert.rejects(admit(f,duplicate),{code:'image_attempt_already_generated'});
  await f.runtime.close();storage.close();
});

test('revoking the stored claim during admission releases the reservation and never reaches submit',async()=>{
  let saved=true;const value=await job(),f=setup({resolveWorldApproval:async()=>saved,afterClaim:()=>{saved=false;}});
  await assert.rejects(admit(f,value),{code:'image_attempt_world_claim'});assert.deepEqual(f.calls,['claim','settle']);
  const identity=await createImageAdmissionIdentity(value,namespace);assert.equal(f.store.inspect(identity.scope).automaticUsed,0);assert.equal(value.imageAdmission,undefined);await f.runtime.close();
});

test('a claim no longer valid before dispatch never reaches the image begin operation',async()=>{
  let saved=true;const value=await job(),f=setup({resolveWorldApproval:async()=>saved});await admit(f,value);saved=false;
  await assert.rejects(f.runtime.beforeSubmit(value),{code:'image_attempt_world_claim'});assert.deepEqual(f.calls,['claim']);await f.runtime.close();
});

test('mutating an admitted world identity or changing it to manual cannot bypass the captured receipt',async()=>{
  for(const change of [v=>v.automatic=false,v=>v.target='floor',v=>v.shotSpec.productionContext.packetId='different',v=>v.shotSpec.directorDecision.approval.worldAutomation.requestId='wa-'+'d'.repeat(32)]){
    const value=await job(),f=setup({resolveWorldApproval:async()=>true});await admit(f,value);change(value);await assert.rejects(f.runtime.beforeSubmit(value));assert.deepEqual(f.calls,['claim']);await f.runtime.close();
  }
});

test('account changes cannot consume an admitted world receipt',async()=>{
  const value=await job(),f=setup({resolveWorldApproval:async()=>true});await admit(f,value);f.account='st-user:other';
  await assert.rejects(f.runtime.beforeSubmit(value),{code:'image_attempt_account_changed'});assert.deepEqual(f.calls,['claim']);await f.runtime.close();
});

test('cancellation while the persisted world claim is being verified cannot acquire a reservation',async()=>{
  let current=true;const value=await job(),f=setup({resolveWorldApproval:async()=>{current=false;return true;}});
  await assert.rejects(admit(f,value,{valid:()=>current}),{code:'image_attempt_cancelled'});assert.deepEqual(f.calls,[]);await f.runtime.close();
});

test('world authorization is checked again after begin, not only before acquiring the submit reservation',async()=>{
  let checks=0;const value=await job(),f=setup({resolveWorldApproval:async()=>++checks<4});
  await admit(f,value);await assert.rejects(f.runtime.beforeSubmit(value),{code:'image_attempt_world_claim'});
  assert.equal(checks,4);assert.deepEqual(f.calls,['claim','begin']);await f.runtime.close();
});

test('world history reconstructs success and uncertain occupancy without using any message reference',async()=>{
  const value=await job(),first=setup({resolveWorldApproval:async()=>true});await admit(first,value);const identity=await createImageAdmissionIdentity(value,namespace);
  for(const row of [{id:'log',status:'success',recordId:'image',snapshot:copy(value)},
    {id:'log',status:'failed',submissionState:'unknown',snapshot:copy(value)},
    {id:'image',taskId:value.id,url:'/world-image.png',...copy(value)}]){
    const f=setup({resolveWorldApproval:async()=>true}),next=await job();next.id='next';
    const seeds=await createImageHistorySeeds([row],identity);assert.equal(seeds.length,1);assert.equal(seeds[0].automaticSlot,true);
    await assert.rejects(admit(f,next,{history:[row]}));assert.ok(!f.calls.includes('begin'));await f.runtime.close();
  }
  const logs=[{id:'log',status:'success',recordId:'image',snapshot:copy(value)},{...copy(value),id:'image',url:'/world-image.png'}];
  assert.equal((await createImageHistorySeeds(logs,identity)).length,1);await first.runtime.close();
});

test('a lightweight world gallery row retains source and occupancy even without its heavy snapshot',async()=>{
  const value=await job(),f=setup({resolveWorldApproval:async()=>true});await admit(f,value);const identity=await createImageAdmissionIdentity(value,namespace);
  const row={id:'image',taskId:value.id,url:'/world-image.png',chatKey,shotSpec:copy(value.shotSpec),productionContext:copy(value.shotSpec.productionContext),imageAdmission:copy(value.imageAdmission),inline:false,floor:null};
  const seeds=await createImageHistorySeeds([row],identity);assert.equal(seeds.length,1);assert.equal(seeds[0].logicalShotId,identity.logicalShotId);assert.equal(seeds[0].automaticSlot,true);await f.runtime.close();
});

test('missing, foreign or corrupted world history is not silently skipped to manufacture a fresh automatic slot',async()=>{
  const value=await job(),f=setup({resolveWorldApproval:async()=>true});await admit(f,value);const identity=await createImageAdmissionIdentity(value,namespace);
  for(const change of [v=>delete v.shotSpec.directorDecision,v=>v.imageAdmission.namespace='st-user:other',v=>v.imageAdmission.logicalShotId='f'.repeat(64),
    v=>v.shotSpec.directorDecision.approval.worldAutomation=null]){
    const row={...copy(value),url:'/world-image.png'};change(row);await assert.rejects(createImageHistorySeeds([row],identity));
  }
  assert.deepEqual(await createImageHistorySeeds([{...copy(value),chatKey:'other-chat',url:'/world.png'},{id:'ordinary',chatKey,status:'success',messageRef:{messageKey:'floor',revisionId:'revision'}}],identity),[]);await f.runtime.close();
});

test('world automatic generation cannot spend a second variant or count greater than one; prose budgets remain independent',async()=>{
  const value=await job(),f=setup({resolveWorldApproval:async()=>true}),prose={id:'prose',chatKey,target:'floor',messageRef:{messageKey:'prose-floor',revisionId:'rev-a'},automatic:true,profile:{count:'1'},prompt:'garden'};
  await admit(f,prose,{maxAutomatic:1});await f.runtime.beforeSubmit(prose);await f.runtime.settle(prose,'succeeded');await admit(f,value,{maxAutomatic:1});
  assert.equal(f.store.inspect((await createImageAdmissionIdentity(value,namespace)).scope).automaticUsed,1);
  const next=await job();next.id='another-world';next.payload.parameters.count=2;const g=setup({resolveWorldApproval:async()=>true});await assert.rejects(admit(g,next),{code:'image_attempt_count'});await f.runtime.close();await g.runtime.close();
});

test('a manual redraw of a world original preserves its scope and does not require fresh automatic permission',async()=>{
  const value=await job(),f=setup({resolveWorldApproval:async()=>true});await admit(f,value);await f.runtime.beforeSubmit(value);await f.runtime.settle(value,'succeeded');
  const identity=await createImageAdmissionIdentity(value,namespace),manual=copy(value);manual.id='manual-redraw';manual.automatic=false;manual.attempt=2;
  await admit(f,manual);await f.runtime.beforeSubmit(manual);await f.runtime.settle(manual,'succeeded');
  assert.equal(f.store.inspect(identity.scope).automaticUsed,1);assert.equal(manual.imageAdmission.automaticSlot,true);await f.runtime.close();
});
