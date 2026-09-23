import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {galleryMembershipSnapshot} from '../qianmu-gallery-membership.js';
import * as takes from '../qianmu-storyboard-floor-take.js';
import * as receipts from '../qianmu-storyboard-floor-take-receipt.js';
import * as capture from '../qianmu-storyboard-floor-capture.js';
import {migrateQianmuChatStoreV2} from '../qianmu-data-migrations.js';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {captureStoryboardContinuation,saveStoryboardContinuation} from '../qianmu-storyboard-continuation.js';
import {captureStoryboardStreamFrame,createStoryboardStreamMessageReference} from '../qianmu-storyboard-stream-source.js?v=1.59.331';
import {bindStoryboardStreamBudgetFamily} from '../qianmu-storyboard-stream-reference.js?v=1.59.331';
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve:value=>resolve(value)};};
const ref=core.createStoryboardMessageReference({chatKey:'chat',floor:0,message:{mes:'Alice cooks.',send_date:'synthetic',swipe_id:0}});
const baseline=()=>({id:'old',chatKey:'chat',floor:0,messageRef:copy(ref),swipeId:0,inline:true,url:'/old.png',snapshot:{prompt:'original recipe'}});
function prepared({count=3,old=[baseline()],id='take',time=100,pending=[],history=[],reference=ref,messageKeys=null}={}) {
  const plan={...core.createStoryboardWorkflowTicket({id,chatKey:'chat',floor:0,messageRef:reference}),shots:Array.from({length:count},(_,i)=>({id:`s${i}`}))};
  plan.floorTake={...takes.createStoryboardFloorTake(plan,old,row=>row.inline,pending,history,messageKeys),startedAt:time};
  const jobs=plan.shots.map((shot,i)=>({id:`${id}-job-${i}`,planId:id,planShotId:shot.id,chatKey:'chat',floor:0,messageRef:copy(reference),inlineByDefault:true,
    profile:{count:'1'},inlineOrder:{version:1,batchId:id,batchStartedAt:time,shotIndex:i,requestIndex:1}}));
  takes.bindStoryboardFloorTakeJobs(plan,jobs);
  return {plan,jobs,old};
}
const image=(job,extra={})=>({id:job.id+'-image',taskId:job.id,planId:job.planId,planShotId:job.planShotId,chatKey:job.chatKey,floor:0,messageRef:copy(job.messageRef),
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

test('legacy gallery trimming compatibility export retains every original and the just-received image',()=>{
  const f=prepared({count:1}),rows=[...f.old,...Array.from({length:399},(_,i)=>({id:'legacy-'+i})),image(f.jobs[0])];
  const before=copy(rows),removed=takes.pruneStoryboardRetakeGallery(rows,[rows.at(-1)]);assert.equal(rows.length,401);assert.deepEqual(rows,before);assert.deepEqual(removed,[]);
});

test('an unrelated receipt cannot prune an active retake baseline before its first new image arrives',()=>{
  const f=prepared({count:1}),received={id:'unrelated-receipt'},rows=[...f.old,...Array.from({length:399},(_,i)=>({id:`legacy-${i}`})),received];
  takes.pruneStoryboardRetakeGallery(rows,[received],[f.plan.floorTake]);
  assert.equal(rows.length,401);assert.equal(rows.some(row=>row.id==='old'),true);assert.equal(rows.includes(received),true);
});

async function entryFixture(){
  const e=await compilerEnvironment(),message=e.context.ctx().chat[0],reference=core.createStoryboardMessageReference({chatKey:'chat-a',floor:0,message});
  const gallery=[{id:'previous-image',chatKey:'chat-a',floor:0,messageRef:reference,swipeId:0,inline:true,url:'/old.png',snapshot:{prompt:'old recipe'}}],history=[];
  const oldPlan={...core.createStoryboardWorkflowTicket({id:'old-plan',chatKey:'chat-a',floor:0,messageRef:reference}),status:'completed',shots:[{id:'old-shot',prompt:'old',status:'completed'}],archiveRef:'untouched-archive'};
  e.state.shotPlans=[oldPlan];e.state.prompt='old valid draft';e.state.promptDraft.compiled='old valid draft';
  e.context.storyboardAdmissionEpoch=0;let choice={mode:'auto',paragraphIndex:null,selection:null},saveFailure=false;
  const load=e.context.featureRuntime.load;e.context.featureRuntime.load=async key=>key==='storyboardFloorCapture'?capture:key==='imageAdmission'?{resolveImageAccountNamespace:async()=> 'st-user:route-test'}:load(key);
  Object.assign(e.context,{storyboardMessageFloor:()=>0,storyboardChooseCaptureMode:async()=>choice,storyboardGalleryRecords:()=>gallery,storyboardFloorTakeReceipts:()=>history,
    storyboardProductionDeliveryPolicy:core.storyboardProductionDeliveryPolicy,
    storyboardReconcileGalleryLinks:()=>{},storyboardInlineRecordValid:r=>r.inline,storyboardDeletePlanArchives:async()=>{},storyboardPlanCompilerSignature:()=> 'same compiler',
    storyboardPlanForJob:job=>e.state.shotPlans.find(p=>p.id===job.planId),galleryMembershipSnapshot,uniqueClean:v=>v,
    storyboardPersistGatewayImage:async(_image,job,index)=>`/saved/${job.id}-${index}.png`,storyboardValidatedAnchor:()=>({valid:true,floor:0,message}),
    runningHubUsageFields:()=>({}),storyboardPipelineStage:()=>{},storyboardFinishLog:()=>{},saveMetadata:async()=>{if(saveFailure)throw Error('metadata save failed');},
    storyboardArchiveGallerySnapshots:()=>{},storyboardDeleteRecordSnapshots:()=>{},
  });
  vm.runInContext(['storyboardPlanForMessage','storyboardEnsurePlan','storyboardOnChatClick','storyboardCreateRecord','storyboardDeliverGatewayResult'].map(section).join('\n'),e.context);
  const button={dataset:{storyboardChatAction:'capture-floor'},closest:()=>({})};
  return {...e,gallery,history,oldPlan,setChoice:value=>choice=value,setSaveFailure:value=>saveFailure=value,
    click:()=>e.context.storyboardOnChatClick({target:{closest:()=>button},preventDefault(){},stopPropagation(){}}),
    deliver:job=>e.context.storyboardDeliverGatewayResult(job,null,{images:[{url:'/synthetic.png'}]},{service:true})};
}

async function continuedEntryFixture(ordinary=false){
  const e=await entryFixture(),host=e.context.ctx(),message=host.chat[0];
  Object.assign(message,{name:'Alice',send_date:'day-1',gen_started:'generation-1',swipe_id:0});
  const options={getContext:()=>host,epoch:()=>0,resolveNamespace:async()=>'st-user:route-test',isCurrent:()=>true,floor:0,createReference:core.createStoryboardMessageReference};
  const source=async()=>{const frame=await captureStoryboardStreamFrame(options);try{return await createStoryboardStreamMessageReference(frame);}finally{frame.close();}};
  message.mes+='\n\n';const original=ordinary?core.createStoryboardMessageReference({message,chatKey:'chat-a',floor:0}):await source();e.gallery[0].messageRef=copy(original);e.gallery[0].taskId='original-delivered';
  Object.assign(e.oldPlan,{messageRef:copy(original),revisionId:original.revisionId});
  const handle=captureStoryboardContinuation({...options,type:'continue'});message.mes+='The light dims.\n\n';
  Object.assign(message,{send_date:'day-2',gen_started:'generation-2',swipe_info:[{send_date:'day-2',gen_started:'generation-2',extra:{}}]});
  try{await saveStoryboardContinuation(handle,options.resolveNamespace,host.chatMetadata.story_director_liminale,async()=>{});}finally{handle.close();}
  const resolve=reference=>core.resolveStoryboardMessageReference(reference,host.chat,{chatKey:'chat-a',namespace:'st-user:route-test',metadata:host.chatMetadata});
  if(ordinary)message.mes=message.mes.trimEnd();
  const continued=ordinary?core.createStoryboardMessageReference({message,chatKey:'chat-a',floor:0}):await bindStoryboardStreamBudgetFamily(await source(),original,'st-user:route-test',resolve);
  // ST trims terminal whitespace at completion; the simplified compiler fixture
  // treats every split segment as a paragraph and must not invent an empty one.
  message.mes=message.mes.trimEnd();
  e.gallery.push({...copy(e.gallery[0]),id:'continued-image',taskId:'continued-delivered',messageRef:copy(continued),snapshot:{prompt:'continued recipe'}});
  const pending=(id,reference)=>({id,chatKey:'chat-a',messageRef:copy(reference),status:'generating',uiVisible:true,inlineByDefault:true,target:'floor',planId:e.oldPlan.id});
  e.context.storyboardQueue.push(pending('original-pending',original));e.context.storyboardActiveJobs.set('continued-pending',pending('continued-pending',continued));
  e.context.storyboardInlineRecordValid=row=>row.inline&&resolve(row.messageRef).state==='active';
  e.context.storyboardValidatedAnchor=job=>{const result=resolve(job.messageRef);return {...result,valid:result.state==='active'};};
  return {...e,host,message,original,continued,resolve};
}

test('actual continued floor retake captures both key generations, commits together and preserves all old recipes',async()=>{
  const e=await continuedEntryFixture(),old=e.gallery.map(copy);assert.equal(await e.click(),true,JSON.stringify(e.notices));
  const take=e.jobs[0].floorTake;assert.equal(take.version,2);assert.deepEqual(take.messageKeys,[e.continued.messageKey,e.original.messageKey]);
  assert.deepEqual(take.baselineIds,['previous-image','continued-image']);
  assert.deepEqual(new Set(take.baselineTaskIds),new Set(['original-delivered','continued-delivered','original-pending','continued-pending']));
  await e.deliver(e.jobs[2]);await e.deliver(e.jobs[0]);assert.ok(e.gallery.slice(0,2).every(row=>row.inline));
  await e.deliver(e.jobs[1]);assert.ok(e.gallery.slice(0,2).every(row=>!row.inline));assert.equal(e.gallery.filter(row=>row.inline).length,3);
  assert.deepEqual(e.gallery.slice(0,2).map(row=>({...copy(row),inline:true})),old);
  assert.equal(e.history.length,2);assert.ok(e.history.every(row=>row.version===1&&!Object.hasOwn(row,'messageKeys')));
  assert.deepEqual(new Set(e.history.map(row=>row.messageKey)),new Set(take.messageKeys));
});

test('actual ordinary-source continued retake preserves old-generation originals until all new images have been saved',async()=>{
  const e=await continuedEntryFixture(true),before=e.gallery.map(copy);assert.equal(e.resolve(e.original).ordinaryContinuation,true);
  assert.equal(await e.click(),true,JSON.stringify(e.notices));assert.deepEqual(e.jobs[0].floorTake.baselineIds,['previous-image','continued-image']);
  await e.deliver(e.jobs[0]);assert.ok(e.gallery.slice(0,2).every(row=>row.inline));
  await e.deliver(e.jobs[2]);await e.deliver(e.jobs[1]);assert.ok(e.gallery.slice(0,2).every(row=>!row.inline));
  assert.deepEqual(e.gallery.slice(0,2).map(row=>({...copy(row),inline:true})),before);assert.equal(e.history.length,2);
});

test('late old-key and continued-key receipts remain gallery-only after deleting the whole replacement, while new user work stays independent',async()=>{
  const e=await continuedEntryFixture();assert.equal(await e.click(),true);for(const job of e.jobs)await e.deliver(job);
  e.gallery.splice(2);e.history.splice(0,e.history.length,...copy(e.history));
  for(const [id,reference] of [['original-pending',e.original],['continued-pending',e.continued]]){
    const late={...copy(e.jobs[0]),id,planId:e.oldPlan.id,messageRef:copy(reference)};delete late.floorTake;
    await e.deliver(late);assert.equal(e.gallery.find(row=>row.taskId===id).inline,false);
    const fresh={...copy(late),id:`new-user-${id}`};await e.deliver(fresh);assert.equal(e.gallery.find(row=>row.taskId===fresh.id).inline,true);
  }
});

test('failed save of a continued replacement rolls back all key receipts and keeps both old generations readable',async()=>{
  const e=await continuedEntryFixture();assert.equal(await e.click(),true);await e.deliver(e.jobs[0]);await e.deliver(e.jobs[1]);
  e.setSaveFailure(true);await assert.rejects(e.deliver(e.jobs[2]),/metadata save failed/);
  assert.equal(e.history.length,0);assert.ok(e.gallery.slice(0,2).every(row=>row.inline));assert.ok(e.gallery.slice(2).every(row=>!row.inline));
  e.setSaveFailure(false);await e.deliver(e.jobs[2]);assert.equal(e.history.length,2);assert.ok(e.gallery.slice(0,2).every(row=>!row.inline));
});

test('corrupt or foreign-account continuation ownership stops the actual retake before plan creation or any model request',async()=>{
  for(const field of ['digest','id','namespace']){
    const e=await continuedEntryFixture(),row=e.host.chatMetadata.story_director_liminale.storyboardContinuations[0],before=copy(e.gallery),plans=e.state.shotPlans.length;
    row[field]=field==='namespace'?'st-user:other':'a'.repeat(64);
    assert.equal(await e.click(),false);assert.equal(e.llmCalls.length,0);assert.equal(e.jobs.length,0);assert.equal(e.state.shotPlans.length,plans);assert.deepEqual(e.gallery,before);
  }
});

test('host identity changing while the retake chooser is open cancels even when prose and swipe are unchanged',async()=>{
  const e=await continuedEntryFixture(),before=copy(e.gallery);
  e.context.storyboardChooseCaptureMode=async()=>{e.message.gen_started='another-generation';return {mode:'auto'};};
  assert.equal(await e.click(),false);assert.equal(e.llmCalls.length,0);assert.equal(e.jobs.length,0);assert.deepEqual(e.gallery,before);
});

test('multi-key take manifests survive normalizers and retries but malformed or downgraded aliases never become a one-key take',()=>{
  const current={...ref,messageKey:'continued',revisionId:'new-revision'},f=prepared({reference:current,messageKeys:['continued',ref.messageKey]});
  const normalized=core.normalizeStoryboardState({shotPlans:[f.plan]}).shotPlans[0];assert.deepEqual(normalized.floorTake,f.plan.floorTake);
  assert.deepEqual(core.sanitizeStoryboardSnapshot({...f.jobs[0],source:'novel'}).floorTake,f.plan.floorTake);
  takes.applyStoryboardFloorTakeToJob(normalized,f.jobs[0]);
  for(const mutate of [take=>take.version=1,take=>take.version=99,take=>delete take.messageKeys,take=>take.messageKeys=[],
    take=>take.messageKeys=['other',ref.messageKey],take=>take.messageKeys=['continued','continued'],take=>take.messageKeys=['continued','bad\nkey'],
    take=>take.messageKeys=['continued',...Array.from({length:33},(_,n)=>`old-${n}`)]]){
    const bad=copy(f.plan.floorTake);mutate(bad);assert.equal(takes.normalizeStoryboardFloorTake(bad).invalid,true);
    assert.throws(()=>receipts.mergeStoryboardFloorTakeReceipts([],[bad]));assert.equal(takes.storyboardFloorTakeInitialInline({...f.jobs[0],floorTake:bad}),false);
  }
});

test('successive multi-key takes dominate older committed/late groups across aliases without deleting any image',async()=>{
  const b={...ref,messageKey:'b',revisionId:'rev-b'},c={...ref,messageKey:'c',revisionId:'rev-c'};
  const first=prepared({id:'take-b',count:1,time:100,reference:b,messageKeys:['b',ref.messageKey]}),rows=[...first.old,image(first.jobs[0])],history=[];
  await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);
  const second=prepared({id:'take-c',count:1,time:200,reference:c,messageKeys:['c',ref.messageKey,'b'],old:rows,history});
  rows.push(image(second.jobs[0]));await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);
  const late=image(first.jobs[0],{id:'late-old-take'});rows.push(late);await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);
  assert.equal(rows.length,4);assert.equal(late.inline,false);assert.equal(rows.filter(row=>row.inline).length,1);assert.equal(rows.find(row=>row.inline).planId,'take-c');
  assert.equal(history.length,3);assert.ok(history.every(row=>row.id==='take-c'));assert.equal(rows[0].snapshot.prompt,'original recipe');
});

