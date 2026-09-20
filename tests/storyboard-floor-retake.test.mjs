import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as takes from '../qianmu-storyboard-floor-take.js';
import * as capture from '../qianmu-storyboard-floor-capture.js';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve:value=>resolve(value)};};
const ref=core.createStoryboardMessageReference({chatKey:'chat',floor:0,message:{mes:'Alice cooks.',send_date:'synthetic',swipe_id:0}});
const baseline=()=>({id:'old',chatKey:'chat',floor:0,messageRef:copy(ref),swipeId:0,inline:true,url:'/old.png',snapshot:{prompt:'original recipe'}});
function prepared({count=3,old=[baseline()],id='take',time=100}={}) {
  const plan={...core.createStoryboardWorkflowTicket({id,chatKey:'chat',floor:0,messageRef:ref}),shots:Array.from({length:count},(_,i)=>({id:`s${i}`}))};
  plan.floorTake={...takes.createStoryboardFloorTake(plan,old,row=>row.inline),startedAt:time};
  const jobs=plan.shots.map((shot,i)=>({id:`${id}-job-${i}`,planId:id,planShotId:shot.id,chatKey:'chat',floor:0,messageRef:copy(ref),inlineByDefault:true,
    profile:{count:'1'},inlineOrder:{version:1,batchId:id,batchStartedAt:time,shotIndex:i,requestIndex:1}}));
  takes.bindStoryboardFloorTakeJobs(plan,jobs);
  return {plan,jobs,old};
}
const image=(job,extra={})=>({id:job.id+'-image',planId:job.planId,planShotId:job.planShotId,chatKey:job.chatKey,floor:0,messageRef:copy(job.messageRef),
  inlineOrder:copy(job.inlineOrder),imageIndex:0,url:'/new.png',requestedInline:true,inline:takes.storyboardFloorTakeInitialInline(job),
  floorTake:copy(job.floorTake),floorTakeEligible:true,...extra});

test('3→1→2 receipts retain the old inline take until every slot is saved, without changing originals or unrelated supplements',()=>{
  const f=prepared(),rows=f.old,original=copy(rows[0]);rows.push(image(f.jobs[2]));takes.settleStoryboardFloorTakes(rows);
  assert.equal(rows[0].inline,true);assert.equal(rows[1].inline,false);rows.push(image(f.jobs[0]));takes.settleStoryboardFloorTakes(rows);assert.equal(rows[0].inline,true);
  const supplement={...baseline(),id:'later-supplement'};rows.push(supplement,image(f.jobs[1]));takes.settleStoryboardFloorTakes(rows);
  assert.equal(rows[0].inline,false);assert.equal(supplement.inline,true);assert.ok(rows.filter(row=>row.floorTake).every(row=>row.inline&&row.floorTakeCommittedAt>0));
  assert.deepEqual({...rows[0],inline:true},original);assert.equal(rows.length,5);
  assert.deepEqual(core.sortStoryboardInlineRecords(rows.filter(row=>row.floorTake)).map(row=>row.planShotId),['s0','s1','s2']);
});

test('new first-time images can appear incrementally; a failed/missing retake slot cannot replace existing images',()=>{
  const first=prepared({old:[]}),retake=prepared();assert.equal(takes.storyboardFloorTakeInitialInline(first.jobs[0]),true);
  const rows=[...retake.old,image(retake.jobs[0]),image(retake.jobs[2])];takes.settleStoryboardFloorTakes(rows);
  assert.equal(rows[0].inline,true);assert.equal(rows.filter(r=>r.inline).length,1);
});

test('a later successful take wins over an older late retry, including same-time deterministic ties',()=>{
  for(const sameTime of [false,true]){
    const a=prepared({count:1,id:'a',time:100}),b=prepared({count:1,id:'b',time:sameTime?100:101}),rows=[...a.old,image(b.jobs[0])];
    takes.settleStoryboardFloorTakes(rows);rows.push(image(a.jobs[0]));takes.settleStoryboardFloorTakes(rows);
    assert.equal(rows.find(r=>r.planId==='b').inline,true);assert.equal(rows.find(r=>r.planId==='a').inline,false);
  }
});

