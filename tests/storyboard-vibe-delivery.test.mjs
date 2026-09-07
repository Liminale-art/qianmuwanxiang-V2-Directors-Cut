import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { generateImage } from '../qianmu-image-gateway.js';
import * as core from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return tail.slice(0, next + 1);
}
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('image')]);
function environment(items, read = async () => ({ data: png.toString('base64'), mime: 'image/png' })) {
  const state = { enabled:true,vibeLibrary: items };
  const job={source:'novel',profile:{model:'nai-diffusion-4-5-full'},payload:{selectedVibeIds:items.map(item=>item.id),vibeRecipe:core.captureStoryboardVibeRecipe(items.map(item=>item.id),items)}};
  const ctx = vm.createContext({ ...core,storyboardAdmissionEpoch:1,featureRuntime:{load:async()=>({resolveImageAccountNamespace:async()=> 'st-user:test'})},
    storyboardState: () => state, storyboardSafeUrl: value => /^https:\/\//.test(value) ? value : '', storyboardReadImageReference: read });
  vm.runInContext(section('storyboardVibeAmount') + section('storyboardPrepareGatewayAssets'), ctx);
  return { state,job,context:ctx,prepare: () => ctx.storyboardPrepareGatewayAssets(job) };
}
for (const [value, strength, information] of [[0,0,0],['0',0,0],['',.6,1],[undefined,.6,1],[Infinity,.6,1]]) {
  test(`Vibe preparation preserves zero and defaults missing values (${String(value)} ${typeof value})`, async () => {
    const { prepare } = environment([{ id:'v', previewUrl:'https://image.example/a.png', strength:value, informationExtracted:value }]);
    const result = await prepare();
    assert.equal(result.vibes[0].strength,strength); assert.equal(result.vibes[0].information,information);
  });
}
test('Vibe source/amounts are frozen before queueing and survive library replacement before or during any image read', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const rows = [{id:'a',previewUrl:'https://image.example/a.png',strength:0,informationExtracted:0},
    {id:'b',previewUrl:'https://image.example/b.png',strength:.2,informationExtracted:.3}];
  const urls = [];
  const { prepare, state } = environment(rows, async url => { urls.push(url); if(urls.length===1) await gate; return {data:'image'}; });
  const work=prepare();
  rows[0].strength=.9; rows[1].previewUrl='https://other.example/replaced.png';rows[1].informationExtracted=1;
  state.vibeLibrary=[]; finish();
  const assets=await work;
  assert.deepEqual(urls,['https://image.example/a.png','https://image.example/b.png']);
  assert.equal(assets.vibes[0].strength,0);assert.equal(assets.vibes[1].information,.3);
});

test('actual Vibe preparation after library deletion uses only frozen metadata, including historical normalization and retry',async()=>{
  const e=environment([{id:'a',name:'First',previewUrl:'https://image.example/a.png',strength:.2,informationExtracted:0}],async url=>({data:png.toString('base64'),url}));
  e.state.vibeLibrary=[];const original=structuredClone(e.job.payload.vibeRecipe);
  e.job.payload=core.sanitizeStoryboardSnapshot(e.job).payload;
  const assets=await e.prepare();assert.equal(assets.vibes[0].url,'https://image.example/a.png');assert.equal(assets.vibes[0].strength,.2);assert.equal(assets.vibes[0].information,0);
  assert.deepEqual(e.job.payload.vibeRecipe,original);
});

test('legacy missing recipes, corrupt recipes and unsupported models stop before reading any Vibe',async()=>{
  for(const change of [job=>delete job.payload.vibeRecipe,job=>job.payload.vibeRecipe.items[0].strength=2,
    job=>job.payload.selectedVibeIds=[],job=>job.profile.model='nai-diffusion-5-full']){
    let reads=0;const e=environment([{id:'a',previewUrl:'https://image.example/a.png'}],async()=>{reads++;return {data:'image'};});change(e.job);
    await assert.rejects(e.prepare(),/Vibe/);assert.equal(reads,0);
  }
});

test('in-flight cancellation, recipe changes and account switches discard prepared Vibe data before any image generation',async()=>{
  for(const change of [e=>e.job.discardRequested=true,e=>e.job.payload.vibeRecipe.items[0].strength=.8,
    e=>e.job.payload.selectedVibeIds=[],e=>{e.context.featureRuntime.load=async()=>({resolveImageAccountNamespace:async()=> 'st-user:other'});}]){
    let e;let account='st-user:test';const identity={resolveImageAccountNamespace:async()=>account};
    e=environment([{id:'a',previewUrl:'https://image.example/a.png'}],async()=>{change(e);if(e.context.featureRuntime.load!==load)account='st-user:other';return {data:'image'};});
    const load=async()=>identity;e.context.featureRuntime.load=load;
    await assert.rejects(e.prepare(),/已变化/);
  }
});

test('unreadable frozen sources fail without falling back to a new library URL',async()=>{
  const calls=[];const e=environment([{id:'a',previewUrl:'https://image.example/old.png'}],async url=>{calls.push(url);throw Error('原图不存在');});
  e.state.vibeLibrary[0].previewUrl='https://image.example/new.png';await assert.rejects(e.prepare(),/原图不存在/);assert.deepEqual(calls,['https://image.example/old.png']);
});
test('actual prepared zero values reach both NAI transports unchanged', async () => {
  const { prepare } = environment([{id:'zero',previewUrl:'https://image.example/a.png',strength:0,informationExtracted:0}]);
  const assets=await prepare();
  const input={provider:'novel',model:'vendor/NAI',capabilityModelId:'nai-diffusion-3',apiKey:'test-key',baseUrl:'https://relay.example',prompt:'landscape',vibes:assets.vibes,parameters:{count:1}};
  for (const run of [generateDirectImage,generateImage]) {
    let body;
    await run(input,{resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);return new Response(png,{headers:{'content-type':'image/png'}});}});
    assert.deepEqual(body.parameters.reference_strength_multiple,[0]);
    assert.deepEqual(body.parameters.reference_information_extracted_multiple,[0]);
  }
});
test('the library display uses the same zero-preserving formatter as the sending path', () => {
  assert.match(source,/强度 \$\{storyboardVibeAmount\(item.strength, 0.6\).toFixed\(2\)\}/);
  assert.match(source,/信息 \$\{storyboardVibeAmount\(item.informationExtracted, 1\).toFixed\(2\)\}/);
});