test('alias keys identify old baselines but never authorize new retake jobs or receipts to use an ancestor source',()=>{
  const current={...ref,messageKey:'continued',revisionId:'new-revision'},f=prepared({count:1,reference:current,messageKeys:['continued',ref.messageKey]});
  const bad=copy(f.jobs[0]);bad.messageRef.messageKey=ref.messageKey;
  assert.throws(()=>takes.bindStoryboardFloorTakeJobs(f.plan,[bad]),/未提交/);
  assert.throws(()=>takes.applyStoryboardFloorTakeToJob(f.plan,bad),/未重试/);
  const rows=[...f.old,image(bad)];takes.settleStoryboardFloorTakes(rows);assert.equal(rows[0].inline,true);assert.equal(rows[1].inline,false);
});

test('multi-key pruning protects earlier-key in-flight originals before and after receipt persistence',async()=>{
  const current={...ref,messageKey:'new',revisionId:'new-revision'},pending={id:'old-pending',messageRef:copy(ref),inlineByDefault:true,target:'floor'};
  const f=prepared({count:1,reference:current,messageKeys:['new',ref.messageKey],old:[],pending:[pending]});
  for(const committed of [false,true]){
    const history=committed?receipts.mergeStoryboardFloorTakeReceipts([],[f.plan.floorTake]):[],late={id:'late',taskId:pending.id,messageRef:copy(ref)};
    const rows=[late,...Array.from({length:400},(_,n)=>({id:`unrelated-${n}`}))];
    takes.pruneStoryboardRetakeGallery(rows,[],committed?[]:[f.plan.floorTake],history);assert.equal(rows.length,401);assert.equal(rows[0],late);
  }
});

