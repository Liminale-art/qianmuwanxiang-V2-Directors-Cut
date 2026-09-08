import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPortableStoryboardData as check} from '../qianmu-storyboard-package-security.js';
import {buildStoryboardVibePackage,inspectStoryboardVibePackage} from '../qianmu-storyboard-package-assets.js';
import {fixture,file} from './fixtures/storyboard-bundle.mjs';

test('structured credential variants and opaque headers are rejected without leaking their values',async()=>{
  for(const key of ['apiKey','API-token','Access_Key','authorization','Cookie','refreshToken','Session_Token','clientSecret','password','credentialId','grantId','sharedSecret','BearerToken','privateKey','auth','token']){
    await assert.rejects(()=>check({snapshot:{profile:{[key]:'private-fixture-value'}}}),error=>/凭据|授权/.test(error.message)&&!error.message.includes('private-fixture-value'));
  }
  for(const value of [{headers:'X-Key: private-fixture-value'},{customHeaders:['private-fixture-value']},{headers:{'X-Service-Auth':'private-fixture-value'}}])await assert.rejects(()=>check(value));
});

test('public metadata, zero generation values, empty dedicated references and ordinary text survive unchanged',async()=>{
  const value={settings:{tokenBudget:0,max_tokens:2200,seed:0,apiKey:'',credentialId:null,headers:{'X-Client':'qianmu'},apiUrl:'https://example.test/api?version=1'},prompt:'a token, api_key: fictional text',workflow:'{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"token and authorization in prose"}}}'};
  const before=JSON.stringify(value);assert.equal(await check(value),true);assert.equal(JSON.stringify(value),before);
});

test('credential URL queries, embedded identities and fragments cannot hide in profile or historical URLs',async()=>{
  for(const key of ['apiUrl','BASE_URL','comfy_url','url','uri','href','endpoint','previewUrl','image_url','thumbnailUri'])for(const url of ['https://u:private-fixture-value@example.test','https://example.test?api%5Fkey=private-fixture-value','https://example.test?X-Amz-Signature=private-fixture-value','https://example.test#private-fixture-value']){
    await assert.rejects(()=>check({[key]:url}),error=>!error.message.includes('private-fixture-value'));
  }
  assert.equal(await check({url:'/user/images/local.png',uri:'data:image/png;base64,AAAA',endpoint:'https://example.test/api?version=1'}),true);
});

test('serialized workflow credentials, duplicate escaped keys and malformed originals stop without graph rewriting',async()=>{
  for(const workflow of ['{"node":{"inputs":{"apiToken":"private-fixture-value"}}}','{"a":1,"\\u0061":2}','{"node":','{"node":{"inputs":{"customHeaders":"opaque"}}}','{"node":{"inputs":{"endpoint":"https://example.test?token=private-fixture-value"}}}']){
    const value={workflows:[{document:{workflow}}]},before=JSON.stringify(value);await assert.rejects(()=>check(value));assert.equal(JSON.stringify(value),before);
  }
  await assert.rejects(()=>check({comfyWorkflow:JSON.stringify({text:'x'.repeat(2*1048576)})}),/超限/);
});

test('nested graph strings and DAGs are checked within one bounded operation; no stale cross-call cache',async()=>{
  const shared={workflow:'{"node":{"inputs":{"text":"public"}}}'},value={a:shared,b:shared};assert.equal(await check(value),true);
  value.b.workflow='{"node":{"inputs":{"sessionToken":"secret"}}}';await assert.rejects(()=>check(value));
  await assert.rejects(()=>check({workflow:JSON.stringify({workflow:value.b.workflow})}));
  const cyclic={};cyclic.self=cyclic;await assert.rejects(()=>check(cyclic),/循环/);
  let deep={value:1};for(let i=0;i<42;i++)deep={child:deep};await assert.rejects(()=>check(deep),/过深/);
  await assert.rejects(()=>check(JSON.parse('{"constructor":{}}')),/不安全/);
});

test('v7 metadata checks run before loading originals and credentialsIncluded=false is not trusted',async()=>{
  const payload={type:'qianmu-storyboard',version:7,credentialsIncluded:false,settings:{profiles:{comfy:{comfyWorkflow:'{"node":{"inputs":{"apiToken":"secret"}}}'}}},chat:{images:[],collections:[]},vibeAccount:'st-user:fixture',vibeAssets:[]};
  const before=JSON.stringify(payload);let loads=0;
  await assert.rejects(()=>buildStoryboardVibePackage(payload,{namespace:payload.vibeAccount,load:()=>loads++}),/凭据/);
  await assert.rejects(()=>inspectStoryboardVibePackage(payload),/凭据/);assert.equal(loads,0);assert.equal(JSON.stringify(payload),before);
});

test('a deeper graph reuse discovered after its first inspection cannot evade the total nesting bound',async()=>{
  const workflow='{"node":{"inputs":{"text":"public"}}}';let nested={workflow};for(let i=0;i<37;i++)nested={child:nested};
  await assert.rejects(()=>check({workflow,nested:{workflow:JSON.stringify(nested)}}),/过深/);
});

test('full bundle checks serialized library originals and config credentials before any image reads',async()=>{
  for(const target of ['config','workflow']){
    const f=await fixture();
    if(target==='config'){f.config.settings.profiles.comfy.apiToken='secret';f.options.storyboard=file(f.config);}
    else f.sources.workflows.workflows[0].versions[0].document.workflow='{"node":{"inputs":{"apiToken":"secret"}}}';
    const before=JSON.stringify(f.sources);await assert.rejects(()=>f.build(),/凭据/);assert.equal(f.reads.images,0);assert.equal(JSON.stringify(f.sources),before);
  }
});
