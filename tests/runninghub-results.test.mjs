import test from 'node:test';
import assert from 'node:assert/strict';
import {collectRunningHubStillResults as collect} from '../qianmu-runninghub-results.js';
import {readComfyCloudTaskStatus as status} from '../qianmu-comfy-cloud-response.js';
import {bindComfyCloudProtocol,bindComfyCloudTask,planComfyCloudOperation} from '../qianmu-comfy-cloud-protocol.js';
import {COMFY_CLOUD_RECEIPT_SCHEMA as schema} from '../qianmu-comfy-cloud-receipt.js';
const task=bindComfyCloudTask(bindComfyCloudProtocol('https://www.runninghub.cn','runninghub-workflow-v1'),'1904152026220003329');
const receipt=()=>({schema,task,requestDigest:'a'.repeat(64),workflow:{templateHash:'b'.repeat(64),executionHash:'c'.repeat(64)},
  stillOutput:{version:1,model:'workflow',previewNodeIds:['preview'],execution:{version:1,automatic:false,maxImages:2,expectedImages:2,outputNodeIds:['10','2']}}});
const result=(id,nodeId=id)=>({fileUrl:`https://images.example/${id}.png?signature=temporary`,fileType:'png',nodeId});
function fixture(){const evidence={code:0,data:[result('2'),result('10'),result('preview')]};return{evidence,body:{taskId:task.taskId,status:'SUCCESS',errorCode:'',
  results:[evidence.data[1],evidence.data[0],evidence.data[2]].map(row=>({url:row.fileUrl,outputType:row.fileType}))}};}
test('RH current results own order and legacy node evidence cannot reorder, invent or choose the largest image',()=>{
  const f=fixture(),r=receipt(),found=collect(r,f.body,f.evidence);
  assert.deepEqual(found.outputs.map(row=>[row.nodeId,row.outputIndex]),[['10',0],['2',1]]);
  assert.ok(Object.isFrozen(found.outputs[0]));assert.equal(found.outputs[0].assetId,undefined,'a URL must not masquerade as a durable UUID');
  f.evidence.data[1].nodeId='foreign';f.body.results[0].url='https://other.test';r.stillOutput.execution.outputNodeIds[0]='other';
  assert.equal(found.outputs[0].nodeId,'10');assert.match(found.outputs[0].sourceUrl,/images.example/);
  const op=planComfyCloudOperation(task,'outputs',task);assert.equal(op.effect,'read');assert.equal(op.createsJob,false);assert.equal(op.body.taskId,task.taskId);
});
test('RH missing node proofs, conflicting lists, non-images, duplicates and ambiguous counts fail without falling back',()=>{
  const mutations=[f=>{f.evidence.code=404;},f=>{f.evidence.data.pop();},f=>{delete f.evidence.data[0].nodeId;},
    f=>{f.evidence.data[0].fileUrl+='changed';},f=>{f.body.results[0].outputType='webp';},f=>{f.body.results[1]={...f.body.results[0]};},
    f=>{f.body.taskId='other';},f=>{f.evidence.taskId='other';},f=>{f.evidence.data[0].taskId='other';},
    f=>{f.body.results[0].url='http://images.example/a.png';},f=>{f.body.results[0].url='https://secret@images.example/a.png';},
    f=>{f.body.results[0].outputType='mp4';f.evidence.data[1].fileType='mp4';},f=>{f.evidence.data[1].nodeId='unselected';}];
  for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>collect(receipt(),f.body,f.evidence),e=>e.submissionState==='accepted'&&e.upstreamId===task.taskId&&!e.message.includes('temporary'));}
  const f=fixture(),automatic=receipt();automatic.stillOutput.execution.automatic=true;assert.throws(()=>collect(automatic,f.body,f.evidence));
  assert.equal(collect(receipt(),{...f.body,status:'RUNNING'},null),null);assert.throws(()=>collect(receipt(),{...f.body,status:'FAILED',errorCode:'failed'},f.evidence));
});
test('RH usage remains one task-level decimal report, never per-file totals or missing-as-zero',()=>{
  const f=fixture(),usage={consumeCoins:'0.125',consumeMoney:'1234567890123456.123456789012',thirdPartyConsumeMoney:null,taskCostTime:'83'};
  const parsed=status(task,{...f.body,usage});assert.deepEqual(parsed.usage,{...usage});assert.ok(Object.isFrozen(parsed.usage));assert.equal(status(task,f.body).usage,undefined);
  for(const invalid of [null,{},'secret',{consumeCoins:-1},{consumeCoins:'NaN'},{consumeCoins:'1e99'},{consumeCoins:'-1'},{consumeCoins:'<secret>'}])assert.equal(status(task,{...f.body,usage:invalid}).usage,undefined);
  assert.equal(status(task,{...f.body,usage:{consumeCoins:'0',unknown:'secret'}}).usage.consumeCoins,'0');assert.doesNotMatch(JSON.stringify(parsed.usage),/url|signature|results/);
});