test('alias receipt expansion obeys the existing storage cap before the actual extraction, without clearing older receipts',async()=>{
  const e=await continuedEntryFixture();
  e.history.push(...Array.from({length:399},(_,n)=>({version:1,id:`old-${n}`,chatKey:'chat-a',messageKey:`foreign-${n}`,swipeId:0,startedAt:100,baselineTaskIds:[]})));
  const before=copy(e.history);assert.equal(await e.click(),false);assert.equal(e.llmCalls.length,0);assert.equal(e.jobs.length,0);assert.deepEqual(e.history,before);
});

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

test('actual unrelated delivery reads pending plan protection before the retake has received an image',async()=>{
  const e=await entryFixture();assert.equal(await e.click(),true);e.gallery.push(...Array.from({length:399},(_,i)=>({id:`older-${i}`,inline:false})));
  const unrelated={...e.jobs[0],id:'independent-job',planId:'independent-plan'};delete unrelated.floorTake;
  await e.deliver(unrelated);assert.equal(e.gallery.length,401);assert.equal(e.gallery.some(row=>row.id==='previous-image'&&row.inline),true);assert.equal(e.gallery.some(row=>row.taskId==='independent-job'),true);
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

test('a gallery above the former cap can retake one floor without dropping unrelated originals',async()=>{
  const e=await entryFixture();e.gallery.push(...Array.from({length:399},(_,i)=>({id:`kept-${i}`,inline:false})));
  const originals=copy(e.gallery);e.context.storyboardDeleteRecordSnapshots=()=>assert.fail('new receipt must not delete older recipes');
  assert.equal(await e.click(),true);assert.ok(e.llmCalls.length>0);assert.equal(e.jobs.length,3);assert.deepEqual(e.gallery,originals);
  for(const job of e.jobs)await e.deliver(job);assert.equal(e.gallery.length,403);assert.equal(e.gallery[0].inline,false);
  assert.deepEqual(e.gallery.slice(1,400),originals.slice(1));assert.deepEqual(e.gallery[0].snapshot,originals[0].snapshot);
  assert.equal(e.gallery.filter(row=>row.inline).length,3);
});

test('cross-chat cold delivery preserves originals until committed and a failed metadata save must be retried before clearing its inbox',async()=>{
  const e=await entryFixture(),inbox=new Map(),foreign=[],key=e.context.getChatKey;assert.equal(await e.click(),true);
  e.gallery.push(...Array.from({length:499},(_,i)=>({id:`old-${i}`,inline:false,snapshot:{prompt:`saved-${i}`},unknown:{keep:i}})));
  const older=copy(e.gallery.slice(1));e.context.storyboardDeleteRecordSnapshots=()=>assert.fail('cross-chat delivery must not delete prior recipes');
  Object.assign(e.context,{storyboardDeliveryDrainPromise:null,storyboardVolatileDeliveries:new Map(),rerenderIfOpen(){},
    blobStore:{listStoryboardDeliveries:async()=>[...inbox.values(),{chatKey:'other',taskId:'foreign',records:[{id:'foreign'}]}],deleteStoryboardDelivery:async id=>{inbox.delete(id);foreign.push(id);}},
    storyboardStoreDeferredDelivery:async(job,records)=>{inbox.set(job.id,{taskId:job.id,chatKey:job.chatKey,target:job.target,records:copy(records)});return 'pending_chat';}});
  vm.runInContext(['storyboardValidatedAnchor','storyboardDrainPendingDeliveries'].map(section).join('\n'),e.context);
  e.context.getChatKey=()=> 'other';for(const job of e.jobs)await e.deliver(job);assert.equal(e.gallery.length,500);assert.equal(inbox.size,3);
  e.context.getChatKey=key;e.setSaveFailure(true);await assert.rejects(e.context.storyboardDrainPendingDeliveries('chat-a'),/metadata save failed/);
  assert.equal(inbox.size,3);assert.equal(e.gallery.length,503);assert.equal(e.gallery[0].inline,true);assert.ok(e.gallery.slice(1).every(row=>!row.inline));
  assert.deepEqual(e.gallery.slice(1,500),older);
  e.setSaveFailure(false);await e.context.storyboardDrainPendingDeliveries('chat-a');
  assert.equal(inbox.size,0);assert.equal(e.gallery[0].inline,false);assert.equal(e.gallery.filter(row=>row.inline).length,3);assert.equal(foreign.includes('foreign'),false);assert.equal(e.gallery.some(row=>row.id==='foreign'),false);
  assert.equal(e.gallery.length,503);assert.deepEqual(e.gallery.slice(1,500),older);
});

test('ordinary result save failure above 400 retains every old recipe and retries without pruning or duplicates',async()=>{
  const e=await entryFixture();assert.equal(await e.click(),true);
  e.gallery.push(...Array.from({length:499},(_,i)=>({id:`old-${i}`,inline:false,snapshot:{prompt:`saved-${i}`},future:{keep:i}})));
  const originals=copy(e.gallery),job={...e.jobs[0],id:'independent-large-gallery',planId:'independent-plan'};delete job.floorTake;
  e.context.storyboardDeleteRecordSnapshots=()=>assert.fail('no implicit recipe deletion');e.setSaveFailure(true);
  await assert.rejects(e.deliver(job),/metadata save failed/);assert.equal(e.gallery.length,501);assert.deepEqual(e.gallery.slice(0,500),originals);
  e.setSaveFailure(false);await e.deliver(job);assert.equal(e.gallery.length,501);assert.deepEqual(e.gallery.slice(0,500),originals);
});

test('a source edit after partial receipt cannot activate the uncommitted retake; a single-image redraw clears its whole-take manifest',()=>{
  const f=prepared({count:1}),rows=[...f.old,image(f.jobs[0])];takes.settleStoryboardFloorTakes(rows,()=>false);assert.equal(rows[0].inline,true);assert.equal(rows[1].inline,false);
  assert.match(section('storyboardRedrawRecord'),/delete snapshot\.floorTake;[\s\S]*storyboardJobFromLog/);
});

const pendingTask=(id='early',extra={})=>({id,planId:'stream-plan',chatKey:'chat',floor:0,messageRef:copy(ref),uiVisible:true,status:'generating',...extra});
const lateImage=(task,rows=[],history=[])=>({id:`image-${task.id}`,taskId:task.id,planId:task.planId,messageRef:copy(task.messageRef),url:'/late.png',
  inline:takes.storyboardFloorTakeInitialInline(task,rows,history),...(task.floorTake?{floorTake:copy(task.floorTake)}:{})});

test('retake freezes exact pending task ids, not broad batches, other floors or later user intent',()=>{
  const old={...baseline(),taskId:'old-task'},pending=[pendingTask(),pendingTask(),pendingTask('queued',{uiVisible:false,inlineByDefault:true,target:'floor'}),
    pendingTask('done',{status:'completed'}),pendingTask('gallery',{uiVisible:false,inlineByDefault:false,target:'gallery'}),
    pendingTask('foreign',{messageRef:{...ref,chatKey:'other'}}),pendingTask('other-swipe',{messageRef:{...ref,swipeId:1}}),
    pendingTask('other-floor',{messageRef:{...ref,messageKey:'another-message'}}),pendingTask('legacy',{messageRef:null})];
  const f=prepared({old:[old],pending});assert.deepEqual(f.plan.floorTake.baselineTaskIds,['old-task','early','queued']);
  assert.equal(pending[0].status,'generating');assert.deepEqual(core.normalizeStoryboardState({shotPlans:[f.plan]}).shotPlans[0].floorTake.baselineTaskIds,['old-task','early','queued']);
  assert.deepEqual(core.sanitizeStoryboardSnapshot(f.jobs[0]).floorTake.baselineTaskIds,['old-task','early','queued']);
});

test('old in-flight images arriving before or after full retake stay archived while explicit later supplements remain inline',async()=>{
  for(const timing of ['before','after']){
    const task=pendingTask(),f=prepared({count:1,pending:[task]}),rows=[...f.old],history=[];
    if(timing==='before')rows.push(lateImage(task,rows,history));
    rows.push(image(f.jobs[0]));await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);
    if(timing==='after')rows.push(lateImage(task,rows,history));
    await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);
    assert.equal(rows.find(r=>r.taskId==='early').inline,false);assert.equal(rows.find(r=>r.planId==='take').inline,true);
    assert.equal(history.length,1);assert.deepEqual(history[0].baselineTaskIds,['early']);
    const later=pendingTask('user-redraw',{inlineOrder:{batchId:'same-old-stream-batch'}});assert.equal(takes.storyboardFloorTakeInitialInline(later,rows,history),true);
    assert.equal(takes.storyboardFloorTakeInitialInline(pendingTask('early',{messageRef:{...ref,chatKey:'foreign'}}),rows,history),true);
  }
});

