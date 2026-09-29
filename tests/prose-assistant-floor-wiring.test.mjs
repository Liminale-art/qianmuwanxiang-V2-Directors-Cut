import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createProseAssistantFloorTools} from '../qianmu-prose-assistant-floor.js';
import {emptyProseAssistantHistory} from '../qianmu-prose-assistant-history-contract.js';
import {proseAssistantPanelDom} from './helpers/prose-assistant-panel-dom.mjs';
test('assistant uses the existing host refresh and cleanup, outside storyboard enablement, without loading its panel eagerly',async()=>{
  const entry=await readFile(new URL('../index.js',import.meta.url),'utf8'),wrapper=await readFile(new URL('../qianmu-prose-floor-tools.js',import.meta.url),'utf8'),floor=await readFile(new URL('../qianmu-prose-assistant-floor.js',import.meta.url),'utf8');
  assert.match(entry,/const proseFloorTools=createProseFloorTools\(/);assert.doesNotMatch(wrapper,/collectionFloorTools|text-collection-outbox|text-collection-session/);
  const render=entry.slice(entry.indexOf('function storyboardRenderInlineImages('),entry.indexOf('function storyboardScheduleInlineRender('));assert.ok(render.indexOf('proseFloorTools.refresh(chatRoot)')<render.indexOf('if (!storyboardState().enabled)'));
  assert.doesNotMatch(floor,/^import.*panel|new MutationObserver|setInterval\(/m);assert.match(floor,/await loadLocalChunk\('\.\/qianmu-prose-assistant-panel.js'\)/);assert.match(floor,/floorProseText\(candidate\?\.querySelector\('\.mes_text'\)\)/);
  assert.match(floor,/controller.abort\(\)/);assert.match(entry,/assistantConfig:\(\)=>\(\{\.\.\.settings.proseAssistant,profiles:settings.apiProfiles\}\)/);
  assert.match(entry,/assistantSettings:\(\)=>settings/);assert.match(floor,/getProfileStream:\(\)=>assistantSettings\?\.\(\)\?\.streamEnabled===true/);
});

test('formal assistant entry samples only the current prose font and refreshes an old stylesheet URL once',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('visual entry must not call a network transport'));
 for(const kind of ['mixed','plain','offstage']){
  const dom=proseAssistantPanelDom(),doc=dom.doc,create=doc.createElement,observed=[];
  doc.createElement=tag=>{const element=create(tag);element.style.setProperty=(name,value)=>{element.style[name]=value;};return element;};
  const prose=doc.createElement('div');prose.className='mes_text';
  const run=doc.createElement('div');run.className='sd-prose-run';
  if(kind!=='offstage')dom.parent.append(prose);if(kind==='mixed')prose.append(run);
  const expected=kind==='mixed'?run:kind==='plain'?prose:doc.body;
  Object.defineProperty(prose,'textContent',{get(){assert.fail('font inheritance must not read prose text');}});
  const fontSize=kind==='offstage'?'18px':'24px';
  doc.defaultView.getComputedStyle=element=>{observed.push(element);return {fontFamily:'Fixture Serif',fontSize};};
  const oldStyle=doc.createElement('link');oldStyle.dataset.qmProseAssistantStyle='';
  let href='https://fixture.invalid/qianmu-prose-assistant.css',updates=0;
  Object.defineProperty(oldStyle,'href',{get:()=>href,set:value=>{href=value;updates++;}});doc.head.append(oldStyle);
  const host={chat:[],chatMetadata:{}},notices=[];
  const tools=createProseAssistantFloorTools({getContext:()=>host,resolveNamespace:async()=>'st-user:font-fixture',headers:()=>({}),isCurrent:()=>true,
   confirm:async()=>true,notify:notice=>notices.push(notice),assistantHistoryFactory:async({source})=>({initialHistory:()=>emptyProseAssistantHistory(source.key),close(){}})});
  try{
   tools.bindRoot(dom.parent);let panel=await tools.openAssistant();assert.ok(panel,notices.join('\n'));await panel.ready;
   const portal=panel.element.parentNode;
   assert.equal(portal.style['--qm-pa-prose-font'],'Fixture Serif');assert.equal(portal.style['--qm-pa-prose-size'],fontSize);
   assert.deepEqual(observed,[expected]);assert.match(href,/qianmu-prose-assistant\.css\?v=\d+\.\d+\.\d+$/);assert.equal(updates,1);
   assert.equal(doc.querySelectorAll('link[data-qm-prose-assistant-style]').length,1);
   panel.dispose();await panel.finished;await new Promise(resolve=>setImmediate(resolve));
   panel=await tools.openAssistant();assert.ok(panel);await panel.ready;
   assert.equal(updates,1,'ordinary reopen must not replace the matching stylesheet');assert.equal(doc.querySelector('link[data-qm-prose-assistant-style]'),oldStyle);
   assert.deepEqual(observed,[expected,expected]);assert.deepEqual(notices,[]);
  }finally{tools.disposeFloor();}
 }
});
