import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {renderQianmuMainTabs,sizeQianmuTabs,keepQianmuTabVisible,animateQianmuTabSelection,updateTabsFade,bindTabsScrollControls} from '../qianmu-main-tabs.js';

test('main tabs have a separate fixed shell; labels and ids are escaped; only the active page is marked',()=>{
 const html=renderQianmuMainTabs([['one','审片'],['two','专注'],['bad"','<img>']], 'two');
 assert.match(html,/^<div class="sd-tabs-shell"><nav class="sd-tabs"/);assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
 assert.match(html,/data-tab="bad&quot;"/);assert.match(html,/&lt;img&gt;/);assert.doesNotMatch(html,/<img>/);
});
test('reveal only changes horizontal offset when a button is outside the scroll viewport',()=>{
 const tab={getBoundingClientRect:()=>({left:105,right:145})},bar={contains:node=>node===tab,querySelector:()=>tab,scrollLeft:50,scrollTop:123,getBoundingClientRect:()=>({left:16,right:140})};
 keepQianmuTabVisible(bar);assert.equal(bar.scrollLeft,55);assert.equal(bar.scrollTop,123);
 tab.getBoundingClientRect=()=>({left:20,right:80});keepQianmuTabVisible(bar);assert.equal(bar.scrollLeft,55);
 tab.getBoundingClientRect=()=>({left:0,right:60});keepQianmuTabVisible(bar);assert.equal(bar.scrollLeft,39);
 keepQianmuTabVisible(bar,{});assert.equal(bar.scrollLeft,39);
});
test('fade directions tolerate rounded end offsets and overscroll',()=>{
 const classes=new Map(),bar={scrollWidth:500,clientWidth:320,scrollLeft:0,classList:{toggle:(name,on)=>classes.set(name,on)}};
 for(const [at,left,right]of [[-5,false,true],[50,true,true],[179.8,true,false],[195,true,false]]){
  bar.scrollLeft=at;updateTabsFade(bar);assert.deepEqual([...classes.values()],[left,right]);
 }
 bar.clientWidth=600;updateTabsFade(bar);assert.deepEqual([...classes.values()],[false,false]);
});
test('touch is native; dominant horizontal trackpad gestures are not doubled',()=>{
 const listeners=new Map(),bar={scrollWidth:600,clientWidth:300,scrollLeft:10,classList:{add(){},remove(){}},addEventListener:(type,fn)=>listeners.set(type,fn)};
 bindTabsScrollControls(bar);let prevented=0;const wheel=(deltaX,deltaY)=>listeners.get('wheel')({deltaX,deltaY,preventDefault:()=>prevented++});
 wheel(50,1);assert.equal(bar.scrollLeft,10);assert.equal(prevented,0);wheel(0,25);assert.equal(bar.scrollLeft,35);assert.equal(prevented,1);
 listeners.get('pointerdown')({pointerType:'touch',button:0,clientX:50});listeners.get('pointermove')({clientX:80,preventDefault:()=>assert.fail('touch must remain native')});assert.equal(bar.scrollLeft,35);
});
test('mouse focus cannot change the drag baseline; keyboard focus still reveals the tab',()=>{
 const listeners=new Map(),tab={getBoundingClientRect:()=>({left:210,right:280})};
 const bar={scrollLeft:0,contains:node=>node===tab,getBoundingClientRect:()=>({left:0,right:240}),scrollWidth:560,clientWidth:240,classList:{add(){},remove(){},toggle(){}},addEventListener:(type,fn)=>listeners.set(type,fn)};
 bindTabsScrollControls(bar);
 const focus={target:{closest:()=>tab}};
 listeners.get('pointerdown')({pointerType:'mouse',button:0,clientX:228});listeners.get('focusin')(focus);assert.equal(bar.scrollLeft,0);
 listeners.get('pointermove')({clientX:226,preventDefault(){}});assert.equal(bar.scrollLeft,2);
 listeners.get('pointerup')({pointerId:1});bar.scrollLeft=0;
 listeners.get('focusin')(focus);assert.equal(bar.scrollLeft,40);
});

test('overflow tabs fit complete equal slots, then clear sizing on a wide viewport',()=>{
 const old=globalThis.getComputedStyle;globalThis.getComputedStyle=()=>({font:'13.5px sans-serif',gap:'4px',columnGap:'4px'});
 try{const tabs=Array.from({length:8},()=>({style:{},getBoundingClientRect:()=>({width:54})})),bar={children:tabs,clientWidth:344,scrollLeft:17,dataset:{}};
  sizeQianmuTabs(bar);assert.equal(tabs[0].style.flexBasis,'65.6px');assert.equal(bar.scrollLeft,17);assert.equal(tabs[0].style.flexBasis,tabs[7].style.flexBasis);
  bar.clientWidth=780;sizeQianmuTabs(bar);assert.ok(tabs.every(tab=>tab.style.flexBasis===''));
 }finally{if(old)globalThis.getComputedStyle=old;else delete globalThis.getComputedStyle;}
});

function animationFixture(theme='classic'){
 const calls=[],animations=[];
 const node=(kind,width=40)=>({getBoundingClientRect:()=>({width}),animate(frames,options){calls.push({kind,frames,options});const animation={cancelled:false,cancel(){this.cancelled=true;}};animations.push(animation);return animation;}});
 const before={dataset:{tab:'a'},style:{},getBoundingClientRect:()=>({left:0,width:60}),querySelector:()=>node('old-mark',40)};
 const parts={'.sd-tab-mark':node('mark'),'.sd-tab-label':node('label'),'.sd-tab-capsule rect':node('capsule')};
 const next={dataset:{tab:'b'},style:{},getBoundingClientRect:()=>({left:64,width:60}),querySelector:selector=>parts[selector],animate:()=>assert.fail('never animate a button')};
 const bar={children:[before,next],dataset:{},querySelector:()=>next,closest:()=>({dataset:{qmTheme:theme}})};
 return {bar,calls,animations,parts};
}

