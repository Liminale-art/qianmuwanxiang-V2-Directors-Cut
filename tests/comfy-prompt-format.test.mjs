import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from '../qianmu-storyboard.js';
import * as formats from '../qianmu-prompt-formats.js';
import * as contract from '../qianmu-storyboard-contract.js';
import * as routes from '../qianmu-comfy-route.js';
import * as prompts from '../qianmu-comfy-prompt.js';
import * as workbench from '../qianmu-comfy-workbench-binding.js';
import {applyCharacterCasting,CHARACTER_CASTING_SCHEMA} from '../qianmu-character-casting.js';
import {prepareComfyWorkflow} from '../qianmu-comfy-workflow.js';
import {routeEnvironment,recipesFixture,namespace} from './helpers/comfy-route-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {compilerEnvironment as environment,casting} from './helpers/comfy-compiler-fixture.mjs';
const plain=value=>JSON.parse(JSON.stringify(value));
async function workbenchEnvironment(){
  const e=await environment(); e.state.source='comfy';e.state.view='workflows';e.state.routing.enabled=false;
  Object.assign(e.context,{storyboardNavigate:(_root,patch)=>Object.assign(e.state,patch)});
  vm.runInContext(['storyboardRememberPromptLayer','storyboardApplyComfyLibraryRecipe','storyboardCurrentComfyRecipe'].map(section).join('\n'),e.context);
  const root={isConnected:true};
  await e.context.storyboardApplyComfyLibraryRecipe(root,e.state,e.rows[0]);
  for(const shot of e.response.shots) delete shot.prompt_renderings.natural_language;
  return {...e,root};
}

