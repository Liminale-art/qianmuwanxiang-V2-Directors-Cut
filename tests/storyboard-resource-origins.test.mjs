import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,file,namespace,chatKey,receipt} from './fixtures/storyboard-bundle.mjs';
import {openStoryboardBundle,buildStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {inspectStoryboardResourceBundle} from '../qianmu-storyboard-bundle-resources.js';
import {projectStoryboardOriginPayload,buildStoryboardResourceOrigins,inspectStoryboardResourceOrigins,storyboardResourceOriginsPage as page,validStoryboardResourceOriginsPage,storyboardResourceOriginsSummary,validStoryboardResourceOriginsSummary} from '../qianmu-storyboard-resource-origins.js';
import {vibeDigest} from '../qianmu-vibe-file.js';

const canonical=value=>JSON.stringify(value,(_,row)=>row&&typeof row==='object'&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
async function input(f){return {payload:await projectStoryboardOriginPayload(f.config),...f.sources,originals:[receipt]};}
async function replace(built,value){const opened=await openStoryboardBundle(built.file),entries=[];
  for(const row of opened.manifest.entries){if(row.id==='resource-origins'&&value===null)continue;entries.push({id:row.id,file:row.id==='resource-origins'?file(value):(await opened.read(row.id)).file,...(row.mime?{mime:row.mime}:{})});}
  return buildStoryboardBundle({namespace,chatKey,entries,createdAt:123});
}

test('bundles trace every fixed workflow revision including unused file declarations and distinguish dynamic slots',async()=>{
  const f=await fixture({externalFiles:2}),before=structuredClone(f.sources),built=await f.build(),opened=await openStoryboardBundle(built.file),origins=await opened.readJson('resource-origins');
  const files=origins.rows.filter(row=>row.kind==='comfy-file');assert.equal(files.length,4);assert.deepEqual(new Set(files.map(row=>row.owner)),new Set(['workflow@wrev1/v1','workflow@wrev2/v2']));
  assert.ok(files.every(row=>row.state==='external'&&!row.sha256&&!Object.hasOwn(row,'bytes')));assert.ok(files.some(row=>row.target==='models/test-1-v2.safetensors'));
  assert.equal(origins.rows.filter(row=>row.kind==='comfy-slot'&&row.state==='dynamic').length,2);assert.equal(origins.rows.filter(row=>row.kind==='workflow-review').length,2);
  assert.ok(origins.rows.some(row=>row.kind==='workflow'&&row.at.startsWith('characters')));assert.ok(origins.rows.some(row=>row.kind==='connection'&&row.at.startsWith('pools')&&row.target==='comfy/connection'));
  assert.ok(origins.rows.some(row=>row.kind==='image'&&row.label==='阅片室成片原件'&&row.sha256));assert.deepEqual(f.sources,before);assert.equal(f.reads.images,1);
  const inspected=await inspectStoryboardResourceBundle(built.file);assert.equal(inspected.origins,undefined,'ordinary inspection does not post the whole use catalogue to the UI');assert.equal(inspected.summary.resourceOrigins.recorded,true);
  assert.deepEqual(inspected.summary.resourceOrigins,built.summary.resourceOrigins);
});

test('the source projection retains hashes but not base64 media or opaque Vibe documents',async()=>{
  const f=await fixture();f.config.vibeAssets=[{id:'a'.repeat(64),bytes:42,document:{synthetic:'opaque-original'}}];const before=JSON.stringify(f.config),projection=await projectStoryboardOriginPayload(f.config);
  assert.equal(projection.media[0].sha256,receipt.sha256);assert.equal(projection.media[0].bytes,receipt.bytes);assert.equal(projection.media[0].b64,undefined);
  assert.equal(projection.vibeAssets[0].document,undefined);assert.equal(JSON.stringify(projection).includes('opaque-original'),false);assert.equal(JSON.stringify(f.config),before);
});

test('current selected model family is not guessed for old references and LLM profiles remain external',async()=>{
  const f=await fixture();f.config.settings.source='comfy';f.config.settings.taskStates=[{id:'old',connectionPresetId:'connection'}];
  f.config.settings.promptCompiler={apiProfileId:'st-profile',connectionPresetId:'connection'};
  f.config.chat.images[0].source='comfy';f.config.chat.images[0].snapshot={connection:{id:'historical',baseUrl:'http://127.0.0.1:8188'}};
  const origins=await buildStoryboardResourceOrigins(await input(f));
  assert.ok(origins.rows.some(row=>row.kind==='connection'&&row.state==='unresolved'&&row.target==='connection'&&row.at.includes('taskStates')));
  assert.equal(origins.rows.filter(row=>row.kind==='llm-profile'&&row.state==='external').length,2);
  assert.ok(origins.rows.some(row=>row.kind==='connection'&&row.target==='comfy/historical'&&row.state==='included'));
});

test('only matching captured receipts count as included; bare URL sources are not promoted to originals',async()=>{
  const f=await fixture(),args=await input(f);args.payload.settings.artistPresets=[{id:'artist',previewUrl:'https://example.test/image?token=not-copied'}];
  args.originals=[{...receipt,sha256:'b'.repeat(64)}];const result=await buildStoryboardResourceOrigins(args);
  assert.ok(result.rows.some(row=>row.at.includes('artistPresets')&&row.state==='external'));
  assert.ok(result.rows.some(row=>row.target==='参考原件未随包收录'&&row.at.startsWith('characters')));
  assert.equal(JSON.stringify(result).includes('not-copied'),false);assert.equal(JSON.stringify(result).includes('private annotation'),false);
});

test('typed inline workflow copies and character LoRAs are traced without treating unknown inputs as checked files',async()=>{
  const f=await fixture(),args=await input(f);args.payload.settings.profiles.comfy.workflow=JSON.stringify({load:{class_type:'CustomLoader',inputs:{ckpt_name:'old.safetensors',unrecognized_path:'/some/model'}}});
  args.characters.archives[0].document.comfy.implementations[0].loras=[{nodeId:'one',classType:'LoraLoader',loraName:'role.safetensors'}];
  const result=await buildStoryboardResourceOrigins(args);assert.ok(result.rows.some(row=>row.target==='old.safetensors'&&row.at.startsWith('storyboard')));
  assert.ok(result.rows.some(row=>row.target==='role.safetensors'&&row.at.startsWith('characters')));
  assert.ok(result.rows.some(row=>row.kind==='workflow-review'&&row.at.startsWith('storyboard')));assert.equal(result.rows.some(row=>row.target==='/some/model'),false);
});

test('known signed node URLs and structured secrets fail rather than being copied or rewritten',async()=>{
  for(const inputs of [{image:'https://example.test/image?api_key=synthetic-secret'},{XApiKey:'synthetic-secret'}]){
    const f=await fixture(),args=await input(f);args.payload.settings.profiles.comfy.workflow=JSON.stringify({load:{class_type:'LoadImage',inputs}});const before=JSON.stringify(args);
    await assert.rejects(buildStoryboardResourceOrigins(args),error=>!error.message.includes('synthetic-secret'));assert.equal(JSON.stringify(args),before);
  }
});

test('unknown filename fields and unsupported template slots remain unverified rather than claiming external input files or supported dynamic slots',async()=>{
  const f=await fixture(),args=await input(f);args.payload.settings.profiles.comfy.workflow=JSON.stringify({
    save:{class_type:'CustomOutput',inputs:{filename:'result.png'}},load:{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'%qianmu_unknown_model%'}}});
  const rows=(await buildStoryboardResourceOrigins(args)).rows;
  assert.ok(rows.some(row=>row.target==='result.png'&&row.state==='review'));assert.ok(rows.some(row=>row.target==='%qianmu_unknown_model%'&&row.state==='review'));
});

test('fresh checksums cannot disguise a use list changed independently of source documents',async()=>{
  const f=await fixture({externalFiles:2}),built=await f.build(),opened=await openStoryboardBundle(built.file),original=await opened.readJson('resource-origins');
  for(const change of [x=>x.rows.pop(),x=>x.rows.find(row=>row.kind==='comfy-file').state='included',x=>x.rows[0].at+='edited']){
    const value=structuredClone(original);change(value);const {digest:ignored,...body}=value;value.digest=await vibeDigest(canonical(body));
    await assert.rejects(inspectStoryboardResourceBundle((await replace(built,value)).file),/与原包资料不符/);
  }
  await inspectStoryboardResourceOrigins(original,original);
});

test('old bundles reconstruct declared uses without claiming a source-era manifest or altering the original',async()=>{
  const f=await fixture(),built=await f.build(),legacy=await replace(built,null),before=await legacy.file.arrayBuffer();
  const inspected=await inspectStoryboardResourceBundle(legacy.file,{includeOrigins:true});assert.equal(inspected.summary.resourceOrigins.recorded,false);
  assert.ok(inspected.origins.rows.length);assert.deepEqual(await legacy.file.arrayBuffer(),before);
});

test('bounded pages expose only 24 uses, validate offsets and filters, and never mutate the catalogue',async()=>{
  const f=await fixture({externalFiles:25}),built=await f.build(),document=await(await openStoryboardBundle(built.file)).readJson('resource-origins'),before=JSON.stringify(document);
  const first=page(document),second=page(document,{offset:24}),external=page(document,{filter:'external'});
  assert.equal(first.rows.length,24);assert.equal(second.rows.length,24);assert.equal(external.rows.length,24);assert.ok(external.rows.every(row=>row.state==='external'));
  assert.equal(validStoryboardResourceOriginsPage(first),true);assert.equal(validStoryboardResourceOriginsSummary(storyboardResourceOriginsSummary(document,true)),true);
  for(const options of [{offset:-1},{offset:1},{offset:999984},{filter:'secret'},{includeBodies:true}])assert.throws(()=>page(document,options));
  assert.equal(validStoryboardResourceOriginsPage({...first,rows:[...first.rows,first.rows[0]]}),false);
  assert.equal(validStoryboardResourceOriginsPage({...first,rows:[{...first.rows[0],authorization:'private'},...first.rows.slice(1)]}),false);assert.equal(JSON.stringify(document),before);
});

test('cancellation and unsupported long or invalid workflow structures preserve source documents',async()=>{
  const f=await fixture(),args=await input(f),before=JSON.stringify(args);await assert.rejects(buildStoryboardResourceOrigins(args,{guard:async()=>{throw Error('cancelled');}}),/cancelled/);assert.equal(JSON.stringify(args),before);
  args.payload.settings.profiles.comfy.workflow='{incomplete';await assert.rejects(buildStoryboardResourceOrigins(args),/无法完整读取/);
  args.payload.settings.profiles.comfy.workflow=JSON.stringify({load:{class_type:'LoadImage',inputs:{image:'x'.repeat(4097)}}});await assert.rejects(buildStoryboardResourceOrigins(args),/过长/);
});

test('large historical catalogues remain worker-pageable without dropping old file uses or expanding a page',async()=>{
  const document={workflow:JSON.stringify({a:{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'base.safetensors'}},b:{class_type:'LoraLoader',inputs:{lora_name:'style.safetensors'}},c:{class_type:'VAELoader',inputs:{vae_name:'vae.safetensors'}}})};
  const workflows={workflows:Array.from({length:128},(_,i)=>({versions:Array.from({length:64},(_,j)=>({meta:{id:`workflow-${i}`,revision:`r${j+1}`,version:j+1},document}))}))};
  const payload={type:'qianmu-storyboard',settings:{},chat:{images:[]},media:[],vibeAssets:[]};
  const result=await buildStoryboardResourceOrigins({payload,workflows,pools:{pools:[]},characters:{archives:[]}});
  assert.equal(result.rows.length,32768);assert.ok(result.rows.some(row=>row.owner==='workflow-127@r64/v64'));
  const subset=page(result,{offset:24552,filter:'external'});assert.equal(subset.rows.length,24);assert.equal(subset.total,24576);
  assert.ok(new Blob([JSON.stringify(subset)]).size<16384);assert.ok(new Blob([JSON.stringify(result)]).size<32*1048576);
});
