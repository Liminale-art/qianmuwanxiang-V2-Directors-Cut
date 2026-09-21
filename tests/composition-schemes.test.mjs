import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as schemes from '../qianmu-composition-schemes.js';
import * as view from '../qianmu-composition-schemes-view.js';
import {captureStoryboardPackageSettings,assertStoryboardAdditionalSettingsRetained} from '../qianmu-storyboard-package-fields.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
const normalize=core.normalizeStoryboardCompositionPolicy,copy=structuredClone;
function fixture(){const state=core.createStoryboardDefaults();state.promptPresets=[{id:'p',name:'故事',items:[]}];state.promptCompiler.instructionPresetId='p';let sequence=0;
  return {state,preset:state.promptPresets[0],save:name=>schemes.saveCompositionScheme(state,name,{normalize,createId:()=>`c-${++sequence}`})};}

test('legacy normalization adds only an empty library and never reapplies a preset binding over an active temporary policy',()=>{
  const f=fixture();f.state.compositionPolicy=normalize({mode:'fixed',fixedRatioId:'9:16'});const before=copy(f.state.compositionPolicy);
  delete f.state.compositionSchemes;delete f.state.compositionSchemeId;core.normalizeStoryboardState(f.state);
  assert.deepEqual(f.state.compositionPolicy,before);assert.deepEqual(f.state.compositionSchemes,[]);
  f.save('竖幅');schemes.bindCurrentComposition(f.state,f.state.promptPresets[0],true,normalize);
  f.state.compositionPolicy=normalize({mode:'smart',preferredRatioId:'16:9'});core.normalizeStoryboardState(f.state);assert.equal(f.state.compositionPolicy.mode,'smart');
});

test('named scheme choices and explicit default apply copies, without touching an already captured job',()=>{
  const f=fixture();f.state.compositionPolicy=normalize({mode:'fixed',fixedRatioId:'9:16'});const scheme=f.save('竖幅'),job=copy(f.state.compositionPolicy);
  schemes.selectCompositionScheme(f.state,schemes.DEFAULT_COMPOSITION_SCHEME,normalize);assert.equal(f.state.compositionPolicy.mode,'smart');
  schemes.selectCompositionScheme(f.state,scheme.id,normalize);f.state.compositionPolicy.fixedRatioId='1:1';
  assert.equal(scheme.policy.fixedRatioId,'9:16');assert.equal(job.fixedRatioId,'9:16');assert.throws(()=>schemes.selectCompositionScheme(f.state,'missing',normalize));
});

test('bound presets travel standalone, survive a colliding foreign library id, and unbinding preserves current policy',()=>{
  const f=fixture();f.state.compositionPolicy=normalize({mode:'fixed',fixedRatioId:'9:16'});const saved=f.save('手机');schemes.bindCurrentComposition(f.state,f.preset,true,normalize);
  const imported=core.normalizeStoryboardState({promptPresets:copy(f.state.promptPresets)}),before=copy(f.preset.compositionBinding);
  imported.compositionSchemes=[{...copy(saved),policy:normalize({mode:'fixed',fixedRatioId:'1:1'})}];
  schemes.applyBoundComposition(imported,imported.promptPresets[0],normalize);assert.equal(imported.compositionPolicy.fixedRatioId,'9:16');assert.equal(imported.compositionSchemeId,'');
  schemes.bindCurrentComposition(imported,imported.promptPresets[0],false,normalize);assert.equal(imported.compositionPolicy.fixedRatioId,'9:16');assert.deepEqual(f.preset.compositionBinding,before);
});

test('explicit update follows only exact local bindings, while deleting a library entry preserves bound and active policies',()=>{
  const f=fixture(),saved=f.save('日常');schemes.bindCurrentComposition(f.state,f.preset,true,normalize);
  f.state.promptPresets.push({id:'foreign',compositionBinding:{...copy(saved),policy:normalize({mode:'fixed'})}});const foreign=copy(f.state.promptPresets[1]);
  schemes.updateCompositionPolicy(f.state,'ruleOverride','给主体留出空间',normalize);
  schemes.saveCompositionScheme(f.state,'日常新版',{id:saved.id,normalize});assert.equal(f.preset.compositionBinding.name,'日常新版');assert.deepEqual(f.state.promptPresets[1],foreign);
  const policy=copy(f.state.compositionPolicy);schemes.deleteCompositionScheme(f.state,saved.id);assert.equal(f.state.compositionSchemeId,'');assert.deepEqual(f.state.compositionPolicy,policy);
  schemes.applyBoundComposition(f.state,f.preset,normalize);assert.deepEqual(f.state.compositionPolicy,policy);
});

