import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {isCharacterFloor, injectStoryboardMessageButtons} from '../qianmu-prose-floor-entries.js';
import {scanTtsFloor} from '../qianmu-tts-floor-ui.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

// Scoped DOM fixture. Executes the real toolbar adapter; no storage/model calls.
function fixture(chat = [{mes:'char',is_user:false},{mes:'user',is_user:true},{mes:'hidden char',is_user:false,is_system:true}]) {
  const dom = textCollectionDom(), root = dom.parent, Element = dom.doc.createElement('div').constructor;
  const matches = Element.prototype.matches;
  Element.prototype.matches = function(selector) {
    return selector.split(',').some(part => {
      const pieces = part.trim().split(/\s+/), last = pieces.pop();
      return matches.call(this,last) && (!pieces.length || !!this.parentElement?.closest(pieces.join(' ')));
    });
  };
  Element.prototype.insertAdjacentElement = function(position,node) {
    assert.equal(position,'afterend'); this.parentElement.insertBefore(node,this.nextSibling);
  };
  Object.defineProperty(Element.prototype,'innerHTML',{configurable:true,get(){return this._markup;},set(value){
    this._markup=value;this.replaceChildren();
    for(const match of value.matchAll(/<(button|i)\b([^>]*)>(?:[^<]*<i\b([^>]*)><\/i><\/button>)?/g)) {
      const child=dom.doc.createElement(match[1]);
      for(const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g))child.setAttribute(attr[1],attr[2]);
      if(match[3]){const icon=dom.doc.createElement('i');for(const attr of match[3].matchAll(/([\w-]+)="([^"]*)"/g))icon.setAttribute(attr[1],attr[2]);child.append(icon);}
      this.append(child);
    }
  }});
  const elements=chat.map((message,index)=>{
    const node=dom.doc.createElement('div');node.className='mes';node.setAttribute('mesid',index);
    if(message.is_system)node.setAttribute('is_system','true');
    for(const name of ['mes_text','mes_buttons','host-native']){const child=dom.doc.createElement('div');child.className=name;node.append(child);}
    root.append(node);return node;
  });
  let restored=0,icons=0;
  const isCharacter=node=>isCharacterFloor(node,chat[node?.getAttribute('mesid')]);
  const api={isCharacter,barClass:'sd-tts-bar',bindBoundary:node=>{node.dataset.fixtureBoundary='1';},applyIcons:()=>icons++,autoRestore:()=>restored++};
  const storyboard={floorOf:node=>Number(node.getAttribute('mesid')),getContext:()=>({chat}),getState:()=>({}),planForMessage:()=>null,applyIcons:()=>icons++};
  const scan=()=>{injectStoryboardMessageButtons(root,storyboard);elements.forEach(node=>scanTtsFloor(node,api));};
  return {dom,root,Element,chat,elements,isCharacter,api,scan,get restored(){return restored;},get icons(){return icons;}};
}

test('character eligibility does not coerce false strings or confuse prompt exclusion with role',()=>{
  const f=fixture(),node=f.elements[0];
  for(const role of [false,'false',undefined,0,'0'])assert.equal(isCharacterFloor(node,{is_user:role,is_system:true}),true);
  for(const role of [true,'true',1,'1'])assert.equal(isCharacterFloor(node,{is_user:role}),false);
  assert.equal(isCharacterFloor(node,null),false);
  node.setAttribute('is_user','true');assert.equal(isCharacterFloor(node,{is_user:false}),false);
  node.setAttribute('is_user','false');assert.equal(isCharacterFloor(node,{is_user:false}),true);
  node.classList.add('is_user');assert.equal(isCharacterFloor(node,{is_user:false}),false);
});

test('actual mixed-floor mount stays idempotent, skips user and retains all hidden-character controls',()=>{
  const f=fixture();f.scan();
  const hiddenToolbar=f.elements[2].querySelector('.sd-tts-toolbar');
  assert.deepEqual(f.elements.map(node=>node.querySelectorAll('.sd-storyboard-message-action').length),[1,0,1]);
  assert.deepEqual(f.elements.map(node=>node.querySelectorAll('.sd-tts-toolbar').length),[1,0,1]);
  assert.equal(hiddenToolbar.querySelectorAll('button').length,4);
  assert.equal(hiddenToolbar.dataset.fixtureBoundary,'1');
  f.scan();f.scan();assert.equal(f.icons,4);assert.equal(f.restored,6);
  assert.equal(f.elements[2].querySelector('.sd-tts-toolbar'),hiddenToolbar);
  assert.equal(f.root.querySelectorAll('.host-native').length,3);
  assert.equal(f.chat[2].is_system,true);
});

test('refresh removes mounted user-only Qianmu UI and stale hook flags, preserving host and other floors',()=>{
  const f=fixture();f.scan();const node=f.elements[0];
  for(const name of ['sd-tts-bar','sd-tts-inline']){const child=f.dom.doc.createElement('div');child.className=name;node.append(child);}
  f.chat[0].is_user=true;f.scan();
  assert.equal(node.querySelectorAll('.sd-tts-toolbar, .sd-tts-bar, .sd-tts-inline, .sd-storyboard-message-action').length,0);
  assert.equal(node.dataset.sdTtsHooked,undefined);assert.ok(node.querySelector('.host-native'));
  assert.ok(f.elements[2].querySelector('.sd-tts-toolbar'));
  f.chat[0].is_user='false';node.dataset.sdTtsHooked='1';f.scan();
  assert.equal(node.querySelectorAll('.sd-tts-toolbar').length,1,'missing toolbar is repaired despite an old hook flag');
});

