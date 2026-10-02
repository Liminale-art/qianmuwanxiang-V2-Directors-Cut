import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preserveQianmuMainTabs, bindQianmuMainTabNavigation, animateQianmuTabSelection } from '../qianmu-main-tabs.js';

class Tab extends EventTarget {
 constructor(key,active=false,label=key){
  super();this.dataset={tab:key};this.disabled=false;this.attributes=new Map(active?[['aria-current','page']]:[]);this.label={textContent:label};this.classes=new Set(active?['active']:[]);
  this.classList={contains:key=>this.classes.has(key),toggle:(key,on)=>on?this.classes.add(key):this.classes.delete(key)};
 }
 getAttribute(key){return this.attributes.get(key)??null;}
 setAttribute(key,value){this.attributes.set(key,value);}
 removeAttribute(key){this.attributes.delete(key);}
 querySelector(selector){return selector==='.sd-tab-label'?this.label:this.parts?.[selector]??null;}
 click(){this.dispatchEvent(new Event('click'));}
 focus(options){this.focusOptions=options;this.document.activeElement=this;}
}
function fixture(){
 const document={body:{},activeElement:null};document.activeElement=document.body;
 const root={isConnected:true,ownerDocument:document,querySelector:()=>root.shell,querySelectorAll:()=>root.shell.bar.children};
 const shell=(active='a',keys=['a','b'])=>{
  const children=keys.map(key=>{const tab=new Tab(key,key===active);tab.document=document;return tab;});
  const bar={children,scrollLeft:31,dataset:{tabLayout:'cached',fadeBound:'1'},querySelector:()=>children.find(tab=>tab.classList.contains('active')),closest:()=>({dataset:{qmTheme:'glass'}})};
  return{bar,querySelector:selector=>selector==='.sd-tabs'?bar:null,contains:node=>children.includes(node),replaceWith:previous=>{root.shell=previous;}};
 };
 root.shell=shell();return{root,document,shell,old:root.shell};
}
function startAnimation(f){
 const animations=[];
 for(const tab of f.old.bar.children)tab.parts={'.sd-tab-capsule rect':{animate(){const animation={cancelled:false,cancel(){this.cancelled=true;}};animations.push(animation);return animation;}}};
 f.old.bar.children[0].classList.toggle('active',false);f.old.bar.children[1].classList.toggle('active',true);
 animateQianmuTabSelection(f.old.bar,'a');return animations;
}

