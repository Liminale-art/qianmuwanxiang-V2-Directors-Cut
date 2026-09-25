// Isolated, read-only entry-cost fixture. Execute the real index.js
// renderStoryboardTab/reconcile functions against synthetic chat/gallery data.
// This is not a SillyTavern, browser, network, or VPS latency measurement.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {performance} from 'node:perf_hooks';
import {createStoryboardMessageReference,resolveStoryboardMessageReference} from '../qianmu-storyboard.js';

const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
function between(start,end){
  const from=source.indexOf(start),to=source.indexOf(end,from+start.length);
  assert.ok(from>=0&&to>from,`index.js function boundary changed: ${start}`);
  return source.slice(from,to);
}
const reconcileSource=between('function storyboardReconcileGalleryLinks(', '\nfunction storyboardRecordStatus(')
  .replace('function storyboardReconcileGalleryLinks(', 'function realStoryboardReconcileGalleryLinks(');
const renderSource=between('function renderStoryboardTab()', '\nfunction storyboardWorkflowIssue(');

const CHAT_KEY='character-entry-fixture';
const FLOORS=600,RECORDS=48,ROUNDS=3;
const fixture={view:'characters',chat:[],records:[],metrics:null};
fixture.chat=Array.from({length:FLOORS},(_,index)=>({mes:`第 ${index} 层：合成叙事内容，角色在场景中行动。`,name:'Fixture CHAR',is_user:false,swipe_id:0}));
// Count message visits made through the resolver's real full-chat iteration.
Object.defineProperty(fixture.chat,'forEach',{value(callback,thisArg){
  return Array.prototype.forEach.call(this,(message,index)=>{
    fixture.metrics.visits++;
    callback.call(thisArg,message,index,this);
  });
}});
const records=Array.from({length:RECORDS},(_,index)=>{
  const floor=Math.floor(index*(FLOORS-1)/Math.max(1,RECORDS-1));
  return {id:`fixture-image-${index}`,chatKey:CHAT_KEY,floor,linkState:'active',
    messageRef:createStoryboardMessageReference({message:fixture.chat[floor],chatKey:CHAT_KEY,floor,now:1})};
});
const sandbox={fixture,
  ctx:()=>({chat:fixture.chat,chatMetadata:{}}),getChatKey:()=>CHAT_KEY,
  storyboardState:()=>({view:fixture.view}),
  storyboardGalleryRecords:()=>fixture.records,
  storyboardRecordChatKey:record=>record.chatKey||CHAT_KEY,
  storyboardRecoverLegacyMessageReference:()=>{throw Error('fixture records should not enter the legacy reference path');},
  resolveStoryboardMessageReference:(...args)=>{fixture.metrics.resolves++;return resolveStoryboardMessageReference(...args);},
  storyboardScheduleLinkSave:()=>{fixture.metrics.saves++;},
  storyboardPageTitle:()=>fixture.view==='characters'?'角色库':'阅片室',
  storyboardPageKey:()=>fixture.view,
  renderStoryboardNav:()=>'<nav>fixture nav</nav>',
  renderStoryboardGallery:()=>'<div id="fixture-gallery">gallery</div>',
  storyboardVibeLibraryController:null,
  htmlEscape:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
};
const render=vm.runInNewContext(`${reconcileSource}\nfunction storyboardReconcileGalleryLinks(...args){
  fixture.metrics.reconciles++;
  return realStoryboardReconcileGalleryLinks(...args);
}\n${renderSource}\nrenderStoryboardTab`,sandbox,{filename:'index.js character-entry fixture',timeout:10000});

function sample(view,withRecords){
  fixture.view=view;
  fixture.records=withRecords?structuredClone(records):[];
  fixture.metrics={reconciles:0,resolves:0,visits:0,saves:0};
  const started=performance.now(),html=render(),ms=performance.now()-started;
  assert.match(html,view==='characters'?/sd-character-archive-host/:/fixture-gallery/);
  assert.equal(fixture.metrics.saves,0,'unchanged synthetic references must not schedule metadata writes');
  return {ms:+ms.toFixed(3),...fixture.metrics};
}
function measure(view,withRecords){
  const samples=Array.from({length:ROUNDS},()=>sample(view,withRecords));
  const median=[...samples].sort((a,b)=>a.ms-b.ms)[Math.floor(ROUNDS/2)];
  for(const row of samples){
    assert.equal(row.reconciles,samples[0].reconciles,'one route must have a stable reconcile count');
    assert.equal(row.resolves,samples[0].resolves,'one route must have a stable resolve count');
    assert.equal(row.visits,samples[0].visits,'one route must have a stable message-visit count');
  }
  return {...median,rounds:ROUNDS,allMs:samples.map(row=>row.ms)};
}

const emptyCharacters=measure('characters',false);
const populatedCharacters=measure('characters',true);
const populatedGallery=measure('gallery',true);
assert.equal(populatedGallery.reconciles,1,'gallery route must continue reconciling its image links');
assert.ok(populatedGallery.resolves>0,'populated gallery fixture must exercise image references');
assert.ok(populatedGallery.visits>0,'populated gallery fixture must exercise real message scans');
assert.ok([0,1].includes(emptyCharacters.reconciles),'character route must have at most one reconcile pass');
assert.equal(populatedCharacters.reconciles,emptyCharacters.reconciles);
assert.equal(populatedCharacters.resolves,populatedCharacters.reconciles?populatedGallery.resolves:0);
assert.equal(populatedCharacters.visits,populatedCharacters.reconciles?populatedGallery.visits:0);
if(process.argv.includes('--require-fixed')){
  assert.equal(populatedCharacters.reconciles,0,'character route must not reconcile an unrelated gallery');
  assert.equal(emptyCharacters.reconciles,0,'empty character route must not reconcile an unrelated gallery');
}
console.log(JSON.stringify({
  status:populatedCharacters.reconciles?'baseline-extra-reconcile':'character-route-fixed',
  requireFixed:process.argv.includes('--require-fixed'),floors:FLOORS,records:RECORDS,
  emptyCharacters,populatedCharacters,populatedGallery,
  scope:'real index.js renderStoryboardTab/reconcile and real qianmu-storyboard resolver; synthetic chat/gallery only; no DOM, storage, network, or VPS timing',
}));