test('foreign floor, revision, incomplete batch, duplicated image positions or disagreeing manifests never cause replacement',()=>{
  for(const alter of [r=>r.messageRef.messageKey='other',r=>r.messageRef.revisionId='other',r=>r.floorTakeEligible=false,r=>r.floorTake.version=99,
    r=>r.floorTake.slots[0].imageCount=2]){
    const f=prepared({count:1}),r=image(f.jobs[0]);alter(r);const rows=[...f.old,r];takes.settleStoryboardFloorTakes(rows);assert.equal(rows[0].inline,true);
  }
  const f=prepared({count:1});f.plan.floorTake.slots[0].imageCount=2;f.jobs[0].floorTake=copy(f.plan.floorTake);
  const rows=[...f.old,image(f.jobs[0]),image(f.jobs[0],{id:'duplicate'})];takes.settleStoryboardFloorTakes(rows);assert.equal(rows[0].inline,true);
  const foreign={...baseline(),id:'foreign',chatKey:'other',messageRef:{...ref,chatKey:'other'}};
  const g=prepared({count:1,old:[baseline(),foreign]});assert.deepEqual(g.plan.floorTake.baselineIds,['old']);
});

test('failed metadata save can roll back visibility only, and later changes are not overwritten by rollback',()=>{
  const f=prepared({count:1}),rows=[...f.old,image(f.jobs[0])],transaction=takes.settleStoryboardFloorTakes(rows);
  assert.equal(rows[0].inline,false);transaction.rollback();assert.equal(rows[0].inline,true);assert.equal(rows[1].inline,false);assert.equal(rows[1].floorTakeCommittedAt,undefined);
  const later=takes.settleStoryboardFloorTakes(rows);rows[1].floorTakeCommittedAt=999;later.rollback();assert.equal(rows[1].floorTakeCommittedAt,999);
});

test('same-gallery commits serialize failed and successful saves, while another gallery is not held up',async()=>{
  const f=prepared({count:1}),rows=[...f.old,image(f.jobs[0])],gate=deferred(),started=deferred(),calls=[];
  const first=takes.saveStoryboardFloorTakes(rows,async()=>{calls.push('first');started.resolve();await gate.promise;throw Error('first failed');});
  const rejection=assert.rejects(first,/first failed/);await started.promise;
  const second=takes.saveStoryboardFloorTakes(rows,async()=>{calls.push('second');assert.equal(rows[0].inline,false);});
  await takes.saveStoryboardFloorTakes([],async()=>calls.push('other'));
  assert.deepEqual(calls,['first','other']);gate.resolve();await rejection;await second;
  assert.deepEqual(calls,['first','other','second']);assert.equal(rows[0].inline,false);assert.equal(rows[1].inline,true);assert.ok(rows[1].floorTakeCommittedAt>0);
});

test('queued save checks chat ownership again and cannot write into the newly selected chat',async()=>{
  const rows=[],gate=deferred(),started=deferred();let current=true,writes=0;
  const first=takes.saveStoryboardFloorTakes(rows,async()=>{started.resolve();await gate.promise;});await started.promise;
  const second=takes.saveStoryboardFloorTakes(rows,async()=>writes++,()=>true,()=>current);
  const rejection=assert.rejects(second,/聊天已切换/);current=false;gate.resolve();await first;await rejection;assert.equal(writes,0);
});

