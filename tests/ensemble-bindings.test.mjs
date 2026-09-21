import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareEnsembleStyleBindings} from '../qianmu-ensemble-bindings.js';
import {ENSEMBLE_LIBRARY_SCHEMA,ENSEMBLE_SELECTION_SCHEMA} from '../qianmu-ensemble-selection.js';
import {prepareComfyRouteRecipes,assertComfyRouteProfile} from '../qianmu-comfy-route.js';
import {checkComfyConfiguration} from '../qianmu-comfy-preflight.js';
import {routeEnvironment,namespace} from './helpers/comfy-route-fixture.mjs';

async function fixture(){
  const e=await routeEnvironment({formats:['character_blocks','natural_language']});
  const prepared=await prepareComfyRouteRecipes({routes:e.routes,namespace,createStore:e.createStore});
  const profile=e.context.storyboardProviderProfile(e.state,'novel');
  e.state.routing.rules.push({id:'nai',enabled:true,target:{providerId:'novel',modelId:profile.model,capabilityModelId:profile.capabilityModelId,connectionPresetId:'',parameterPresetId:''}});
  e.state.artistPresets.push({id:'artist-ink',name:'Ink',value:'artist:fixture',positivePrompt:'ink wash',negativePrompt:'low quality'});
  const library={schema:ENSEMBLE_LIBRARY_SCHEMA,namespace,schemes:[
    {id:'ink',revision:'one',name:'Ink',description:'留白',tags:['ink'],binding:{routeId:'nai',artistPresetId:'artist-ink'}},
    {id:'cg',revision:'one',name:'CG',description:'场景空间',tags:['CG'],binding:{routeId:'rule-0'}}]};
  const selection={schema:ENSEMBLE_SELECTION_SCHEMA,namespace,chatKey:'chat-a',revision:'selected',enabled:true,schemeIds:['ink','cg'],styleLock:true};
  let active=true,owner=namespace;const checked=[];
  const options={library,selection,namespace,chatKey:'chat-a',preparationId:'prepare-one',readState:()=>e.state,
    resolveProfile:({state,route})=>e.context.storyboardResolveRoutingProfile(state,route,null,prepared),
    assertCurrent:()=>active,guard:async()=>owner===namespace,
    verifyTarget:async(descriptor,{guard})=>{
      checked.push(descriptor);await guard();
      if(descriptor.route.providerId==='comfy'){
        await assertComfyRouteProfile(descriptor.profile,{namespace,guard});
        const report=checkComfyConfiguration({workflow:descriptor.profile.comfyWorkflow,parameters:{...descriptor.profile,count:1},model:descriptor.profile.model,outputNodeId:descriptor.profile.comfyOutputNodeId,automatic:true,referenceCount:0});
        return {ready:report.localConfigurationReady,promptFormats:[descriptor.profile.comfyRoutePromptFormat]};
      }
      return {ready:true};
    }};
  return {...e,library,selection,options,checked,open:extra=>prepareEnsembleStyleBindings({...options,...extra}),stop:()=>{active=false;},switchAccount:()=>{owner='st-user:other';}};
}
const choose=(scheme='ink',shot='S1')=>({shot_id:shot,scheme_id:scheme,reason:'叙事表现增益'});

test('current Comfy style fingerprint includes the automatic workflow selection and rejects later pool changes',async()=>{
  const f=await fixture();f.state.source='comfy';f.state.comfyAutoEnabled=true;f.state.comfyPoolSelection={id:'pool-one',revision:'one'};
  const verify=f.options.verifyTarget,b=await f.open({verifyTarget:(d,c)=>d.route.comfyWorkflowBinding?verify(d,c):{ready:true,promptFormats:['natural_language']}});
  const receipt=b.session.resolve([choose('current')],['S1']);await b.resolveAssignment(receipt,'S1');
  f.state.comfyPoolSelection={id:'pool-two',revision:'two'};
  await assert.rejects(b.resolveAssignment(receipt,'S1'),{code:'ensemble_binding_changed'});b.close();
});

