import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {DEFAULT_GALLERY_KEYWORDS,galleryKeywordList,selectedGalleryKeywords,galleryTagsMatch,toggleGalleryTag} from '../qianmu-gallery-keywords.js';
import {renderGalleryKeywordEntry,renderGalleryKeywordFilters,bindGalleryKeywordEntry} from '../qianmu-gallery-keywords-view.js';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));

test('actual preset page places one keyword editor after composition and still exposes defaults without a selected preset',()=>{
  const state=core.createStoryboardDefaults(),context=vm.createContext({renderGalleryKeywordEntry,htmlEscape:value=>String(value||''),storyboardPresetUndo:null,
    storyboardCompositionLawEntryMarkup:()=>'<div data-composition-entry></div>',storyboardPromptPresetEntryMarkup:()=>'<div data-user-rule></div>'});
  vm.runInContext(section('renderStoryboardPresetLibrary'),context);
  assert.equal((context.renderStoryboardPresetLibrary(state).match(/data-gallery-keyword-editor/g)||[]).length,1);
  state.promptPresets=[{id:'p',items:[{id:'r',name:'Rule',instruction:'Keep the scene'}],galleryKeywords:['自定义']}];state.promptCompiler.instructionPresetId='p';
  const html=context.renderStoryboardPresetLibrary(state);assert.equal((html.match(/data-gallery-keyword-editor/g)||[]).length,1);
  assert.ok(html.indexOf('data-composition-entry')<html.indexOf('data-gallery-keyword-editor'));assert.ok(html.indexOf('data-gallery-keyword-editor')<html.indexOf('data-user-rule'));assert.ok(html.includes('自定义'));
});

