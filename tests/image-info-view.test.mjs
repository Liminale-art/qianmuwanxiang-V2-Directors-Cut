import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {renderImageInfo,imageInfoFinalPrompts,imageInfoParameterMarkup} from '../qianmu-image-info-view.js';
import {storyboardFunctionSource as fn} from './helpers/storyboard-form-fixture.mjs';

test('draft editor only treats an explicitly accepted generation as successful',()=>{
  const source=fn('storyboardEditPrompt');
  assert.match(source,/return await storyboardGenerate\(null,\{plan,automatic:false\}\)===true/);
  assert.doesNotMatch(source,/storyboardGenerate\(null,\{plan,automatic:false\}\)!==false/);
});

test('image info escapes prompt content and keeps one generation action without save-only or backend state',()=>{
  const html=renderImageInfo({record:{id:'a',floor:0,status:'unknown',error:'INTERNAL TASK DETAIL'},positive:'<script>alert(1)</script>',negative:'<img src=x>',characters:'<div>character</div>'});
  assert.doesNotMatch(html,/<script>|<img src=x>|仅保存|INTERNAL TASK DETAIL|待核查/);
  assert.match(html,/&lt;script/);assert.equal([...html.matchAll(/data-image-info-generate/g)].length,1);
  assert.match(html,/data-image-info-copy="positive"/);assert.match(html,/data-image-info-copy="negative"/);
  assert.match(html,/data-image-info-reset-characters hidden/);
});
test('original-only image remains readable with copy and download but no editable recipe or generate action',()=>{
  const html=renderImageInfo({record:{id:'a',url:'image.png',recipeUnavailable:true},positive:'saved scene'});
  assert.equal([...html.matchAll(/readonly/g)].length,2);assert.doesNotMatch(html,/data-image-info-generate/);
  assert.match(html,/saved scene/);assert.match(html,/data-image-info-action="download"/);
});
test('orphan memberships stay removable and thousands of collections are not rendered before opening add',()=>{
  const orphan=renderImageInfo({record:{id:'a'},collectionIds:['original-folder']});
  assert.match(orphan,/original-folder/);assert.match(orphan,/data-image-collection-remove="original-folder"/);
  const html=renderImageInfo({record:{id:'a'},collections:Array.from({length:5001},(_,i)=>({id:String(i),name:'Folder '+i})),collectionIds:['5000']});
  assert.equal([...html.matchAll(/data-image-collection-choice=/g)].length,0);assert.match(html,/Folder 5000/);assert.doesNotMatch(html,/已选|没有匹配项/);
  assert.ok(html.length<6000);
});
test('shared detail has one back header, saved source first, image-only quick menu and expanded prompt cards',()=>{
  const html=renderImageInfo({record:{id:'a',url:'image.png',floor:0},sourceCharacter:'Source CHAR',characterNames:['Alice','Bob','Alice'],modelLabel:'ComfyUI',positive:'scene'});
  const header=html.match(/<header>[\s\S]*?<\/header>/)[0];
  assert.match(header,/返回/);assert.match(header,/画面详情/);assert.match(header,/ComfyUI/);assert.doesNotMatch(header,/关闭|SCREENING ROOM/);
  const cast=html.match(/sd-image-info-cast[\s\S]*?<\/div>/)[0];assert.ok(cast.indexOf('Source CHAR')<cast.indexOf('Alice'));assert.equal([...cast.matchAll(/Alice/g)].length,1);assert.match(cast,/Bob/);
  assert.equal([...html.matchAll(/data-image-info-action="download"/g)].length,1);assert.equal([...html.matchAll(/data-image-info-action="delete"/g)].length,1);
  assert.doesNotMatch(html,/fa-ellipsis|data-image-info-menu-toggle/);assert.match(html,/sd-image-info-collection-editor" hidden/);
  assert.doesNotMatch(html,/重新生成|查看本段全部静帧|原图与重绘工具|<details[^>]*sd-image-info-prompt/);
});
test('gallery detail is explicitly read-only with no editing, character, motion or generation workspace',()=>{
  const html=renderImageInfo({readonly:true,record:{id:'a',url:'image.png',floor:0},sourceCharacter:'Alice',characterNames:['Alice','Bob'],characters:'EDITOR',extra:'CONTROL',organizeActions:'STYLE',positive:'final positive'});
  assert.doesNotMatch(html,/textarea|<footer|人物详情|EDITOR|CONTROL|STYLE|保存并生成|data-image-info-action="(?:motion|inline)"/);
  assert.match(html,/sd-image-info-prompt-text/);assert.match(html,/data-image-info-copy="positive"/);
  const cast=html.match(/sd-image-info-cast[\s\S]*?<\/div>/)[0];assert.equal([...cast.matchAll(/Alice/g)].length,1);
  assert.match(html,/sd-media-tag-chip sd-image-info-chip-add/);
});
test('final prompt view retains the saved native positive and negative captions in their original order',()=>{
  const snapshot={source:'novel',payload:{prompt:'old base',negative:'old negative',parameters:{providerOptions:{
    v4_prompt:{caption:{base_caption:'final base',char_captions:[{char_caption:'red hair, blue coat'},{char_caption:'black hair, green dress'}]}},
    v4_negative_prompt:{caption:{base_caption:'final negative',char_captions:[{char_caption:'long hair'},{char_caption:'blue dress'}]}}
  }}}};
  assert.deepEqual(imageInfoFinalPrompts({finalPrompt:'not actual',effectiveNegative:'not actual'},snapshot),{positive:'final base\n\nred hair, blue coat\n\nblack hair, green dress',negative:'final negative\n\nlong hair\n\nblue dress',positiveAvailable:true,negativeAvailable:true});
});
test('final prompt view preserves explicit empty negatives and never invents history from raw drafts',()=>{
  assert.deepEqual(imageInfoFinalPrompts({finalPrompt:'saved final',effectiveNegative:'',prompt:'draft',negative:'old draft'}),{positive:'saved final',negative:'',positiveAvailable:true,negativeAvailable:true});
  const missing=imageInfoFinalPrompts({prompt:'draft only',negative:'draft only',compiledPrompt:{prompt:'intermediate'}});
  assert.deepEqual(missing,{positive:'',negative:'',positiveAvailable:false,negativeAvailable:false});
  const html=renderImageInfo({readonly:true,record:{id:'old'},...missing});assert.match(html,/未保留最终提示词/);assert.doesNotMatch(html,/data-image-info-copy=/);
});
test('final flat payload contains saved character and artist content without reconstructing names or current settings',()=>{
  const source={source:'comfy',payload:{prompt:'artist, 2people, red hair, blue coat, green dress, indoors',negative:'blur, merged limbs'}};
  assert.equal(imageInfoFinalPrompts({finalPrompt:'older copy'},source).positive,source.payload.prompt);
});
test('generation parameters are small labelled cells, not a serialization of request internals',()=>{
  const html=imageInfoParameterMarkup({}, {payload:{parameters:{seed:42,width:640,height:960,steps:24,scale:6,sampler:'euler',scheduler:'normal',workflow:{secret:'never render'},providerOptions:{token:'never render'}}}});
  assert.match(html,/sd-image-info-parameter-grid/);assert.equal([...html.matchAll(/<div><dt>/g)].length,6);assert.match(html,/640 × 960/);assert.doesNotMatch(html,/secret|token|never render|\[object Object\]/);
});
test('an opaque Comfy workflow does not borrow unrelated profile defaults as actual parameters',()=>{
  assert.equal(imageInfoParameterMarkup({source:'comfy',width:512,height:768,seed:0,steps:20,cfg:7,sampler:'euler'}, {payload:{parameters:{workflow:{},width:'',height:'',steps:'',scale:'',seed:'',sampler:''}}}), '');
  assert.match(imageInfoParameterMarkup({seed:0}),/<dd>0<\/dd>/);
});
for(const mode of ['success','cancel','save-failure','chat-change','account-change'])test('image deletion '+mode+' preserves original ownership and only removes the selected variant',async()=>{
  const record={id:'a',floor:1},other={id:'b'},store={storyboardImages:[record,other]};let active=store,chat='original',verified=0;
  const calls=[],c=vm.createContext({storyboardAdmissionEpoch:1,confirmDialog:async()=>mode!=='cancel',getChatStore:()=>active,getChatKey:()=>chat,
    saveMetadata:async()=>{calls.push('save');if(mode==='save-failure')throw Error('save failed');if(mode==='chat-change'){active={storyboardImages:[{id:'a'}]};chat='new';}if(mode==='account-change')c.storyboardAdmissionEpoch++;},
    storyboardGallerySelection:{delete:id=>calls.push('selection:'+id)},storyboardDeleteRecordSnapshots:row=>calls.push('snapshot:'+row.id),storyboardRenderInlineImages:()=>calls.push('render'),rerenderIfOpen:()=>calls.push('view')});
  vm.runInContext(fn('storyboardRemoveImage'),c);
  const operation=c.storyboardRemoveImage(record,async()=>{verified++;});
  if(mode==='save-failure')await assert.rejects(operation,/save failed/);else assert.equal(await operation,mode!=='cancel');
  assert.equal(verified,mode==='cancel'?0:1);
  assert.deepEqual(store.storyboardImages,['cancel','save-failure'].includes(mode)?[record,other]:[other]);
  assert.deepEqual(calls,mode==='success'?['save','selection:a','snapshot:a','render','view']:mode==='cancel'?[]:['save']);
  if(mode==='chat-change')assert.equal(active.storyboardImages[0].id,'a');
});
