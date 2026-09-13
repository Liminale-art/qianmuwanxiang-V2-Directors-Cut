import test from 'node:test';
import assert from 'node:assert/strict';
import {createComfyRecoveryClient} from '../qianmu-comfy-recovery-client.js';
import {normalizeComfyDelivery,assertComfyDeliveryUpdate} from '../qianmu-comfy-delivery-store.js';
import {bindComfyCloudProtocol,bindComfyCloudTask} from '../qianmu-comfy-cloud-protocol.js';
const connection=bindComfyCloudProtocol('https://cloud.comfy.org','comfy-cloud-v2');
const job=()=>({source:'comfy',id:'original',chatKey:'chat',logId:'log',automatic:false,
  imageAdmission:{version:1,namespace:'st-user:alice',attemptId:'original'},connection:{baseUrl:connection.origin,credentialId:'original-key'}});
const packet=(id='accepted')=>({ok:true,version:1,status:'accepted',task:bindComfyCloudTask(connection,id,{self:`/api/v2/jobs/${id}`,cancel:`/api/v2/jobs/${id}/cancel`}),
  locator:{version:1,attemptId:'original',channelKey:'a'.repeat(64)}});
function setup(){
  const rows=new Map();let namespace='st-user:alice',failWrite=false,held=false;
  const store={get:async(ns,id)=>structuredClone(rows.get(`${ns}/${id}`)||null),put:async raw=>{
    if(failWrite)throw Error('simulated storage failure');
    const row=normalizeComfyDelivery(raw,'https://st.test'),key=`${row.namespace}/${row.attemptId}`;
    assertComfyDeliveryUpdate(rows.get(key),row);rows.set(key,row);
  },close(){}};
  const client=createComfyRecoveryClient({origin:'https://st.test',store,account:async()=>namespace,
    locks:{request:async(_name,_options,work)=>{if(held)return work(null);held=true;try{return await work({});}finally{held=false;}}},
    fetchImpl:()=>assert.fail('preparation and binding must never submit or query a cloud task')});
  return {client,rows,store,setAccount:value=>{namespace=value;},failWrite:()=>{failWrite=true;},read:()=>rows.get('st-user:alice/original')};
}
test('cloud preparation is explicit, compact and an existing ticket never grants permission to resubmit',async()=>{
  const f=setup(),source={...job(),prompt:'private narrative',workflow:{private:true},apiKey:'never-store'};
  const first=await f.client.prepareCloud(source,connection);assert.equal(first.created,true);assert.equal(first.record.version,3);
  assert.equal(first.record.cloudTask,null);assert.equal(first.record.originalOnly,false);
  assert.doesNotMatch(JSON.stringify(first.record),/private|never-store|workflow|apiKey/);
  const repeated=await f.client.prepareCloud(source,connection);assert.equal(repeated.created,false);assert.deepEqual(repeated.record,first.record);
  await f.client.bindCloudAcceptance(first.record,packet());
  assert.equal((await f.client.prepareCloud(source,connection)).created,false);assert.equal(f.read().cloudTask.taskId,'accepted');
});
test('acceptance binds once and duplicate replies preserve later image checkpoints',async()=>{
  const f=setup(),prepared=await f.client.prepareCloud(job(),connection);
  const accepted=await f.client.bindCloudAcceptance(prepared.record,packet());assert.equal(accepted.status,'prepared');assert.equal(accepted.cloudTask.taskId,'accepted');
  const archived={...accepted,status:'archived',imageCount:1,receipt:'b'.repeat(64),files:[{imageIndex:0,url:'/user/images/original.png'}]};
  await f.store.put(archived);
  assert.deepEqual(await f.client.bindCloudAcceptance(prepared.record,packet()),archived);
  await assert.rejects(f.client.bindCloudAcceptance(prepared.record,packet('replacement')));
  assert.deepEqual(f.read(),archived);
});
test('malformed or foreign acceptance cannot invent a task, and missing preparation is not silently recreated',async()=>{
  const f=setup(),prepared=await f.client.prepareCloud(job(),connection);
  for(const change of [{ok:false},{status:'running'},{version:2},{task:null},{locator:{...packet().locator,attemptId:'other'}}]){
    await assert.rejects(f.client.bindCloudAcceptance(prepared.record,{...packet(),...change}),{submissionState:'unknown'});
    assert.equal(f.read().cloudTask,null);
  }
  f.rows.clear();await assert.rejects(f.client.bindCloudAcceptance(prepared.record,packet()),/准备记录已缺失/);assert.equal(f.rows.size,0);
});
test('new cloud preparation cannot overwrite native history, move a chat or bypass storage failure',async()=>{
  const f=setup();await f.client.prepare(job());
  await assert.rejects(f.client.prepareCloud(job(),connection));assert.equal(f.read().version,1);
  const cloud=setup();await cloud.client.prepareCloud(job(),connection);
  await assert.rejects(cloud.client.prepareCloud({...job(),chatKey:'different'},connection),{submissionState:'not_submitted'});
  const broken=setup();broken.failWrite();await assert.rejects(broken.client.prepareCloud(job(),connection),{submissionState:'not_submitted'});assert.equal(broken.rows.size,0);
});
test('storage failure, account switch and close after acceptance do not report successful binding',async()=>{
  for(const mode of ['storage','account','close']){
    const f=setup(),prepared=await f.client.prepareCloud(job(),connection);
    if(mode==='storage')f.failWrite();else if(mode==='account')f.setAccount('st-user:bob');else f.client.close();
    await assert.rejects(f.client.bindCloudAcceptance(prepared.record,packet()),{submissionState:'accepted'});assert.equal(f.read().cloudTask,null);
  }
});