test('retains exact shell, sizing cache, scroll listeners and in-flight animation on quiet repaint',()=>{
 const f=fixture(),animations=startAnimation(f),restore=preserveQianmuMainTabs(f.root);
 f.root.shell=f.shell('b');assert.equal(restore(),true);
 assert.equal(f.root.shell,f.old);assert.equal(f.old.bar.scrollLeft,31);assert.equal(f.old.bar.dataset.tabLayout,'cached');assert.equal(f.old.bar.dataset.fadeBound,'1');
 animateQianmuTabSelection(f.old.bar,'b');assert.equal(animations.length,1);assert.equal(animations[0].cancelled,false);
 assert.equal(restore(),false,'one render transaction releases its captured nodes');
});
test('restoration adopts current selected state, aria-current and disabled state only',()=>{
 const f=fixture(),before=f.old.bar.children,restore=preserveQianmuMainTabs(f.root);
 f.root.shell=f.shell('b');f.root.shell.bar.children[1].disabled=true;restore();
 assert.equal(before[0].classList.contains('active'),false);assert.equal(before[0].getAttribute('aria-current'),null);
 assert.equal(before[1].classList.contains('active'),true);assert.equal(before[1].getAttribute('aria-current'),'page');assert.equal(before[1].disabled,true);
});
test('no computed style or geometry is read by shell preservation',()=>{
 const f=fixture(),previous=globalThis.getComputedStyle;globalThis.getComputedStyle=()=>assert.fail('not a style snapshot');
 for(const tab of f.old.bar.children)tab.getBoundingClientRect=()=>assert.fail('not a layout pass');
 try{const restore=preserveQianmuMainTabs(f.root);f.root.shell=f.shell('b');assert.equal(restore(),true);}
 finally{if(previous)globalThis.getComputedStyle=previous;else delete globalThis.getComputedStyle;}
});
test('clicked keyboard focus is restored without scrolling, never stolen from a new editor',()=>{
 for(const editorFocus of[false,true]){
  const f=fixture(),tab=f.old.bar.children[0];f.document.activeElement=tab;const restore=preserveQianmuMainTabs(f.root);f.root.shell=f.shell('b');
  const nextFocus=editorFocus?{}:f.document.body;f.document.activeElement=nextFocus;restore();
  assert.equal(f.document.activeElement,editorFocus?nextFocus:tab);assert.deepEqual(tab.focusOptions,editorFocus?undefined:{preventScroll:true});
 }
});
test('changed ids, labels, count or duplicate ids do not reuse stale navigation and cancel owned animation',()=>{
 for(const mutate of[
  f=>{f.root.shell=f.shell('c',['a','c']);},
  f=>{f.root.shell=f.shell('b');f.root.shell.bar.children[0].label.textContent='new title';},
  f=>{f.root.shell=f.shell('a',['a']);},
  f=>{f.old.bar.children[1].dataset.tab='a';f.root.shell=f.shell('a',['a','a']);},
 ]){
  const f=fixture(),animations=startAnimation(f),restore=preserveQianmuMainTabs(f.root);mutate(f);
  const incoming=f.root.shell;assert.equal(restore(),false);assert.equal(f.root.shell,incoming);assert.ok(animations.every(animation=>animation.cancelled));
 }
});
test('missing bar, leaving main tabs and closing the modal safely release animation',()=>{
 assert.equal(preserveQianmuMainTabs({querySelector:()=>null})(),false);
 for(const scenario of['disabled','closed','missing-next']){
  const f=fixture(),animations=startAnimation(f),restore=preserveQianmuMainTabs(f.root,scenario!=='disabled');
  if(scenario==='closed')f.root.isConnected=false;if(scenario==='missing-next')f.root.shell=null;
  assert.equal(restore(),false);assert.ok(animations.every(animation=>animation.cancelled));
 }
});
test('a renderer failing before DOM replacement leaves the original navigation and animation alive',()=>{
 const f=fixture(),animations=startAnimation(f),restore=preserveQianmuMainTabs(f.root);
 assert.equal(restore(),false);assert.equal(f.root.shell,f.old);assert.equal(animations[0].cancelled,false);
});
test('rebinding retained buttons invokes only the latest callback and preserves unrelated listeners',()=>{
 const f=fixture(),calls=[],button=f.old.bar.children[0];button.addEventListener('click',()=>calls.push('other owner'));
 for(let i=0;i<30;i++)bindQianmuMainTabNavigation(f.root,tab=>calls.push(`${i}:${tab.dataset.tab}`));
 button.click();assert.deepEqual(calls,['other owner','29:a']);
 button.disabled=true;button.click();assert.deepEqual(calls,['other owner','29:a','other owner']);
});
test('replacement roots cannot share click ownership and do not bind non-main shortcuts',()=>{
 const first=fixture(),second=fixture(),calls=[];
 first.root.querySelectorAll=selector=>{assert.equal(selector,'.sd-tabs .sd-tab');return first.old.bar.children;};
 bindQianmuMainTabNavigation(first.root,()=>calls.push('first'));bindQianmuMainTabNavigation(second.root,()=>calls.push('second'));
 first.old.bar.children[0].click();second.old.bar.children[0].click();assert.deepEqual(calls,['first','second']);
});

test('production renderer restores before binding and sizes the retained bar only through visibility reveal',()=>{
 const source=readFileSync(new URL('../index.js',import.meta.url),'utf8'),start=source.indexOf('function renderModal()'),end=source.indexOf('\nfunction ',start+1),render=source.slice(start,end);
 assert.ok(render.indexOf('preserveQianmuMainTabs(modal, !storyboardLayout)')<render.indexOf('modal.innerHTML ='));
 assert.ok(render.indexOf('restoreMainTabs();')>render.indexOf('modal.innerHTML ='));
 assert.ok(render.indexOf('restoreMainTabs();')<render.indexOf('applyQianmuIcons(modal)'));
 assert.ok(render.indexOf('restoreMainTabs();')<render.indexOf('bindQianmuMainTabNavigation(modal'));
 assert.match(render,/bindQianmuMainTabNavigation\(modal, \(el\) => \{[\s\S]*?activeTab = el\.dataset\.tab;\s*renderModal\(\);/);
 assert.doesNotMatch(render,/querySelectorAll\('\.sd-tab'\)\.forEach/);
 assert.doesNotMatch(render,/sizeQianmuTabs\(tabsBar\)/,'keepQianmuTabVisible already performs the single sizing pass');
 assert.match(render,/keepQianmuTabVisible\(tabsBar\)/);
 assert.match(render,/if \(!tabsBar\.dataset\.fadeBound\) \{[\s\S]*?bindTabsScrollControls\(tabsBar\)/);
});
