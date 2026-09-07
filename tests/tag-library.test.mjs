import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as tags from '../qianmu-tags.js';
import * as core from '../qianmu-storyboard.js';
import {storyboardComfyPromptFormat} from '../qianmu-comfy-workbench-binding.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

test('unnamed single semantic tags persist; multiple top-level terms require an explicit group name',()=>{
  for(const content of ['long hair','artist:sample','(red hair, blue eyes:1.2)','1.2::red hair, blue eyes::','"red, blue"','red\\,blue'])assert.equal(tags.validateStoryboardTagContent('',content).content,content);
  for(const content of ['red hair, blue eyes','红色，蓝色','sky\nforest'])assert.throws(()=>tags.validateStoryboardTagContent('',content),/组名/);
  const state=core.normalizeStoryboardState({...core.createStoryboardDefaults(),tagLibrary:[{id:'single',name:'',content:'red hair'},{id:'group',name:'Look',content:'red hair, blue eyes'},{id:'bad',name:''}]});
  assert.equal(state.tagLibrary.length,2);assert.equal(state.tagLibrary[0].name,'');assert.equal(state.tagLibrary[0].content,'red hair');
});
test('model-specific text replaces general text without duplication or invented translation; old fields remain usable',()=>{
  const item={name:'look',content:'raw tag',renderings:{novel:'NAI tags',banana:'Gemini wording'},naturalLanguage:'general prose'};
  assert.equal(tags.storyboardTagText(item,'novel'),'NAI tags');assert.equal(tags.storyboardTagText(item,'banana'),'Gemini wording');assert.equal(tags.storyboardTagText(item,'comfy'),'general prose');
  assert.equal(tags.storyboardTagText({name:'label',content:'raw tag'},'gptimage'),'raw tag');assert.equal(tags.storyboardTagContent({name:'old',renderings:{novel:'old value'}}),'old value');
});
test('sorting uses creation or actual usage, never favorites or last edit, with bounded pages and polarity independent of source',()=>{
  const items=[{id:'old',content:'soft light',createdAt:1,updatedAt:99999,favorite:true,usageCount:8},{id:'new',name:'Garden',content:'flower',aliases:['花'],createdAt:3,usageCount:1,positive:false},{id:'middle',content:'blue light',createdAt:2,usageCount:4}];
  const index=tags.createStoryboardTagIndex(items);assert.equal(tags.searchStoryboardTags(index).rows[0].item.id,'new');assert.equal(tags.searchStoryboardTags(index,{sort:'used'}).rows[0].item.id,'old');
  assert.equal(tags.searchStoryboardTags(index,{query:'花',polarity:'negative'}).rows[0].item.id,'new');assert.equal(tags.searchStoryboardTags(index,{limit:1,offset:1}).rows.length,1);
  assert.deepEqual(items.map(item=>item.id),['old','new','middle']);
});
test('caret insertion preserves surrounding NAI emphasis, escaped groups, unrelated scene text and explicit selection',()=>{
  for(const [value,caret,expected]of [['sky, (re:1.2), tree',8,'sky, (red hair:1.2), tree'],['sky, 1.2::re::, tree',12,'sky, 1.2::red hair::, tree']]){
    const result=tags.insertStoryboardTag(value,caret,caret,'red hair');assert.equal(result.value,expected);
  }
  const value='forest, ancient temple, mountains',start=value.indexOf('ancient');assert.equal(tags.insertStoryboardTag(value,start,start+'ancient temple'.length,'quiet lake').value,'forest, quiet lake, mountains');
  assert.equal(tags.insertStoryboardTag('a fox near the fo',16,16,'forest',{format:'natural'}).value,'a fox near the forest ');
});
test('exact duplicates retain original weights and unsuccessful insertion does not truncate a full input',()=>{
  const value='{red hair}, re';const duplicate=tags.insertStoryboardTag(value,value.length,value.length,'red hair');assert.equal(duplicate.changed,false);assert.equal(duplicate.value,value);assert.equal(duplicate.reason,'duplicate');
  const full=tags.insertStoryboardTag('abc, ',5,5,'long hair',{maxLength:8});assert.equal(full.reason,'limit');assert.equal(full.value,'abc, ');
});