test('actual profile resolvers pin NAI artist and classified Comfy graph while descriptions alone reach the model',async()=>{
  const f=await fixture(),before=JSON.stringify(f.state),binding=await f.open();
  try{
    assert.deepEqual(binding.session.catalogue.map(r=>r.id),['current','ink','cg']);assert.deepEqual(binding.session.promptFormats,['tags','character_blocks']);
    const receipt=binding.session.resolve([choose('cg','S2'),choose()],['S1','S2']);
    const first=await binding.resolveAssignment(receipt,'S1'),second=await binding.resolveAssignment(receipt,'S2');
    assert.equal(first.artistPresetId,'artist-ink');assert.equal(first.route.providerId,'novel');assert.equal(second.route.comfyWorkflowBinding.id,'portrait');assert.equal(second.executionAuthorized,false);
    assert.doesNotMatch(JSON.stringify({catalogue:binding.session.catalogue,receipt}),/comfyWorkflow|apiKey|baseUrl|artist:fixture|CLIPTextEncode|credential|rule-0/);
    assert.equal(JSON.stringify(f.state),before);assert.equal(f.jobs.length,0);assert.equal(f.checked.length,3);assert.ok(Object.isFrozen(second.route.comfyWorkflowBinding));
  }finally{binding.close();}
});
test('unavailable styles are not offered, and disabled ensembles preflight only the current route',async()=>{
  for(const mutate of [f=>f.state.routing.rules.find(r=>r.id==='nai').enabled=false,f=>f.state.routing.rules=f.state.routing.rules.filter(r=>r.id!=='nai'),f=>f.state.artistPresets=[]]){
    const f=await fixture();mutate(f);const b=await f.open();assert.ok(!b.session.catalogue.some(r=>r.id==='ink'));assert.equal(b.unavailable[0].id,'ink');b.close();
  }
  const f=await fixture();f.selection.enabled=false;const b=await f.open();assert.deepEqual(b.session.catalogue.map(r=>r.id),['current']);assert.equal(f.checked.length,1);b.close();
});
test('named API or parameter presets are never replaced with a current draft on failure',async()=>{
  for(const prop of ['connectionPresetId','parameterPresetId']){const f=await fixture();f.state.routing.rules.find(r=>r.id==='nai').target[prop]='deleted';
    const b=await f.open();assert.ok(!b.session.catalogue.some(r=>r.id==='ink'));assert.equal(f.checked.length,2);b.close();}
});
test('missing, invalid or mismatched model capabilities are excluded without silently using defaults',async()=>{
  for(const mutate of [route=>route.modelId='',route=>{route.modelId='vendor/unknown';route.capabilityModelId='';},route=>{route.modelId='nai-diffusion-3';route.capabilityModelId='nai-diffusion-4-5-full';}]){
    const f=await fixture();mutate(f.state.routing.rules.find(r=>r.id==='nai').target);const b=await f.open();assert.ok(!b.session.catalogue.some(r=>r.id==='ink'));b.close();
  }
});
test('NAI aliases with an explicit matching capability remain exact on the returned route',async()=>{
  const f=await fixture();Object.assign(f.state.routing.rules.find(r=>r.id==='nai').target,{modelId:'relay/my-nai',capabilityModelId:'nai-diffusion-4-5-full'});
  const b=await f.open(),receipt=b.session.resolve([choose()],['S1']);assert.equal((await b.resolveAssignment(receipt,'S1')).route.modelId,'relay/my-nai');b.close();
});
test('an artist binding cannot be applied to a non-artist-capable closed model',async()=>{
  const f=await fixture();f.state.routing.rules.find(r=>r.id==='nai').target={providerId:'openai',modelId:'gpt-image-1',connectionPresetId:'',parameterPresetId:''};
  const b=await f.open();assert.ok(!b.session.catalogue.some(r=>r.id==='ink'));b.close();
});
test('Comfy schemes require an exact account-owned fixed graph, not today\'s workbench or another recipe',async()=>{
  for(const mutate of [f=>delete f.state.routing.rules[0].target.comfyWorkflowBinding,f=>f.state.routing.rules[0].target.comfyWorkflowBinding={...f.routes[0].comfyWorkflowBinding,namespace:'st-user:other'}]){
    const f=await fixture();mutate(f);const b=await f.open();assert.ok(!b.session.catalogue.some(r=>r.id==='cg'));b.close();
  }
  const f=await fixture(),resolve=f.options.resolveProfile;
  const b=await f.open({resolveProfile:options=>options.route.providerId==='comfy'?{...resolve(options),comfyWorkflow:resolve(options).comfyWorkflow.replace('portrait','changed')}:resolve(options)});
  assert.ok(!b.session.catalogue.some(r=>r.id==='cg'));b.close();
});
test('Comfy format must be declared by a successful preflight and is never guessed from the model name',async()=>{
  for(const report of [{ready:false,promptFormats:['tags']},{ready:true,promptFormats:[]},{ready:true,promptFormats:['invented']},{ready:'true',promptFormats:['tags']}]){
    const f=await fixture(),verify=f.options.verifyTarget,b=await f.open({verifyTarget:(d,c)=>d.route.providerId==='comfy'?report:verify(d,c)});
    assert.ok(!b.session.catalogue.some(r=>r.id==='cg'));b.close();
  }
});
test('the current fallback must itself pass preflight; a failed base does not authorize another paid route',async()=>{
  const f=await fixture();await assert.rejects(f.open({verifyTarget:async()=>({ready:false})}),{code:'ensemble_not_ready'});assert.equal(f.jobs.length,0);
});
test('only original receipts issued by this preparation resolve, never a copy or another session',async()=>{
  const f=await fixture(),one=await f.open(),two=await f.open(),receipt=one.session.resolve([choose()],['S1']);
  await assert.rejects(one.resolveAssignment(structuredClone(receipt),'S1'),{code:'ensemble_binding'});await assert.rejects(two.resolveAssignment(receipt,'S1'),{code:'ensemble_binding'});
  await assert.rejects(one.resolveAssignment(receipt,'S2'),{code:'ensemble_binding'});one.close();two.close();
});
test('editing actual route, connection, parameter, artist or bound reference invalidates earlier assignments',async()=>{
  for(const mutate of [f=>f.state.routing.rules.find(r=>r.id==='nai').target.modelId='nai-diffusion-3',f=>f.state.connections.novel.draft.baseUrl='https://another.invalid',f=>Object.assign(f.state.profiles.novel,{loaded:true,steps:'17'}),f=>f.state.artistPresets[0].positivePrompt='new',f=>f.state.routing.rules[0].target.comfyCharacterEnabled=true]){
    const f=await fixture(),b=await f.open(),receipt=b.session.resolve([choose()],['S1']);mutate(f);await assert.rejects(b.resolveAssignment(receipt,'S1'));assert.equal(receipt.assignments[0].schemeId,'ink');b.close();
  }
});
test('changing the selected library while preflight awaits aborts the preparation instead of using a partial new set',async()=>{
  const f=await fixture(),verify=f.options.verifyTarget;let count=0;
  await assert.rejects(f.open({verifyTarget:async(d,c)=>{const result=await verify(d,c);if(++count===2)f.selection.schemeIds=['cg'];return result;}}),{code:'ensemble_binding_changed'});
});
test('changing an earlier pinned target during later checks cannot escape the final batch assertion',async()=>{
  const f=await fixture(),verify=f.options.verifyTarget;let count=0;
  await assert.rejects(f.open({verifyTarget:async(d,c)=>{const result=await verify(d,c);if(++count===3)f.state.artistPresets[0].negativePrompt='later';return result;}}),{code:'ensemble_binding_changed'});
});
test('account/source changes and closed handles prevent resolve, including changes during asynchronous guards',async()=>{
  for(const change of ['stop','switchAccount']){const f=await fixture(),b=await f.open(),receipt=b.session.resolve([choose()],['S1']);f[change]();await assert.rejects(b.resolveAssignment(receipt,'S1'),{code:'ensemble_binding_changed'});b.close();}
  const f=await fixture(),b=await f.open(),receipt=b.session.resolve([choose()],['S1']);b.close();await assert.rejects(b.resolveAssignment(receipt,'S1'),{code:'ensemble_binding_changed'});
  assert.throws(()=>b.session.responseSchema(['S1']),{code:'ensemble_binding_changed'});
});
test('technical errors are reduced to non-sensitive reasons and immutable bindings cannot be edited by the checker',async()=>{
  const f=await fixture(),verify=f.options.verifyTarget;
  const b=await f.open({verifyTarget:async(d,c)=>{assert.ok(Object.isFrozen(d.connection));if(d.artist)throw Error('secret https://private.invalid Bearer key');return verify(d,c);}});
  assert.deepEqual(b.unavailable,[{id:'ink',reason:'ensemble_not_ready'}]);assert.doesNotMatch(JSON.stringify(b.unavailable),/secret|private|Bearer/);b.close();
});
test('unknown asynchronous configuration readers cannot be interpreted as valid snapshots',async()=>{
  const f=await fixture();await assert.rejects(f.open({readState:async()=>{throw Error('late');}}),{code:'ensemble_binding'});
  await assert.rejects(f.open({assertCurrent:async()=>true}),{code:'ensemble_binding'});await Promise.resolve();
});
test('a new scene selection keeps repeated scheme choices and exact narrative ordering without increasing job count',async()=>{
  const f=await fixture(),b=await f.open(),receipt=b.session.resolve([choose('ink','S3'),choose('current','S1'),choose('ink','S2')],['S1','S2','S3']);
  const results=await Promise.all(receipt.assignments.map(row=>b.resolveAssignment(receipt,row.shotId)));
  assert.deepEqual(results.map(r=>r.schemeId),['current','ink','ink']);assert.deepEqual(results.map(r=>r.shotId),['S1','S2','S3']);assert.equal(results[1].bindingKey,results[2].bindingKey);assert.equal(f.jobs.length,0);b.close();
});

test('duplicate named connection references are unavailable instead of choosing an arbitrary first match',async()=>{
  const f=await fixture();f.state.connections.novel.presets=[{id:'same',baseUrl:'https://one.invalid'},{id:'same',baseUrl:'https://two.invalid'}];
  f.state.routing.rules.find(r=>r.id==='nai').target.connectionPresetId='same';const b=await f.open();
  assert.ok(!b.session.catalogue.some(row=>row.id==='ink'));assert.equal(b.unavailable[0].reason,'ensemble_missing_connection');b.close();
});
test('preparation checks only the selected set, with linear profile reads and no catalog-wide polling',async()=>{
  const f=await fixture();f.library.schemes=Array.from({length:128},(_,i)=>({...structuredClone(f.library.schemes[0]),id:'scheme-'+i}));
  f.selection.schemeIds=f.library.schemes.slice(0,32).map(row=>row.id);let reads=0;const original=f.options.resolveProfile;
  const b=await f.open({resolveProfile:options=>{reads++;return original(options);}});
  assert.equal(f.checked.length,33);assert.ok(reads<=33*7,`profile reads ${reads} should remain linear`);assert.equal(b.session.catalogue.length,33);assert.equal(f.jobs.length,0);b.close();
});
