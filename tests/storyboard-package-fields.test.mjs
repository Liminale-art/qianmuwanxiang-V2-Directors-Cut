import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardDefaults,normalizeStoryboardState} from '../qianmu-storyboard.js';
import {STORYBOARD_IMPORT_FIELDS,STORYBOARD_ADDED_IMPORT_FIELDS,STORYBOARD_LOCAL_STATE_FIELDS,captureStoryboardPackageSettings,inspectStoryboardPortableSelections} from '../qianmu-storyboard-package-fields.js';
import {prepareStoryboardPackageDraft} from '../qianmu-storyboard-package-draft.js';
import {createStoryboardMutation,applyStoryboardMutation,validateStoryboardMutation} from '../qianmu-storyboard-package-mutation.js';
import {buildStoryboardVibePackage} from '../qianmu-storyboard-package-assets.js';
import {inspectStoryboardPackageFile} from '../qianmu-storyboard-package-input.js';
import {fixture,namespace,file} from './fixtures/storyboard-bundle.mjs';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';
import {vibeDigest} from '../qianmu-vibe-file.js';
const clone=structuredClone;
const scope={namespace,sourceNamespace:namespace};
const draft=incoming=>prepareStoryboardPackageDraft({settings:normalizeStoryboardState(createStoryboardDefaults()),chat:{},incoming,images:[],collections:[],chatKey:'chat',...scope});
async function settings(){
  const f=await fixture(),value=createStoryboardDefaults();
  Object.assign(value,{source:'comfy',lastModelSource:'novel',directorBridge:{worldSideShotsEnabled:true},prompt:'lake, swan',negative:'lettering',contentRating:'sfw',paragraphMode:'manual',
    promptDraft:{compiled:'lake, swan',negative:'lettering',artistString:'artist',userEditedCompiled:true,compiledAt:123},
    comfyLibrarySelection:{id:'workflow',revision:'wrev1',version:1,name:'First recipe'},comfyPoolSelection:{schemaVersion:1,namespace,id:'pool',revision:'prev1',version:1,name:'Pool',poolHash:await vibeDigest(JSON.stringify(f.sources.pools.pools[0].versions[0].pool))},comfyAutoEnabled:true,
    characterArchive:{schemaVersion:1,collapsed:{char:true,user:false,other:true}},collapsedCards:{worldbook:false,production:true},tagSort:'used'});
  return normalizeStoryboardState(value);
}
test('imported compiler IDs never replace the local choice while creative compiler settings still transfer',()=>{
  for(const apiProfileId of ['local-profile','', 'source-profile']){
    const local=createStoryboardDefaults();Object.assign(local.promptCompiler,{apiProfileId,connectionPresetId:'local-connection'});
    const incoming={promptCompiler:{...local.promptCompiler,apiProfileId:'source-profile',connectionPresetId:'foreign-connection',includeRecentFloors:5,worldBookNames:['source-world']}};
    const before=JSON.stringify({local,incoming}),prepared=prepareStoryboardPackageDraft({settings:local,chat:{},incoming,images:[],collections:[],chatKey:'chat'});
    assert.equal(prepared.settings.promptCompiler.apiProfileId,apiProfileId);assert.equal(prepared.settings.promptCompiler.connectionPresetId,'local-connection');
    assert.equal(prepared.settings.promptCompiler.includeRecentFloors,5);assert.deepEqual(prepared.settings.promptCompiler.worldBookNames,['source-world']);assert.equal(JSON.stringify({local,incoming}),before);
  }
});

test('actual package import and recovery preserve destination API selection, with explicit pre-write explanation',async()=>{
  const f=createPackageImportFixture();Object.assign(f.e.state.promptCompiler,{apiProfileId:'destination',connectionPresetId:'destination-connection'});const before=clone(f.e.state);
  const payload={type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:{promptCompiler:{...f.e.state.promptCompiler,apiProfileId:'foreign',connectionPresetId:'foreign-connection',includeRecentFloors:7}},chat:{images:[],collections:[]}};
  const {file}=await buildStoryboardVibePackage(payload,{namespace:f.e.namespace,load:()=>assert.fail('no asset')});await f.import(file);
  assert.ok(f.e.pending,JSON.stringify(f.e.notices));assert.match(f.e.lastConfirmation[1],/取景 API 沿用本机选择/);assert.equal(f.e.state.promptCompiler.apiProfileId,'destination');assert.equal(f.e.state.promptCompiler.includeRecentFloors,7);
  f.e.choice='2';await f.recover();assert.deepEqual(f.e.state,before);
});