test('classic marker travels as a longer line, contracts into a dot, then becomes a line',()=>{
 const {bar,calls}=animationFixture();animateQianmuTabSelection(bar,'a');
 assert.equal(calls.length,1);assert.equal(calls[0].kind,'mark');
 const {frames,options}=calls[0];assert.equal(options.duration,360);
 assert.equal(frames[0].width,'40px');assert.match(frames[0].transform,/-64px/);
 assert.equal(frames[1].width,'5px');assert.equal(frames[1].height,'5px');assert.equal(frames[2].width,'5px');
 assert.equal(frames.at(-1).width,'40px');assert.equal(frames.at(-1).height,'2.5px');assert.equal(frames.at(-1).transform,'translate(-50%, 50%)');
});

test('glass traces a normalized capsule outline; paper only raises its label and grows the dot',()=>{
 const glass=animationFixture('glass');animateQianmuTabSelection(glass.bar,'a');
 assert.deepEqual(glass.calls.map(call=>call.kind),['capsule']);
 assert.equal(glass.calls[0].frames[0].strokeDashoffset,'.92');assert.equal(glass.calls[0].frames.at(-1).strokeDashoffset,'0');
 const paper=animationFixture('editorial');animateQianmuTabSelection(paper.bar,'a');
 assert.deepEqual(paper.calls.map(call=>call.kind),['mark','label']);
 assert.match(paper.calls[0].frames[0].transform,/scale\(\.25\)/);
 assert.equal(paper.calls[1].frames.at(-1).transform,'translateY(-2px)');
});

test('rapid selections replace decoration animations, and reduced motion cancels them immediately',()=>{
 const fixture=animationFixture(),old=globalThis.matchMedia;
 try{
  globalThis.matchMedia=()=>({matches:false});animateQianmuTabSelection(fixture.bar,'a');
  animateQianmuTabSelection(fixture.bar,'a');assert.equal(fixture.calls.length,2);assert.equal(fixture.animations[0].cancelled,true);assert.equal(fixture.animations[1].cancelled,false);
  globalThis.matchMedia=()=>({matches:true});animateQianmuTabSelection(fixture.bar,'a');
  assert.equal(fixture.calls.length,2);assert.equal(fixture.animations[1].cancelled,true);
 }finally{if(old)globalThis.matchMedia=old;else delete globalThis.matchMedia;}
});

test('resizing cancels stale travel geometry; all unsupported-animation paths keep the static selection usable',()=>{
 const fixture=animationFixture(),old=globalThis.getComputedStyle;
 try{
  animateQianmuTabSelection(fixture.bar,'a');globalThis.getComputedStyle=()=>({font:'13.5px serif',gap:'4px',columnGap:'4px'});
  fixture.bar.clientWidth=140;fixture.bar.scrollLeft=0;sizeQianmuTabs(fixture.bar);assert.equal(fixture.animations[0].cancelled,true);
  fixture.parts['.sd-tab-mark'].animate=()=>{throw new Error('unsupported');};assert.doesNotThrow(()=>animateQianmuTabSelection(fixture.bar,'a'));
  delete fixture.parts['.sd-tab-mark'].animate;assert.doesNotThrow(()=>animateQianmuTabSelection(fixture.bar,'a'));
  assert.doesNotThrow(()=>animateQianmuTabSelection(fixture.bar,'missing'));assert.doesNotThrow(()=>animateQianmuTabSelection(null,'a'));
 }finally{if(old)globalThis.getComputedStyle=old;else delete globalThis.getComputedStyle;}
});

test('selection decorations are aria hidden; CSS has no gradient rail, folder silhouette, or moving hitbox',()=>{
 const markup=renderQianmuMainTabs([['one','世界']], 'one');
 assert.match(markup,/<span class="sd-tab-mark" aria-hidden="true"><\/span>/);
 assert.match(markup,/<svg class="sd-tab-capsule" aria-hidden="true" focusable="false">/);
 assert.match(markup,/pathLength="1"/);
 assert.match(markup,/ry="50%"/,'one vertical radius defines circular ends instead of an elliptical outline');
 assert.doesNotMatch(markup,/rx="999"/);
 const style=readFileSync(new URL('../style.css',import.meta.url),'utf8'),skins=readFileSync(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
 const tabCss=style.slice(style.indexOf('/* ---------- 6. 标签页'),style.indexOf('/* ---------- 7. 内容区'));
 assert.match(tabCss,/\.sd-tabs-shell\s*\{[^}]*background: transparent;/);
 assert.match(tabCss,/width: min\(48px, calc\(100% - 12px\)\)/);
 assert.match(tabCss,/\.sd-tab\s*\{[^}]*overflow: visible;/);
 assert.doesNotMatch(tabCss,/\.sd-tab::(?:before|after)|qm-tab-rail|qm-tab-page/);
 assert.doesNotMatch(skins,/\.sd-tab::(?:before|after)|qm-tab-rail|qm-tab-page/);
 assert.match(skins,/"editorial"\] \.sd-tab\.active \.sd-tab-label \{ transform: translateY\(-2px\)/);
 assert.match(skins,/"glass"\] \.sd-tab\.active \.sd-tab-capsule \{ opacity: 1/);
});
