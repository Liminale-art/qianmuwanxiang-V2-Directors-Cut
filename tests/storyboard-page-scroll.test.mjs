import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function setup(){
  const state={view:'create',source:'novel'},frames=[],positions=new Map();
  const context=vm.createContext({storyboardState:()=>state,storyboardPageScrolls:positions,requestAnimationFrame:fn=>frames.push(fn),document:{querySelector:()=>null}});
  vm.runInContext(['storyboardPageKey','storyboardScroller','storyboardRememberPageScroll','storyboardRestorePageScroll'].map(section).join('\n'),context);
  const body={dataset:{storyboardPage:'create'},scrollTop:380,isConnected:true,querySelector:()=>null};
  return {context,state,frames,positions,body,root:{querySelector:()=>body}};
}

test('departing model page cannot overwrite Comfy memory after state has changed',()=>{
  const e=setup();e.positions.set('create:comfy',810);e.state.source='comfy';
  e.context.storyboardRememberPageScroll(e.root);
  assert.equal(e.positions.get('create'),380);assert.equal(e.positions.get('create:comfy'),810);
  e.body.dataset.storyboardPage='create:comfy';e.body.scrollTop=950;e.state.source='novel';e.context.storyboardRememberPageScroll(e.root);
  assert.equal(e.positions.get('create'),380);assert.equal(e.positions.get('create:comfy'),950);
});

test('loading placeholders cannot erase a previously scrolled workbench',()=>{
  const e=setup();e.positions.set('create:comfy',810);e.body.dataset.storyboardPage='create:comfy';e.body.scrollTop=0;e.body.querySelector=()=>({});
  e.context.storyboardRememberPageScroll(e.root);assert.equal(e.positions.get('create:comfy'),810);
});

test('deferred restore belongs to its original body, never a replacement page',()=>{
  const e=setup();e.context.storyboardRestorePageScroll(e.body,600);e.body.isConnected=false;e.body.scrollTop=0;
  const replacement={scrollTop:75};e.context.document.querySelector=()=>replacement;e.frames.shift()();
  assert.equal(e.body.scrollTop,0);assert.equal(replacement.scrollTop,75);
});

test('a user scroll before the layout frame takes precedence over restoration',()=>{
  const e=setup();e.context.storyboardRestorePageScroll(e.body,600);e.body.scrollTop=650;e.frames.shift()();assert.equal(e.body.scrollTop,650);
});

test('a layout expansion can finish restoration without a navigation or user action',()=>{
  const e=setup();let actual=0,limit=100;Object.defineProperty(e.body,'scrollTop',{get:()=>actual,set:value=>actual=Math.min(limit,value)});
  e.context.storyboardRestorePageScroll(e.body,600);limit=900;e.frames.shift()();assert.equal(e.body.scrollTop,600);
  assert.match(section('renderModal'),/storyboardRememberPageScroll\(modal\)/);
  assert.match(section('renderModal'),/storyboardRestorePageScroll\(body, restoreBodyScroll\)/);
});