test('composition policies reject empty selection and oversized instructions without truncating, preserving one main frame',()=>{
  const f=fixture(),original=copy(f.state.compositionPolicy);
  assert.throws(()=>schemes.updateCompositionPolicy(f.state,'allowedRatioIds',[],normalize),/至少/);assert.throws(()=>schemes.updateCompositionPolicy(f.state,'ruleOverride','x'.repeat(12001),normalize),/未截断/);
  assert.deepEqual(f.state.compositionPolicy,original);
  schemes.updateCompositionPolicy(f.state,'allowedRatioIds',['9:16'],normalize);assert.equal(f.state.compositionPolicy.preferredRatioId,'9:16');
  schemes.updateCompositionPolicy(f.state,'preferredRatioId','3:2',normalize);assert.equal(f.state.compositionPolicy.preferredRatioId,'9:16');
});

test('scheme limits, names, reserved ids and malformed bindings cannot silently replace a valid active policy',()=>{
  const f=fixture();f.save('A');assert.throws(()=>f.save('A'),/同名/);assert.throws(()=>f.save('x'.repeat(81)));assert.throws(()=>f.save('bad\nname'));
  assert.throws(()=>schemes.saveCompositionScheme(f.state,'collision',{createId:()=>f.state.compositionSchemes[0].id,normalize}),/标识重复/);
  assert.throws(()=>schemes.saveCompositionScheme(f.state,'Default',{id:schemes.DEFAULT_COMPOSITION_SCHEME,normalize}));
  const original=copy(f.state.compositionPolicy);assert.throws(()=>schemes.applyBoundComposition(f.state,{compositionBinding:{id:'x',name:'x',policy:{mode:'unknown'}}},normalize));assert.deepEqual(f.state.compositionPolicy,original);
  f.state.compositionSchemes=Array.from({length:100},(_,i)=>({id:String(i),name:String(i),policy:normalize({})}));assert.throws(()=>f.save('new'),/100/);
});

test('configuration backup includes named schemes, selected id and standalone bindings without loss',()=>{
  const f=fixture();f.save('A');schemes.bindCurrentComposition(f.state,f.preset,true,normalize);
  const payload=captureStoryboardPackageSettings(f.state),restored=core.normalizeStoryboardState(copy(payload));
  assertStoryboardAdditionalSettingsRetained(payload,restored);assert.deepEqual(restored.compositionSchemes,f.state.compositionSchemes);assert.deepEqual(restored.promptPresets[0].compositionBinding,f.preset.compositionBinding);
});

test('standalone import gives the bound full policy precedence over legacy override and validates before mutation',()=>{
  const f=fixture();f.save('A');schemes.bindCurrentComposition(f.state,f.preset,true,normalize);const before=copy(f.state);
  const result=schemes.importedCompositionPolicy(f.state,f.preset,{id:'qianmu:composition-law',ruleOverride:'legacy'},normalize);
  assert.deepEqual(result.compositionPolicy,f.preset.compositionBinding.policy);assert.deepEqual(f.state,before);
  assert.throws(()=>schemes.importedCompositionPolicy(f.state,{compositionBinding:{}},null,normalize));assert.deepEqual(f.state,before);
});

test('actual preset switch applies binding once; same preset selection and plain normalization retain temporary edits',()=>{
  const f=fixture();f.save('A');schemes.bindCurrentComposition(f.state,f.preset,true,normalize);f.state.promptCompiler.instructionPresetId='';
  const context=vm.createContext({...core,...schemes,storyboardState:()=>f.state,saveSettings(){},renderModal(){},toast:message=>assert.fail(message)});vm.runInContext(section('storyboardLoadPromptPreset'),context);
  context.storyboardLoadPromptPreset('p');schemes.updateCompositionPolicy(f.state,'ruleOverride','临时修订',normalize);context.storyboardLoadPromptPreset('p');core.normalizeStoryboardState(f.state);
  assert.equal(f.state.compositionPolicy.ruleOverride,'临时修订');context.storyboardLoadPromptPreset('');context.storyboardLoadPromptPreset('p');assert.equal(f.state.compositionPolicy.ruleOverride,'');
});