test('pending originals are sufficient to hold a first retake until complete, without hiding an old result on a partial failure',async()=>{
  const task=pendingTask(),f=prepared({count:2,old:[],pending:[task]}),rows=[image(f.jobs[0])],history=[];
  assert.equal(rows[0].inline,false);await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);
  assert.deepEqual(history,[]);const late=lateImage(task,rows,history);assert.equal(late.inline,true);rows.push(late);
  await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);assert.equal(late.inline,true);
});

test('a saved compact receipt survives deleting every new image and cold JSON restoration; old retries cannot reactivate',async()=>{
  const task=pendingTask(),f=prepared({count:1,pending:[task]}),rows=[...f.old,image(f.jobs[0])],history=[];
  await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);rows.splice(1);
  const restored=copy(history),late=lateImage(task,rows,restored);assert.equal(late.inline,false);rows.push(late);
  const older=prepared({count:1,id:'older-take',time:99}),olderImage=image(older.jobs[0]);rows.push(olderImage);
  await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,restored);
  assert.equal(olderImage.inline,false);assert.equal(olderImage.floorTakeCommittedAt,undefined);assert.equal(rows[0].inline,false);
  assert.deepEqual(restored,history);assert.deepEqual(Object.keys(restored[0]).sort(),['baselineTaskIds','chatKey','id','messageKey','startedAt','swipeId','version']);
});

