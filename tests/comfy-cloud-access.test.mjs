import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeComfyCloudTarget} from '../qianmu-comfy-cloud-access.js';
import {createComfyCloudServerTransport} from '../qianmu-comfy-server-transport.js';
import {bindComfyCloudProtocol} from '../qianmu-comfy-cloud-protocol.js';
import {requireTrustedComfyConnection} from '../qianmu-comfy-targets-view.js';
import {createStoryboardFormFixture} from './helpers/storyboard-form-fixture.mjs';

const user=()=>({user:{profile:{handle:'alice',enabled:true,admin:false}}});
const target=baseUrl=>({baseUrl,allowPrivateNetwork:false});

test('an ordinary authenticated user can authorize only official public cloud roots, without native target registration',async()=>{
  for(const root of ['https://cloud.comfy.org','https://deployment.run.comfy.app','https://www.runninghub.cn','https://www.runninghub.ai']){
    const verify=await authorizeComfyCloudTarget(user(),target(root));await verify();
  }
  for(const input of [target('https://custom-comfy.test'),target('http://127.0.0.1:8188'),target('https://cloud.comfy.org.attacker.test'),
    target('https://cloud.comfy.org/jobs/other'),target('https://secret@cloud.comfy.org'),target('http://cloud.comfy.org'),target('https://cloud.comfy.org?key=secret'),
    {...target('https://cloud.comfy.org'),allowPrivateNetwork:true}])await assert.rejects(authorizeComfyCloudTarget(user(),input),{code:'comfy_cloud_access_target'});
  await assert.rejects(authorizeComfyCloudTarget({},target('https://cloud.comfy.org')),{code:'comfy_cloud_access_account'});
});

test('cloud authorization remains bound to the original ST identity and optional site revocation policy',async()=>{
  const req=user();let permitted=true;
  const verify=await authorizeComfyCloudTarget(req,target('https://cloud.comfy.org'),{policy:async(_req,binding)=>{
    assert.equal(binding.provider,'comfy-cloud');assert.ok(Object.isFrozen(binding));return async()=>{if(!permitted)throw Error('site revoked');};
  }});
  await verify();permitted=false;await assert.rejects(verify(),/site revoked/);permitted=true;
  req.user.profile.handle='bob';await assert.rejects(verify(),{code:'comfy_cloud_access_account'});
  await assert.rejects(authorizeComfyCloudTarget(user(),target('https://cloud.comfy.org'),{policy:async()=>undefined}),{code:'comfy_cloud_access_policy'});
  const disabled=user();disabled.user.profile.enabled=false;await assert.rejects(authorizeComfyCloudTarget(disabled,target('https://cloud.comfy.org')));
});

test('official cloud permission does not authorize private DNS, mixed DNS or a departed account',async()=>{
  const binding=bindComfyCloudProtocol('https://cloud.comfy.org','comfy-cloud-v2');
  for(const addresses of [[{address:'127.0.0.1'}],[{address:'8.8.8.8'},{address:'10.0.0.1'}]]){
    await assert.rejects(createComfyCloudServerTransport(user(),{binding,operation:'submit'},
      {authorizeTarget:authorizeComfyCloudTarget,resolveHost:async()=>addresses,requestImpl:()=>assert.fail('private cloud DNS must not open a socket')}));
  }
  const req=user();await assert.rejects(createComfyCloudServerTransport(req,{binding,operation:'submit'},
    {authorizeTarget:authorizeComfyCloudTarget,resolveHost:async()=>{req.user.profile.handle='other';return [{address:'8.8.8.8'}];},requestImpl:()=>assert.fail('departed account')}));
});

test('cloud preflight skips only native target enrollment; native preflight still requires its existing registration',async()=>{
  let checks=0;
  const cloud=await requireTrustedComfyConnection({baseUrl:'https://cloud.comfy.org',options:{allowPrivateNetwork:true}},
    {assertCurrent:()=>checks++,fetchImpl:()=>assert.fail('official cloud must not fetch native trust registry')});
  assert.equal(cloud.cloud.provider,'comfy-cloud');assert.equal(checks,1);
  await assert.rejects(requireTrustedComfyConnection({baseUrl:'https://native.test'},{headers:()=>({}),fetchImpl:async()=>Response.json({ok:true,schemaVersion:1,revision:0,admin:false,targets:[]})}),/管理员登记/);
});

test('cloud settings show only the platform label, while native controls remain unchanged',()=>{
  for(const [baseUrl,label] of [['https://cloud.comfy.org','Comfy Cloud'],['https://www.runninghub.cn','RunningHub']]){
    const form=createStoryboardFormFixture({family:'comfy',connection:{baseUrl}}).content;
    assert.ok(form.includes(label));assert.doesNotMatch(form,/sd-comfy-transport|sd-comfy-targets|sd-comfy-deployment-guide|sd-comfy-private-network/);
  }
  const native=createStoryboardFormFixture({family:'comfy',connection:{baseUrl:'http://127.0.0.1:8188'}}).content;
  assert.match(native,/sd-comfy-transport/);assert.match(native,/sd-comfy-targets/);
});
