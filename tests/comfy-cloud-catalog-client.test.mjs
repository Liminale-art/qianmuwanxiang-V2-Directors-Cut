import test from 'node:test';
import assert from 'node:assert/strict';
import {createComfyRecoveryClient} from '../qianmu-comfy-recovery-client.js';
import {resolveComfyCloudRecoveryKey} from '../qianmu-comfy-recovery-action.js';
import {bindComfyCloudProtocol,bindComfyCloudTask} from '../qianmu-comfy-cloud-protocol.js';
import {comfyCloudResourceKey} from '../qianmu-comfy-cloud-ledger.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';

const connection=bindComfyCloudProtocol('https://cloud.comfy.org','comfy-cloud-v2');
const task=bindComfyCloudTask(connection,'original',{self:'/api/v2/jobs/original',cancel:'/api/v2/jobs/original/cancel'});
const receipt='a'.repeat(64),key='synthetic-original-key',channelKey=comfyCloudResourceKey(connection,key);
const row={attemptId:'original',createdAt:1,status:'succeeded',task,taskLocator:{version:1,channelKey},cacheReceipt:receipt,
  archiveState:'stored',resultAvailable:true,canDiscard:true,imageCount:1,cacheBytes:10};
const totals={count:1,imageBytes:10,metadataBytes:2,temporaryBytes:0,reservedBytes:0,tasks:1};
const cloud={ok:true,version:1,catalogVersion:1,storageReadable:true,totals,originals:[row],tasks:[row]};
const native={...cloud,originals:[{...row,attemptId:'native',task:undefined}],tasks:[]};
const json=value=>new Response(JSON.stringify(value));
const capability={ok:true,version:1,accountBindingVersion:1,catalogVersion:1,expectedAccount:imageServiceAccount({user:{profile:{handle:'alice',enabled:true}}}).namespace,
  submission:false,cancellation:false,referenceUpload:false,resultRetrieval:true,archiveConfirmation:true,automaticReplay:false,
  queryProviders:['comfy-cloud','runninghub'],resultProviders:['comfy-cloud']};
function fixture({respond,capabilities}={}){
  let account='st-user:alice';const calls=[];
  const client=createComfyRecoveryClient({origin:'https://st.test',account:async()=>account,
    store:{close(){},get:async()=>null,put:async()=>assert.fail('catalog and cleanup do not invent local image checkpoints')},
    locks:{request:async(_name,_options,work)=>work({})},
    fetchImpl:async(url,init)=>{const body=init.body?JSON.parse(init.body):{};calls.push({url,body,method:init.method});
      if(url.endsWith('/capabilities'))return capabilities?capabilities():json(capability);
      return respond?respond(url,body):json(url.includes('/cloud/')?cloud:native);}});
  return {client,calls,switchAccount:()=>{account='st-user:bob';}};
}
test('one catalog merges local and cloud originals and carries explicit immutable cloud identity',async()=>{
  const f=fixture(),data=await f.client.catalogAll();
  assert.equal(data.storageReadable,true);assert.equal(data.originals.length,2);assert.equal(data.totals.imageBytes,20);
  const selected=data.originals.find(item=>item.engine==='cloud');
  assert.equal(selected.canDiscard,false);assert.equal(selected.cloudRecord.version,3);assert.equal(selected.cloudRecord.originalOnly,true);
  assert.deepEqual(selected.cloudRecord.cloudTask,task);assert.equal(selected.cloudRecord.status,'prepared');
  assert.deepEqual(selected.cloudRecord.files,[]);assert.equal(selected.cloudRecord.receipt,'');
  assert.ok(f.calls.every(call=>/\/(catalog|capabilities)$/.test(call.url)&&!call.body.apiKey));
});

test('RH original actions follow advertised backend retrieval support without opening RH paid submission', async () => {
  const rh = bindComfyCloudTask(bindComfyCloudProtocol('https://www.runninghub.cn', 'runninghub-workflow-v1'), '1904152026220003329');
  for (const supported of [true, false]) {
    const f = fixture({ capabilities: () => json({ ...capability, resultProviders: supported ? ['comfy-cloud', 'runninghub'] : ['comfy-cloud'] }),
      respond: url => json(url.includes('/cloud/') ? { ...cloud, originals: [{ ...row, task: rh }], tasks: [] } : native) });
    const data = await f.client.catalogAll(), selected = data.originals.find(item => item.engine === 'cloud');
    assert.equal(selected.resultAvailable, supported); assert.equal(selected.canReceiveOriginal, supported);
    assert.equal(selected.canDiscard, false); assert.equal(selected.cloudRecord.cloudTask.taskId, rh.taskId);
    assert.equal(data.cloudCapabilities.submission, false);
    assert.ok(f.calls.every(call => /\/(catalog|capabilities)$/.test(call.url))); f.client.close();
  }
});
test('reported RH usage remains visible after cache cleanup without querying the platform or implying images still occupy space',async()=>{
  const task=bindComfyCloudTask(bindComfyCloudProtocol('https://www.runninghub.cn','runninghub-workflow-v1'),'1904152026220003329');
  const usage={consumeCoins:'1.2500',consumeMoney:null,thirdPartyConsumeMoney:null,taskCostTime:'35'};
  const f=fixture({respond:url=>json(url.includes('/cloud/')?{...cloud,originals:[],tasks:[{...row,task,usage,archiveState:'archived',resultAvailable:false,canRetryCleanup:false}]}:native)});
  const data=await f.client.catalogAll(),item=data.originals.find(row=>row.engine==='cloud');
  assert.deepEqual(item.usage,usage);assert.equal(item.canReceiveOriginal,false);assert.equal(item.resultAvailable,false);
  assert.ok(f.calls.every(call=>/\/(?:capabilities|catalog)$/.test(call.url)));f.client.close();
});