test('deleting one committed image never invalidates an already saved replacement and late old output cannot appear during a failed save',async()=>{
  const task=pendingTask(),f=prepared({count:2,pending:[task]}),rows=[...f.old,...f.jobs.map(job=>image(job))],history=[];
  await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);rows.splice(1,1);
  const late=lateImage(task,rows,history);rows.push(late);assert.equal(late.inline,false);
  await assert.rejects(takes.saveStoryboardFloorTakes(rows,async()=>{throw Error('save failed');},()=>true,()=>true,history),/save failed/);
  assert.equal(late.inline,false);assert.equal(rows[0].inline,false);assert.equal(history.length,1);
});

test('failed replacement save rolls back its receipt and visibility; an arrival during that failure is not permanently retired',async()=>{
  const task=pendingTask(),f=prepared({count:1,pending:[task]}),rows=[...f.old,image(f.jobs[0])],history=[],gate=deferred(),started=deferred();
  const write=takes.saveStoryboardFloorTakes(rows,async()=>{started.resolve();await gate.promise;throw Error('failed');},()=>true,()=>true,history);
  const rejection=assert.rejects(write,/failed/);await started.promise;
  const late=lateImage(task,rows,history);rows.push(late);assert.equal(late.inline,true,'uncommitted metadata is not authority');
  gate.resolve();await rejection;assert.deepEqual(history,[]);assert.equal(rows[0].inline,true);assert.equal(late.inline,true);
  await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>false,()=>true,history);assert.equal(late.inline,true);assert.deepEqual(history,[]);
});

