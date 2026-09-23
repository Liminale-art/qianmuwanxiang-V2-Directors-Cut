import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as core from '../qianmu-storyboard.js';
import * as contract from '../qianmu-storyboard-contract.js';
import {captureStoryboardContinuation,saveStoryboardContinuation} from '../qianmu-storyboard-continuation.js';
import {createStoryboardStreamMoment} from '../qianmu-storyboard-stream-moment.js?v=1.59.224';
import {verifyStoryboardStreamReference} from '../qianmu-storyboard-stream-reference.js?v=1.59.319';
import {readStoryboardStreamCoverage,configureStoryboardStreamCoverage,filterStoryboardStreamCoveredNarrative,storyboardStreamCoverageScope} from '../qianmu-storyboard-stream-coverage.js?v=1.59.319';
const copy=value=>JSON.parse(JSON.stringify(value));
const namespace='st-user:test';
async function fixture({legacy=false}={}){
  const message={mes:'Alice cooks.\n\n',name:'Alice',send_date:'day-1',gen_started:'generation-1',swipe_id:0};
  const host={chatId:'chat',characterId:0,characters:[{chat:'chat',avatar:'Alice.png'}],chat:[message],chatMetadata:{story_director_liminale:{}},eventSource:new EventEmitter()};
  const options={getContext:()=>host,epoch:()=>0,resolveNamespace:async()=>namespace,isCurrent:()=>true,floor:0,referenceFloors:0,
    readText:m=>m.mes,readParagraphs:m=>m.mes.split('\n\n').filter(Boolean).map((text,index)=>({id:`P${index+1}`,text}))};
  const root=core.createStoryboardMessageReference({message,chatKey:'chat',floor:0,now:1});
  const handle=captureStoryboardContinuation({...options,type:'continue',createReference:core.createStoryboardMessageReference});
  message.mes+='Bob brings a cup.\n\n';message.send_date='day-2';message.gen_started='generation-2';message.swipe_info=[{send_date:'day-2',extra:{}}];
  try{await saveStoryboardContinuation(handle,options.resolveNamespace,host.chatMetadata.story_director_liminale,async()=>{});}finally{handle.close();}
  const window=await contract.captureStoryboardCompilerSources(options);
  const shot={source_paragraph_ids:['P1'],insert_after:'P1',narrative_layer:'present',subject:'Alice cooks',state_point:{paragraphId:'P1',branchId:'present',evidence:'Alice cooks.'}};
  const moment=createStoryboardStreamMoment(shot,window);
  const spec=core.normalizeStoryboardShotSpec({id:'shot-1',subject:shot.subject,sourceParagraphIds:['P1'],insertAfter:'P1',narrativeLayer:'present',...(!legacy?{narrativeMoment:moment}:{})});
  const plan=core.createStoryboardWorkflowTicket({id:'original-custom-plan',chatKey:'chat',messageRef:root,floor:0,origin:'automatic',autoGenerate:true,createdAt:1});
  plan.status='completed';plan.shots=[{id:'shot-1',shotSpec:copy(spec),status:'completed',attempt:1,resultIds:['image-1']}];
  const snapshot={messageRef:copy(root),chatKey:'chat',automatic:true,planId:plan.id,planShotId:'shot-1',shotSpec:copy(spec),
    imageAdmission:{version:1,namespace,chatKey:'chat',messageKey:root.messageKey,revisionId:root.revisionId,logicalShotId:'a'.repeat(64),automaticSlot:true}};
  if(legacy)snapshot.compilerStages=[{type:'prompt_compiler',status:'success',output:{shots:[{id:'shot-1',shotSpec:copy(spec)}],trace:{narrative:{shots:[shot]}}}}];
  const row={id:'log-1',status:'success',snapshot},resolve=ref=>core.resolveStoryboardMessageReference(ref,host.chat,{chatKey:'chat',namespace,metadata:host.chatMetadata});
  return {message,host,options,window,root,shot,moment,spec,plan,row,resolve,context:{compilerSources:window},
    read:(rows=[row],plans=[plan],pipelines=[])=>contract.captureStoryboardStreamCoverage(window,rows,plans,pipelines),close:()=>window.close()};
}

