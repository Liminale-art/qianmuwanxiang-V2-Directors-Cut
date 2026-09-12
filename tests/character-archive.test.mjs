import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as archive from '../qianmu-character-archive.js';
import {createCharacterArchiveStore} from '../qianmu-character-archive-store.js';
import {renderCharacterArchive,saveCharacterReference,createCharacterArchiveController} from '../qianmu-character-archive-view.js';
import {implementation} from './helpers/comfy-character-fixture.mjs';
import {LUCIDE_GLYPH_NAMES} from '../qianmu-icon-renderer.js';
import {normalizeStoryboardState} from '../qianmu-storyboard.js';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
const document=()=>({...archive.newCharacterArchive('char'),name:'Alice',aliases:['Al','阿莉'],imagegen:{appearance:'black hair',negative:'',sensitiveAppearance:'private field',reference:null}});

test('retired character workflow editors are absent without erasing old archive data',()=>{
  const doc={...document(),comfy:{version:1,implementations:[implementation]}},before=structuredClone(doc);
  const html=renderCharacterArchive({draft:{id:'alice',document:doc},rows:[],bindings:[],subjects:[]});
  assert.doesNotMatch(html,/Comfy 实现|data-archive-action="comfy-|绑定当前 Comfy 方案/);
  assert.match(html,/data-archive-field="appearance"/);assert.match(html,/data-archive-image/);
  assert.deepEqual(doc,before);
});

test('editing an existing archive preserves legacy fields, copying it does not create new workflow bindings',async()=>{
  const doc=archive.normalizeCharacterArchive({...document(),comfy:{version:1,implementations:[implementation]}}),original=structuredClone(doc),saved=[];
  const head={id:'alice',revision:'revision-a',version:1,category:'char',name:'Alice'},events={preventDefault(){},stopPropagation(){}};
  const buttons=Object.fromEntries(['edit','copy','save','comfy-new'].map(action=>[action,{dataset:{archiveAction:action,archiveId:'alice'},addEventListener(_name,handler){this.click=()=>handler(events);}}]));
  const field={dataset:{archiveField:'name'},value:'Alice revised',addEventListener(_name,handler){this.input=handler;}};
  const host={isConnected:true,innerHTML:'',closest:()=>null,querySelector:()=>null,querySelectorAll:selector=>selector==='[data-archive-action]'?Object.values(buttons):selector==='[data-archive-field]'?[field]:[]};
  const store={list:async()=>[head],bindings:async()=>[],load:async()=>({head,document:doc}),save:async(_namespace,row)=>saved.push(structuredClone(row)),close(){}};
  const notices=[],controller=createCharacterArchiveController({store,resolveNamespace:async()=> 'st-user:test',getContext:async()=>({chatKey:'chat-a',subjects:[]}),notify:(message,kind)=>notices.push({message,kind})});
  const flush=async()=>{for(let turn=0;turn<6;turn++)await new Promise(resolve=>setImmediate(resolve));};
  try{
    controller.mount(host);await flush();buttons.edit.click();await flush();
    buttons['comfy-new'].click();await flush();assert.equal(saved.length,0);
    field.input();buttons.save.click();await flush();assert.equal(saved.length,1);
    assert.equal(saved[0].id,'alice');assert.equal(saved[0].document.name,'Alice revised');assert.deepEqual(saved[0].document.comfy,original.comfy);
    buttons.edit.click();await flush();buttons.copy.click();await flush();buttons.save.click();await flush();
    assert.equal(saved.length,2);assert.equal(saved[1].id,'');assert.equal(saved[1].document.comfy,undefined);
    assert.equal(saved[1].document.imagegen.appearance,original.imagegen.appearance);
    assert.equal(notices.filter(row=>row.kind==='warning').length,0);assert.deepEqual(doc,original);
  }finally{controller.dispose();}
});

test('new character schema isolates appearance, sensitive fields and explicit references from connection data',()=>{
  const raw={...document(),apiKey:'secret',imagegen:{...document().imagegen,apiKey:'secret'}};
  const clean=archive.normalizeCharacterArchive(raw);assert.equal(clean.imagegen.sensitiveAppearance,'private field');assert.doesNotMatch(JSON.stringify(clean),/apiKey|secret/);
  const projected=archive.characterIdentityProjection('stable-id',2,raw);assert.equal(projected.subjectId,'archive:stable-id');assert.equal(projected.archiveVersion,2);assert.doesNotMatch(JSON.stringify(projected),/private field|negative|reference/);
});
test('archive schema rejects malformed, oversized or unknown documents rather than truncating appearance',()=>{
  for(const value of [null,{}, {...document(),schema:'future'}, {...document(),category:'cast'}, {...document(),name:''}, {...document(),name:'a'.repeat(81)}, {...document(),aliases:Array(25).fill('a')}, {...document(),imagegen:{appearance:'a'.repeat(12001)}}])assert.throws(()=>archive.normalizeCharacterArchive(value));
  assert.throws(()=>archive.normalizeCharacterArchive({...document(),imagegen:{reference:{url:'https://external.test/a.png'}}}));
});
test('export/import is a copy with explicit reference omission and no authority over another ST file',()=>{
  const raw=document();raw.imagegen.reference={url:'/user/images/ref.png',name:'ref',sha256:'a'.repeat(64),bytes:70,mime:'image/png'};
  const exported=archive.exportCharacterArchive(raw);assert.equal(exported.referenceOmitted,true);assert.equal(exported.document.imagegen.reference,null);assert.ok(raw.imagegen.reference);
  const imported=archive.importCharacterArchive(JSON.stringify(exported));assert.equal(imported.document.name,'Alice');assert.equal(imported.referenceOmitted,true);
  assert.throws(()=>archive.importCharacterArchive('{'));assert.throws(()=>archive.importCharacterArchive(' '.repeat(128*1024+1)));
});
test('chat-level unbound deliberately masks defaults; identities and chats never cross match',()=>{
  const subject={category:'char',subjectKey:'char:alice.png'},base={...subject,scope:'default',chatKey:'',archiveId:'default'},chat={...subject,scope:'chat',chatKey:'chat-a',archiveId:''};
  assert.equal(archive.selectCharacterBinding([base,chat],subject,'chat-a'),chat);
  assert.equal(archive.selectCharacterBinding([base,chat],subject,'chat-b'),base);
  assert.equal(archive.selectCharacterBinding([base,chat],{...subject,subjectKey:'char:bob.png'},'chat-a'),null);
  assert.equal(archive.characterBindingTarget({...subject,scope:'default',chatKey:'ignored'}).chatKey,'');
  assert.throws(()=>archive.characterBindingTarget({...subject,scope:'chat',chatKey:''}));
});
test('archive store stays unopened until use and rejects invalid saves/accounts before accessing IndexedDB',async()=>{
  let opens=0;const store=createCharacterArchiveStore({indexedDB:{open(){opens++;throw Error('denied');}}});assert.equal(opens,0);
  await assert.rejects(store.list(''));await assert.rejects(store.save('st-user:alice',{document:{}}));assert.equal(opens,0);
  await assert.rejects(store.list('st-user:alice'));await assert.rejects(store.list('st-user:alice'));assert.equal(opens,2);store.close();
  await assert.rejects(store.list('st-user:alice'));assert.equal(opens,2);
});
test('new archive route and preferences survive legacy character cleanup without reviving old stores',()=>{
  const state=normalizeStoryboardState({view:'characters',characters:[{id:'retired'}],entities:[{id:'retired'}],characterArchive:{schemaVersion:1,collapsed:{char:true},documents:[document()]}});
  assert.equal(state.view,'characters');assert.equal(state.characters,undefined);assert.equal(state.entities,undefined);assert.equal(state.characterArchive.collapsed.char,true);assert.equal(state.characterArchive.documents,undefined);
});
test('library has three categories, escaped content and no sensitive field in browse metadata',()=>{
  const view={rows:[{id:'a',category:'char',name:'<script>x</script>',aliases:[],cover:''}],bindings:[],subjects:[],chatKey:'',collapsed:{},shown:{},search:'',draft:null};
  const html=renderCharacterArchive(view);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('sensitiveAppearance'));
  for(const category of archive.CHARACTER_CATEGORIES)assert.ok(html.includes(`data-category="${category}"`));
  const editor=renderCharacterArchive({...view,draft:{document:document(),id:'a',version:1}});assert.match(editor,/data-archive-image/);assert.match(editor,/data-archive-field="sensitiveAppearance"/);assert.match(editor,/data-archive-field="ageStatus"/);
  for(const [_,name]of (html+editor).matchAll(/data-qm-icon="qm-regular-([^"]+)"/g))assert.ok(LUCIDE_GLYPH_NAMES[name],name);
});
test('thumbnail receipts are tied to the original and never substitute full-size files into list indexes',()=>{
  const raw=document(),reference={url:'/user/images/ref.png',name:'ref',sha256:'a'.repeat(64),bytes:70,mime:'image/png'};
  raw.imagegen={...raw.imagegen,reference,preview:{...reference,url:'/user/images/preview.png',sourceSha256:'b'.repeat(64)}};
  assert.throws(()=>archive.normalizeCharacterArchive(raw));raw.imagegen.preview.sourceSha256=reference.sha256;assert.equal(archive.normalizeCharacterArchive(raw).imagegen.preview.url,'/user/images/preview.png');
  raw.imagegen.preview.bytes=256*1024+1;assert.throws(()=>archive.normalizeCharacterArchive(raw));
});
test('oversized decoded references close bitmap resources and do not write a thumbnail or change a profile',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');let writes=0,closed=0;
  await assert.rejects(saveCharacterReference(new File([png],'ref.png'),{guard:async()=>{},save:async()=>{writes++;return '/user/images/ref.png';},createBitmap:async()=>({width:10000,height:10000,close(){closed++;}})}),/像素过大/);
  assert.equal(closed,1);assert.equal(writes,1);
});
test('actual storyboard navigation places the working character library second',()=>{
  const context=vm.createContext({});vm.runInContext(storyboardFunctionSource('renderStoryboardNav'),context);
  const html=context.renderStoryboardNav({view:'characters'}),routes=[...html.matchAll(/data-storyboard-view="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(routes,['create','characters','assets','gallery','logs']);assert.match(html,/aria-current="page"[^>]+data-storyboard-view="characters"/);
});
test('actual current identity adapter keeps group members separate and never binds by display name',async()=>{
  const data={chatId:'chat-a',groupId:'group',characters:[{avatar:'alice.png',name:'Same'},{avatar:'bob.png',name:'Same'}],groups:[{id:'group',members:['bob.png','alice.png','missing.png']}]};
  const context=vm.createContext({ctx:()=>data,refreshCoreadPersonaAvatar:async()=>{},coreadIdentityAvatar:()=>'/User%20Avatars/persona.png',getPersonaName:()=> 'User',getChatKey:()=>data.chatId});
  vm.runInContext(storyboardFunctionSource('storyboardCharacterArchiveContext'),context);const current=await context.storyboardCharacterArchiveContext();
  assert.equal(current.subjects.length,3);assert.equal(current.subjects[0].subjectKey,'char:bob.png');assert.equal(current.subjects[1].subjectKey,'char:alice.png');assert.equal(current.subjects[2].subjectKey,'user:/User%20Avatars/persona.png');
  context.refreshCoreadPersonaAvatar=async()=>{data.chatId='chat-b';};await assert.rejects(context.storyboardCharacterArchiveContext(),/聊天已切换/);
});
test('archive runtime is lazy and disposed with the main plugin; no separate settings image payload',async()=>{
  const code=await readFile(new URL('../index.js',import.meta.url),'utf8');assert.match(code,/load: \(\) => import\('\.\/qianmu-character-archive-view\.js\?v=/);
  assert.match(storyboardFunctionSource('storyboardEndSession'),/storyboardCharacterArchiveController\?\.detach\(\)/);
  assert.match(code,/storyboardCharacterArchiveController\?\.dispose\(\)/);
});
