import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as storyboard from '../qianmu-storyboard.js';
import {projectNewComfyExecution} from '../qianmu-comfy-new-execution.js';
import {renderComfyLibrary,createComfyLibraryController} from '../qianmu-comfy-library-view.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const document={workflow:JSON.stringify({save:{class_type:'SaveImage',inputs:{text:'%qianmu_prompt%'}}}),outputNodeId:'save',parameters:{width:'832',height:'1216'},positivePrompt:'prefix',negativePrompt:'exclusion'};
test('classification editor uses accessible multi-selects and does not classify old documents by rendering',()=>{
  const before=structuredClone(document),html=renderComfyLibrary({draft:{name:'old',document}});
  for(const group of ['visualKinds','castSizes','narrativeLayers','contentClasses'])assert.match(html,new RegExp(`data-comfy-class-group="${group}"`));
  assert.equal((html.match(/data-comfy-class-choice=/g)||[]).length,15);assert.doesNotMatch(html,/aria-pressed="true"/);
  assert.match(html,/data-comfy-class-field="maxSubjects" value=""/);assert.match(html,/data-comfy-action="clear-classification"[^>]+disabled/);
  assert.deepEqual(document,before);assert.doesNotMatch(html,/data-comfy-action="(?:generate|enable-auto)"/);
});
test('classification list uses safe light metadata while draft preserves format and zero limit',()=>{
  const classification={version:1,visualKinds:['object'],castSizes:['none'],contentClasses:['sfw'],promptFormat:'natural_language',maxSubjects:0};
  const html=renderComfyLibrary({rows:[{id:'a',name:'x',version:1,nodes:2,totalBytes:1,classification}]});
  assert.match(html,/sd-comfy-classification-badges/);assert.match(html,/人物 ≤ 0/);assert.doesNotMatch(html,/API Workflow JSON/);
  const draft=renderComfyLibrary({draft:{name:'x',document:{...document,classification}}});
  assert.match(draft,/data-comfy-class-choice="object" aria-pressed="true"/);assert.match(draft,/value="natural_language" selected/);
  assert.match(draft,/data-comfy-class-field="maxSubjects" value="0"/);
  const invalid=renderComfyLibrary({rows:[{id:'a',name:'x',version:1,nodes:2,totalBytes:1,classification:{version:1,visualKinds:['<script>']}}]});
  assert.match(invalid,/分类待核对/);assert.doesNotMatch(invalid,/<script>/);
});
test('invalid numeric draft remains editable after save rejection',()=>{
  const html=renderComfyLibrary({draft:{name:'x',document:{...document,classification:{version:1,maxSubjects:13}}}});
  assert.match(html,/人物上限|可见人物上限/);assert.match(html,/data-comfy-class-field="maxSubjects" value="13"/);
  assert.match(html,/data-comfy-class-choice="one"/);
});
test('library list is metadata-only, escaped and blank without fabricated placeholder cards',()=>{
  const empty=renderComfyLibrary({rows:[]});assert.doesNotMatch(empty,/sd-comfy-library-row"|暂无|API Workflow JSON/);
  const html=renderComfyLibrary({rows:[{id:'a',name:'<script>bad</script>',version:1,nodes:4,totalBytes:100}]});
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/data-comfy-action="apply"/);assert.doesNotMatch(html,/data-comfy-action="purge"/);
});
test('full editor retains missing output, exposes history and separates saving from applying',()=>{
  const html=renderComfyLibrary({draft:{name:'x',revision:'r1',version:1,document:{...document,outputNodeId:'missing'},versions:[{revision:'r1',version:1,updatedAt:1}]}});
  assert.match(html,/value="missing" selected/);assert.match(html,/data-comfy-version/);assert.match(html,/data-comfy-action="save-copy"/);assert.doesNotMatch(html,/data-comfy-action="apply"/);
  assert.doesNotMatch(html,/提示补充|data-comfy-draft="(?:positivePrompt|negativePrompt)"/);
});

