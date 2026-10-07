import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as utils from '../qianmu-storyboard-utils.js';
import * as sources from '../qianmu-st-context-sources.js';
const index = await readFile(new URL('../index.js',import.meta.url),'utf8');
function source(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`,'m').exec(index);
  assert.ok(match,`actual function ${name}`);
  const tail=index.slice(match.index), end=tail.indexOf('\n}');
  return tail.slice(0,end+2);
}
function fixture() {
  const calls = [], state = {chatKey:'chat-A', selected:'Host', saved:0};
  const order = (rows) => [{character_id:100001,order:rows.map(([identifier,enabled])=>({identifier,enabled}))}];
  const presets = {
    Host:{prompts:[{identifier:'host',content:'HOST_NOT_SELECTED'}],prompt_order:order([['host',true]])},
    Dedicated:{prompts:[{identifier:'on',content:'DEDICATED_ON'},{identifier:'off',content:'DEDICATED_OFF'},{identifier:'unlisted',content:'UNLISTED'}],prompt_order:order([['on',true],['off',false]])},
    Hidden:{prompts:[{identifier:'other',content:'HIDDEN_OTHER'}],prompt_order:order([['other',true]])},
  };
  const books = {
    Bound:{entries:{0:{uid:0,content:'BOUND_NOT_SELECTED'}}},
    Book:{entries:{0:{uid:0,content:'BOOK_ON'},1:{uid:1,disable:true,content:'BOOK_OFF'},2:{uid:2,content:'BOOK_UNCHECKED'}}},
    Global:{entries:{0:{uid:0,content:'GLOBAL_ON'}}},
  };
  const context = {chat:[],characters:[{data:{extensions:{world:'Bound'}}}],characterId:0,
    chatCompletionSettings:presets.Host,
    getPresetManager:()=>({getSelectedPresetName:()=>state.selected,getAllPresets:()=>Object.keys(presets),getCompletionPresetByName:name=>{calls.push(['preset',name]);return presets[name];}}),
    getWorldInfoNames:()=>Object.keys(books),loadWorldInfo:async name=>{calls.push(['book',name]);return books[name];}};
  const settings = {selectedPresetNames:{},selectedPresetItems:{},selectedWorldBookNamesByChat:{},selectedWorldBookItemsByChat:{},globalWorldBookNames:{},
    contextOptions:{includeChatHistory:true,contextDepth:5},contextBudget:0,systemPrompt:'OWN_SYSTEM'};
  const cache = {presets:{},worldBooks:{},presetNames:[],worldBookNames:[]};
  const store = {blueprint:'OWN_BLUEPRINT'};
  const c = vm.createContext({...utils,...sources,structuredClone,settings,contextScanCache:cache,ctx:()=>context,getChatKey:()=>state.chatKey,
    saveSettings:()=>state.saved++,rerenderIfOpen:()=>{},toast:()=>{},resolveMacro:async text=>text,cleanContextText:text=>String(text||''),
    getCharacterName:()=> 'CHAR',getPersonaName:()=> 'USER',getCharacterDescription:()=> 'CHAR_DESCRIPTION',getPersonaDescription:()=> 'USER_DESCRIPTION',
    prepareDirectorMemoryHost:async()=>{},directorSourceFingerprint:()=> 'unchanged',getChatStore:()=>store,
    directorMemorySnapshot:()=>({text:'',status:'empty'}),selectCreativeOptions:()=>({}),creativeSectionGuidance:()=> 'SECTION_GUIDANCE',createCreativeSchema:()=> 'SCHEMA',
    JSON_SCHEMA_TEXT:'SCHEMA',DEFAULT_SYSTEM_PROMPT:'OWN_SYSTEM',DEFAULT_BLUEPRINT:'OWN_BLUEPRINT',estimateTokens:text=>String(text).length,
    htmlEscape:text=>String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
  });
  const names=['getCurrentPresetName','getPresetEntries','listPresetNames','getWorldBookEntries','listWorldBooks','detectBoundWorldBookNames',
    'refreshPresets','refreshWorldBooks','getPresetNameStore','getPresetSelectionStore','getWorldNameStore','getWorldSelectionStore',
    'getSelectedPresetNames','setPresetNameSelected','getGlobalWorldBookStore','setWorldBookGlobal','getSelectedWorldBookNames','setWorldBookNameSelected',
    'isPresetItemSelected','setPresetItemSelected','isWorldItemSelected','setWorldItemSelected','getContextItemId','getContextSelectionReviewStore',
    'contextSourceNeedsSelectionReview','confirmContextSourceSelection','renderContextSelectionReview','initializeSelectedContextState',
    'resolvePresetMarker','buildPresetContextText','buildWorldContextText','directorHistorySelection','buildPrompt'];
  vm.runInContext(names.map(source).join('\n'),c);
  return {c,settings,cache,context,state,calls,presets,books,json:value=>JSON.parse(JSON.stringify(value))};
}

test('empty dedicated material selection never implicitly opts into active ST presets or bound worldbooks',async()=>{
  const f=fixture(), prompt=await f.c.buildPrompt();
  assert.doesNotMatch(prompt,/HOST_NOT_SELECTED|BOUND_NOT_SELECTED|DEDICATED|BOOK_ON/);
  assert.match(prompt,/CHAR_DESCRIPTION/);assert.match(prompt,/USER_DESCRIPTION/);
  assert.deepEqual(f.json(f.settings.selectedPresetNames),{});
  assert.deepEqual(f.json(f.settings.selectedWorldBookNamesByChat['chat-A']),{});
  assert.deepEqual(f.calls,[]);
});

test('actual full prompt includes only the chosen preset and its enabled dedicated entries plus chosen book entries',async()=>{
  const f=fixture(); f.c.setPresetNameSelected('Dedicated',true);await f.c.setWorldBookNameSelected('Book',true);
  f.c.setWorldItemSelected('Book',2,false);
  const prompt=await f.c.buildPrompt();
  assert.match(prompt,/DEDICATED_ON/);assert.match(prompt,/BOOK_ON/);
  assert.doesNotMatch(prompt,/DEDICATED_OFF|UNLISTED|HOST_NOT_SELECTED|HIDDEN_OTHER|BOUND_NOT_SELECTED|BOOK_OFF|BOOK_UNCHECKED|GLOBAL_ON/);
  assert.equal(f.calls.some(([kind,name])=>name==='Host'||name==='Hidden'||name==='Bound'),false);
});

test('million-character disabled inventory is excluded instead of bloating the assembled request',async()=>{
  const f=fixture();f.presets.Dedicated.prompts[1].content='EXCLUDED_DISABLED '.repeat(90000);
  f.c.setPresetNameSelected('Dedicated',true);
  const prompt=await f.c.buildPrompt();
  assert.ok(prompt.length<4000);assert.doesNotMatch(prompt,/EXCLUDED_DISABLED/);assert.match(prompt,/DEDICATED_ON/);
});

test('switching ST active preset does not add material or alter the independent picker choice',async()=>{
  const f=fixture();f.c.setPresetNameSelected('Dedicated',true);
  await f.c.buildPrompt();f.state.selected='Hidden';f.context.chatCompletionSettings=f.presets.Hidden;
  await f.c.refreshPresets(false);
  const prompt=await f.c.buildPrompt();assert.match(prompt,/DEDICATED_ON/);assert.doesNotMatch(prompt,/HIDDEN_OTHER|HOST_NOT_SELECTED/);
  assert.deepEqual(f.json(f.c.getSelectedPresetNames()),['Dedicated']);
});

test('legacy hidden multi-selections match the one displayed source and choosing none clears every hidden true',async()=>{
  const f=fixture();f.settings.selectedPresetNames={Deleted:true,Dedicated:true,Hidden:true,Host:true};
  let prompt=await f.c.buildPrompt();assert.match(prompt,/DEDICATED_ON/);assert.doesNotMatch(prompt,/HIDDEN_OTHER|HOST_NOT_SELECTED/);
  f.c.setPresetNameSelected('',true);prompt=await f.c.buildPrompt();assert.doesNotMatch(prompt,/DEDICATED_ON|HIDDEN_OTHER|HOST_NOT_SELECTED/);
  assert.ok(Object.values(f.settings.selectedPresetNames).every(value=>value===false));
  f.c.setPresetNameSelected('Hidden',true);assert.deepEqual(f.json(f.c.getSelectedPresetNames()),['Hidden']);
});

test('only an ambiguous old group requires a one-time review and preserves every previous checkbox',async()=>{
  const f=fixture();f.settings.selectedPresetNames.Dedicated=true;
  f.settings.selectedPresetItems.Dedicated={on:true,off:true,unlisted:false};
  await assert.rejects(f.c.buildPrompt(),/旧版条目开关需核对一次/);
  assert.deepEqual(f.json(f.settings.selectedPresetItems.Dedicated),{on:true,off:true,unlisted:false});
  assert.match(f.c.renderContextSelectionReview('preset','Dedicated',f.cache.presets.Dedicated),/确认当前选择/);
  f.c.confirmContextSourceSelection('preset','Dedicated');
  let prompt=await f.c.buildPrompt();assert.match(prompt,/DEDICATED_ON/);assert.match(prompt,/DEDICATED_OFF/);
  f.c.setPresetItemSelected('Dedicated','off',false);prompt=await f.c.buildPrompt();assert.doesNotMatch(prompt,/DEDICATED_OFF/);
  // Reopen and reread ST: the confirmed Qianmu override remains its own source of truth.
  f.c.setPresetItemSelected('Dedicated','off',true);await f.c.refreshPresets(false);
  assert.match(await f.c.buildPrompt(),/DEDICATED_OFF/);
  assert.equal(f.c.renderContextSelectionReview('preset','Dedicated',f.cache.presets.Dedicated),'');
  f.c.settings=JSON.parse(JSON.stringify(f.settings));
  assert.match(await f.c.buildPrompt(),/DEDICATED_OFF/);
  assert.equal(f.c.renderContextSelectionReview('preset','Dedicated',f.cache.presets.Dedicated),'');
});

test('safe old selections and explicit post-import overrides need no review and never mutate host switches',async()=>{
  const f=fixture();f.settings.selectedPresetNames.Dedicated=true;f.settings.selectedPresetItems.Dedicated={on:true,off:false,unlisted:false};
  await f.c.buildPrompt();assert.equal(f.c.contextSourceNeedsSelectionReview('preset','Dedicated',f.cache.presets.Dedicated),false);
  f.c.setPresetItemSelected('Dedicated','off',true);assert.match(await f.c.buildPrompt(),/DEDICATED_OFF/);
  assert.equal(f.presets.Dedicated.prompt_order[0].order[1].enabled,false);
});

test('deselecting an ambiguous legacy source immediately removes its request blocker without clearing choices',async()=>{
  const f=fixture();f.settings.selectedPresetNames.Dedicated=true;f.settings.selectedPresetItems.Dedicated={on:true,off:true};
  await assert.rejects(f.c.buildPrompt(),/旧版条目开关/);
  f.c.setPresetNameSelected('',true);assert.doesNotMatch(await f.c.buildPrompt(),/DEDICATED/);
  assert.equal(f.settings.selectedPresetItems.Dedicated.off,true);
});

test('worldbook review and selections stay chat-scoped, with user-selected global books and local opt-outs respected',async()=>{
  const f=fixture();f.settings.selectedWorldBookNamesByChat['chat-A']={Book:true};
  f.settings.selectedWorldBookItemsByChat['chat-A']={Book:{0:true,1:true,2:false}};
  await assert.rejects(f.c.buildPrompt(),/世界书「Book」.*旧版条目/);
  f.c.confirmContextSourceSelection('world','Book');assert.match(await f.c.buildPrompt(),/BOOK_OFF/);
  f.c.setWorldItemSelected('Book',1,false);assert.doesNotMatch(await f.c.buildPrompt(),/BOOK_OFF/);
  f.c.setWorldBookGlobal('Global',true);await f.c.refreshWorldBooks(false);assert.match(await f.c.buildPrompt(),/GLOBAL_ON/);
  await f.c.setWorldBookNameSelected('Global',false);assert.doesNotMatch(await f.c.buildPrompt(),/GLOBAL_ON/);
  f.state.chatKey='chat-B';await f.c.refreshWorldBooks(false);
  const next=await f.c.buildPrompt();assert.match(next,/GLOBAL_ON/);assert.doesNotMatch(next,/BOOK_ON|BOOK_OFF|BOUND_NOT_SELECTED/);
  assert.equal(f.settings.contextSourceSelectionReviews.worldBooks['chat-B'].Book,undefined);
});

test('preset world markers cannot resurrect an unselected bound worldbook',async()=>{
  const f=fixture();f.presets.Dedicated.prompts.push({identifier:'worldInfoBefore',marker:true});
  f.presets.Dedicated.prompt_order[0].order.push({identifier:'worldInfoBefore',enabled:true});
  f.c.setPresetNameSelected('Dedicated',true);
  assert.doesNotMatch(await f.c.buildPrompt(),/BOUND_NOT_SELECTED/);
  assert.equal(f.calls.some(([kind,name])=>kind==='book'&&name==='Bound'),false);
});

test('later host additions stay unselected rather than silently expanding a previously imported source',async()=>{
  const f=fixture();f.c.setPresetNameSelected('Dedicated',true);await f.c.setWorldBookNameSelected('Book',true);
  await f.c.buildPrompt();
  f.presets.Dedicated.prompts.push({identifier:'new',content:'NEW_HOST_PROMPT'});
  f.presets.Dedicated.prompt_order[0].order.push({identifier:'new',enabled:true});
  f.books.Book.entries[3]={uid:3,content:'NEW_HOST_WORLD'};
  await f.c.refreshPresets(false);await f.c.refreshWorldBooks(false);
  assert.doesNotMatch(await f.c.buildPrompt(),/NEW_HOST_PROMPT|NEW_HOST_WORLD/);
  assert.equal(f.settings.selectedPresetItems.Dedicated.new,false);
  assert.equal(f.settings.selectedWorldBookItemsByChat['chat-A'].Book[3],false);
  f.c.setPresetItemSelected('Dedicated','new',true);f.c.setWorldItemSelected('Book',3,true);
  const prompt=await f.c.buildPrompt();assert.match(prompt,/NEW_HOST_PROMPT/);assert.match(prompt,/NEW_HOST_WORLD/);
});

test('empty or partial preset reads cannot silently approve a legacy selected identifier that later returns disabled',async()=>{
  for (const partial of [false,true]) {
    const f=fixture(),original=f.presets.Dedicated;
    f.settings.selectedPresetNames.Dedicated=true;
    f.settings.selectedPresetItems.Dedicated={on:true,off:true};
    f.presets.Dedicated=partial ? {prompts:[original.prompts[0]],prompt_order:original.prompt_order} : {prompts:[]};
    await f.c.refreshPresets(false);
    assert.equal(f.settings.contextSourceSelectionReviews?.presets?.Dedicated,undefined);
    assert.equal(f.settings.selectedPresetItems.Dedicated.off,true);
    f.presets.Dedicated=original;await f.c.refreshPresets(false);
    await assert.rejects(f.c.buildPrompt(),/旧版条目开关需核对一次/);
    assert.match(f.c.renderContextSelectionReview('preset','Dedicated',f.cache.presets.Dedicated),/确认当前选择/);
  }
});

test('empty or partial world reads cannot silently approve a legacy selected identifier that later returns disabled',async()=>{
  for (const partial of [false,true]) {
    const f=fixture(),original=f.books.Book;
    f.settings.selectedWorldBookNamesByChat['chat-A']={Book:true};
    f.settings.selectedWorldBookItemsByChat['chat-A']={Book:{0:true,1:true}};
    f.books.Book=partial ? {entries:{0:original.entries[0]}} : {entries:{}};
    await f.c.refreshWorldBooks(false);
    assert.equal(f.settings.contextSourceSelectionReviews?.worldBooks?.['chat-A']?.Book,undefined);
    assert.equal(f.settings.selectedWorldBookItemsByChat['chat-A'].Book[1],true);
    f.books.Book=original;await f.c.refreshWorldBooks(false);
    await assert.rejects(f.c.buildPrompt(),/旧版条目开关需核对一次/);
    assert.match(f.c.renderContextSelectionReview('world','Book',f.cache.worldBooks.Book),/确认当前选择/);
  }
});

test('confirmation covers only visible preset IDs, not another old selected ID that was missing',async()=>{
  for (const restoredEnabled of [false,true]) {
    const f=fixture();f.settings.selectedPresetNames.Dedicated=true;
    f.settings.selectedPresetItems.Dedicated={on:true,off:true,later:true};
    await f.c.refreshPresets(false);await assert.rejects(f.c.buildPrompt(),/旧版条目开关/);
    f.c.confirmContextSourceSelection('preset','Dedicated');
    assert.match(await f.c.buildPrompt(),/DEDICATED_OFF/);
    assert.equal(f.settings.selectedPresetItems.Dedicated.later,true);
    assert.deepEqual(f.json(f.settings.contextSourceSelectionReviews.presets.Dedicated),['on','off','unlisted']);
    f.presets.Dedicated.prompts.push({identifier:'later',content:'RETURNED_PRESET'});
    f.presets.Dedicated.prompt_order[0].order.push({identifier:'later',enabled:restoredEnabled});
    await f.c.refreshPresets(false);await assert.rejects(f.c.buildPrompt(),/旧版条目开关/);
    f.c.setPresetItemSelected('Dedicated','later',false);assert.doesNotMatch(await f.c.buildPrompt(),/RETURNED_PRESET/);
    f.c.setPresetItemSelected('Dedicated','later',true);await assert.rejects(f.c.buildPrompt(),/旧版条目开关/);
    f.c.confirmContextSourceSelection('preset','Dedicated');assert.match(await f.c.buildPrompt(),/RETURNED_PRESET/);
  }
});

test('confirmation covers only visible world IDs and survives reload without approving a missing old selection',async()=>{
  const f=fixture();f.settings.selectedWorldBookNamesByChat['chat-A']={Book:true};
  f.settings.selectedWorldBookItemsByChat['chat-A']={Book:{0:true,1:true,9:true}};
  await f.c.refreshWorldBooks(false);await assert.rejects(f.c.buildPrompt(),/旧版条目开关/);
  f.c.confirmContextSourceSelection('world','Book');assert.match(await f.c.buildPrompt(),/BOOK_OFF/);
  assert.equal(f.settings.selectedWorldBookItemsByChat['chat-A'].Book[9],true);
  f.c.settings=JSON.parse(JSON.stringify(f.settings));
  f.books.Book.entries[9]={uid:9,disable:true,content:'RETURNED_WORLD'};
  await f.c.refreshWorldBooks(false);await assert.rejects(f.c.buildPrompt(),/旧版条目开关/);
  f.c.setWorldItemSelected('Book',9,false);assert.doesNotMatch(await f.c.buildPrompt(),/RETURNED_WORLD/);
  f.c.setWorldItemSelected('Book',9,true);await assert.rejects(f.c.buildPrompt(),/旧版条目开关/);
  f.c.confirmContextSourceSelection('world','Book');assert.match(await f.c.buildPrompt(),/RETURNED_WORLD/);
});