test('replacement receipts serialize across gallery array replacement and retain the prior receipt after a newer save fails',async()=>{
  const task=pendingTask(),f=prepared({count:1,pending:[task]}),rows=[...f.old,image(f.jobs[0])],history=[];
  await takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);const original=copy(history);
  const newer=prepared({count:1,id:'next',time:200,pending:[pendingTask('other')]}),next=[...rows,image(newer.jobs[0])];
  const gate=deferred(),started=deferred(),events=[];
  const first=takes.saveStoryboardFloorTakes(next,async()=>{events.push('first');started.resolve();await gate.promise;throw Error('new failed');},()=>true,()=>true,history);
  const rejected=assert.rejects(first,/new failed/);await started.promise;
  const second=takes.saveStoryboardFloorTakes([...rows],async()=>events.push('second'),()=>true,()=>true,history);
  await Promise.resolve();assert.deepEqual(events,['first']);gate.resolve();await rejected;await second;
  assert.deepEqual(events,['first','second']);assert.deepEqual(history,original);
});

test('successive receipt merges retain earlier retired ids, use one row per floor and never read a recipe',()=>{
  const f=prepared({count:1,pending:[pendingTask('a')]}),next=prepared({count:1,id:'next',time:200,pending:[pendingTask('b')]});
  let history=receipts.mergeStoryboardFloorTakeReceipts([],[f.plan.floorTake]);history=receipts.mergeStoryboardFloorTakeReceipts(history,[next.plan.floorTake]);
  history=receipts.mergeStoryboardFloorTakeReceipts(history,[f.plan.floorTake]);assert.equal(history.length,1);assert.equal(history[0].id,'next');assert.deepEqual(history[0].baselineTaskIds,['a','b']);
  const job=pendingTask('a');Object.defineProperty(job,'snapshot',{get(){assert.fail('heavy recipe read');}});
  assert.equal(takes.storyboardFloorTakeInitialInline(job,[],history),false);
});