test('every normalized built-in state field is either portable, explicitly local UI, or the derived schema version',()=>{
  const keys=[...STORYBOARD_IMPORT_FIELDS,...STORYBOARD_LOCAL_STATE_FIELDS,'schemaVersion'];assert.equal(new Set(keys).size,keys.length);
  assert.deepEqual([...Object.keys(normalizeStoryboardState(createStoryboardDefaults()))].sort(),keys.sort());
  const source=normalizeStoryboardState(createStoryboardDefaults()),result=captureStoryboardPackageSettings(source);
  assert.deepEqual(Object.keys(result).sort(),['schemaVersion',...STORYBOARD_IMPORT_FIELDS].sort());
  assert.throws(()=>captureStoryboardPackageSettings(source,{pendingParagraphSelection:{}}));
  result.profiles.comfy.width=123;assert.notEqual(source.profiles.comfy.width,123);
});
test('new creative settings survive a detached round trip, with only automatic routing explicitly disabled',async()=>{
  const state=await settings(),incoming=captureStoryboardPackageSettings(state),before=JSON.stringify(incoming),restored=draft(incoming).settings;
  for(const key of STORYBOARD_ADDED_IMPORT_FIELDS)assert.deepEqual(restored[key],key==='comfyAutoEnabled'?false:state[key],key);
  assert.equal(JSON.stringify(incoming),before);assert.equal(restored.comfyPoolSelection.revision,'prev1');assert.equal(restored.comfyLibrarySelection.version,1);
});
test('partial old packages leave newly portable choices and local UI alone, including a current automatic selection',async()=>{
  const state=await settings();state.view='gallery';state.editingArtistPresetId='new';state.pendingParagraphSelection={local:true};
  const restored=prepareStoryboardPackageDraft({settings:state,chat:{},incoming:{promptMode:'combined'},images:[],collections:[],chatKey:'chat'}).settings;
  assert.deepEqual(Object.keys(restored),['promptMode']);assert.equal(state.comfyAutoEnabled,true);assert.equal(state.view,'gallery');
});
test('a partial package replacing or clearing a Comfy choice cannot inherit the previous local automation switch',async()=>{
  const state=await settings();
  for(const incoming of [{comfyPoolSelection:state.comfyPoolSelection},{comfyPoolSelection:null},{comfyLibrarySelection:state.comfyLibrarySelection}]){
    const result=prepareStoryboardPackageDraft({settings:state,chat:{},incoming,images:[],collections:[],chatKey:'chat',...scope});
    assert.equal(result.settings.comfyAutoEnabled,false);assert.equal(state.comfyAutoEnabled,true,'detached preview never changes live permission');
  }
});
test('new fields cannot silently lose text, future properties or malformed selection values through normalization',async()=>{
  for(const incoming of [{prompt:'x'.repeat(24001)},{negative:'x'.repeat(12001)},{directorBridge:{worldSideShotsEnabled:true,unknown:true}},
    {promptDraft:{compiled:'one',unknown:{nested:{excess:{levels:{more:{another:{beyond:'no'}}}}}}}},{comfyAutoEnabled:'yes'},{comfyLibrarySelection:{id:'unknown'}}])assert.throws(()=>draft(incoming),undefined,Object.keys(incoming)[0]);
  const state=await settings();state.comfyPoolSelection.poolHash='bad';assert.throws(()=>draft(captureStoryboardPackageSettings(state)));
  assert.equal(draft({directorBridge:{worldSideShotsEnabled:true}}).settings.directorBridge.worldSideShotsEnabled,true,'a partial import does not run absent-schema migrations over explicitly supplied new settings');
  assert.equal(draft({promptDraft:{compiled:'kept'}}).settings.promptDraft.compiled,'kept','adding default metadata is not data loss');
});
test('current Comfy selections require an explicit source account and are never inferred from matching IDs',async()=>{
  const incoming=captureStoryboardPackageSettings(await settings());
  for(const args of [{},{namespace:'st-user:other',sourceNamespace:namespace},{namespace}])assert.throws(()=>prepareStoryboardPackageDraft({settings:createStoryboardDefaults(),chat:{},incoming,images:[],collections:[],chatKey:'chat',...args}),/原账户/);
  assert.throws(()=>inspectStoryboardPortableSelections({comfyPoolSelection:incoming.comfyPoolSelection},'st-user:other'),/来源/);
  assert.equal(draft({comfyLibrarySelection:null,comfyPoolSelection:null,comfyAutoEnabled:false}).settings.comfyPoolSelection,null);
});
test('new setting mutations include null selections, restore exact prior choices, and protect concurrent user edits',async()=>{
  const state=await settings(),targets={settings:state,chat:{}},before=clone(state),prepared=draft(captureStoryboardPackageSettings(normalizeStoryboardState(createStoryboardDefaults())));
  const row=await createStoryboardMutation({namespace,chatKey:'chat',fileHash:'a'.repeat(64),...targets,draft:prepared});
  applyStoryboardMutation(row,targets);assert.equal(state.comfyPoolSelection,null);assert.equal(state.comfyAutoEnabled,false);applyStoryboardMutation(row,targets,'before');assert.deepEqual(state,before);
  state.prompt='edited now';assert.throws(()=>applyStoryboardMutation(row,targets),/已被修改/);assert.equal(state.comfyAutoEnabled,true);
  for(const key of ['comfyAutoEnabled','comfyPoolSelection','comfyLibrarySelection','prompt']){const invalid=clone(row),entry=invalid.patch.find(row=>row.key===key);entry.after.value=key==='comfyAutoEnabled'?'false':1;assert.throws(()=>validateStoryboardMutation(invalid));}
});
test('actual v7 import applies the new field set only after consent and restores the previous settings through recovery',async()=>{
  const f=createPackageImportFixture(),state=await settings();f.e.namespace=namespace;
  const original=clone(f.e.state),payload={type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:captureStoryboardPackageSettings(state),chat:{images:[],collections:[]}};
  const {file}=await buildStoryboardVibePackage(payload,{namespace,load:()=>assert.fail('no Vibe file')});
  const parsed=await inspectStoryboardPackageFile(file);assert.deepEqual(parsed.payload.settings.promptDraft,state.promptDraft);
  f.e.confirm=false;await f.import(file);assert.deepEqual(f.e.state,original);assert.equal(f.e.pending,null);
  f.e.confirm=true;await f.import(file);assert.ok(f.e.pending,JSON.stringify(f.e.notices));
  for(const key of STORYBOARD_ADDED_IMPORT_FIELDS)assert.deepEqual(f.e.state[key],key==='comfyAutoEnabled'?false:state[key],key);
  assert.match(f.e.lastConfirmation[1],/自动择流.*重新开启/);assert.ok(f.e.events.indexOf('journal')<f.e.events.indexOf('settings'));
  f.e.choice='2';await f.recover();assert.deepEqual(f.e.state,original);
});
test('actual v7 import refuses foreign current Comfy choices before consent, asset writes or metadata changes',async()=>{
  const state=await settings(),payload={type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:captureStoryboardPackageSettings(state),chat:{images:[],collections:[]}};
  const {file}=await buildStoryboardVibePackage(payload,{namespace,load:()=>assert.fail('no asset')}),f=createPackageImportFixture(),before=clone(f.e.state);
  await f.import(file);assert.deepEqual(f.e.state,before);assert.equal(f.e.lastConfirmation,undefined);assert.equal(f.e.pending,null);assert.deepEqual(f.e.events,[]);assert.match(f.e.notices.at(-1)[0],/原账户/);
});
test('resource bundles retain current selections against exact historic versions, not latest names',async()=>{
  const f=await fixture(),state=await settings();Object.assign(f.config.settings,{comfyLibrarySelection:state.comfyLibrarySelection,comfyPoolSelection:state.comfyPoolSelection,comfyAutoEnabled:true});f.options.storyboard=file(f.config);
  const result=await f.build();assert.equal(result.summary.workflows.versions,2);
  for(const change of [value=>value.comfyLibrarySelection.revision='missing',value=>value.comfyLibrarySelection.version=2,value=>value.comfyPoolSelection.revision='missing',value=>value.comfyPoolSelection.poolHash='b'.repeat(64)]){
    const config=clone(f.config);change(config.settings);f.options.storyboard=file(config);const before=f.reads.images;await assert.rejects(()=>f.build(),/版本|摘要/);assert.equal(f.reads.images,before,'refusal before reading original images');
  }
});
