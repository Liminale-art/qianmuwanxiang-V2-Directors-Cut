import test from 'node:test';
import assert from 'node:assert/strict';
import {generateDirectImage} from '../qianmu-image-direct.js';
import {generateImage,sanitizeImageRequest,imageGatewayCapabilities} from '../qianmu-image-gateway.js';
import {normalizeNovelVibeEntries} from '../qianmu-novel-vibe.js';
import {checkQianmuNovelVibeBinding,probeQianmuImageCapabilities} from '../qianmu-service-capabilities.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
const encoded=(i=0)=>({kind:'novelai-vibe-encoding',data:Buffer.alloc(64,i+1).toString('base64'),encodingModel:'v4-5full',information:null,strength:0});
const base={provider:'novel',model:'relay/prefix',capabilityModelId:'nai-diffusion-4-5-full',baseUrl:'https://relay.example',apiKey:'test-key',prompt:'forest',novelVibeVersion:1,parameters:{count:1}};
const options=fetchImpl=>({fetchImpl,resolveHost:async()=>[{address:'93.184.216.34',family:4}]});
test('all sixteen encoded Vibes reach both transports in order, with zero strengths, and never an invented encoding-time IE',async()=>{
  const sent=[];for(const generate of [generateDirectImage,generateImage]){
    await generate({...base,vibes:Array.from({length:16},(_,i)=>encoded(i))},options(async(url,init)=>{sent.push(JSON.parse(init.body));return new Response(png,{headers:{'content-type':'image/png'}});}));
  }
  for(const request of sent){assert.equal(request.model,base.model);assert.deepEqual(request.parameters.reference_image_multiple,Array.from({length:16},(_,i)=>encoded(i).data));
    assert.deepEqual(request.parameters.reference_strength_multiple,Array(16).fill(0));assert.equal(Object.hasOwn(request.parameters,'reference_information_extracted_multiple'),false);}
});
test('V3 raw images have identical canonical bytes/zero fields on both transports',async()=>{
  const bodies=[];for(const generate of [generateDirectImage,generateImage])await generate({...base,capabilityModelId:'nai-diffusion-3',vibes:[{data:`data:image/png;base64,${png.toString('base64')}`,strength:0,information:0}]},
    options(async(url,init)=>{bodies.push(JSON.parse(init.body));return new Response(png,{headers:{'content-type':'image/png'}});}));
  for(const request of bodies){assert.deepEqual(request.parameters.reference_image_multiple,[png.toString('base64')]);assert.deepEqual(request.parameters.reference_information_extracted_multiple,[0]);assert.deepEqual(request.parameters.reference_strength_multiple,[0]);}
});
test('gateway task admission can sanitize then freeze and revalidate an encoded request without losing its protocol version',async()=>{
  const request=sanitizeImageRequest({...base,vibes:[encoded()]});assert.equal(request.novelVibeVersion,1);
  assert.deepEqual(sanitizeImageRequest(request),request);let body;
  await generateImage(structuredClone(request),options(async(url,init)=>{body=JSON.parse(init.body);return new Response(png,{headers:{'content-type':'image/png'}});}));
  assert.equal(body.parameters.reference_image_multiple[0],encoded().data);
});
for(const [name,change,code] of [
  ['missing version',v=>delete v.novelVibeVersion,'novel_vibe_version'],['wrong version',v=>v.novelVibeVersion=2,'novel_vibe_version'],
  ['wrong model',v=>v.vibes[0].encodingModel='v4full','novel_vibe_model'],['bad bytes',v=>v.vibes[0].data='AAAAA','invalid_vibe_encoding'],
  ['seventeen',v=>v.vibes=Array.from({length:17},()=>encoded()),'invalid_vibe_count'],['V4 raw',v=>v.vibes=[{data:png.toString('base64')}],'novel_vibe_requires_encoding'],
  ['V3 encoded',v=>v.capabilityModelId='nai-diffusion-3','novel_vibe_model'],['untyped provider option',v=>v.parameters={providerOptions:{reference_image_multiple:['x']}},'untyped_vibe'],
  ['V3 broken image',v=>{v.capabilityModelId='nai-diffusion-3';v.vibes=[{data:btoa('not an image')}];},'invalid_reference'],
])test(`${name} is rejected before any direct or gateway submission`,async()=>{
  for(const generate of [generateDirectImage,generateImage]){let writes=0;const input={...base,parameters:{count:1},vibes:[encoded()]};change(input);
    await assert.rejects(()=>generate(input,options(async()=>{writes++;throw Error('unexpected');})),{code});assert.equal(writes,0);}
});
test('combined encoded bytes are bounded even when individual Vibes are under eight MB',()=>{
  const data=Buffer.alloc(8*1024*1024,1).toString('base64'),row={...encoded(),data};
  assert.throws(()=>normalizeNovelVibeEntries({...base,vibes:Array(7).fill(row)}),{code:'references_too_large'});
});
test('old, failed or malformed gateway capabilities cannot enable encoded forwarding',async()=>{
  for(const capabilities of [{status:'ready'},{status:'missing'},{status:'ready',novelVibe:{version:2,encoded:true,maxReferences:16}},
    {status:'ready',novelVibe:{version:1,encoded:true,maxReferences:8}}])assert.equal(checkQianmuNovelVibeBinding(capabilities).ok,false);
  const ready=await probeQianmuImageCapabilities({fetchImpl:async()=>new Response(JSON.stringify(imageGatewayCapabilities()),{headers:{'content-type':'application/json'}})});
  assert.deepEqual(checkQianmuNovelVibeBinding(ready),{ok:true,version:1});
});