test('receipt validation fails closed for malformed/future data, duplicates and capacity, without clearing metadata',async()=>{
  const f=prepared({count:1}),valid=receipts.mergeStoryboardFloorTakeReceipts([],[f.plan.floorTake])[0];
  for(const history of [null,{},[{...valid,version:2}],[valid,valid],[{...valid,baselineTaskIds:['same','same']}],[{...valid,baselineTaskIds:['bad\nid']}],
    [{...valid,baselineTaskIds:Array.from({length:401},(_,i)=>`task-${i}`)}],Array.from({length:401},(_,i)=>({...valid,messageKey:`floor-${i}`}))]){
    const before=copy(history),rows=[baseline()];assert.equal(takes.storyboardFloorTakeInitialInline(pendingTask(),rows,history),false);
    await assert.rejects(takes.saveStoryboardFloorTakes(rows,async()=>assert.fail('invalid save'),()=>true,()=>true,history),/换版记录/);
    assert.deepEqual(history,before);assert.equal(rows[0].inline,true);
  }
  const full=Array.from({length:400},(_,i)=>({...valid,messageKey:`floor-${i}`}));
  assert.throws(()=>takes.createStoryboardFloorTake(f.plan,[],()=>true,[],full),/换版记录/);
  const large=Array.from({length:20},(_,i)=>({...valid,messageKey:`floor-${i}`,baselineTaskIds:Array.from({length:400},(_,n)=>`${n}-${'a'.repeat(150)}`)}));
  assert.throws(()=>receipts.normalizeStoryboardFloorTakeReceipts(large),/换版记录/);
});

test('durable retired-task protection retains late originals during gallery pruning after all replacement images were deleted',()=>{
  const task=pendingTask(),f=prepared({count:1,pending:[task]}),history=receipts.mergeStoryboardFloorTakeReceipts([],[f.plan.floorTake]);
  const late=lateImage(task,[],history),rows=[late,...Array.from({length:400},(_,i)=>({id:`other-${i}`}))];
  const removed=takes.pruneStoryboardRetakeGallery(rows,[],[],history);assert.equal(rows.length,401);assert.equal(rows[0],late);assert.equal(removed.length,0);
  const before=copy(rows);rows.push({id:'extra'});assert.deepEqual(takes.pruneStoryboardRetakeGallery(rows,[],[],null),[]);assert.equal(rows.length,before.length+1);
});

test('actual retake captures task-state, queue and active ids; saved metadata retires their late arrivals without blocking a new redraw',async()=>{
  const e=await entryFixture(),reference=e.gallery[0].messageRef;
  const task=id=>pendingTask(id,{chatKey:'chat-a',messageRef:copy(reference)});
  e.state.taskStates=[task('task-state')];e.context.storyboardQueue.push(task('queued'));
  e.context.storyboardActiveJobs.set('active',task('active'));
  assert.equal(await e.click(),true);assert.deepEqual([...e.jobs[0].floorTake.baselineTaskIds],['task-state','queued','active']);
  for(const job of e.jobs)await e.deliver(job);assert.equal(e.history.length,1);
  e.gallery.splice(1);const old={...e.jobs[0],id:'active',planId:'stream-plan'};delete old.floorTake;
  await e.deliver(old);assert.equal(e.gallery.at(-1).inline,false);assert.equal(e.gallery.at(-1).taskId,'active');
  await e.deliver({...old,id:'new-user-redraw'});assert.equal(e.gallery.at(-1).inline,true);
});

test('actual invalid or full receipt metadata stops before extraction and does not silently reset user history',async()=>{
  for(const malformed of [true,false]){
    const e=await entryFixture(),reference=e.gallery[0].messageRef;
    e.history.push(...(malformed?[{version:99}]:Array.from({length:400},(_,i)=>({version:1,id:`take-${i}`,chatKey:'chat-a',messageKey:`other-${i}`,swipeId:0,startedAt:100,baselineTaskIds:[]}))));
    const before=copy(e.history);assert.equal(await e.click(),false);assert.equal(e.llmCalls.length,0);assert.equal(e.jobs.length,0);
    assert.deepEqual(e.history,before);assert.equal(e.gallery[0].inline,true);assert.match(e.notices.at(-1),/换版记录/);assert.ok(reference);
  }
});

