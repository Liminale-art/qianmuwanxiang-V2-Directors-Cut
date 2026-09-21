import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardDefaults,createStoryboardWorkflowTicket,normalizeStoryboardState} from '../qianmu-storyboard.js';
import {captureStoryboardStreamFrame,createStoryboardStreamMessageReference} from '../qianmu-storyboard-stream-source.js?v=1.59.280';
import {beginStoryboardStreamAttempt as begin,normalizeStoryboardStreamAttempt as normalize,assertStoryboardStreamAttemptSettled as settled} from '../qianmu-storyboard-stream-attempt.js?v=1.59.280';
import {createStoryboardStreamCheckpointStorage} from '../qianmu-storyboard-stream-checkpoint-storage.js?v=1.59.280';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
async function fixture(){
  const state=createStoryboardDefaults(),message={mes:'First paragraph.\n\n',name:'Alice',swipe_id:0,send_date:'day',gen_started:'generation'};
  const host={chatId:'chat',characterId:0,characters:[{chat:'chat',avatar:'Alice.png'}],chat:[message],chatMetadata:{story_director_liminale:{}}};
  const storage=streamCheckpointTransport('st-user:test');let live=true,saves=0,seq=0,save=()=>saves++;
  const d={state:()=>state,message:()=>message,guard:()=>{if(!live)throw Error('source changed');},uid:()=>`request-${++seq}`,save:()=>save(),createPlan:createStoryboardWorkflowTicket};
  d.openCheckpoint=({reference,planId,guard})=>createStoryboardStreamCheckpointStorage({scope:{namespace:'st-user:test',chatKey:reference.chatKey,messageKey:reference.messageKey,revisionId:reference.revisionId,planId},guard,createStorage:storage.createStorage});
  async function reference(){const frame=await captureStoryboardStreamFrame({getContext:()=>host,epoch:()=>0,resolveNamespace:async()=>'st-user:test',isCurrent:()=>live,floor:0});try{return await createStoryboardStreamMessageReference(frame);}finally{frame.close();}}
  return{state,message,host,d,reference,storage,get saves(){return saves;},set live(value){live=value;},set save(value){save=value;},begin:async()=>begin(await reference(),null,d)};
}

test('a source-bound checkpoint exists before model work and contains no prose or credentials',async()=>{
  const f=await fixture(),attempt=await f.begin();assert.equal(f.saves,1);assert.equal(f.state.shotPlans.length,1);assert.equal(attempt.plan.streamAttempt.status,'preparing');
  assert.equal(attempt.plan.streamAttempt.passes,1);assert.doesNotMatch(JSON.stringify(attempt.plan.streamAttempt),/First paragraph|api|key|prompt/);
  assert.throws(()=>settled(attempt.plan));assert.equal(await attempt.finish('waiting'),'waiting');settled(attempt.plan);assert.equal(attempt.plan.status,'idle');
});

test('normalization preserves interrupted and failed markers and they cannot authorize automatic final capture',async()=>{
  for(const status of ['preparing','failed','cancelled']){
    const f=await fixture(),attempt=await f.begin();if(status!=='preparing')await attempt.finish(status);
    const normalized=normalizeStoryboardState(copy(f.state));assert.equal(normalized.shotPlans[0].streamAttempt.status,status);assert.throws(()=>settled(normalized.shotPlans[0]));
    await assert.rejects(begin(await f.reference(),null,{...f.d,state:()=>normalized}),error=>error.code==='storyboard_stream_attempt');
  }
});

test('a successful checkpoint accepts only new stable content and caps partial rounds while allowing a final handoff',async()=>{
  const f=await fixture();for(let i=0;i<3;i++){
    if(i)f.message.mes+=`Later ${i}.\n\n`;const attempt=await f.begin();await attempt.finish('waiting');assert.equal(attempt.plan.streamAttempt.passes,i+1);
  }
  assert.equal(f.state.shotPlans.length,1);f.message.mes+='Too many rounds.\n\n';await assert.rejects(f.begin(),error=>error.code==='storyboard_stream_wait');settled(f.state.shotPlans[0]);
});

test('repeated unchanged content cannot reuse a completed extraction or reset its counter',async()=>{
  const f=await fixture(),attempt=await f.begin();await attempt.finish('ready');await assert.rejects(f.begin(),error=>error.code==='storyboard_stream_wait');
  assert.equal(attempt.plan.streamAttempt.passes,1);assert.equal(f.saves,2);
});

test('changing an earlier waiting fragment cannot hide behind an unchanged initial source prefix',async()=>{
  const f=await fixture();await (await f.begin()).finish('waiting');f.message.mes+='Second fragment.\n\n';await (await f.begin()).finish('waiting');
  const old=copy(f.state.shotPlans[0].streamAttempt);f.message.mes=f.message.mes.replace('Second fragment','Changed fragment')+'Third.\n\n';
  await assert.rejects(f.begin(),/片段或原检查点改变/);assert.deepEqual(f.state.shotPlans[0].streamAttempt,old);
});

test('a shortened prior prefix fails before starting another checkpoint',async()=>{
  const f=await fixture();await (await f.begin()).finish('waiting');f.message.mes='Short.\n\n';await assert.rejects(f.begin(),/片段改变/);assert.equal(f.saves,2);
});

