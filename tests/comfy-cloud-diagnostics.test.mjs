import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {normalizeComfyCloudFailureDiagnostic as normalize,describeComfyCloudFailureDiagnostic as describe,readComfyCloudAcceptance} from '../qianmu-comfy-cloud-response.js';
import {createComfyCloudService} from '../qianmu-comfy-cloud-service.js';
import {imageGatewayErrorPayload} from '../qianmu-image-gateway.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {stillInput} from './helpers/runninghub-validation-fixture.mjs';

const secret='PRIVATE_RAW_MESSAGE_KEY_PROMPT_GRAPH_URL';
function fixture({status=200,body={code:9001,msg:secret,data:null},headers,networkError,authorizeError,recordError=false,cleanupError=false,afterResponse}={}){
  const rows=new Map(),calls=[];let failedRecord=false;
  const store={
    async transaction(key,reduce){
      const result=reduce(structuredClone(rows.get(key)));
      if(recordError&&!failedRecord&&result.state.entries.some(row=>row.upstreamId)){
        failedRecord=true;throw Error(secret);
      }
      if(cleanupError&&result.state.entries.some(row=>row.status==='uncertain'))throw Error(secret);
      rows.set(key,structuredClone(result.state));return result.result;
    },
    async inspectChannel(key){return structuredClone(rows.get(key));},close(){},
  };
  const requestImpl=(_url,_options,callback)=>{
    calls.push('submit');if(networkError)throw networkError;
    return new Writable({write(_chunk,_encoding,done){done();},final(done){
      const incoming=new PassThrough();incoming.statusCode=status;incoming.headers=headers||{'content-type':'application/json'};
      callback(incoming);incoming.end(typeof body==='string'?body:JSON.stringify(body));afterResponse?.();done();
    }});
  };
  const req={user:{profile:{handle:'synthetic-account',enabled:true,admin:false}}};
  const input={version:1,expectedAccount:imageServiceAccount(req).namespace,attemptId:'synthetic-attempt',apiKey:secret,request:stillInput()};
  input.request.prompt=secret;
  const service=createComfyCloudService({store,cache:{load(){assert.fail('No collection');},reserve(){assert.fail('No collection');},save(){assert.fail('No collection');}},
    transportOptions:{authorizeTarget:async()=>{if(authorizeError)throw authorizeError;return async()=>{};},
      resolveHost:async()=>[{address:'8.8.8.8',family:4}],requestImpl}});
  return {rows,calls,input,req,service,run:()=>service.submit(req,input),row:()=>[...rows.values()][0]?.entries[0]};
}
async function failed(f,check){
  try{
    await assert.rejects(f.run(),error=>{
      const packet=imageGatewayErrorPayload(error);
      assert.doesNotMatch(JSON.stringify(packet),new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(error.cloudDiagnostic)||'',new RegExp(secret));
      assert.ok(packet.body.message.length<300,'existing frontend message bound retains the whole safe diagnostic');
      assert.equal(error.retryable,false);check(error,packet);return true;
    });
    assert.doesNotMatch(JSON.stringify([...f.rows.values()]),/cloudDiagnostic|providerCode|httpStatus/,'ledger schema does not acquire diagnostics');
  }finally{await f.service.close();}
}

test('closed diagnostic projection drops text, unknown codes, descriptors, coercion and invalid scalar fields',()=>{
  const value={stage:'response',causeCode:`comfy_cloud_response_http_${secret}`,reason:secret,httpStatus:'403',providerCode:secret,
    attempted:'true',dispatched:{toString(){throw Error('No coercion');}},message:secret,stack:secret,body:{secret},url:secret};
  Object.defineProperty(value,'hasKnownTaskId',{get(){assert.fail('No accessor reads');}});
  assert.deepEqual(normalize(value),{stage:'response',reason:'unclassified'});
  assert.doesNotMatch(describe(value),new RegExp(secret));assert.equal(normalize({stage:secret}),null);assert.equal(describe({stage:secret}),'');
  for(const providerCode of [NaN,Infinity,-Infinity,1.1,2147483648,-2147483649,'7',true,null])assert.equal(normalize({stage:'response',providerCode}).providerCode,undefined);
  for(const httpStatus of [0,99,600,1.1,'403',true,null])assert.equal(normalize({stage:'response',httpStatus}).httpStatus,undefined);
  const clean=normalize({stage:'response',causeCode:'comfy_cloud_response_http',httpStatus:403,providerCode:9001,attempted:true,dispatched:true,hasKnownTaskId:false,recordCleanupFailed:false});
  assert.deepEqual(clean,{stage:'response',reason:'http',httpStatus:403,providerCode:9001,attempted:true,dispatched:true,hasKnownTaskId:false,recordCleanupFailed:false});
  assert.ok(Object.isFrozen(clean));assert.match(describe(clean),/响应校验.*HTTP 403.*平台码 9001/);
  assert.doesNotMatch(describe(clean),/response|http:|attempted|dispatched|许可入口|发送流程入口|取得任务号|收尾异常/);
});

test('RH rejection retains only a bounded numeric code and never turns rejection-looking bodies into replay permission',()=>{
  const connection=stillInput().connection;
  for(const code of [9001,-1,2147483647,secret,'0',null,{},2147483648]){
    assert.throws(()=>readComfyCloudAcceptance(connection,{code,msg:secret,data:{taskId:'1904152026220003329',secret}}),error=>{
      assert.equal(error.submissionState,'unknown');assert.equal(error.retryable,false);assert.equal(error.upstreamId,undefined);
      assert.equal(error.providerCode,Number.isSafeInteger(code)&&Math.abs(code)<=2147483647?code:undefined);
      assert.doesNotMatch(error.message+JSON.stringify(error),new RegExp(secret));return true;
    });
  }
});