test('fixed recipes expose only their exact classification and unknown recipes clear stale format provenance',async()=>{
  const f=await recipesFixture({formats:['natural_language','tags']}),prepared=await routes.prepareComfyRouteRecipes({routes:f.routes,namespace,createStore:f.createStore});
  assert.deepEqual(prepared.promptFormats,['tags','natural_language']);assert.ok(Object.isFrozen(prepared.promptFormats));
  assert.equal(prepared.apply(f.routes[0],{}).comfyRoutePromptFormat,'natural_language');
  const old=await recipesFixture();assert.equal(routes.applyComfyRouteRecipe({comfyRoutePromptFormat:'natural_language'},old.routes[0],old.recipes[0]).comfyRoutePromptFormat,undefined);
});
test('alias remapping allows only IDs; visual changes, reordered people and duplicate target IDs fail',()=>{
  const before=core.normalizeStoryboardShotSpec({subject:'Alice reads',characters:[{id:'A',name:'Alice',identity:['silver hair']}],primarySubjectId:'A'});
  const rendering={tags:{global:'kitchen',characters:[{character_id:'A',positive:'silver hair'}],negative:''}};
  const after=core.normalizeStoryboardShotSpec(applyCharacterCasting(before,casting).shot),mapped=formats.remapStoryboardPromptRenderings(rendering,before,after);
  assert.equal(mapped.tags.characters[0].character_id,'archive:alice');assert.equal(rendering.tags.characters[0].character_id,'A');
  after.characters[0].identity=['black hair'];assert.throws(()=>formats.remapStoryboardPromptRenderings(rendering,before,after),/改变了画面事实/);
});
test('numeric output geometry does not stale a rendering; camera/framing changes still do',async()=>{
  const shot=core.normalizeStoryboardShotSpec({scene:'garden',composition:{ratioId:'3:2',focus:'flower'}}),pack=await formats.bindStoryboardPromptRenderings(shot,{tags:{global:'garden',characters:[],negative:''}});
  shot.composition.ratioId='';shot.composition.ratioLocked=true;assert.equal((await formats.resolveStoryboardPromptRendering(shot,pack,'tags')).global,'garden');
  shot.composition.focus='person';await assert.rejects(formats.resolveStoryboardPromptRendering(shot,pack,'tags'),/旧提示表达已失效/);
});
test('single actual extraction requests the fixed-route format union and binds resolved archive IDs',async()=>{
  const e=await environment(),plan={id:'plan',status:'screening',shots:[]};assert.equal(await e.context.storyboardCompilePrompt(null,{plan}),true,JSON.stringify(e.errors));
  assert.equal(e.llmCalls.length,1);assert.deepEqual(e.llmCalls[0].options.promptFormats,['tags','natural_language']);assert.equal(e.llmCalls[0].options.maxTokens,10800);
  assert.deepEqual(Object.keys(JSON.parse(e.llmCalls[0].messages[1].content).constraints.prompt_format_definitions),['tags','natural_language']);
  const shot=e.state.promptDraft.shots[0].shotSpec;assert.equal(shot.characters[0].id,'archive:alice');assert.equal(shot.promptRenderingPack.renderings.tags.characters[0].character_id,'archive:alice');
  assert.equal(shot.promptRenderings,undefined);assert.equal(e.state.promptDraft.shots[0].promptRenderings,undefined);
  assert.equal(plan.shots[0].shotSpec.promptRenderingPack.sourceHash,shot.promptRenderingPack.sourceHash);
});
test('actual extraction -> settings reload -> mixed route jobs -> final workflow inputs preserves formats and narrative order',async()=>{
  const e=await environment(),plan={id:'plan',chatKey:'chat-a',status:'screening',shots:[]};assert.equal(await e.context.storyboardCompilePrompt(null,{plan}),true,JSON.stringify(e.errors));
  core.normalizeStoryboardState(e.state);
  assert.equal(await e.context.storyboardGenerate(null,{plan,automatic:true}),true,JSON.stringify({notices:e.notices,errors:e.errors}));
  assert.equal(e.jobs.length,3);assert.deepEqual(e.jobs.map(job=>job.source),['comfy','comfy','novel']);assert.equal(e.llmCalls.length,1);
  const [tags,natural,nai]=e.jobs;
  assert.match(tags.payload.prompt,/^portrait quality, tag-scene-0/);assert.match(tags.payload.prompt,/'Alice'|"Alice"/);assert.match(tags.payload.prompt,/coat removed/);
  assert.match(natural.payload.prompt,/^landscape quality\n\nNatural scene 1/);assert.doesNotMatch(natural.payload.prompt,/tag-scene|portrait quality/);
  assert.equal(tags.payload.negative,'portrait exclusions, extra people');assert.match(natural.payload.negative,/landscape exclusions\n\nNo extra people/);
  assert.equal(nai.payload.promptRendering,undefined);assert.doesNotMatch(nai.payload.prompt,/landscape quality|Natural scene/);
  assert.deepEqual(e.jobs.map(job=>job.inlineOrder.shotIndex),[0,1,2]);
  for(const job of [tags,natural]) {
    const graphBefore=job.profile.comfyWorkflow;
    await e.context.storyboardPrepareGatewayAssets(job);assert.equal(job.profile.comfyWorkflow,graphBefore);
    const workflow=prepareComfyWorkflow(job.payload.parameters.workflow,{prompt:job.payload.prompt,negativePrompt:job.payload.negative,parameters:job.payload.parameters,model:job.profile.model}).bind();
    assert.ok(workflow.text.inputs.text.startsWith(job.payload.prompt));assert.equal(workflow.negative.inputs.text,job.payload.negative);
  }
});
test('frozen history re-verifies the same expression without reading a newer library version or translating',async()=>{
  const e=await environment();await e.context.storyboardCompilePrompt(null);await e.context.storyboardGenerate(null,{automatic:true});const job=e.jobs[0];
  const saved=core.sanitizeStoryboardSnapshot(job),loads=e.calls.filter(call=>Array.isArray(call)&&call[0]==='load').length;
  assert.equal(saved.profile.comfyRoutePromptFormat,'tags');assert.equal(saved.payload.shotSpec.promptRenderingPack.invalid,undefined);
  const replay={...saved,payload:saved.payload};await prompts.prepareComfyPromptJob(replay);assert.equal(e.llmCalls.length,1);
  replay.payload.promptRendering=Object.fromEntries(Object.entries(replay.payload.promptRendering).reverse());await prompts.prepareComfyPromptJob(replay);
  assert.equal(e.calls.filter(call=>Array.isArray(call)&&call[0]==='load').length,loads);
  replay.payload.prompt+=' changed';await assert.rejects(prompts.prepareComfyPromptJob(replay),/已准备的提示表达/);
});
test('bad/missing formats, visual edits and safety adaptation stop before a provider request',async()=>{
  const e=await environment();await e.context.storyboardCompilePrompt(null);await e.context.storyboardGenerate(null,{automatic:true});
  for(const mutate of [job=>delete job.payload.shotSpec.promptRenderingPack,job=>job.payload.shotSpec.characters[0].action=['dances'],job=>job.safetyAdapted=true,job=>job.profile.comfyRoutePromptFormat='guess']){
    const job=plain(e.jobs[0]);mutate(job);await assert.rejects(prompts.prepareComfyPromptJob(job,{prepare:true}));
  }
  assert.equal(e.llmCalls.length,1);
});
test('explicit manual prompt editing bypasses extraction, but submission verifies the exact new text',async()=>{
  const e=await environment();await e.context.storyboardCompilePrompt(null);await e.context.storyboardGenerate(null,{automatic:true});const job=plain(e.jobs[0]);
  job.promptLocked=true;job.safetyAdapted=true;delete job.payload.shotSpec.promptRenderingPack;job.payload.prompt='my explicit manual wording';job.payload.negative='manual exclusions';
  await prompts.prepareComfyPromptJob(job,{prepare:true});assert.equal(job.payload.promptRendering.mode,'manual');assert.equal(job.payload.compiledPrompt.prompt,job.payload.prompt);
  await prompts.prepareComfyPromptJob(job);job.payload.prompt+=' changed';await assert.rejects(prompts.prepareComfyPromptJob(job),/已准备的提示表达/);assert.equal(e.llmCalls.length,1);
});
test('late async mutations, scope changes and malformed persisted packs cannot be blessed as newly prepared',async()=>{
  const e=await environment();await e.context.storyboardCompilePrompt(null);await e.context.storyboardGenerate(null,{automatic:true});let job=plain(e.jobs[0]);
  await assert.rejects(prompts.prepareComfyPromptJob(job,{guard:async()=>{job.profile.comfyRoutePromptLayer.positive='late';}}),/已变化/);
  job=plain(e.jobs[0]);await assert.rejects(prompts.prepareComfyPromptJob(job,{guard:async()=>{throw Error('account changed');}}),/account changed/);
  const spec=plain(job.shotSpec);spec.promptRenderingPack={schema:'v999'};const normalized=core.normalizeStoryboardShotSpec(spec);assert.equal(normalized.promptRenderingPack.invalid,true);
  assert.equal(core.normalizeStoryboardParameterProfile({...job.profile,comfyRoutePromptFormat:'guess'},'comfy').comfyRoutePromptFormat,'[invalid]');
});
test('bounded output allowance reaches both API paths only for negotiated formats, without hidden per-shot calls',async()=>{
  assert.equal(formats.storyboardPromptFormatBudget([],4),2200);assert.equal(formats.storyboardPromptFormatBudget(['tags'],1),2600);assert.equal(formats.storyboardPromptFormatBudget(['tags','natural_language','character_blocks'],4),16384);
  const e=await environment(),requests=[];vm.runInContext(section('storyboardCallCompiler'),e.context);Object.assign(e.context,{AbortController,
    callExternalApi:async(_messages,_unused,cfg)=>{requests.push(cfg);return 'ok';},callSillyTavernModel:async(_user,_system,_unused,cfg)=>{requests.push(cfg);return 'ok';}});
  e.context.settings.providerMode='external';await e.context.storyboardCallCompiler([{role:'user',content:'x'}],null,{promptFormats:['tags'],maxTokens:999999});assert.equal(requests.at(-1).maxTokens,16384);
  await e.context.storyboardCallCompiler([{role:'user',content:'x'}],null,{maxTokens:999999});assert.equal(requests.at(-1).maxTokens,4000);
  e.context.settings.providerMode='st';await e.context.storyboardCallCompiler([{role:'user',content:'x'}],null,{promptFormats:['tags'],maxTokens:5200});assert.equal(requests.at(-1).max_tokens,5200);
});
test('format projection does not modify graphs, claim spatial isolation or duplicate character blocks',()=>{
  const shot=core.normalizeStoryboardShotSpec({characters:[{id:'A',name:'Alice'},{id:'B',name:'Bob'}]});
  const output=prompts.compileComfyPromptRendering({format:'character_blocks',global:'shared scene',negative:'no extras',characters:[{character_id:'A',positive:'reads a letter'},{character_id:'B',positive:'watches'}]},shot,{positive:'style',supportsNegative:false});
  assert.equal((output.prompt.match(/reads a letter/g)||[]).length,1);assert.equal(output.characterBlocks.length,2);assert.equal(output.negative,'');assert.match(output.prompt,/"Alice": reads a letter\n\n"Bob": watches/);
});
test('enqueue and pre-submission verify expressions; workflow selection stays outside the pure prompt compiler',async()=>{
  assert.match(section('storyboardConfirmComfyExecution'),/storyboardPrepareComfyPromptJob\(job,\{prepare:true,valid\}\)/);
  assert.match(section('storyboardPrepareGatewayAssets'),/storyboardPrepareComfyPromptJob\(job\)/);
  const source=await readFile(new URL('../qianmu-comfy-prompt.js',import.meta.url),'utf8');assert.doesNotMatch(source,/\b(fetch|XMLHttpRequest|WebSocket|indexedDB)\b/);
  assert.doesNotMatch(section('storyboardGenerate'),/selectComfyWorkflow/);
});
test('the actual last-moment submission callback rejects altered expressions before admission',async()=>{
  const e=await environment();await e.context.storyboardCompilePrompt(null);await e.context.storyboardGenerate(null,{automatic:true});const job=e.jobs[0];let admissions=0;
  Object.assign(e.context,{job,log:{},storyboardValidatedAnchor:()=>({valid:true}),storyboardAdmission:{beforeSubmit:async()=>{admissions++;}},channelTicket:null,admissionOutcome:'not_submitted'});
  const body=section('storyboardRunJob');const start=body.indexOf('  const beforeSubmit = async () => {'),end=body.indexOf('\n  };\n  try {',start)+5;
  assert.ok(start>0&&end>start);vm.runInContext(`${body.slice(start,end)}\nglobalThis.checkSubmission=beforeSubmit;`,e.context);
  job.payload.prompt+=' changed';await assert.rejects(e.context.checkSubmission(),/已准备的提示表达/);assert.equal(admissions,0);
  job.payload.prompt=job.compiledPrompt.prompt;await e.context.checkSubmission();assert.equal(admissions,1);assert.equal(job.submissionState,'unknown');
});
test('queued plan details are updated with the actual selected-format compilation',async()=>{
  const e=await environment();await e.context.storyboardCompilePrompt(null);await e.context.storyboardGenerate(null,{automatic:true});const job=e.jobs[0],plan={id:'p',shots:[{id:'s',compiledPrompt:{prompt:'legacy preview'}}]};job.planShotId='s';
  Object.assign(e.context,{storyboardSyncTaskState:()=>null,aggregateStoryboardShotTasks:()=>({status:'queued',error:'',partialFailureCount:0,resultIds:[]}),storyboardPlanIsTerminal:()=>false});
  vm.runInContext(section('storyboardSetPlanStatus'),e.context);e.context.storyboardSetPlanStatus(plan,'queued',{job});
  assert.equal(plan.shots[0].compiledPrompt.prompt,job.payload.prompt);assert.equal(plan.shots[0].compiledPrompt.promptFormat,'tags');
});
test('actual compiler uses only its one bounded repair and retains the same format/output allowance',async()=>{
  const e=await environment(),call=e.context.storyboardCallCompiler;let round=0;
  e.context.storyboardCallCompiler=async(...args)=>{const raw=await call(...args);if(round++===0){const value=JSON.parse(raw);delete value.shots[0].prompt_renderings.tags;return JSON.stringify(value);}return raw;};
  assert.equal(await e.context.storyboardCompilePrompt(null),true,JSON.stringify(e.errors));assert.equal(e.llmCalls.length,2);
  assert.deepEqual(e.llmCalls[1].options.promptFormats,e.llmCalls[0].options.promptFormats);assert.equal(e.llmCalls[1].options.maxTokens,e.llmCalls[0].options.maxTokens);assert.equal(e.llmCalls[1].options.temperature,0);
  assert.equal(e.state.promptDraft.shots[0].shotSpec.promptRenderingPack.invalid,undefined);
});
test('format text remains literal input, never a second workflow-template expansion',()=>{
  const text='literal %qianmu_reference% and %qianmu_negative%';
  const shot=core.normalizeStoryboardShotSpec({scene:'letter'}),rendered=prompts.compileComfyPromptRendering({format:'natural_language',global:text,characters:[],negative:''},shot);
  const workflow={text:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}}};
  assert.equal(prepareComfyWorkflow(workflow,{prompt:rendered.prompt,negativePrompt:''}).bind().text.inputs.text,text);assert.equal(workflow.text.inputs.text,'%qianmu_prompt%');
});