test('cold inbox late output remains gallery-only after replacement deletion and survives failed receipt save for retry',async()=>{
  const e=await entryFixture(),reference=e.gallery[0].messageRef,task=pendingTask('late-inbox',{chatKey:'chat-a',messageRef:copy(reference)});
  e.state.taskStates=[task];assert.equal(await e.click(),true);for(const job of e.jobs)await e.deliver(job);e.gallery.splice(1);
  const inbox=new Map([[task.id,{taskId:task.id,chatKey:'chat-a',target:'floor',records:[{...lateImage(task),requestedInline:true}]}]]);
  e.history.splice(0,e.history.length,...copy(e.history));
  Object.assign(e.context,{storyboardDeliveryDrainPromise:null,storyboardVolatileDeliveries:new Map(),rerenderIfOpen(){},
    blobStore:{listStoryboardDeliveries:async()=>[...inbox.values()],deleteStoryboardDelivery:async id=>inbox.delete(id)}});
  vm.runInContext(['storyboardValidatedAnchor','storyboardDrainPendingDeliveries'].map(section).join('\n'),e.context);
  e.setSaveFailure(true);await assert.rejects(e.context.storyboardDrainPendingDeliveries('chat-a'),/metadata save failed/);
  assert.equal(inbox.size,1);assert.equal(e.gallery.at(-1).inline,false);assert.equal(e.history.length,1);
  e.setSaveFailure(false);await e.context.storyboardDrainPendingDeliveries('chat-a');assert.equal(inbox.size,0);assert.equal(e.gallery.length,2);assert.equal(e.gallery.at(-1).inline,false);
});

test('chat metadata migration and the real getter preserve receipts across reload without clearing malformed fields',()=>{
  const f=prepared({count:1,pending:[pendingTask()]}),history=receipts.mergeStoryboardFloorTakeReceipts([],[f.plan.floorTake]);
  let store=migrateQianmuChatStoreV2({storyboardFloorTakeReceipts:copy(history)}).value;
  const c=vm.createContext({getChatStore:()=>store});vm.runInContext(section('storyboardFloorTakeReceipts'),c);
  const first=c.storyboardFloorTakeReceipts();assert.deepEqual(first,history);assert.equal(c.storyboardFloorTakeReceipts(),first);
  store=migrateQianmuChatStoreV2(copy(store)).value;assert.deepEqual(c.storyboardFloorTakeReceipts(),history);
  store.storyboardFloorTakeReceipts=null;assert.equal(c.storyboardFloorTakeReceipts(),null);
  delete store.storyboardFloorTakeReceipts;assert.deepEqual(copy(c.storyboardFloorTakeReceipts()),[]);
});

test('completed but not yet delivered cross-chat tasks are captured; delivered completions do not broaden the pending baseline',()=>{
  const f=prepared({pending:[pendingTask('pending',{status:'completed',deliveryState:'pending_chat'}),
    pendingTask('volatile',{status:'completed',deliveryState:'volatile_pending'}),pendingTask('delivered',{status:'completed',deliveryState:'delivered'})]});
  assert.deepEqual(f.plan.floorTake.baselineTaskIds,['pending','volatile']);
});

test('legacy manifests remain compatible while malformed pending identities and excessive capture metadata are rejected',()=>{
  const f=prepared({count:1}),legacy=copy(f.plan.floorTake);delete legacy.baselineTaskIds;
  assert.equal(Object.hasOwn(takes.normalizeStoryboardFloorTake(legacy),'baselineTaskIds'),false);
  for(const ids of [null,['x','x'],['bad\nid'],Array.from({length:401},(_,i)=>String(i))])assert.deepEqual(takes.normalizeStoryboardFloorTake({...legacy,baselineTaskIds:ids}),{invalid:true});
  assert.throws(()=>takes.createStoryboardFloorTake(f.plan,[],()=>true,Array.from({length:1001},()=>pendingTask())),/在途分镜/);
  assert.throws(()=>takes.createStoryboardFloorTake(f.plan,[],()=>true,[pendingTask('bad\nid')]),/换版记录/);
});

test('an arrival during a successful save is retired by the saved receipt even if replacement images were then deleted',async()=>{
  const task=pendingTask(),f=prepared({count:1,pending:[task]}),rows=[...f.old,image(f.jobs[0])],history=[],started=deferred(),gate=deferred();
  const write=takes.saveStoryboardFloorTakes(rows,async()=>{started.resolve();await gate.promise;},()=>true,()=>true,history);
  await started.promise;const late=lateImage(task,rows,history);rows.push(late);assert.equal(late.inline,true);
  const received=takes.saveStoryboardFloorTakes(rows,async()=>{},()=>true,()=>true,history);
  rows.splice(1,1);gate.resolve();await write;await received;assert.equal(late.inline,false);assert.equal(history.length,1);
});