test('ordinary occupied shots produce verified coverage in the original custom plan and bind a fresh complete source',async()=>{
  const f=await fixture(),old=copy(f.row),coverage=await f.read();
  assert.equal(coverage.scope.planId,f.plan.id);assert.deepEqual(coverage.scope.reference,f.root);assert.deepEqual(coverage.pins[0].moment,f.moment);
  const ref=await contract.createStoryboardFinalStreamReference(f.window,coverage);assert.equal(ref.stream.version,3);assert.equal(ref.stream.complete,true);
  assert.equal(ref.stream.family.reference.revisionId,f.root.revisionId);await verifyStoryboardStreamReference(ref,()=>f.resolve(ref));assert.deepEqual(f.row,old);f.close();
});

test('ordinary coverage reduces remaining shots, filters exact old moments and keeps distinct subjects from the same sentence',async()=>{
  const f=await fixture();f.context.streamCoverage=await f.read();const payload={constraints:{max_shots:3,min_shots_target:2}};
  const control=configureStoryboardStreamCoverage(f.context,payload,{});assert.equal(control.remaining,2);assert.equal(payload.constraints.min_shots_target,1);
  assert.equal(payload.committed_images[0].subject,f.shot.subject);
  const distinct={...f.shot,subject:'The cooking pot'},result=filterStoryboardStreamCoveredNarrative({shots:[f.shot,distinct]},[{},{}],f.context,{streamCoverage:control});
  assert.equal(result.covered,1);assert.deepEqual(result.data.shots,[distinct]);assert.equal(payload.constraints.committed_images.occupied,1);f.close();
});

test('legacy focused compiler trace recovers a unique matching shot without a new model request or persistent rewrite',async()=>{
  const f=await fixture({legacy:true}),old=copy(f.row),coverage=await f.read();
  assert.deepEqual(coverage.pins[0].moment,f.moment);assert.deepEqual(f.row,old);assert.equal(f.row.snapshot.shotSpec.narrativeMoment,undefined);f.close();
});

test('legacy trace cannot guess by array position, prompt similarity or a duplicated shot ID',async()=>{
  for(const mutate of [j=>j.compilerStages[0].output.shots[0].id='other',j=>j.compilerStages[0].output.trace.narrative.shots[0].subject='Different',
    j=>j.compilerStages[0].output.shots[0].shotSpec.insertAfter='P2',j=>delete j.compilerStages[0].output.trace,
    j=>{j.compilerStages[0].output.shots.push(copy(j.compilerStages[0].output.shots[0]));j.compilerStages[0].output.trace.narrative.shots.push(copy(fallbackShot()));}]){
    const f=await fixture({legacy:true});mutate(f.row.snapshot);await assert.rejects(f.read(),{code:'storyboard_stream_coverage'});f.close();
  }
});
function fallbackShot(){return {source_paragraph_ids:['P1'],insert_after:'P1',narrative_layer:'present',subject:'Alice cooks',state_point:{paragraphId:'P1',branchId:'present',evidence:'Alice cooks.'}};}

test('a compact legacy gallery duplicate can use the same validated logical shot from a retained log in either input order',async()=>{
  const f=await fixture({legacy:true}),gallery={id:'image-1',url:'/synthetic.png',...copy(f.row.snapshot)};delete gallery.compilerStages;
  for(const rows of [[gallery,f.row],[f.row,gallery]])assert.equal((await f.read(rows)).pins.length,1);
  gallery.shotSpec.subject='Another scene';await assert.rejects(f.read([gallery,f.row]),{code:'storyboard_stream_coverage'});f.close();
});

test('missing ordinary position evidence and explicit invalid compact positions do not turn into unused capacity',async()=>{
  for(const value of [undefined,null,{}, {version:99}, {version:1,invalid:true}]){
    const f=await fixture();if(value===undefined)delete f.row.snapshot.shotSpec.narrativeMoment;else f.row.snapshot.shotSpec.narrativeMoment=value;
    await assert.rejects(f.read(),{code:'storyboard_stream_coverage'});f.close();
  }
});