function setup(){
  const state=core.createStoryboardDefaults(),notices=[];let saved=0;
  const context=vm.createContext({...core,...tags,storyboardComfyPromptFormat,storyboardState:()=>state,htmlEscape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
    STORYBOARD_TAG_CATEGORY_LABELS:Object.fromEntries(core.STORYBOARD_TAG_CATEGORIES.map(key=>[key,key])),snip:(value,max)=>String(value).slice(0,max),uid:()=> 'new-tag',uniqueClean:values=>[...new Set(values.filter(Boolean))],saveSettings(){saved++;},renderModal(){},toast:message=>{notices.push(message);return false;}});
  vm.runInContext(['storyboardFilteredTags','storyboardTagFormValues','storyboardCaptureTagDraft','renderStoryboardTagLibrary','storyboardSaveTagFromForm','storyboardBindTagCompletion'].map(section).join('\n'),context);
  const fields={'.sd-storyboard-tag-name':'','.sd-storyboard-tag-rendering':'soft light','.sd-storyboard-tag-category':'lighting','.sd-storyboard-tag-description':'gentle light','.sd-storyboard-tag-override':'','.sd-storyboard-tag-aliases':'柔光，gentle'};
  const editor={dataset:{tagEditor:'new',tagSource:'novel'},querySelector:key=>key==='.sd-storyboard-tag-negative'?{getAttribute:()=> 'true'}:{value:fields[key]||''}};
  const root={querySelector:key=>key==='[data-tag-editor]'?editor:null};return {state,context,fields,editor,root,notices,saved:()=>saved};
}
test('actual tag form saves optional group names and negative state without overwriting old cross-model expressions or creation time',()=>{
  const e=setup();assert.equal(e.context.storyboardSaveTagFromForm(e.root),true);let item=e.state.tagLibrary[0];assert.equal(item.name,'');assert.equal(item.content,'soft light');assert.equal(item.positive,false);assert.equal(e.saved(),1);
  item.renderings.banana='old specific';item.createdAt=1;e.state.editingTagId=item.id;e.editor.dataset.tagEditor=item.id;e.fields['.sd-storyboard-tag-name']='Look';e.fields['.sd-storyboard-tag-rendering']='soft light, flower';
  assert.equal(e.context.storyboardSaveTagFromForm(e.root),true);item=e.state.tagLibrary[0];assert.equal(item.createdAt,1);assert.equal(item.renderings.banana,'old specific');assert.equal(item.name,'Look');
});
test('invalid unnamed group, capacity limits, and stale editor source leave the actual library unchanged',()=>{
  const e=setup();e.fields['.sd-storyboard-tag-rendering']='a,b';assert.equal(e.context.storyboardSaveTagFromForm(e.root),false);assert.equal(e.state.tagLibrary.length,0);
  e.fields['.sd-storyboard-tag-rendering']='a';e.state.tagLibrary=Array.from({length:2000},(_,i)=>({id:String(i),content:'a'}));assert.equal(e.context.storyboardSaveTagFromForm(e.root),false);assert.equal(e.state.tagLibrary.length,2000);
  e.editor.dataset.tagSource='banana';assert.equal(e.context.storyboardSaveTagFromForm(e.root),false);assert.equal(e.saved(),0);
});
test('library renders bounded chips, visible negative selection, no favorites and preserves unsaved editor during filtering',()=>{
  const e=setup();e.state.tagLibrary=Array.from({length:105},(_,i)=>({id:String(i),content:'tag '+i,name:i?'':'group',createdAt:i,positive:i!==0}));
  e.context.storyboardCaptureTagDraft(e.root);const html=e.context.renderStoryboardTagLibrary(e.state);
  assert.equal((html.match(/data-storyboard-edit-tag=/g)||[]).length,100);assert.match(html,/sd-storyboard-tag-negative active/);assert.match(html,/aria-pressed="true"/);assert.doesNotMatch(html,/favorite|data-storyboard-add-tag/);assert.match(html,/>soft light<\/textarea>/);
});
test('lazy component binding rejects obsolete page and counts successful use only, without changing creation time',async()=>{
  const e=setup(),page={isConnected:true,querySelector:()=>({})};e.root.querySelector=()=>page;e.state.tagLibrary=[{id:'one',content:'x',usageCount:2,createdAt:7}];let resolve,mounted=0,options;
  Object.assign(e.context,{activeTab:'imagegen',storyboardAdmissionEpoch:1,featureRuntime:{load:()=>new Promise(r=>resolve=r)}});
  e.context.storyboardBindTagCompletion(e.root);e.root._sdTagCompleteCleanup();resolve({mountStoryboardTagComplete(){mounted++;}});await new Promise(r=>setImmediate(r));assert.equal(mounted,0);
  e.context.featureRuntime.load=async()=>({mountStoryboardTagComplete:(root,value)=>{options=value;mounted++;return ()=>{};}});e.context.storyboardBindTagCompletion(e.root);await new Promise(r=>setImmediate(r));
  assert.equal(mounted,1);options.onUse(e.state.tagLibrary[0]);assert.equal(e.state.tagLibrary[0].usageCount,3);assert.equal(e.state.tagLibrary[0].createdAt,7);
  const field={classList:{contains:()=>false}};e.state.source='comfy';e.state.profiles.comfy.comfyRoutePromptFormat='tags';assert.equal(options.format(field),'tags');delete e.state.profiles.comfy.comfyRoutePromptFormat;assert.equal(options.format(field),'natural');
  assert.equal(options.format({classList:{contains:key=>key==='sd-storyboard-artist-edit-negative'}}),'tags');
  page.isConnected=false;options.onUse(e.state.tagLibrary[0]);assert.equal(e.state.tagLibrary[0].usageCount,3);
});