test('default vocabulary is copied, preset overrides are independent and explicit empty means disabled',()=>{
  const state=core.createStoryboardDefaults(),words=selectedGalleryKeywords(state);words.length=0;
  assert.ok(Object.isFrozen(DEFAULT_GALLERY_KEYWORDS));assert.ok(selectedGalleryKeywords(state).length>20);
  state.galleryKeywords=['全局'];state.promptPresets=[{id:'a',galleryKeywords:['自定义']},{id:'b',galleryKeywords:[]}];
  for(const [id,expected] of [['a',['自定义']],['b',[]],['',['全局']]]){state.promptCompiler.instructionPresetId=id;assert.deepEqual(selectedGalleryKeywords(state),expected);}
});
test('invalid import is rejected rather than truncated or reinterpreted as model instructions',()=>{
  assert.deepEqual(galleryKeywordList(['  夜色 ','夜色','a b','']),['夜色','a b']);
  for(const value of [null,{},['x'.repeat(65)],Array(201).fill('x'),['new\nline'],[3]])assert.throws(()=>galleryKeywordList(value));
});
test('preset keyword settings and per-shot tags survive normalized settings and portable snapshots',()=>{
  const state=core.createStoryboardDefaults();state.galleryKeywords=[];state.promptPresets=[{id:'p',items:[],galleryKeywords:['关键词']}];state.promptCompiler.instructionPresetId='p';
  state.shotPlans=[{id:'p1',shots:[{id:'s1',tags:['关键词']}]}];state.promptDraft.shots=[{id:'s1',tags:['关键词']}];
  core.normalizeStoryboardState(state);assert.deepEqual(selectedGalleryKeywords(state),['关键词']);
  assert.deepEqual(state.shotPlans[0].shots[0].tags,['关键词']);assert.deepEqual(state.promptDraft.shots[0].tags,['关键词']);
  assert.deepEqual(core.sanitizeStoryboardSnapshot({source:'novel',tags:['关键词']}).tags,['关键词']);
});
test('gallery filters are exact intersection, independent of text query, and only existing tags render',()=>{
  const records=[{tags:['夜色','相伴']},{tags:['夜色']},{tags:['暖光']}];let selected=[];
  selected=toggleGalleryTag(selected,'夜色');selected=toggleGalleryTag(selected,'相伴');
  assert.deepEqual(records.filter(row=>galleryTagsMatch(row,selected)),[records[0]]);
  assert.deepEqual(toggleGalleryTag(selected,'夜色'),['相伴']);
  const html=renderGalleryKeywordFilters(records,selected);assert.equal((html.match(/aria-pressed="true"/g)||[]).length,2);assert.equal(html.includes('战斗'),false);
  assert.equal(renderGalleryKeywordFilters([],selected),'');assert.ok(renderGalleryKeywordFilters([{tags:['<b>']}]).includes('&lt;b&gt;'));
});
test('actual compiler -> normalized settings -> mixed jobs -> gallery records retains per-shot keywords without prompt pollution',async()=>{
  const e=await compilerEnvironment(),plan={id:'plan',chatKey:'chat-a',status:'screening',shots:[]};
  e.state.galleryKeywords=['相伴','风景','物件'];e.response.shots.forEach((shot,i)=>shot.gallery_keywords=[e.state.galleryKeywords[i]]);
  assert.equal(await e.context.storyboardCompilePrompt(null,{plan}),true,JSON.stringify(e.errors));
  assert.equal(e.llmCalls.length,2);assert.deepEqual(e.state.promptDraft.shots.map(shot=>copy(shot.tags)),[['相伴'],['风景'],['物件']]);
  assert.deepEqual(plan.shots.map(shot=>copy(shot.tags)),[['相伴'],['风景'],['物件']]);
  assert.doesNotMatch(e.llmCalls[1].messages[1].content,/gallery_keywords|gallery_keyword_vocabulary|相伴|风景|物件/);
  core.normalizeStoryboardState(e.state);assert.equal(await e.context.storyboardGenerate(null,{plan,automatic:true}),true,JSON.stringify(e.notices));
  assert.deepEqual(e.jobs.map(job=>copy(job.tags)),[['相伴'],['风景'],['物件']]);
  vm.runInContext(section('storyboardCreateRecord'),e.context);
  e.context.storyboardProductionDeliveryPolicy=core.storyboardProductionDeliveryPolicy;
  e.context.storyboardItemCollectionIds=()=>[];
  const records=e.jobs.map((job,i)=>e.context.storyboardCreateRecord(job,{snapshot:core.sanitizeStoryboardSnapshot(job)},'https://image.invalid/'+i,i,{floor:null,message:null},{}));
  assert.deepEqual(records.map(row=>copy(row.tags)),[['相伴'],['风景'],['物件']]);
  assert.ok(e.jobs.every(job=>!JSON.stringify(job.payload).includes('相伴')));
});
test('empty configured vocabulary requests no keyword field and still uses only two calls',async()=>{
  const e=await compilerEnvironment();e.state.galleryKeywords=[];
  assert.equal(await e.context.storyboardCompilePrompt(null),true,JSON.stringify(e.errors));assert.equal(e.llmCalls.length,2);
  assert.equal(e.llmCalls[0].options.jsonSchema.properties.shots.items.properties.gallery_keywords,undefined);
  assert.ok(e.state.promptDraft.shots.every(shot=>shot.tags.length===0));
});
test('actual preparation guard rejects vocabulary edits during the model request',async()=>{
  const e=await compilerEnvironment(),original=e.context.storyboardCallCompiler;
  e.context.storyboardCallCompiler=async(...args)=>{const raw=await original(...args);e.state.galleryKeywords=['changed'];return raw;};
  assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(e.jobs.length,0);assert.equal(e.llmCalls.length,1);
});
function editorFixture(){
  const state=core.createStoryboardDefaults();state.promptPresets=[{id:'p',galleryKeywords:['夜色']}];state.promptCompiler.instructionPresetId='p';
  const input=new EventTarget(),defaults=new EventTarget(),status={textContent:''};input.value='夜色';let active=true,saves=0,fail=false;
  const root={querySelector:selector=>selector==='[data-gallery-keyword-editor]'?input:selector==='[data-gallery-keyword-defaults]'?defaults:status};
  bindGalleryKeywordEntry(root,state,{current:()=>active,save:()=>{if(fail)throw Error('synthetic save failure');saves++;}});
  return {state,input,defaults,status,get saves(){return saves;},set active(value){active=value;},set fail(value){fail=value;},change(){input.dispatchEvent(new Event('change'));}};
}
test('keyword editor saves only its selected preset, retains invalid drafts and rejects a stale mount',()=>{
  const f=editorFixture();f.input.value='相伴，夜色\n夜色';f.change();assert.deepEqual(f.state.promptPresets[0].galleryKeywords,['相伴','夜色']);assert.equal(f.saves,1);
  f.input.value='x'.repeat(65);f.change();assert.equal(f.saves,1);assert.equal(f.input.value.length,65);assert.match(f.status.textContent,/64/);
  f.state.promptCompiler.instructionPresetId='';f.input.value='不应保存';f.change();assert.equal(f.saves,1);
});
test('keyword editor empty save disables; failed save preserves prior configuration and restores defaults only explicitly',()=>{
  const f=editorFixture();f.input.value='';f.change();assert.deepEqual(f.state.promptPresets[0].galleryKeywords,[]);
  f.fail=true;f.input.value='新词';f.change();assert.deepEqual(f.state.promptPresets[0].galleryKeywords,[]);assert.equal(f.input.value,'新词');
  f.fail=false;f.defaults.dispatchEvent(new Event('click'));assert.deepEqual(f.state.promptPresets[0].galleryKeywords,[...DEFAULT_GALLERY_KEYWORDS]);
  const html=renderGalleryKeywordEntry({galleryKeywords:['</textarea><script>'],promptPresets:[]});assert.equal(html.includes('<script>'),false);
});