test('ordinary plan identity, cancellation, manual review and delivered-slot evidence are required before supplementary planning',async()=>{
  for(const mutate of [f=>f.plan.status='cancelled',f=>f.plan.promptLocked=true,f=>f.plan.manualReviewRequired=true,f=>f.plan.origin='manual',
    f=>f.plan.revisionId='another',f=>f.plan.shots.push({id:'missing',status:'completed',attempt:1,resultIds:['lost']})]){
    const f=await fixture();mutate(f);await assert.rejects(f.read(),{code:'storyboard_stream_coverage'});f.close();
  }
  const f=await fixture();await assert.rejects(f.read([f.row],[]),{code:'storyboard_stream_coverage'});
  await assert.rejects(f.read([f.row],[f.plan,copy(f.plan)]),{code:'storyboard_stream_coverage'});f.close();
});

for(const status of ['queued','generating','success','unknown','accepted'])test(`ordinary ${status} consumes its existing automatic slot`,async()=>{
  const f=await fixture();f.row.status=['unknown','accepted'].includes(status)?'failed':status;
  if(['unknown','accepted'].includes(status))f.row.submissionState=status;
  assert.equal((await f.read()).pins.length,1);f.close();
});

test('explicit first-attempt unsubmitted failure keeps the ordinary plan with zero occupied slots',async()=>{
  const f=await fixture();Object.assign(f.row,{status:'failed',submissionState:'not_submitted'});Object.assign(f.plan.shots[0],{status:'failed',resultIds:[]});
  const coverage=await f.read();assert.equal(coverage.pins.length,0);assert.equal(coverage.scope.planId,f.plan.id);
  f.plan.shots[0].attempt=2;await assert.rejects(f.read(),{code:'storyboard_stream_coverage'});f.close();
});

test('known manual supplementary shots do not spend ordinary automatic slots but an automatic redraw retains its existing one',async()=>{
  const f=await fixture();f.plan.shots=[];f.row.snapshot.automatic=false;f.row.snapshot.imageAdmission.automaticSlot=false;
  assert.equal((await f.read()).pins.length,0);f.row.snapshot.imageAdmission.automaticSlot=true;
  assert.equal((await f.read()).pins.length,1);f.close();
});

test('changed ordinary source, account or stored bridge fails before returning coverage',async()=>{
  for(const mutate of [f=>f.message.mes='changed',f=>f.row.snapshot.imageAdmission.namespace='st-user:other',
    f=>f.host.chatMetadata.story_director_liminale.storyboardContinuations[0].digest='b'.repeat(64)]){
    const f=await fixture();mutate(f);await assert.rejects(f.read());f.close();
  }
});

test('coverage ownership cannot be cloned, and plan mutations across asynchronous source checks are rejected',async()=>{
  const f=await fixture(),coverage=await f.read();assert.throws(()=>storyboardStreamCoverageScope(copy(coverage),f.window),{code:'storyboard_stream_coverage'});
  let calls=0;await assert.rejects(readStoryboardStreamCoverage(f.window,[f.row],{message:f.message,namespace,plans:[f.plan],
    continuationLinks:f.host.chatMetadata.story_director_liminale.storyboardContinuations,
    sourceParagraphs:length=>f.options.readParagraphs({...f.message,mes:f.message.mes.slice(0,length)}),
    resolve:ref=>{if(++calls===2)f.plan.status='cancelled';return f.resolve(ref);}}),{code:'storyboard_stream_coverage'});f.close();
});

test('compact ordinary moments survive shot, plan and log normalization without retaining compiler transcripts',async()=>{
  const f=await fixture();assert.deepEqual(core.normalizeStoryboardShotSpec(copy(f.spec)).narrativeMoment,f.moment);
  assert.deepEqual(core.sanitizeStoryboardSnapshot(f.row.snapshot).shotSpec.narrativeMoment,f.moment);
  const state=core.normalizeStoryboardState({shotPlans:[f.plan],logs:[f.row]});
  assert.deepEqual(state.shotPlans[0].shots[0].shotSpec.narrativeMoment,f.moment);assert.deepEqual(state.logs[0].snapshot.shotSpec.narrativeMoment,f.moment);
  assert.equal(state.logs[0].snapshot.compilerStages,undefined);
  assert.equal(core.normalizeStoryboardShotSpec({...f.spec,narrativeMoment:{version:99}}).narrativeMoment.invalid,true);f.close();
});

