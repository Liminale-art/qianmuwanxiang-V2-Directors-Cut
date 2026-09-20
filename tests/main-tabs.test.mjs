import test from 'node:test';
import assert from 'node:assert/strict';
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

test('tab contour animation never transforms buttons on engines without pseudo support',()=>{
 const old=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:false});let cancelled=0,calls=0;
 const before={dataset:{tab:'a'},getBoundingClientRect:()=>({left:0})},next={dataset:{tab:'b'},getBoundingClientRect:()=>({left:60}),animate(){calls++;return {effect:{pseudoElement:null},cancel(){cancelled++;}};}},bar={children:[before,next],querySelector:()=>next};
 try{animateQianmuTabSelection(bar,'a');assert.equal(cancelled,2);assert.equal(calls,2);next.animate=()=>{throw Error('Not supported');};assert.doesNotThrow(()=>animateQianmuTabSelection(bar,'a'));globalThis.matchMedia=()=>({matches:true});next.animate=()=>assert.fail('reduced motion');animateQianmuTabSelection(bar,'a');}
 finally{if(old)globalThis.matchMedia=old;else delete globalThis.matchMedia;}
});
