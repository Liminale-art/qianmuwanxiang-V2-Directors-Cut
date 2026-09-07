import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {filterStoryboardVibes,checkStoryboardVibeSelection} from '../qianmu-vibe-library-view.js';
import {createStoryboardDefaults,getStoryboardCapabilities} from '../qianmu-storyboard.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const item=(id='one',extra={})=>({id,name:id,previewUrl:'/user/images/one.png',providerIds:['novel'],modelIds:[],strength:0,informationExtracted:0,...extra});
test('library search reads names and bounds image pages without mutating its source',()=>{
  const rows=Array.from({length:90},(_,i)=>item(String(i),{name:i%2?'Forest Light':'Night Sky'}));
  assert.equal(filterStoryboardVibes(rows,'forest').total,45);assert.equal(filterStoryboardVibes(rows,'forest').items.length,40);assert.equal(filterStoryboardVibes(rows,'SKY night',80).items.length,45);assert.equal(rows.length,90);
});
test('selection is explicit, rejects missing or incompatible Vibes and precision conflicts, but allows clearing hidden selections',()=>{
  const rows=[item(),item('old',{modelIds:['nai-diffusion-4-full']})],options={supportsVibe:true,modelId:'nai-diffusion-5-full',preciseReference:false};
  assert.deepEqual(checkStoryboardVibeSelection(rows,['one'],options),['one']);
  for(const ids of [['missing'],['old'],['one','one'],Array(17).fill('one')])assert.throws(()=>checkStoryboardVibeSelection(rows,ids,options));
  assert.throws(()=>checkStoryboardVibeSelection(rows,['one'],{...options,preciseReference:true}),/互斥/);assert.throws(()=>checkStoryboardVibeSelection(rows,['one'],{...options,supportsVibe:false}),/不支持/);
  assert.deepEqual(checkStoryboardVibeSelection(rows,[],{supportsVibe:false,preciseReference:true}),[]);
});
test('workbench is a library-entry strip, never a first-24 inline selector, and can show missing historical choices',()=>{
  const context=vm.createContext({htmlEscape:String,storyboardSafeUrl:String});vm.runInContext(section('renderStoryboardParameterVibes'),context);
  const state={vibeLibrary:[item()],selectedVibeIds:['one','gone']};const html=context.renderStoryboardParameterVibes(state,{}, {supportsVibe:true});
  assert.match(html,/sd-vibe-workbench-strip/);assert.match(html,/素材已失效/);assert.doesNotMatch(html,/data-storyboard-param-vibe|aria-pressed/);assert.equal(context.renderStoryboardParameterVibes(state,{},{}),'');
});
test('actual mount rejects obsolete lazy results and apply rejects cancellation or external selection changes after its await',async()=>{
  const state=createStoryboardDefaults();state.view='assets';state.assetView='vibes';state.vibeLibrary=[item()];let options,resolve,mounts=0;
  const host={isConnected:true},root={querySelector:()=>host};
  const profile={model:'nai-diffusion-5-full',capabilityModelId:'nai-diffusion-5-full'},controller={mount:()=>mounts++,detach(){},dispose(){},edit(){},beginSelection(){},cancelSelection(){}};
  const runtime={createStoryboardVibeLibraryController:value=>{options=value;return controller;},checkStoryboardVibeSelection};
  const context=vm.createContext({storyboardState:()=>state,storyboardAdmissionEpoch:1,getChatKey:()=> 'chat',activeTab:'imagegen',storyboardVibeControllerContext:null,storyboardVibeLibraryController:null,storyboardVibeSelection:null,
    storyboardProviderProfile:()=>profile,storyboardConnectionState:()=>({draft:{}}),getStoryboardCapabilities,storyboardGalleryRecords:()=>[],applyQianmuIcons(){},toast(){},saveSettings(){},storyboardNavigate(){},storyboardFinishVibeSelection(){},
    featureRuntime:{load:async key=>key==='vibeLibrary'?runtime:{resolveImageAccountNamespace:async()=> 'st-user:one'}}});
  vm.runInContext(['storyboardVibeSelectionKey','storyboardMountVibeLibrary'].map(section).join('\n'),context);
  context.featureRuntime.load=key=>key==='vibeLibrary'?new Promise(r=>resolve=r):Promise.resolve({resolveImageAccountNamespace:async()=> 'st-user:one'});
  const obsolete=context.storyboardMountVibeLibrary(root);host.isConnected=false;resolve(runtime);await obsolete;assert.equal(mounts,0);
  host.isConnected=true;const identity={resolveImageAccountNamespace:async()=> 'st-user:one'};context.featureRuntime.load=async key=>key==='vibeLibrary'?runtime:identity;await context.storyboardMountVibeLibrary(root);assert.equal(mounts,1);
  const session=()=>({state,epoch:1,chat:'chat',original:JSON.stringify(state.selectedVibeIds),key:context.storyboardVibeSelectionKey(state)});
  context.storyboardVibeSelection=session();identity.resolveImageAccountNamespace=()=>new Promise(r=>resolve=r);const cancelled=options.onApply(['one']);context.storyboardVibeSelection=null;resolve('st-user:one');await assert.rejects(cancelled,/变化/);assert.deepEqual(state.selectedVibeIds,[]);
  identity.resolveImageAccountNamespace=async()=> 'st-user:one';context.storyboardVibeSelection=session();state.selectedVibeIds=['other'];await assert.rejects(options.onApply(['one']),/变化/);assert.deepEqual(state.selectedVibeIds,['other']);
});