test('ordinary coverage at high floors never reads unrelated prose',async()=>{
  const f=await fixture();for(let i=1;i<5000;i++)f.host.chat.push({name:'Other',send_date:`other-${i}`,gen_started:`other-${i}`,get mes(){assert.fail('unrelated body read');}});
  assert.equal((await f.read()).pins.length,1);f.close();
});

test('actual depth-limited snapshots recover old positions from their explicitly linked normalized pipeline log',async()=>{
  const f=await fixture({legacy:true}),pipeline={id:'pipeline',taskId:'task-1',status:'success',stages:copy(f.row.snapshot.compilerStages)};
  pipeline.stages[0].id='stage-1';f.row.pipelineId=pipeline.id;delete f.row.snapshot.compilerStages;
  const state=core.normalizeStoryboardState({shotPlans:[f.plan],logs:[f.row],pipelineLogs:[pipeline]});
  assert.equal((await f.read(state.logs,state.shotPlans,state.pipelineLogs)).pins.length,1);
  assert.equal(f.row.snapshot.shotSpec.narrativeMoment,undefined);f.close();
});

test('pipeline fallback rejects conflicting task IDs, duplicate pipelines and evidence from a different shot',async()=>{
  const f=await fixture({legacy:true}),pipeline={id:'pipeline',taskId:'task-1',stages:copy(f.row.snapshot.compilerStages)};
  f.row.pipelineId=pipeline.id;delete f.row.snapshot.compilerStages;f.row.snapshot.id='wrong-task';
  await assert.rejects(f.read([f.row],[f.plan],[pipeline]),{code:'storyboard_stream_coverage'});delete f.row.snapshot.id;
  await assert.rejects(f.read([f.row],[f.plan],[pipeline,copy(pipeline)]),{code:'storyboard_stream_coverage'});
  pipeline.stages[0].output.shots[0].id='wrong-shot';await assert.rejects(f.read([f.row],[f.plan],[pipeline]),{code:'storyboard_stream_coverage'});f.close();
});

test('compact gallery fallback uses its original task ID instead of confusing an image ID with the task',async()=>{
  const f=await fixture({legacy:true}),pipeline={id:'pipeline',taskId:'task-1',stages:copy(f.row.snapshot.compilerStages)};
  const gallery={id:'image-1',taskId:'task-1',url:'/synthetic.png',...copy(f.row.snapshot)};delete gallery.compilerStages;
  assert.equal((await f.read([gallery],[f.plan],[pipeline])).pins.length,1);
  gallery.taskId='unrelated';await assert.rejects(f.read([gallery],[f.plan],[pipeline]),{code:'storyboard_stream_coverage'});f.close();
});

test('irrelevant duplicated pipeline entries do not interfere with compact verified ordinary moments',async()=>{
  const f=await fixture(),unrelated={id:'unrelated',taskId:'other',stages:[]};
  assert.equal((await f.read([f.row],[f.plan],[unrelated,copy(unrelated)])).pins.length,1);f.close();
});

test('an old ordinary shot cannot claim a narrative position that appeared only after its captured source ended',async()=>{
  const f=await fixture(),future={source_paragraph_ids:['P2'],insert_after:'P2',narrative_layer:'present',subject:'Bob brings a cup',
    state_point:{paragraphId:'P2',branchId:'present',evidence:'Bob brings a cup.'}};
  Object.assign(f.row.snapshot.shotSpec,{subject:future.subject,sourceParagraphIds:['P2'],insertAfter:'P2',narrativeMoment:createStoryboardStreamMoment(future,f.window)});
  await assert.rejects(f.read(),{code:'storyboard_stream_coverage'});f.close();
});