test('attribute-marked user nodes are excluded even before the model role catches up',()=>{
  const f=fixture();f.scan();f.elements[0].setAttribute('is_user','true');f.scan();
  assert.equal(f.elements[0].querySelector('.sd-storyboard-message-action'),null);
  assert.equal(f.elements[0].querySelector('.sd-tts-toolbar'),null);
  assert.equal(f.chat[0].is_user,false);
});

test('old user buttons, detached delayed single-play and popup callbacks cannot extract or synthesize',async()=>{
  const f=fixture(),node=f.elements[1],button=f.dom.doc.createElement('button');button.className='sd-tts-trigger';node.append(button);
  let calls=0;
  const c=vm.createContext({Element:f.Element,isCharacterFloor,ctx:()=>({chat:f.chat}),ttsRestoreTasks:0,
    ttsEnsureBar:()=>{calls++;},ttsSynthCached:()=>{calls++;},ttsCloseQuickPopup:()=>{},ttsResolveLineFromBtn:()=>({mesEl:node,line:{}})});
  vm.runInContext(['ttsMesId','ttsIsCharacter','ttsOnChatClick','ttsHandleTrigger','ttsPlayResolvedLine','ttsHandlePlayAll','ttsOpenQuickPopup'].map(section).join('\n'),c);
  c.ttsOnChatClick({target:button});await c.ttsHandleTrigger(button);await c.ttsHandlePlayAll(button,true);
  await c.ttsPlayResolvedLine({},node,0,button,true);await c.ttsPlayResolvedLine({},null,0,button,true);
  c.ttsOpenQuickPopup(button);assert.equal(calls,0);assert.equal(c.ttsRestoreTasks,0);
  f.chat[1].is_user=false;node.remove();
  await c.ttsPlayResolvedLine({},node,0,button,true);await c.ttsHandleTrigger(button);
  assert.equal(calls,0,'an entire detached old message is not a current floor');
});

test('stale user storyboard entry stops before loading capture or buying any request',async()=>{
  const f=fixture(),node=f.elements[1],button=f.dom.doc.createElement('button');button.dataset.storyboardChatAction='capture-floor';node.append(button);
  const original=button.closest.bind(button);button.closest=selector=>selector==='#chat'?f.root:original(selector);
  let loads=0;
  const c=vm.createContext({isCharacterFloor,ctx:()=>({chat:f.chat}),proseFloorTools:{collectionClick:()=>false},storyboardMessageFloor:()=>1,
    storyboardAdmissionEpoch:0,getChatKey:()=> 'chat',featureRuntime:{load:()=>{loads++;}}});
  vm.runInContext(section('storyboardOnChatClick'),c);
  await c.storyboardOnChatClick({target:{closest:()=>button},preventDefault(){},stopPropagation(){}});
  assert.equal(loads,0);
});

test('a role change while probing audio cache prevents starting continuous synthesis',async()=>{
  const f=fixture(),node=f.elements[0],button=f.dom.doc.createElement('button'),bar=f.dom.doc.createElement('div');
  node.append(button,bar);bar.className='sd-tts-bar';bar.dataset.key='cached-lines';
  bar.querySelectorAll=()=>[{dataset:{idx:'0'}}];
  let release,syntheses=0;const probe=new Promise(resolve=>{release=resolve;});
  const c=vm.createContext({Element:f.Element,isCharacterFloor,ctx:()=>({chat:f.chat}),ttsRestoreTasks:0,TTS_BAR_CLASS:'sd-tts-bar',
    ttsSeqToken:0,ttsStopPlayback(){},ttsSetPlayingState(){},ttsLineCache:new Map([['cached-lines',[{text:'line'}]]]),
    ttsBuildParams:()=>({providerId:'fixture'}),blobStore:{blobStoreAvailable:()=>true,hasAudio:()=>probe},cacheKeyForTts:()=> 'audio-key',
    ttsSynthCached:()=>{syntheses++;},ttsAutoRestore(){},toast(){}});
  vm.runInContext(['ttsMesId','ttsIsCharacter','ttsHandlePlayAll'].map(section).join('\n'),c);
  const task=c.ttsHandlePlayAll(button);f.chat[0].is_user=true;release(true);await task;
  assert.equal(syntheses,0);assert.equal(c.ttsRestoreTasks,0);
});

test('a single synthesis already started for char cannot play after its floor becomes user',async()=>{
  const f=fixture(),node=f.elements[0];let release,played=0;
  const c=vm.createContext({isCharacterFloor,ctx:()=>({chat:f.chat}),ttsRestoreTasks:0,setQianmuIconClass(){},
    ttsSynthCached:()=>new Promise(resolve=>{release=resolve;}),ttsPlayBlob:()=>{played++;},toast(){}});
  vm.runInContext(['ttsMesId','ttsIsCharacter','ttsPlayResolvedLine'].map(section).join('\n'),c);
  const task=c.ttsPlayResolvedLine({},node,0,null);f.chat[0].is_user=true;release({blob:{},cached:true});await task;
  assert.equal(played,0);assert.equal(c.ttsRestoreTasks,0);
});
