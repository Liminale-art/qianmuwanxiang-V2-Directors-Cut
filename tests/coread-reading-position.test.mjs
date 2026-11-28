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

// 阅读中写设置节流：每次 saveSettings 都会把整份 ST 设置传上去。滚动 30 秒最多 6 次；页面藏起时攒着的那次立刻写。
function saveFixture(){
  let now=1_000_000,id=0;const timers=new Map(),saves=[],listeners=new Map();
  const document={visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const context=vm.createContext({document,nowMs:()=>now,saveSettings:()=>saves.push(now),COREAD_SAVE_EVERY_MS:5000,coreadSaveTimer:null,coreadSaveAt:0,
    setTimeout:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimeout:key=>timers.delete(key)});
  vm.runInContext(`${section('coreadQueueSave')}\n${section('coreadFlushSave')}\nvar coreadSaveOnHide = () => { if (document.visibilityState === 'hidden') coreadFlushSave(); };`,context);
  const advance=ms=>{const end=now+ms;for(;;){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();}now=end;};
  return {context,saves,timers,listeners,document,advance,start:now};
}
test('thirty seconds of scrolling upload the settings at most six times, the last position included',()=>{
  const e=saveFixture();
  for(let t=0;t<30000;t+=100){e.context.coreadQueueSave();e.advance(100);}
  const inWindow=e.saves.filter(at=>at<e.start+30000);
  assert.ok(inWindow.length<=6,`${inWindow.length} uploads`);assert.ok(inWindow.length>=5,'still saved while reading');
  e.advance(5000);assert.equal(e.timers.size,0,'the last pending save went out');
  assert.ok(e.saves.at(-1)>=e.start+29900,'the final position is written');
});
test('hiding the page or closing the book writes the pending save at once',()=>{
  const e=saveFixture();e.context.coreadQueueSave();assert.equal(e.saves.length,1);
  e.advance(1000);e.context.coreadQueueSave();assert.equal(e.saves.length,1);assert.equal(e.timers.size,1);assert.ok(e.listeners.has('visibilitychange'));
  e.document.visibilityState='hidden';e.listeners.get('visibilitychange')();
  assert.equal(e.saves.length,2);assert.equal(e.timers.size,0);assert.equal(e.listeners.has('visibilitychange'),false,'no listener left behind');
  e.document.visibilityState='visible';e.advance(100);e.context.coreadQueueSave();assert.equal(e.timers.size,1);
  e.context.coreadFlushSave();assert.equal(e.saves.length,3);assert.equal(e.timers.size,0);
});
