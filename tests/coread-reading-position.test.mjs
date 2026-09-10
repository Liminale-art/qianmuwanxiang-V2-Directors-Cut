import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture(){
  const frames=[],timers=new Map(),saved=[];let id=0;
  const context=vm.createContext({readerView:{chapterIndex:1,scrollRatio:.6},readerScrollSaveTimer:null,
    requestAnimationFrame:cb=>frames.push(cb),clearTimeout:key=>timers.delete(key),setTimeout:cb=>{timers.set(++id,cb);return id;},
    coreadSaveProgress:()=>saved.push(context.readerView.scrollRatio)});
  vm.runInContext(section('bindCoreadReadingPosition'),context);
  const body={isConnected:true,scrollHeight:1500,clientHeight:500,scrollTop:0,addEventListener:(name,fn)=>body.scroll=fn};
  context.bindCoreadReadingPosition(body);
  return {context,body,frames,timers,saved};
}

test('restoration lands before first paint and ignores its synthetic scroll event',()=>{
  const e=fixture();assert.equal(e.body.scrollTop,600);e.body.scroll();
  assert.equal(e.timers.size,0);e.frames.shift()();assert.equal(e.context.readerView.scrollRatio,.6);
});
test('detached old reader scroll, animation and debounce cannot reset the new companion position',()=>{
  const e=fixture();e.body.scrollTop=650;e.body.scroll();const timer=[...e.timers.values()][0];
  e.body.isConnected=false;e.context.readerView={chapterIndex:1,scrollRatio:.8};e.body.scrollTop=0;
  e.body.scroll();e.frames.forEach(f=>f());timer();
  assert.equal(e.context.readerView.scrollRatio,.8);assert.equal(e.saved.length,0);
});
test('chapter changes invalidate callbacks even when the same view object is reused',()=>{
  const e=fixture();e.body.scrollTop=650;e.body.scroll();const timer=[...e.timers.values()][0];
  e.context.readerView.chapterIndex=2;e.context.readerView.scrollRatio=.3;e.body.scrollTop=0;e.body.scroll();
  e.frames.forEach(f=>f());timer();assert.equal(e.context.readerView.scrollRatio,.3);assert.equal(e.saved.length,0);
});
test('hidden or zero-overflow layouts do not turn a real reading position into zero',()=>{
  const e=fixture();e.frames.shift()();e.body.clientHeight=0;e.body.scrollTop=0;e.body.scroll();
  assert.equal(e.context.readerView.scrollRatio,.6);e.body.clientHeight=e.body.scrollHeight;e.body.scroll();
  assert.equal(e.context.readerView.scrollRatio,.6);assert.equal(e.timers.size,0);
});
test('post-layout restoration uses the frozen ratio and genuine scrolling wins over pending restoration',()=>{
  const e=fixture();e.body.scrollHeight=2500;e.frames.shift()();assert.equal(e.body.scrollTop,1200);
  const f=fixture();f.body.scrollTop=720;f.body.scroll();f.frames.shift()();
  assert.equal(f.body.scrollTop,720);assert.equal(f.context.readerView.scrollRatio,.72);
  [...f.timers.values()][0]();assert.deepEqual(f.saved,[.72]);
});
test('rebinding a reader cancels the old scheduled save',()=>{
  const e=fixture();e.body.scrollTop=720;e.body.scroll();assert.equal(e.timers.size,1);
  e.context.bindCoreadReadingPosition({...e.body,addEventListener:()=>{}});assert.equal(e.timers.size,0);
});