test('invalid, future or extra checkpoint fields are retained as an invalid sentinel and never silently dropped into a fresh attempt',async()=>{
  const f=await fixture(),attempt=await f.begin(),original=copy(attempt.plan.streamAttempt);
  for(const value of [{...original,version:2},{...original,status:'done'},{...original,passes:0},{...original,passes:4},{...original,sourceDigest:'bad'},{...original,extra:true}]){
    assert.deepEqual(normalize(value),{version:1,invalid:true});attempt.plan.streamAttempt=value;
    const state=normalizeStoryboardState(copy(f.state));assert.deepEqual(state.shotPlans[0].streamAttempt,{version:1,invalid:true});assert.throws(()=>settled(state.shotPlans[0]));
  }
});

test('a missing, duplicated or manually controlled root plan cannot be claimed as a new partial attempt',async()=>{
  for(const kind of ['duplicate','manual','cancelled','locked','review']){
    const f=await fixture(),attempt=await f.begin();await attempt.finish('waiting');f.message.mes+='New.\n\n';
    if(kind==='duplicate')f.state.shotPlans.push(copy(attempt.plan));if(kind==='manual')attempt.plan.origin='manual';if(kind==='cancelled')attempt.plan.status='cancelled';
    if(kind==='locked')attempt.plan.promptLocked=true;if(kind==='review')attempt.plan.manualReviewRequired=true;
    await assert.rejects(f.begin());assert.equal(f.saves,2);
  }
  const f=await fixture(),ref=await f.reference();await assert.rejects(begin(ref,{chatKey:ref.chatKey,messageKey:ref.messageKey,revisionId:ref.revisionId},f.d),/原计划缺失/);
});

test('plan capacity is checked before checkpointing without evicting previous originals',async()=>{
  const f=await fixture();f.state.shotPlans=Array.from({length:300},(_,i)=>({id:`old-${i}`,status:'completed'}));const before=copy(f.state.shotPlans);
  await assert.rejects(f.begin(),/记录已满/);assert.deepEqual(f.state.shotPlans,before);assert.equal(f.saves,0);
});

test('checkpoint save failure remains a failed no-replay record and does not remove previous content',async()=>{
  const f=await fixture();f.save=()=>{throw Error('write failed');};await assert.rejects(f.begin(),/write failed/);
  assert.equal(f.state.shotPlans.length,1);assert.equal(f.state.shotPlans[0].streamAttempt.status,'failed');assert.throws(()=>settled(f.state.shotPlans[0]));
});

test('completion cannot overwrite a replacement checkpoint or save through a changed source',async()=>{
  const f=await fixture(),attempt=await f.begin(),original=attempt.plan.streamAttempt;attempt.plan.streamAttempt={...original,requestId:'replacement'};
  assert.equal(await attempt.finish('ready'),'cancelled');assert.equal(attempt.plan.streamAttempt.requestId,'replacement');assert.equal(f.saves,1);
  const g=await fixture(),running=await g.begin();g.live=false;assert.equal(await running.finish('ready'),'cancelled');assert.equal(g.saves,1);assert.equal(running.plan.streamAttempt.status,'preparing');
});

test('checkpoint finish preserves already queued image rows after a later partial failure',async()=>{
  const f=await fixture(),attempt=await f.begin();attempt.plan.status='queued';attempt.plan.shots=[{id:'accepted',status:'queued',resultIds:[]}];
  await attempt.finish('failed');assert.equal(attempt.plan.status,'queued');assert.equal(attempt.plan.shots[0].status,'queued');assert.equal(attempt.plan.streamAttempt.status,'failed');
  assert.throws(()=>settled(attempt.plan));await attempt.finish('ready');assert.equal(attempt.plan.streamAttempt.status,'failed');
});

test('an absent confirmed-storage adapter cannot fall back to settings as persistence',async()=>{
  const f=await fixture();delete f.d.openCheckpoint;await assert.rejects(f.begin(),/确认保存未就绪/);
  assert.equal(f.state.shotPlans[0].streamAttempt.status,'failed');assert.equal(f.state.shotPlans[0].status,'failed');assert.equal(f.storage.calls.length,0);
});

test('the first completion owns an asynchronous settlement shared with finally',async()=>{
  const f=await fixture(),attempt=await f.begin(),first=attempt.finish('waiting'),second=attempt.finish('cancelled');
  assert.equal(first,second);assert.equal(await first,'waiting');assert.equal(await attempt.finish('ready'),'waiting');assert.equal(f.saves,2);
});

test('a settings failure after verified settlement still leaves a local stop marker and retained remote receipt',async()=>{
  const f=await fixture(),attempt=await f.begin();f.save=()=>{throw Error('settings failure after storage');};
  assert.equal(await attempt.finish('ready'),'failed');assert.equal(attempt.plan.streamAttempt.status,'failed');
  assert.ok(f.storage.checkpoints().some(row=>row.attempt.status==='ready'));assert.throws(()=>settled(attempt.plan));
});

for(const change of ['replaced plan','manual takeover','cancelled plan','changed owner','manual origin'])test(`a ${change} during preparation readback cannot authorize the model`,async()=>{
  const f=await fixture();let heads=0;
  f.storage.hook=({path,options})=>{
    if(path==='/api/files/upload'&&JSON.parse(Buffer.from(JSON.parse(options.body).data,'base64').toString('utf8')).schema==='qianmu.st-account-head.v1'&&++heads===1){
      const plan=f.state.shotPlans[0];if(change==='replaced plan')f.state.shotPlans=[copy(plan)];
      if(change==='manual takeover')plan.promptLocked=true;if(change==='cancelled plan')plan.status='cancelled';
      if(change==='changed owner')plan.chatKey='other';if(change==='manual origin')plan.origin='manual';
    }
  };
  await assert.rejects(f.begin());assert.ok(f.storage.files.size>0);assert.equal(f.saves,1);
});