test('applying a classified library version retains only bounded workbench provenance and preserves classification when saving current',async()=>{
  const e=await workbenchEnvironment(),profile=e.state.profiles.comfy;
  assert.equal(profile.comfyRouteBinding,undefined);assert.equal(profile.comfyRoutePromptFormat,undefined);
  assert.equal(core.storyboardComfyPromptFormat(profile),'tags');assert.equal(profile.comfyWorkbenchBinding.binding.revision,'revision-portrait');
  const recipe=e.context.storyboardCurrentComfyRecipe(e.state);
  assert.equal(recipe.document.classification.promptFormat,'tags');assert.equal(recipe.document.workflow,e.recipes[0].document.workflow);
  const restored=core.normalizeStoryboardState(plain(e.state));assert.deepEqual(restored.profiles.comfy.comfyWorkbenchBinding,plain(profile.comfyWorkbenchBinding));
  assert.equal(core.getStoryboardRememberedProfile(restored.modelProfiles,'comfy','comfy-workflow').comfyWorkbenchBinding.classification.promptFormat,'tags');
  assert.ok(JSON.stringify(profile.comfyWorkbenchBinding).length<1500);assert.doesNotMatch(JSON.stringify(profile.comfyWorkbenchBinding),/class_type|parameters|positivePrompt/);
});
test('ordinary workbench actual extraction and generation honor format plus current parameter and prompt edits',async()=>{
  const e=await workbenchEnvironment(),profile=e.state.profiles.comfy;
  profile.steps='19';profile.cfg='6';profile.width='768';profile.height='1024';
  e.context.storyboardRememberPromptLayer(e.state,null,'comfy',profile.model,'positive','user edited prefix');
  e.context.storyboardRememberPromptLayer(e.state,null,'comfy',profile.model,'negative','user edited exclusion');
  const plan={id:'plan',chatKey:'chat-a',status:'screening',shots:[]};
  assert.equal(await e.context.storyboardCompilePrompt(null,{plan}),true,JSON.stringify(e.errors));
  assert.deepEqual(e.llmCalls[0].options.promptFormats,['tags']);assert.equal(e.llmCalls[0].options.maxTokens,7800);
  core.normalizeStoryboardState(e.state);
  assert.equal(await e.context.storyboardGenerate(null,{plan,automatic:true}),true,JSON.stringify({errors:e.errors,notices:e.notices}));
  assert.equal(e.jobs.length,3);assert.ok(e.jobs.every(job=>job.source==='comfy'));
  for(const job of e.jobs){
    assert.equal(job.profile.steps,'19');assert.equal(job.profile.cfg,'6');assert.equal(job.profile.comfyRouteBinding,undefined);
    assert.match(job.payload.prompt,/^user edited prefix, tag-scene-/);assert.equal(job.payload.negative,'user edited exclusion, extra people');
    await e.context.storyboardPrepareGatewayAssets(job);
    assert.equal(prepareComfyWorkflow(job.payload.parameters.workflow,{prompt:job.payload.prompt,negativePrompt:job.payload.negative,parameters:job.payload.parameters}).bind().negative.inputs.text,job.payload.negative);
  }
  assert.deepEqual(e.jobs.map(job=>job.inlineOrder.shotIndex),[0,1,2]);assert.equal(e.llmCalls.length,1);
});
test('ordinary and fixed routes negotiate only reachable formats, and a fixed route removes workbench provenance',async()=>{
  const e=await workbenchEnvironment();e.state.routing.enabled=true;e.state.routing.rules=e.state.routing.rules.slice(1);
  const input=e.context.storyboardCreatePreparationGuard(e.state),prepared=await e.context.storyboardPrepareComfyRoutes(e.state,input);
  assert.deepEqual(plain(prepared.promptFormats),['tags','natural_language']);
  const selected=e.context.storyboardResolveRoutingProfile(e.state,e.routes[1],null,prepared);
  assert.equal(selected.comfyWorkbenchBinding,undefined);assert.equal(selected.comfyRoutePromptFormat,'natural_language');
  e.state.routing.rules=[{id:'all',enabled:true,shotTypes:Object.keys(e.context.STORYBOARD_SHOT_TYPE_LABELS),target:e.routes[1]}];
  const fixedOnly=await e.context.storyboardPrepareComfyRoutes(e.state,e.context.storyboardCreatePreparationGuard(e.state));
  assert.deepEqual(plain(fixedOnly.promptFormats),['natural_language']);
});
test('changing a graph or classification stops before the actual LLM call, not by dropping to legacy tags',async()=>{
  for(const change of [profile=>profile.comfyWorkflow=profile.comfyWorkflow.replace('portrait','modified'),profile=>profile.comfyWorkbenchBinding.classification.promptFormat='natural_language']){
    const e=await workbenchEnvironment();change(e.state.profiles.comfy);
    assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(e.llmCalls.length,0);assert.equal(e.jobs.length,0);
    assert.match(e.errors.join(' '),/工作流图已修改|分类与原版本不符/);
  }
});
test('workbench replay uses frozen classification and additions after library purge, not a fresh head or current UI defaults',async()=>{
  const e=await workbenchEnvironment(),plan={id:'plan',chatKey:'chat-a',status:'screening',shots:[]};
  await e.context.storyboardCompilePrompt(null,{plan});await e.context.storyboardGenerate(null,{plan,automatic:true});
  const job=core.sanitizeStoryboardSnapshot(e.jobs[0]),before=job.payload.prompt;e.rows.length=0;
  e.context.storyboardRememberPromptLayer(e.state,null,'comfy','comfy-workflow','positive','do not use this');
  await prompts.prepareComfyPromptJob(job,{namespace});assert.equal(job.payload.prompt,before);
  await routes.assertComfyRouteProfile(job.profile,{namespace});
  await assert.rejects(()=>prompts.prepareComfyPromptJob(job,{namespace:'st-user:other'}),/另一账户/);
  job.payload.comfyWorkbenchPromptLayer.positive='changed frozen prefix';
  await assert.rejects(()=>prompts.prepareComfyPromptJob(job,{namespace}),/不符/);
});
test('loading an old unclassified recipe explicitly clears old provenance without altering queued jobs or the other provider',async()=>{
  const e=await workbenchEnvironment(),before=plain(e.state.profiles.novel),old=plain(e.state.profiles.comfy);
  e.state.view='workflows';delete e.rows[1].document.classification;
  await e.context.storyboardApplyComfyLibraryRecipe(e.root,e.state,e.rows[1]);
  assert.equal(e.state.profiles.comfy.comfyWorkbenchBinding,undefined);assert.equal(core.storyboardComfyPromptFormat(e.state.profiles.comfy),'');
  assert.deepEqual(e.state.profiles.novel,before);assert.equal(old.comfyWorkbenchBinding.classification.promptFormat,'tags');
  assert.equal(await e.context.storyboardPrepareComfyRoutes(e.state,e.context.storyboardCreatePreparationGuard(e.state)),null);
});
test('classification without a prompt declaration preserves compatibility but still checks graph/account provenance',async()=>{
  const e=await workbenchEnvironment();e.rows[0].document.classification.promptFormat='';e.state.view='workflows';
  await e.context.storyboardApplyComfyLibraryRecipe(e.root,e.state,e.rows[0]);
  assert.equal(core.storyboardComfyPromptFormat(e.state.profiles.comfy),'');
  const prepared=await e.context.storyboardPrepareComfyRoutes(e.state,e.context.storyboardCreatePreparationGuard(e.state));assert.deepEqual(plain(prepared.promptFormats),[]);
  await assert.rejects(()=>prompts.prepareComfyPromptJob({source:'comfy',profile:e.state.profiles.comfy},{namespace:'st-user:other'}),/另一账户/);
});
test('late library application cannot replace another page, account, or concurrently edited workbench',async()=>{
  for(const change of [e=>{e.state.view='create';},e=>e.setAccount('st-user:other'),e=>{e.state.profiles.comfy.steps='21';}]){
    const e=await workbenchEnvironment();e.state.view='workflows';const prior=e.state.profiles.comfy,load=e.context.featureRuntime.load;
    e.context.featureRuntime.load=async key=>{const module=await load(key);return key==='comfyRoutes'?{...module,pinComfyRouteWorkflow:async options=>{const value=await module.pinComfyRouteWorkflow(options);change(e);return value;}}:module;};
    await assert.rejects(()=>e.context.storyboardApplyComfyLibraryRecipe(e.root,e.state,e.rows[1]),/已变化/);
    assert.equal(e.state.profiles.comfy,prior);assert.equal(prior.comfyWorkbenchBinding.binding.id,'portrait');
  }
});
test('malformed workbench provenance cannot disappear through normalization, even when manual text is present',async()=>{
  for(const value of [null,{},{schemaVersion:2},{invalid:true}]){
    const p=core.normalizeStoryboardParameterProfile({comfyWorkbenchBinding:value},'comfy');assert.equal(p.comfyWorkbenchBinding.invalid,true);
    assert.equal(core.storyboardComfyPromptFormat(p),'[invalid]');
    await assert.rejects(()=>prompts.prepareComfyPromptJob({source:'comfy',profile:p,promptLocked:true,payload:{prompt:'manual'}},{namespace,prepare:true}),/来源无效/);
  }
});
test('in-flight workbench prompt preparation cannot sign payload text changed during graph verification',async()=>{
  const e=await workbenchEnvironment(),job={source:'comfy',profile:e.state.profiles.comfy,promptLocked:true,payload:{prompt:'manual'}};let count=0;
  await assert.rejects(()=>prompts.prepareComfyPromptJob(job,{namespace,prepare:true,guard:async()=>{if(++count===2)job.payload.prompt='late changed';}}),/已变化/);
  assert.equal(job.payload.promptRendering,undefined);
});
test('light workbench declarations do not pull candidate selection or reference storage into startup',async()=>{
  const source=await readFile(new URL('../qianmu-comfy-workbench-binding.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/^import .*from ['"].*(?:selection|references|library)\.js['"]/m);
  assert.equal(workbench.retainComfyWorkbenchBinding({schemaVersion:3}).invalid,true);
  const declaration=await readFile(new URL('../qianmu-comfy-classification.js',import.meta.url),'utf8');assert.doesNotMatch(declaration,/\b(fetch|indexedDB|WebSocket)\b/);
});
test('workbench additions are typed and bounded, never object-to-string prompt coercion',async()=>{
  const e=await workbenchEnvironment(),plan={id:'plan',chatKey:'chat-a',status:'screening',shots:[]};
  await e.context.storyboardCompilePrompt(null,{plan});await e.context.storyboardGenerate(null,{plan,automatic:true});
  for(const layer of [{positive:{text:'coerce me'},negative:''},{positive:'x'.repeat(12001),negative:''},{positive:'',negative:null},null]){
    const job=plain(e.jobs[0]);delete job.payload.promptRendering;job.payload.comfyWorkbenchPromptLayer=layer;
    await assert.rejects(()=>prompts.prepareComfyPromptJob(job,{prepare:true,namespace}),/提示补充无效/);assert.equal(job.payload.promptRendering,undefined);
  }
});
test('library apply reads the verified version instead of trusting a changed callback document',async()=>{
  const e=await workbenchEnvironment();e.state.view='workflows';
  await e.context.storyboardApplyComfyLibraryRecipe(e.root,e.state,{...e.rows[1],document:{...e.rows[1].document,positivePrompt:'forged callback prefix'}});
  assert.equal(e.context.storyboardCurrentComfyRecipe(e.state).document.positivePrompt,'landscape quality');
});