test('serialized plans, snapshots and unknown versions retain typed retake provenance, and retries require the exact original slots',()=>{
  const f=prepared(),saved=core.normalizeStoryboardState({shotPlans:[f.plan]}).shotPlans[0];assert.deepEqual(saved.floorTake,f.plan.floorTake);
  const snap=core.sanitizeStoryboardSnapshot({...f.jobs[0],source:'novel',payload:{prompt:'synthetic'}});assert.deepEqual(snap.floorTake,f.plan.floorTake);
  takes.applyStoryboardFloorTakeToJob({floorTake:saved.floorTake},f.jobs[0]);assert.throws(()=>takes.applyStoryboardFloorTakeToJob({floorTake:saved.floorTake},{...f.jobs[0],planShotId:'unknown'}),/未重试/);
  const future=core.sanitizeStoryboardSnapshot({...f.jobs[0],floorTake:{version:99}});assert.deepEqual(future.floorTake,{invalid:true});assert.equal(takes.storyboardFloorTakeInitialInline(future),false);
});

test('legacy gallery trimming cannot drop a retake baseline or the just-received originals',()=>{
  const f=prepared({count:1}),rows=[...f.old,...Array.from({length:399},(_,i)=>({id:'legacy-'+i})),image(f.jobs[0])];
  const removed=takes.pruneStoryboardRetakeGallery(rows,[rows.at(-1)]);assert.equal(rows.length,400);assert.equal(rows[0].id,'old');assert.equal(removed.length,1);assert.notEqual(removed[0].id,'old');
});

async function entryFixture(){
  const e=await compilerEnvironment(),message=e.context.ctx().chat[0],reference=core.createStoryboardMessageReference({chatKey:'chat-a',floor:0,message});
  const gallery=[{id:'previous-image',chatKey:'chat-a',floor:0,messageRef:reference,swipeId:0,inline:true,url:'/old.png',snapshot:{prompt:'old recipe'}}];
  const oldPlan={...core.createStoryboardWorkflowTicket({id:'old-plan',chatKey:'chat-a',floor:0,messageRef:reference}),status:'completed',shots:[{id:'old-shot',prompt:'old',status:'completed'}],archiveRef:'untouched-archive'};
  e.state.shotPlans=[oldPlan];e.state.prompt='old valid draft';e.state.promptDraft.compiled='old valid draft';
  e.context.storyboardAdmissionEpoch=0;let choice={mode:'auto',paragraphIndex:null,selection:null},saveFailure=false;
  const load=e.context.featureRuntime.load;e.context.featureRuntime.load=async key=>key==='storyboardFloorCapture'?capture:key==='imageAdmission'?{resolveImageAccountNamespace:async()=> 'st-user:route-test'}:load(key);
  Object.assign(e.context,{storyboardMessageFloor:()=>0,storyboardChooseCaptureMode:async()=>choice,storyboardGalleryRecords:()=>gallery,
    storyboardProductionDeliveryPolicy:core.storyboardProductionDeliveryPolicy,
    storyboardReconcileGalleryLinks:()=>{},storyboardInlineRecordValid:r=>r.inline,storyboardDeletePlanArchives:async()=>{},storyboardPlanCompilerSignature:()=> 'same compiler',
    storyboardPlanForJob:job=>e.state.shotPlans.find(p=>p.id===job.planId),storyboardItemCollectionIds:()=>[],uniqueClean:v=>v,
    storyboardPersistGatewayImage:async(_image,job,index)=>`/saved/${job.id}-${index}.png`,storyboardValidatedAnchor:()=>({valid:true,floor:0,message}),
    runningHubUsageFields:()=>({}),storyboardPipelineStage:()=>{},storyboardFinishLog:()=>{},saveMetadata:async()=>{if(saveFailure)throw Error('metadata save failed');},
    storyboardArchiveGallerySnapshots:()=>{},storyboardDeleteRecordSnapshots:()=>{},
  });
  vm.runInContext(['storyboardPlanForMessage','storyboardEnsurePlan','storyboardOnChatClick','storyboardCreateRecord','storyboardDeliverGatewayResult'].map(section).join('\n'),e.context);
  const button={dataset:{storyboardChatAction:'capture-floor'},closest:()=>({})};
  return {...e,gallery,oldPlan,setChoice:value=>choice=value,setSaveFailure:value=>saveFailure=value,
    click:()=>e.context.storyboardOnChatClick({target:{closest:()=>button},preventDefault(){},stopPropagation(){}}),
    deliver:job=>e.context.storyboardDeliverGatewayResult(job,null,{images:[{url:'/synthetic.png'}]},{service:true})};
}

