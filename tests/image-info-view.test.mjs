import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {renderImageInfo} from '../qianmu-image-info-view.js';
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
  assert.match(html,/fa-ellipsis/);assert.match(html,/sd-image-info-collection-editor" hidden/);
  assert.doesNotMatch(html,/重新生成|查看本段全部静帧|原图与重绘工具|<details[^>]*sd-image-info-prompt/);
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