test('actual service carries numeric RH rejection through the safe message while preserving unknown and one submission',async()=>{
  const f=fixture();await failed(f,(error,packet)=>{
    assert.equal(error.code,'comfy_cloud_service_unconfirmed');assert.equal(packet.body.submissionState,'unknown');
    assert.deepEqual(error.cloudDiagnostic,{stage:'response',reason:'acceptance',httpStatus:200,providerCode:9001,attempted:true,dispatched:true,hasKnownTaskId:false,recordCleanupFailed:false});
    assert.match(packet.body.message,/响应校验.*平台码 9001/);
  });
  assert.equal(f.calls.length,1);assert.equal(f.row().status,'uncertain');assert.equal(f.row().upstreamId,undefined);
});

for(const [label,options,reason,httpStatus] of [
  ['HTTP rejection',{status:403,body:{message:secret}},'http',403],
  ['invalid JSON',{body:`{${secret}`},'response_format',200],
  ['HTML response',{body:secret,headers:{'content-type':'text/html'}},'response_format',200],
  ['network reset',{networkError:Object.assign(Error(secret),{code:'ECONNRESET'})},'connection',undefined],
  ['untrusted exception code',{networkError:Object.assign(Error(secret),{code:`comfy_cloud_response_http_${secret}`})},'connection',undefined],
])test(`actual service classifies ${label} without reflecting raw content or clearing uncertainty`,async()=>{
  const f=fixture(options);await failed(f,(error,packet)=>{
    assert.equal(packet.body.submissionState,'unknown');assert.equal(error.cloudDiagnostic.reason,reason);
    assert.equal(error.cloudDiagnostic.httpStatus,httpStatus);assert.equal(error.cloudDiagnostic.providerCode,undefined);
    assert.equal(error.cloudDiagnostic.attempted,true);assert.equal(error.cloudDiagnostic.dispatched,true);
  });assert.equal(f.calls.length,1);assert.equal(f.row().status,'uncertain');
});

test('pre-dispatch authorization failure remains not_submitted with no reservation or dispatch',async()=>{
  const f=fixture({authorizeError:Error(secret)});await failed(f,(error,packet)=>{
    assert.equal(packet.body.submissionState,'not_submitted');assert.equal(error.cloudDiagnostic.stage,'authorization');
    assert.equal(error.cloudDiagnostic.reason,'connection');assert.equal(error.cloudDiagnostic.attempted,false);assert.equal(error.cloudDiagnostic.dispatched,false);
  });assert.equal(f.calls.length,0);assert.equal(f.rows.size,0);
});

test('accepted task whose ledger update fails remains accepted and never exposes its id through the diagnostic',async()=>{
  const taskId='1904152026220003329',f=fixture({body:{code:0,data:{taskId}},recordError:true});
  await failed(f,(error,packet)=>{
    assert.equal(packet.body.submissionState,'accepted');assert.equal(error.cloudDiagnostic.stage,'record');
    assert.equal(error.cloudDiagnostic.reason,'ledger');assert.equal(error.cloudDiagnostic.hasKnownTaskId,true);
    assert.doesNotMatch(JSON.stringify(error.cloudDiagnostic),new RegExp(taskId));
  });assert.equal(f.calls.length,1);assert.equal(f.row().status,'uncertain');
});

test('failed uncertainty bookkeeping preserves its original state and adds only a private safe flag',async()=>{
  const f=fixture({status:503,cleanupError:true});await failed(f,(error,packet)=>{
    assert.equal(packet.body.submissionState,'unknown');assert.equal(error.cloudDiagnostic.recordCleanupFailed,true);
    assert.match(packet.body.message,/HTTP 503/);assert.doesNotMatch(packet.body.message,/recordCleanupFailed|收尾|true|false/);
  });assert.equal(f.calls.length,1);assert.equal(f.row().status,'submitting');
});

test('an account switch after the provider response receives only the existing generic uncertainty message',async()=>{
  const f=fixture({afterResponse:()=>{f.req.user.profile.handle='other-account';}});
  await failed(f,(error,packet)=>{
    assert.equal(packet.body.submissionState,'unknown');assert.equal(error.cloudDiagnostic,undefined);
    assert.equal(packet.body.message,'云任务处理未完成，请核查原记录；未重新生成');
    assert.doesNotMatch(JSON.stringify(packet),/9001|HTTP|平台码|cloudDiagnostic/);
  });assert.equal(f.calls.length,1);assert.equal(f.row().status,'uncertain');
  assert.equal(f.row().namespace,f.input.expectedAccount);
});

test('successful acceptance remains unchanged and stores no new diagnostic fields',async()=>{
  const taskId='1904152026220003329',f=fixture({body:{code:0,msg:secret,data:{taskId,secret}}});
  try{
    const result=await f.run();assert.equal(result.status,'accepted');assert.equal(result.task.taskId,taskId);assert.equal(f.calls.length,1);
    assert.equal(f.row().upstreamId,taskId);assert.equal(f.row().cloudReceipt.task.taskId,taskId);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));assert.doesNotMatch(JSON.stringify([...f.rows.values()]),/cloudDiagnostic|providerCode|httpStatus/);
  }finally{await f.service.close();}
});