test('actual floor action → two-step extraction → mixed-route jobs → receipt saves performs a new full take and preserves archived previous plans',async()=>{
  const e=await entryFixture(),before=copy(e.oldPlan);assert.equal(await e.click(),true,JSON.stringify(e.notices));assert.equal(e.llmCalls.length,2);assert.equal(e.jobs.length,3);
  assert.deepEqual(e.oldPlan,before);assert.notEqual(e.jobs[0].planId,e.oldPlan.id);assert.ok(e.jobs.every(job=>job.floorTake?.slots.length===3));
  await e.deliver(e.jobs[2]);assert.equal(e.gallery[0].inline,true);await e.deliver(e.jobs[0]);assert.equal(e.gallery[0].inline,true);
  await e.deliver(e.jobs[1]);assert.equal(e.gallery[0].inline,false);assert.equal(e.gallery.filter(row=>row.inline).length,3);assert.equal(e.gallery[0].snapshot.prompt,'old recipe');
  const saved=copy(e.gallery);await e.deliver(e.jobs[1]);assert.equal(e.gallery.length,4,'receipt replay does not duplicate images');assert.deepEqual(copy(e.gallery),saved);
});

test('actual failed full-floor extraction retains draft, target and previous successful plan, without submitting images',async()=>{
  const e=await entryFixture();e.state.target='gallery';e.state.floor='';const before=copy(e.state.promptDraft),old=copy(e.oldPlan);
  e.context.storyboardCallCompiler=async()=>'{ invalid';assert.equal(await e.click(),false);
  assert.equal(e.jobs.length,0);assert.equal(e.state.target,'gallery');assert.equal(e.state.floor,'');assert.equal(e.state.prompt,'old valid draft');assert.deepEqual(copy(e.state.promptDraft),before);assert.deepEqual(e.oldPlan,old);assert.equal(e.gallery[0].inline,true);
});

test('actual supplement only appends; cancel/double-click/stale dialog cannot buy a retake; busy compiler blocks manual generation',async()=>{
  const supplement=await entryFixture();supplement.setChoice({mode:'manual_supplement',paragraphIndex:0,selection:core.normalizeStoryboardParagraphSelection({mode:'manual_supplement',indexes:[0]})});
  supplement.response.shots.splice(1);assert.equal(await supplement.click(),true,JSON.stringify(supplement.notices));assert.ok(supplement.jobs.every(j=>!j.floorTake));assert.equal(supplement.gallery[0].inline,true);
  const cancelled=await entryFixture();cancelled.setChoice(null);assert.equal(await cancelled.click(),false);assert.equal(cancelled.llmCalls.length,0);
  const stale=await entryFixture();stale.context.storyboardChooseCaptureMode=async()=>{stale.context.storyboardAdmissionEpoch++;return {mode:'auto'};};assert.equal(await stale.click(),false);assert.equal(stale.llmCalls.length,0);
  const busy=await entryFixture();busy.context.storyboardCompilerBusy=true;await busy.context.storyboardGenerate(null);assert.equal(busy.jobs.length,0);
});

test('actual delivery rollback leaves previous take readable when its metadata save fails',async()=>{
  const e=await entryFixture();assert.equal(await e.click(),true);await e.deliver(e.jobs[0]);await e.deliver(e.jobs[1]);e.setSaveFailure(true);
  await assert.rejects(e.deliver(e.jobs[2]),/metadata save failed/);assert.equal(e.gallery[0].inline,true);assert.ok(e.gallery.slice(1).every(r=>!r.inline));
});

