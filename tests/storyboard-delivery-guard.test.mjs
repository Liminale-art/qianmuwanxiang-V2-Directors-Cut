import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as takes from '../qianmu-storyboard-floor-take.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture(){
  const ref=core.createStoryboardMessageReference({chatKey:'chat',floor:0,message:{mes:'A person stands.',send_date:'today',swipe_id:0}});
  const old={id:'old',taskId:'old-job',chatKey:'chat',floor:0,messageRef:ref,swipeId:0,inline:true,url:'/old.png'};
  const original=structuredClone(old),gallery=[old],receipts=[],logs=[],stages=[];
  const plan={...core.createStoryboardWorkflowTicket({id:'take',chatKey:'chat',floor:0,messageRef:ref}),shots:[{id:'shot'}]};
  plan.floorTake=takes.createStoryboardFloorTake(plan,gallery,row=>row.inline);
  const job={id:'job',planId:'take',planShotId:'shot',chatKey:'chat',messageRef:ref,inlineByDefault:true,target:'inline',profile:{count:1},automatic:true,
    inlineOrder:{version:1,batchId:'take',batchStartedAt:1,shotIndex:0,requestIndex:1}};
  takes.bindStoryboardFloorTakeJobs(plan,[job]);
  let valid=true,owns=true,saves=0,foreign=0,currentGallery=gallery,currentReceipts=receipts;
  const c=vm.createContext({...takes,clone:structuredClone,storyboardResultOwned:async()=>owns,
    storyboardAssertResultOwner:async()=>{if(!owns)throw Error('account changed');},storyboardStoreForeignAccountResult:async()=>{foreign++;return false;},
    storyboardPlanForJob:()=>plan,storyboardSetPlanStatus:()=>{},storyboardPipelineStage:(_log,type,status)=>stages.push({type,status}),
    storyboardPersistGatewayImage:async()=>'/new.png',storyboardValidatedAnchor:()=>({valid:true,floor:0}),
    storyboardCreateRecord:(job,_log,url,index)=>({id:'new',taskId:job.id,chatKey:'chat',floor:0,messageRef:ref,requestedInline:true,inline:false,
      imageIndex:index,planId:job.planId,planShotId:job.planShotId,inlineOrder:job.inlineOrder,floorTake:job.floorTake,floorTakeEligible:true,url}),
    runningHubUsageFields:()=>({}),sanitizeStoryboardSnapshot:()=>({}),getChatKey:()=> 'chat',ctx:()=>({saveMetadata(){}}),
    storyboardGalleryRecords:()=>currentGallery,storyboardFloorTakeReceipts:()=>currentReceipts,
    saveMetadata:async()=>{saves++;},storyboardFinishLog:(...args)=>logs.push(args),toast:()=>{},
  });
  vm.runInContext(section('storyboardDeliverGatewayResult'),c);
  const deliver=(input=job,guard=async()=>{if(!valid)throw Error('log removed');})=>c.storyboardDeliverGatewayResult(input,{}, {images:[{}]}, {service:true,guard});
  return {c,job,gallery,receipts,original,logs,stages,deliver,invalid:()=>valid=false,loseAccount:()=>owns=false,
    replace:()=>{currentGallery=[{id:'new-owner'}];currentReceipts=[];return currentGallery;},get saves(){return saves;},get foreign(){return foreign;}};
}
const untouched=f=>{assert.deepEqual(f.gallery,[f.original]);assert.deepEqual(f.receipts,[]);assert.equal(f.logs.length,0);assert.equal(f.stages.some(row=>row.type==='asset_persistence'&&row.status==='success'),false);};
test('removed log before metadata write rolls back pending visibility/receipts and newly inserted image',async()=>{
  const f=fixture();f.c.saveStoryboardFloorTakes=async(...args)=>{f.invalid();return takes.saveStoryboardFloorTakes(...args);};
  await assert.rejects(f.deliver(),/log removed/);untouched(f);assert.equal(f.saves,0);
});
test('removed log during metadata save prevents archive success and restores previous take',async()=>{
  const f=fixture();f.c.saveMetadata=async()=>f.invalid();await assert.rejects(f.deliver(),/log removed/);untouched(f);
});
test('the commit boundary has no later whole-gallery rollback which could overwrite another delivery',async()=>{
  const f=fixture();f.c.saveStoryboardFloorTakes=async(...args)=>{await takes.saveStoryboardFloorTakes(...args);f.invalid();};
  assert.equal(await f.deliver(),true);assert.equal(f.gallery.length,2);assert.equal(f.gallery[0].inline,false);assert.equal(f.receipts.length,1);
});
test('replaced chat metadata never receives or retains an old recovery image',async()=>{
  const f=fixture();let next;f.c.saveMetadata=async()=>{next=f.replace();};
  await assert.rejects(f.deliver(),/原聊天内容已变化/);untouched(f);assert.deepEqual(next,[{id:'new-owner'}]);
});
test('lost account after metadata save preserves originals separately and rolls back only old in-memory transaction',async()=>{
  const f=fixture();f.c.saveMetadata=async()=>f.loseAccount();assert.equal(await f.deliver(),false);untouched(f);assert.equal(f.foreign,1);
});
test('ordinary successful delivery keeps its committed take and logs success once',async()=>{
  const f=fixture();assert.equal(await f.deliver(),true);assert.equal(f.gallery.length,2);assert.equal(f.gallery[0].inline,false);
  assert.equal(f.gallery[1].inline,true);assert.ok(f.gallery[1].floorTakeCommittedAt);assert.equal(f.receipts.length,1);assert.equal(f.logs.length,1);assert.equal(f.saves,1);
});
test('two concurrent deliveries serialize: failing the second never rolls back the first saved take',async()=>{
  const f=fixture();let entered,release,calls=0,secondValid=true;
  const firstEntered=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  f.c.saveMetadata=async()=>{if(++calls===1){entered();await gate;}else secondValid=false;};
  const first=f.deliver();await firstEntered;
  const secondJob={...f.job,id:'second',planId:'another',planShotId:'another-shot'};delete secondJob.floorTake;
  const second=f.deliver(secondJob,async()=>{if(!secondValid)throw Error('second log removed');});
  await new Promise(resolve=>setImmediate(resolve));release();await first;await assert.rejects(second,/second log removed/);
  assert.equal(f.gallery.length,2);assert.equal(f.gallery[0].inline,false);assert.equal(f.gallery[1].taskId,'job');
  assert.equal(f.gallery[1].inline,true);assert.ok(f.gallery[1].floorTakeCommittedAt);assert.equal(f.receipts.length,1);assert.equal(f.logs.length,1);
});
