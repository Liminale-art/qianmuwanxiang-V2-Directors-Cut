import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { generateImage } from '../qianmu-image-gateway.js';
import * as core from '../qianmu-storyboard.js';
import {prepareStoryboardVibes} from '../qianmu-vibe-prepare.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {parseNovelVibeFile} from '../qianmu-vibe-file.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return tail.slice(0, next + 1);
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
function environment(items, read = async () => ({ data: png.toString('base64'), mime: 'image/png' })) {
  const state = { enabled:true,vibeLibrary: items };
  // This suite verifies the legacy raw/V3 path. V4/4.5's actual paid/cached path is covered in vibe-prepare.
  const job={source:'novel',profile:{model:'nai-diffusion-3'},connection:{baseUrl:'https://relay.example'},payload:{selectedVibeIds:items.map(item=>item.id),vibeRecipe:core.captureStoryboardVibeRecipe(items.map(item=>item.id),items)}};
  const files=new Map();let account='st-user:test';const run=createVibeAssetOperations({
    putFile:async(_namespace,text)=>{const assets=await parseNovelVibeFile(text);assets.forEach(asset=>files.set(asset.assetId,asset));return assets;},load:async(_namespace,id)=>files.get(id),
  });
  const ctx = vm.createContext({ ...core,clone:structuredClone,confirmDialog:async()=>assert.fail('V3 should not request encoding fees'),storyboardAdmissionEpoch:1,
    featureRuntime:{load:async key=>key==='vibePrepare'?{prepareStoryboardVibes}:key==='vibeAssets'?{callVibeAsset:(type,args)=>run({type,...args})}:{resolveImageAccountNamespace:async()=>account}},
    storyboardState: () => state, storyboardSafeUrl: value => /^https:\/\//.test(value) ? value : '', storyboardReadImageReference: read });
  vm.runInContext(section('storyboardVibeAmount') + section('storyboardPrepareGatewayAssets'), ctx);
  return { state,job,context:ctx,setAccount:value=>account=value,prepare: () => ctx.storyboardPrepareGatewayAssets(job) };
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
  const { prepare, state } = environment(rows, async url => { urls.push(url); if(urls.length===1) await gate; return {data:png.toString('base64')}; });
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
  const assets=await e.prepare();assert.equal(assets.vibes[0].data,png.toString('base64'));assert.equal(assets.vibes[0].strength,.2);assert.equal(assets.vibes[0].information,0);
  assert.equal(e.job.payload.vibeRecipe.version,2);assert.match(e.job.payload.vibeRecipe.items[0].assetRef.id,/^[a-f0-9]{64}$/);
  assert.deepEqual(e.job.payload.vibeRecipe.items[0],{...original.items[0],previewUrl:'',assetRef:e.job.payload.vibeRecipe.items[0].assetRef});
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
    e=>e.job.payload.selectedVibeIds=[],e=>e.setAccount('st-user:other')]){
    let e;e=environment([{id:'a',previewUrl:'https://image.example/a.png'}],async()=>{change(e);return {data:png.toString('base64')};});
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
test('the lazy library display retains zero rather than replacing it with defaults', async () => {
  const view=await readFile(new URL('../qianmu-vibe-library-view.js',import.meta.url),'utf8');
  assert.match(view,/value==null\|\|value===''/);assert.match(view,/强度 \$\{amount\(item.strength,\.6\).toFixed\(2\)\}/);
  assert.match(view,/信息 \$\{amount\(item.informationExtracted,1\).toFixed\(2\)\}/);
});
