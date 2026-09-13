import test from 'node:test';
import assert from 'node:assert/strict';
import {issueComfySceneArchiveProof,readComfySceneArchiveProof as read} from '../qianmu-comfy-scene-result.js';
const issue=(job,row,verify)=>issueComfySceneArchiveProof(job,row,verify,{origin:'https://st.test'});
import {bindComfyCloudProtocol,bindComfyCloudTask} from '../qianmu-comfy-cloud-protocol.js';
const fixture=()=>{
  const scope={namespace:'st-user:archive',chatKey:'chat',continuityId:'scene',narrativeLayer:'present'};
  const job={id:'original',source:'comfy',chatKey:'chat',imageAdmission:{version:1,namespace:scope.namespace,attemptId:'original'},
    connection:{baseUrl:'https://comfy.test'},comfySceneOrigin:{version:1,mode:'scene',scope,poolKey:'a'.repeat(64),executionKey:'b'.repeat(64),sourceHash:'c'.repeat(64),candidateId:'candidate',connectionPresetId:''}};
  const row={version:1,namespace:scope.namespace,attemptId:'original',baseUrl:'https://comfy.test',credentialId:'key-id',chatKey:'chat',automatic:true,
    createdAt:1,status:'archived',receipt:'d'.repeat(64),imageCount:1,files:[{imageIndex:0,url:'/user/images/original.png'}]};
  return {job,row};
};
test('only an issued, still-verified original archive can authorize the exact scene result',async()=>{
  const {job,row}=fixture();let checks=0;const proof=issue(job,row,async()=>{checks++;return structuredClone(row);});
  const result=await read(proof,job);assert.equal(result.attemptId,job.id);assert.equal(result.lock.candidateId,'candidate');assert.equal(checks,1);
  assert.deepEqual(JSON.parse(JSON.stringify(proof)),{version:1});assert.doesNotMatch(JSON.stringify(result),/key-id|original\.png|workflow/);
  for(const fake of [{version:1},structuredClone(proof)])await assert.rejects(read(fake,job),{code:'comfy_scene_archive_proof'});
  row.status='confirmed';assert.equal((await read(proof,job)).attemptId,'original','later host acknowledgement does not invalidate an already complete archive');
});
test('pending, partial and unrelated archives cannot mint scene completion evidence',()=>{
  for(const change of [f=>f.row.status='available',f=>f.row.files=[],f=>f.row.attemptId='other',f=>f.row.namespace='st-user:other',
    f=>f.row.chatKey='other',f=>f.row.baseUrl='https://other.test',f=>f.row.receipt='',f=>f.job.originalOnly=true,f=>f.job.comfySceneOrigin.mode='independent']){
    const f=fixture();change(f);assert.throws(()=>issue(f.job,f.row,async()=>f.row));
  }
});
test('changed provenance, file binding, lost archive or failed current-account guard blocks confirmation',async()=>{
  for(const mode of ['scene','task','namespace','file','receipt','lost','guard']){
    const f=fixture(),proof=issue(f.job,f.row,async()=>{if(mode==='guard')throw Error('account changed');if(mode==='lost')return null;return f.row;});
    if(mode==='scene')f.job.comfySceneOrigin.candidateId='another';if(mode==='task')f.job.id='other';if(mode==='namespace')f.job.imageAdmission.namespace='st-user:other';
    if(mode==='file')f.row.files[0].url='/user/images/other.png';if(mode==='receipt')f.row.receipt='e'.repeat(64);
    await assert.rejects(read(proof,f.job));
  }
});
test('proof rechecks identity after asynchronous archive verification instead of trusting the initial object',async()=>{
  const f=fixture(),proof=issue(f.job,f.row,async()=>{f.job.comfySceneOrigin.sourceHash='f'.repeat(64);return f.row;});
  await assert.rejects(read(proof,f.job),{code:'comfy_scene_archive_proof'});
});

test('Cloud and RH API root aliases match the original resource, but a changed original cloud task cannot inherit proof',async()=>{
  for(const [url,protocol,id] of [['https://cloud.comfy.org/api/v2','comfy-cloud-v2','cloud-id'],['https://www.runninghub.cn/openapi/v2','runninghub-workflow-v1','12345']]){
    const f=fixture(),cloudConnection=bindComfyCloudProtocol(url,protocol);f.job.connection.baseUrl=url;
    Object.assign(f.row,{version:3,baseUrl:cloudConnection.origin,cloudConnection,cloudTask:bindComfyCloudTask(cloudConnection,id,
      protocol==='comfy-cloud-v2'?{self:'/api/v2/jobs/'+id,cancel:'/api/v2/jobs/'+id+'/cancel'}:undefined),taskLocator:{version:1,channelKey:'f'.repeat(64)}});
    const proof=issue(f.job,f.row,async()=>f.row);assert.equal((await read(proof,f.job)).attemptId,'original');
    f.row.taskLocator.channelKey='a'.repeat(64);await assert.rejects(read(proof,f.job));
  }
});