test('partial catalog and unreadable cache retain known originals without inventing zero usage',async()=>{
  for(const mode of ['missing-cloud','missing-native','unreadable']){
    const f=fixture({respond:(url)=>{
      const isCloud=url.includes('/cloud/');
      if(mode===(isCloud?'missing-cloud':'missing-native'))return new Response('{}',{status:404});
      return json(isCloud?{...cloud,...(mode==='unreadable'?{storageReadable:false,totals:{...totals,imageBytes:null},originals:[],
        tasks:[{...row,archiveState:'archived',canRetryCleanup:true}],warning:'暂存暂不可读取'}:{})}:native);
    }});
    const data=await f.client.catalogAll();assert.equal(data.storageReadable,false);assert.equal(data.totals.imageBytes,null);assert.match(data.warning,/暂不可读取/);
    assert.ok(data.originals.length>0);
    if(mode==='unreadable')assert.equal(data.originals.find(item=>item.engine==='cloud').canRetryCleanup,true);
  }
});
test('late catalog replies cannot mix two ST accounts',async()=>{
  const f=fixture({respond:url=>{f.switchAccount();return json(url.includes('/cloud/')?cloud:native);}});
  await assert.rejects(f.client.catalogAll(),{code:'comfy_delivery_account'});
});
test('accepted but not yet cached cloud jobs remain discoverable without fabricating ready images',async()=>{
  const f=fixture({respond:url=>json(url.includes('/cloud/')?{...cloud,originals:[],tasks:[{...row,resultAvailable:false,archiveState:null,status:'uncertain'}]}:native)});
  const data=await f.client.catalogAll(),selected=data.originals.find(item=>item.engine==='cloud');
  assert.equal(selected.canReceiveOriginal,true);assert.equal(selected.resultAvailable,false);assert.equal(selected.cloudRecord.status,'prepared');
  assert.ok(f.calls.every(call=>/\/(catalog|capabilities)$/.test(call.url)),'discovery must not fetch media or submit anything');
});
test('older cloud ledger pages use an explicit account-bound cursor and keep retry position after a failed read',async()=>{
  const cursor={channelKey,attemptId:'original'};let failed=false;
  const f=fixture({respond:(url,body)=>{
    if(!url.includes('/cloud/'))return json(native);
    if(failed)return new Response('{}',{status:503});
    return json({...cloud,originals:[],tasks:[{...row,attemptId:body.cursor?'older':'original'}],nextCursor:body.cursor?null:cursor});
  }});
  const first=await f.client.catalogAll();assert.deepEqual(first.cloudNextCursor,cursor);
  const next=await f.client.catalogAll({cloudCursor:first.cloudNextCursor,namespace:first.namespace});
  assert.equal(next.cloudNextCursor,null);assert.ok(next.originals.some(item=>item.attemptId==='older'));
  failed=true;const retry=await f.client.catalogAll({cloudCursor:cursor,namespace:first.namespace});
  assert.deepEqual(retry.cloudNextCursor,cursor);assert.equal(retry.storageReadable,false);assert.match(retry.warning,/暂不可读取/);
  assert.ok(f.calls.every(call=>/\/(catalog|capabilities)$/.test(call.url)));
  f.switchAccount();await assert.rejects(f.client.catalogAll({cloudCursor:cursor,namespace:first.namespace}),{code:'comfy_delivery_account'});
});
test('original cleanup needs archived proof, uses no Key and never manufactures missing local files',async()=>{
  let cleanup='pending';
  const f=fixture({respond:(url)=>json(url.endsWith('/catalog')?{...cloud,originals:[{...row,archiveState:'archived',canRetryCleanup:true}]}:
    {ok:true,version:1,status:'archived',task,delivery:{state:'archived',cacheReceipt:receipt},cleanup})});
  const selected=(await f.client.cloudCatalog()).originals[0];
  assert.match((await f.client.retryCloudCleanup(selected)).warning,/尚未清理完/);
  cleanup='complete';assert.equal((await f.client.retryCloudCleanup(selected)).warning,'');
  const ack=f.calls.filter(call=>call.url.endsWith('/acknowledge'));assert.equal(ack.length,2);
  assert.ok(ack.every(call=>call.body.archived===true&&call.body.apiKey===undefined&&call.body.receipt===receipt));
  await assert.rejects(f.client.retryCloudCleanup({...selected,archiveState:'stored'}),{code:'comfy_delivery_confirmation'});
  assert.equal(f.calls.length,3);
});
test('incorrect cleanup receipt in response remains unconfirmed',async()=>{
  const f=fixture({respond:()=>json({ok:true,version:1,status:'archived',task,delivery:{state:'archived',cacheReceipt:'b'.repeat(64)},cleanup:'complete'})});
  await assert.rejects(f.client.retryCloudCleanup({...row,namespace:'st-user:alice',engine:'cloud',archiveState:'archived',canRetryCleanup:true}),{code:'comfy_delivery_confirmation'});
});
test('cloud credential resolver selects the exact original key, not just another key at the same host',async()=>{
  const f=fixture(),selected=(await f.client.cloudCatalog()).originals[0],reads=[];
  const group={draft:{baseUrl:'https://cloud.comfy.org/api/v2',credentialId:'wrong'},presets:[{baseUrl:connection.origin,credentialId:'original'}]};
  const deps={connections:()=>group,resolve:async id=>{reads.push(id);return id==='original'?key:'different-key';}};
  assert.equal(await resolveComfyCloudRecoveryKey(selected,deps),key);assert.deepEqual(reads,['wrong','original']);
  reads.length=0;group.presets.push({baseUrl:'https://unrelated.test',credentialId:'original'});
  assert.equal(await resolveComfyCloudRecoveryKey(selected,deps),'');assert.deepEqual(reads,['wrong'],'ambiguous credential ownership must not be read');
});
test('cloud key resolution rechecks live configuration and does no work for already archived records',async()=>{
  const f=fixture(),selected=(await f.client.cloudCatalog()).originals[0];
  const group={draft:{baseUrl:connection.origin,credentialId:'original'}};
  assert.equal(await resolveComfyCloudRecoveryKey(selected,{connections:()=>group,resolve:async()=>{group.draft.baseUrl='https://different.test';return key;}}),'');
  assert.equal(await resolveComfyCloudRecoveryKey({...selected.cloudRecord,status:'archived'},{connections:()=>assert.fail('no connection needed'),resolve:()=>assert.fail('no Key needed')}),'');
  group.draft.baseUrl=connection.origin;
  await assert.rejects(resolveComfyCloudRecoveryKey(selected,{connections:()=>group,resolve:async()=>key,guard:()=>{throw Error('page changed');}}),/page changed/);
});
test('capability read is small, account bound, keyless and does not imply paid submission support',async()=>{
  const f=fixture(),data=await f.client.cloudCapabilities();
  assert.equal(data.submission,false);assert.deepEqual(data.resultProviders,['comfy-cloud']);
  assert.deepEqual(f.calls.map(call=>[call.method,call.body]),[['GET',{}]]);
  for(const change of [{version:2},{archiveConfirmation:'true'},{resultProviders:['unknown']},{resultProviders:['comfy-cloud','comfy-cloud']},{submissionProviders:null},{submissionProviders:['other']}]){
    const bad=fixture({capabilities:()=>json({...capability,...change})});
    await assert.rejects(bad.client.cloudCapabilities(),{code:'comfy_delivery_capabilities'});
  }
  const foreign=fixture({capabilities:()=>json({...capability,expectedAccount:'st-user:someone-else'})});
  await assert.rejects(foreign.client.cloudCapabilities(),{code:'comfy_delivery_account'});
});