test('actual compiler receives bound composition in narrative only, with no extra request or changes to user preset',async()=>{
  const e=await compilerEnvironment();e.state.promptPresets=[{id:'bound',name:'Bound',items:[],compositionBinding:{id:'exported',name:'Exported',policy:normalize({ruleOverride:'COMPOSITION-BOUND-ONCE',userEdited:true})}}];
  Object.assign(e.context,schemes);
  vm.runInContext(section('storyboardLoadPromptPreset'),e.context);e.context.storyboardLoadPromptPreset('bound');
  assert.equal(e.state.compositionPolicy.ruleOverride,'COMPOSITION-BOUND-ONCE');
  assert.equal(e.llmCalls.length,0);assert.equal(await e.context.storyboardCompilePrompt(null),true,JSON.stringify(e.errors));assert.equal(e.llmCalls.length,2);
  assert.match(JSON.stringify(e.llmCalls[0].messages),/COMPOSITION-BOUND-ONCE/);assert.doesNotMatch(JSON.stringify(e.llmCalls[1].messages),/COMPOSITION-BOUND-ONCE/);
});

test('workbench renderer contains only the scheme selector; preset editor escapes user text and keeps layout controls in one place',()=>{
  const f=fixture();f.save('<script>');const selector=view.renderCompositionSelector(f.state),editor=view.renderCompositionEditor(f.state,{ratios:core.STORYBOARD_RATIOS});
  assert.doesNotMatch(selector,/textarea|data-composition-field/);assert.match(editor,/data-composition-field="ruleOverride"/);assert.doesNotMatch(editor,/<script>/);
  const context=vm.createContext({...core,...view});vm.runInContext(section('renderStoryboardCompositionCard')+section('storyboardCompositionLawEntryMarkup'),context);
  assert.doesNotMatch(context.renderStoryboardCompositionCard(f.state),/textarea/);assert.match(context.storyboardCompositionLawEntryMarkup(f.state),/data-composition-editor/);
});

function boundEditor(){
  const f=fixture();f.save('A');const field=new EventTarget(),status={textContent:''};field.dataset={compositionField:'ruleOverride'};field.value='';
  let active=true,failed=false,saves=0,renders=0;
  const root={querySelectorAll:selector=>selector==='[data-composition-field]'?[field]:[],querySelector:selector=>selector==='[data-composition-status]'?status:null};
  view.bindCompositionEditor(root,f.state,{normalize,current:()=>active,save:()=>{if(failed)throw Error('save failed');saves++;},render:()=>renders++});
  return {...f,field,status,change:value=>{field.value=value;field.dispatchEvent(new Event('change'));},set active(value){active=value;},set failed(value){failed=value;},counts:()=>({saves,renders})};
}
test('editor refuses late events after owner departure or selected preset change',()=>{
  for(const kind of ['owner','preset']){const f=boundEditor(),before=copy(f.state.compositionPolicy);if(kind==='owner')f.active=false;else f.state.promptCompiler.instructionPresetId='other';
    f.change('late');assert.deepEqual(f.state.compositionPolicy,before);assert.deepEqual(f.counts(),{saves:0,renders:0});}
});
test('editor retains invalid text drafts and rolls back a synchronous save failure without detaching other preset editors',()=>{
  const f=boundEditor(),preset=f.preset,policy=f.state.compositionPolicy;
  f.change('x'.repeat(12001));assert.match(f.status.textContent,/12000/);assert.equal(f.field.value.length,12001);assert.equal(f.state.compositionPolicy,policy);
  f.failed=true;f.change('unsaved');assert.match(f.status.textContent,/save failed/);assert.equal(f.state.compositionPolicy,policy);assert.equal(f.state.promptPresets[0],preset);assert.deepEqual(f.counts(),{saves:0,renders:0});
  f.failed=false;f.change('accepted');assert.equal(f.state.compositionPolicy.ruleOverride,'accepted');assert.deepEqual(f.counts(),{saves:1,renders:1});
});
