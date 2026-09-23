import test from 'node:test';import assert from 'node:assert/strict';
import {runStoryboardBundle,closeStoryboardBundleRuntime} from '../qianmu-storyboard-bundle-runtime.js';
import {openStoryboardBundleRestoreRuntime,closeStoryboardBundleRestoreRuntime} from '../qianmu-storyboard-bundle-restore-runtime.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {bundleCarrierHead} from '../qianmu-bundle-carrier-storage-contract.js';
const namespace='st-user:progress',fingerprint='a'.repeat(64);
const currentHead=bundleCarrierHead({version:1,namespace,carrierDigest:fingerprint,digest:'b'.repeat(64),chatHash:'c'.repeat(64),createdAt:1,fileBytes:1000,manifestBytes:100,indexBytes:0,receiptCount:0,indexState:'absent',bytes:200,identityVerified:false,restoreAuthorized:false});
function workerClass(mode,flow){
  return class Worker{
    static last;
    constructor(){this.constructor.last=this;this.events={};this.sent=[];this.closed=false;this.timers=[];}
    addEventListener(type,fn){this.events[type]=fn;}
    terminate(){this.closed=true;for(const timer of this.timers)clearTimeout(timer);}
    emit(data){if(!this.closed)this.events.message?.({data});}
    later(ms,run){this.timers.push(setTimeout(()=>{if(!this.closed)run();},ms));}
    postMessage(message){this.sent.push(message);if(message.guard||message.type==='rpc')return;
      if(mode==='restore'&&message.action==='open'){this.emit({id:message.id,operation:message.operation,action:'open',type:'result',sourceDigest:fingerprint,result:{sourceDigest:fingerprint}});return;}
      flow(this,message);
    }
    progress(message,count){this.emit(mode==='capture'?{progress:count}:mode==='restore'?{id:message.id,operation:message.operation,progress:count}:{id:message.id,progress:count});}
    result(message){if(mode==='capture')this.emit({result:{file:new Blob(['{}']),summary:{},manifest:{entries:[]},fingerprint}});
      else if(mode==='restore')this.emit({id:message.id,operation:message.operation,action:message.action,type:'result',sourceDigest:fingerprint,result:{version:1,namespace,sourceDigest:fingerprint,descriptorDigest:'b'.repeat(64),offset:0,total:1,rows:[{...currentHead,current:true}]}});
      else this.emit({id:message.id,result:{version:1,status:'ready',namespace,count:0,proofBytes:0,originalCount:0,originalBytes:0,bytes:0}});
    }
  };
}
async function run(mode,Worker,extra={}){
  const options={namespace,chatKey:'chat',guard:async()=>{},WorkerClass:Worker,timeoutMs:150,totalTimeoutMs:1000,...extra};
  if(mode==='capture')return runStoryboardBundle('capture',new Blob(['{}']),options);
  if(mode==='storage')return runRestoreStorage('carriers',options);
  const client=await openStoryboardBundleRestoreRuntime(new Blob(['{}']),{...options,configuration:{preview:async()=>({}),apply:async()=>({})}});
  try{return await client.carriers({offset:0});}finally{client.close();}
}
for(const mode of ['capture','restore','storage'])test(`${mode} runtime accepts fresh verified progress beyond its initial idle window`,async t=>{
  t.after(()=>{closeStoryboardBundleRuntime();closeStoryboardBundleRestoreRuntime();});
  const Worker=workerClass(mode,(worker,message)=>{for(let at=1;at<=6;at++)worker.later(at*40,()=>worker.progress(message,at));worker.later(270,()=>worker.result(message));});
  await run(mode,Worker);assert.equal(Worker.last.closed,true);
});
for(const mode of ['capture','restore','storage'])test(`${mode} runtime terminates an endless progress stream at the total deadline`,async()=>{
  const Worker=workerClass(mode,(worker,message)=>{for(let at=1;at<=20;at++)worker.later(at*30,()=>worker.progress(message,at));});
  await assert.rejects(run(mode,Worker,{totalTimeoutMs:240}),/最长等待/);assert.equal(Worker.last.closed,true);
});
for(const mode of ['capture','restore','storage'])test(`${mode} runtime rejects replayed progress and progress after live identity loss`,async()=>{
  const repeated=workerClass(mode,(worker,message)=>{worker.progress(message,1);worker.progress(message,1);});await assert.rejects(run(mode,repeated),/进度消息/);assert.equal(repeated.last.closed,true);
  let active=true;const lost=workerClass(mode,(worker,message)=>{active=false;worker.progress(message,1);});await assert.rejects(run(mode,lost,{guard:async()=>{if(!active)throw Error('lost identity');}}),/lost identity/);assert.equal(lost.last.closed,true);
});
test('guard heartbeats alone do not renew the source accounting deadline',async()=>{
  const Worker=workerClass('storage',(worker,message)=>{for(let at=1;at<=20;at++)worker.later(at*20,()=>worker.emit({id:message.id,guard:at}));});
  await assert.rejects(run('storage',Worker),/等待超时/);assert.equal(Worker.last.closed,true);assert.ok(Worker.last.sent.length>1);
});
test('an explicit abort still terminates immediately despite recent progress',async()=>{
  const controller=new AbortController(),Worker=workerClass('capture',(worker,message)=>{worker.progress(message,1);worker.later(20,()=>controller.abort());});
  await assert.rejects(run('capture',Worker,{signal:controller.signal}),/取消/);assert.equal(Worker.last.closed,true);
});

for(const mode of ['capture','restore','storage'])test(`${mode} runtime refuses malformed or skipped progress counters`,async()=>{
  for(const value of [0,2,1.5,'1',Infinity]){
    const Worker=workerClass(mode,(worker,message)=>worker.progress(message,value));
    await assert.rejects(run(mode,Worker),/进度消息/);assert.equal(Worker.last.closed,true);
  }
});

for(const mode of ['restore','storage'])test(`${mode} runtime ignores progress for another operation or session`,async()=>{
  const Worker=workerClass(mode,(worker,message)=>{
    for(let at=1;at<=20;at++)worker.later(at*20,()=>worker.progress({...message,id:mode==='storage'?'stale-session':message.id,operation:message.operation-1},at));
  });
  await assert.rejects(run(mode,Worker),/等待超时/);assert.equal(Worker.last.closed,true);
});