test('submission providers are explicit on new hosts and conservatively inferred only for legacy Comfy Cloud',async()=>{
  for(const [extra,expected] of [[{submission:true},['comfy-cloud']],[{submission:false},[]],
    [{submission:true,submissionProviders:['comfy-cloud','runninghub']},['comfy-cloud','runninghub']]]){
    const f=fixture({capabilities:()=>json({...capability,...extra})});
    assert.deepEqual((await f.client.cloudCapabilities()).submissionProviders,expected);f.client.close();
  }
});
test('old backend yields a precise update notice while native records remain accessible',async()=>{
  const f=fixture({capabilities:()=>new Response('',{status:404})}),data=await f.client.catalogAll();
  assert.match(data.warning,/后端尚未支持云任务/);assert.equal(data.cloudCapabilities,null);assert.equal(data.originals.length,1);
  assert.equal(data.storageReadable,false);assert.ok(!f.calls.some(call=>call.url.endsWith('/cloud/tasks/catalog')));
});
test('advertised unsupported result retrieval disables cloud actions without hiding stored metadata',async()=>{
  const f=fixture({capabilities:()=>json({...capability,resultRetrieval:false,archiveConfirmation:false,resultProviders:[]})});
  const data=await f.client.catalogAll(),item=data.originals.find(value=>value.engine==='cloud');
  assert.equal(item.resultAvailable,false);assert.equal(item.canReceiveOriginal,false);assert.equal(item.canRetryCleanup,false);
  assert.equal(data.cloudCapabilities.resultRetrieval,false);
});