test('new saved revisions omit retired additions while draft export and the source document remain intact',async()=>{
  for(const saveAction of ['save','save-copy']){
    const original=structuredClone(document),saved=[],downloads=[];let applied=0;
    const buttons=Object.fromEntries(['from-current','export-draft',saveAction].map(action=>[action,{dataset:{comfyAction:action},addEventListener(_name,handler){this.click=handler;},closest:()=>null}]));
    const host={isConnected:true,innerHTML:'',closest:()=>null,querySelector:()=>null,querySelectorAll:selector=>selector==='[data-comfy-action]'?Object.values(buttons):[]};
    const store={list:async()=>[],usage:async()=>({count:0,versions:0,bytes:0,limit:10000}),save:async(_namespace,row)=>saved.push(structuredClone(row)),close(){}};
    const controller=createComfyLibraryController({store,resolveNamespace:async()=> 'st-user:test',getCurrentRecipe:()=>({name:'legacy',document}),download:blob=>downloads.push(blob),onApply:()=>{applied++;}});
    const flush=async()=>{for(let turn=0;turn<6;turn++)await new Promise(resolve=>setImmediate(resolve));};
    try{
      controller.mount(host);await flush();buttons['from-current'].click();await flush();
      assert.doesNotMatch(host.innerHTML,/data-comfy-draft="positivePrompt"/);
      buttons['export-draft'].click();await flush();assert.equal(downloads.length,1);
      const exported=await downloads[0].text();assert.match(exported,/prefix/);assert.match(exported,/exclusion/);
      buttons[saveAction].click();await flush();assert.equal(saved.length,1);
      assert.deepEqual(saved[0].document,{...original,positivePrompt:'',negativePrompt:''});
      assert.deepEqual(document,original);assert.equal(applied,0,'save is not apply');
    }finally{controller.dispose();}
  }
});
test('archived schemes expose explicit recovery/export/purge, not generation',()=>{
  const html=renderComfyLibrary({archived:true,rows:[{id:'a',name:'x',nodes:1,version:1,totalBytes:100}]});
  for(const action of ['restore','export','purge'])assert.ok(html.includes(`data-comfy-action="${action}"`));assert.doesNotMatch(html,/data-comfy-action="apply"/);
});
test('applying a recipe retires active role routing without rewriting saved additions, references or queued data',async()=>{
  const state=storyboard.createStoryboardDefaults();state.source='comfy';state.view='workflows';const connections=structuredClone(state.connections),other=structuredClone(state.profiles.novel),queued=structuredClone(state.profiles.comfy);
  Object.assign(state.profiles.comfy,{comfyInstanceType:'ultra',comfyCharacterEnabled:true,comfyCharacterActivation:{legacy:true},comfyReferences:{enabled:true,items:[{id:'reference'}]}});
  state.promptDefaults['comfy:legacy']={positive:'keep old default',negative:'keep old exclusion'};
  const original=state.profiles.comfy,before=structuredClone(original),defaults=structuredClone(state.promptDefaults),source=structuredClone(document);
  const root={isConnected:true},notices=[],routes=[];const context=vm.createContext({...storyboard,projectNewComfyExecution,storyboardState:()=>state,clone:structuredClone,storyboardAdmissionEpoch:1,getChatKey:()=> 'chat-a',
    featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=> 'st-user:test'}:{pinComfyRouteWorkflow:async({guard,selection})=>{await guard();return {binding:{...selection,name:'versioned'},document};}}},
    storyboardNavigate:(node,patch)=>{assert.equal(node,root);routes.push(patch);state.view=patch.view;},toast:message=>notices.push(message)});
  vm.runInContext(['storyboardPromptDefaultsKey','storyboardRememberPromptLayer','storyboardApplyComfyLibraryRecipe'].map(section).join('\n'),context);
  await context.storyboardApplyComfyLibraryRecipe(root,state,{namespace:'st-user:test',id:'a',revision:'b',name:'versioned',version:2,document});
  assert.equal(state.profiles.comfy.comfyWorkflow,document.workflow);assert.equal(state.profiles.comfy.width,'832');assert.equal(state.comfyLibrarySelection.version,2);
  assert.deepEqual(state.connections,connections);assert.deepEqual(state.profiles.novel,other);assert.equal(queued.comfyWorkflow,'');assert.equal(routes.length,1);assert.equal(notices.length,1);
  assert.equal(state.profiles.comfy.comfyCharacterEnabled,false);assert.equal(state.profiles.comfy.comfyCharacterActivation,undefined);
  assert.equal(Object.hasOwn(state.profiles.comfy,'comfyInstanceType'),false,'an old applied document cannot inherit the previous RH tier');
  assert.deepEqual(state.profiles.comfy.comfyReferences,before.comfyReferences);assert.deepEqual(original,before);
  assert.deepEqual(state.promptDefaults,defaults);assert.deepEqual(document,source);
  await assert.rejects(()=>context.storyboardApplyComfyLibraryRecipe(root,state,{document}),/已切换/);
});
test('saved-version apply carries the verified account and rejects a late account or page switch',async()=>{
  for(const change of ['none','account','page']){
    const row={id:'one',revision:'r1',name:'old',version:1},applied=[],notices=[];let account='st-user:test',loads=0;
    const buttons=Object.fromEntries(['edit','apply-version'].map(action=>[action,{dataset:{comfyAction:action},addEventListener(_name,handler){this.click=handler;},closest:()=>action==='edit'?{dataset:{comfyId:row.id}}:null}]));
    const host={isConnected:true,innerHTML:'',closest:()=>null,querySelector:()=>null,querySelectorAll:selector=>selector==='[data-comfy-action]'?Object.values(buttons):[]};
    const store={list:async()=>[row],usage:async()=>({count:1,versions:1,bytes:100,limit:10000}),versions:async()=>[row],close(){},
      load:async()=>{if(++loads===2){if(change==='account')account='st-user:other';if(change==='page')host.isConnected=false;}return structuredClone(document);}};
    const controller=createComfyLibraryController({store,resolveNamespace:async()=>account,onApply:value=>applied.push(value),notify:message=>notices.push(message)});
    const flush=async()=>{for(let n=0;n<6;n++)await new Promise(resolve=>setImmediate(resolve));};
    try{
      controller.mount(host);await flush();buttons.edit.click();await flush();buttons['apply-version'].click();await flush();
      assert.equal(loads,2);assert.equal(applied.length,change==='none'?1:0);
      if(change==='none')assert.deepEqual(applied[0],{namespace:'st-user:test',...row,document});
      if(change==='account')assert.match(notices.join(' '),/账户已切换/);
    }finally{controller.dispose();}
  }
});

test('workflow route and selection survive reload without library documents in settings',()=>{
  const state=storyboard.createStoryboardDefaults();state.source='comfy';state.view='workflows';state.comfyLibrarySelection={id:'a',revision:'b',name:'x',version:2,workflow:'not-index-data'};
  const restored=storyboard.normalizeStoryboardState(state);assert.equal(restored.view,'workflows');assert.equal(restored.comfyLibrarySelection.version,2);assert.ok(!Object.hasOwn(restored.comfyLibrarySelection,'workflow'));
  restored.source='novel';assert.equal(storyboard.normalizeStoryboardState(restored).view,'create');
});
test('library and its document store are shipped lazily, and the existing legacy DB is unchanged',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  assert.ok(source.includes("load: () => import('./qianmu-comfy-library-view.js?v="));
  for(const file of ['qianmu-comfy-library.js','qianmu-comfy-library-view.js'])assert.ok(release.files.includes(file));
  const module=await readFile(new URL('../qianmu-comfy-library.js',import.meta.url),'utf8');assert.doesNotMatch(module,/qianmu-blobstore|fetch\(|\.generate\(/);
});