for(const [name,factory,key] of [['fixed-route',environment,'comfyRoutePromptLayer'],['workbench',workbenchEnvironment,'comfyWorkbenchPromptLayer']]){
  test(`${name} historical prompt retirement cannot erase frozen additions or re-sign an altered replay`,async()=>{
    const e=await factory();await e.context.storyboardCompilePrompt(null);await e.context.storyboardGenerate(null,{automatic:true});
    const saved=core.sanitizeStoryboardSnapshot(e.jobs[0]),original=JSON.stringify(saved);
    const holder=job=>name==='workbench'?job.payload:job.profile;
    assert.ok(holder(saved)[key].positive);assert.ok(holder(saved)[key].negative);assert.ok(saved.payload.promptRendering);
    const loads=e.calls.filter(call=>Array.isArray(call)&&call[0]==='load').length,llmCalls=e.llmCalls.length;
    // Retirement applies to new jobs; enqueue is not permission to rewrite a historical receipt.
    for(const prepare of [false,true])for(const erase of [false,true]){
      const replay=plain(saved);
      if(erase)delete holder(replay)[key];else holder(replay)[key]={positive:'',negative:''};
      const before=JSON.stringify(replay);
      await assert.rejects(()=>prompts.prepareComfyPromptJob(replay,{prepare,namespace}),{code:'storyboard_prompt_format'});
      assert.equal(JSON.stringify(replay),before);
    }
    await prompts.prepareComfyPromptJob(saved,{namespace});assert.equal(JSON.stringify(saved),original);
    assert.equal(e.llmCalls.length,llmCalls);assert.equal(e.calls.filter(call=>Array.isArray(call)&&call[0]==='load').length,loads);
  });
}