test('a second click while the chooser is open cannot start another extraction, and opening does not wait for account I/O',async()=>{
  const e=await entryFixture(),choice=deferred(),identity=deferred(),opened=deferred(),load=e.context.featureRuntime.load;let prompts=0;
  e.context.featureRuntime.load=async key=>key==='imageAdmission'?{resolveImageAccountNamespace:()=>identity.promise}:load(key);
  e.context.storyboardChooseCaptureMode=async()=>{prompts++;opened.resolve();return choice.promise;};
  const first=e.click();await opened.promise;assert.equal(prompts,1);assert.equal(await e.click(),false);assert.equal(prompts,1);assert.equal(e.llmCalls.length,0);
  choice.resolve(null);assert.equal(await first,false);identity.resolve('st-user:route-test');assert.equal(e.jobs.length,0);
});

test('failed capture restores untouched controls but never overwrites a concurrent user edit',()=>{
  for(const edit of ['prompt','target','compiler']){
    const state=core.createStoryboardDefaults(),reservation=takes.createStoryboardCaptureReservation(state);state.target='floor';reservation.seal();
    if(edit==='prompt')state.prompt='user typed';if(edit==='target')state.floor='9';if(edit==='compiler')state.promptCompiler.enabled=!state.promptCompiler.enabled;
    const before=copy(state);assert.equal(reservation.restore(),false);assert.deepEqual(state,before);
  }
});

test('full gallery refuses a new retake before extraction instead of dropping archived originals',async()=>{
  const e=await entryFixture();e.gallery.push(...Array.from({length:399},(_,i)=>({id:`kept-${i}`,inline:false})));
  assert.equal(await e.click(),false);assert.equal(e.llmCalls.length,0);assert.equal(e.jobs.length,0);assert.equal(e.gallery.length,400);assert.equal(e.gallery[0].inline,true);assert.match(e.notices.at(-1),/索引空间不足/);
});

test('cross-chat cold delivery preserves originals until committed and a failed metadata save must be retried before clearing its inbox',async()=>{
  const e=await entryFixture(),inbox=new Map(),foreign=[],key=e.context.getChatKey;assert.equal(await e.click(),true);
  Object.assign(e.context,{storyboardDeliveryDrainPromise:null,storyboardVolatileDeliveries:new Map(),rerenderIfOpen(){},
    blobStore:{listStoryboardDeliveries:async()=>[...inbox.values(),{chatKey:'other',taskId:'foreign',records:[{id:'foreign'}]}],deleteStoryboardDelivery:async id=>{inbox.delete(id);foreign.push(id);}},
    storyboardStoreDeferredDelivery:async(job,records)=>{inbox.set(job.id,{taskId:job.id,chatKey:job.chatKey,target:job.target,records:copy(records)});return 'pending_chat';}});
  vm.runInContext(['storyboardValidatedAnchor','storyboardDrainPendingDeliveries'].map(section).join('\n'),e.context);
  e.context.getChatKey=()=> 'other';for(const job of e.jobs)await e.deliver(job);assert.equal(e.gallery.length,1);assert.equal(inbox.size,3);
  e.context.getChatKey=key;e.setSaveFailure(true);await assert.rejects(e.context.storyboardDrainPendingDeliveries('chat-a'),/metadata save failed/);
  assert.equal(inbox.size,3);assert.equal(e.gallery.length,4);assert.equal(e.gallery[0].inline,true);assert.ok(e.gallery.slice(1).every(row=>!row.inline));
  e.setSaveFailure(false);await e.context.storyboardDrainPendingDeliveries('chat-a');
  assert.equal(inbox.size,0);assert.equal(e.gallery[0].inline,false);assert.equal(e.gallery.filter(row=>row.inline).length,3);assert.equal(foreign.includes('foreign'),false);assert.equal(e.gallery.some(row=>row.id==='foreign'),false);
});

test('a source edit after partial receipt cannot activate the uncommitted retake; a single-image redraw clears its whole-take manifest',()=>{
  const f=prepared({count:1}),rows=[...f.old,image(f.jobs[0])];takes.settleStoryboardFloorTakes(rows,()=>false);assert.equal(rows[0].inline,true);assert.equal(rows[1].inline,false);
  assert.match(section('storyboardRedrawRecord'),/delete snapshot\.floorTake;[\s\S]*storyboardJobFromLog/);
});
