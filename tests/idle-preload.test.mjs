import test from 'node:test';import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {scheduleQianmuIdlePreload} from '../qianmu-idle-preload.js';
function fixture(){const document=new EventTarget(),window=new EventTarget(),timers=new Map();let time=0,id=0,busy=false,current=true;const loaded=[];
 document.readyState='complete';document.hidden=false;window.navigator={connection:{saveData:false}};
 window.setTimeout=fn=>{timers.set(++id,fn);return id;};window.clearTimeout=id=>timers.delete(id);
 const stop=scheduleQianmuIdlePreload({window,document,now:()=>time,isCurrent:()=>current,isBusy:()=>busy,loaders:[async()=>loaded.push('library'),async()=>loaded.push('assistant')]});
 return {document,window,loaded,timers,stop,setBusy:v=>busy=v,expire:()=>current=false,async tick(){time+=5000;const [key,fn]=timers.entries().next().value;timers.delete(key);await fn();await Promise.resolve();}};}
test('preload waits for quiet and warms code serially, then sleeps forever',async()=>{const f=fixture();assert.deepEqual(f.loaded,[]);await f.tick();assert.deepEqual(f.loaded,['library']);await f.tick();assert.deepEqual(f.loaded,['library','assistant']);assert.equal(f.timers.size,0);f.stop();});
test('streaming, hidden pages, data saving and disposal prevent warming',async()=>{const f=fixture();f.setBusy(true);await f.tick();f.setBusy(false);f.document.hidden=true;await f.tick();f.document.hidden=false;f.window.navigator.connection.saveData=true;await f.tick();assert.deepEqual(f.loaded,[]);f.stop();assert.equal(f.timers.size,0);});
test('expired runtime never executes a scheduled import',async()=>{const f=fixture();f.expire();await f.tick();assert.deepEqual(f.loaded,[]);assert.equal(f.timers.size,0);f.stop();});

test('finished and retired preloads release their activity and pagehide listeners',async()=>{
 for(const mode of ['finish','expire','pagehide']){const f=fixture();assert.equal(getEventListeners(f.document,'input').length,1);assert.equal(getEventListeners(f.window,'pagehide').length,1);
  if(mode==='finish'){await f.tick();await f.tick();}else if(mode==='expire'){f.expire();await f.tick();}else f.window.dispatchEvent(new Event('pagehide'));
  assert.equal(f.timers.size,0);for(const type of ['input','pointerdown','keydown','wheel'])assert.equal(getEventListeners(f.document,type).length,0);assert.equal(getEventListeners(f.window,'pagehide').length,0);f.stop();
 }
});
