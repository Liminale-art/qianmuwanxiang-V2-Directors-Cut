import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPreparedConfig,finishConfigRestore} from '../qianmu-config-apply.js';
import {createConfigUndoSlot} from '../qianmu-config-undo.js';

function fixture(raw='old raw layout') {
  const owner={theme:'old'},prepared={theme:'new',proseLayout:{width:96}},host={q:owner},saved=[];
  let current=owner,cache=raw;
  const storage={getItem:()=>cache,setItem:(key,value)=>{cache=value;},removeItem:()=>{cache=null;}};
  const options={owner,prepared,host,slot:'q',setCurrent:value=>{current=value;},save:()=>saved.push(host.q),
    layoutStorage:()=>storage,layoutKey:'layout',now:()=>123};
  return {owner,prepared,host,storage,saved,options,current:()=>current,cache:()=>cache};
}

test('application hands off prepared state once and only acknowledges scheduling, not durable persistence',()=>{
  const e=fixture();const before=structuredClone(e.owner);
  assert.deepEqual(applyPreparedConfig(e.options),{status:'applied',persistence:'requested'});
  assert.equal(e.host.q,e.prepared);assert.equal(e.current(),e.prepared);assert.deepEqual(e.saved,[e.prepared]);
  assert.deepEqual(JSON.parse(e.cache()),{width:96,updatedAt:123});assert.deepEqual(e.owner,before);
});

test('unreadable layout or mismatched host rejects before any configuration writes',()=>{
  for(const fault of ['cache','host']) {
    const e=fixture();if(fault==='cache')e.storage.getItem=()=>{throw Error('private detail');};else e.host.q={theme:'another owner'};
    const old=e.host.q;
    const result=applyPreparedConfig(e.options);assert.equal(result.status,'rejected');assert.doesNotMatch(JSON.stringify(result),/private/);
    assert.equal(e.host.q,old);assert.equal(e.current(),e.owner);assert.equal(e.cache(),'old raw layout');assert.equal(e.saved.length,0);
  }
});

test('save failure restores exact raw layout, original host presence and live owner before compensation',()=>{
  for(const raw of [null,'not valid JSON','{"width":4,"updatedAt":1}'])for(const present of [true,false]) {
    const e=fixture(raw);if(!present)delete e.host.q;let calls=0;
    e.options.save=()=>{calls++;e.saved.push(e.host.q);if(calls===1)throw Error('schedule uncertain');};
    assert.deepEqual(applyPreparedConfig(e.options),{status:'reverted',persistence:'uncertain'});
    assert.equal(Object.hasOwn(e.host,'q'),present);assert.equal(e.host.q,present?e.owner:undefined);
    assert.equal(e.current(),e.owner);assert.equal(e.cache(),raw);assert.equal(calls,2);
    assert.equal(e.saved[1],present?e.owner:undefined,'compensation must never reschedule the imported state');
  }
});

test('write-then-throw cache failure is compensated without scheduling imported settings',()=>{
  const e=fixture();const write=e.storage.setItem;let calls=0;
  e.storage.setItem=(...args)=>{write(...args);if(++calls===1)throw Error('cache failed after write');};
  assert.deepEqual(applyPreparedConfig(e.options),{status:'reverted',persistence:'not-requested'});
  assert.equal(e.host.q,e.owner);assert.equal(e.current(),e.owner);assert.equal(e.cache(),'old raw layout');assert.equal(e.saved.length,0);
});

test('failed compensation is reported explicitly and still restores the other targets',()=>{
  const e=fixture();e.options.save=()=>{throw Error('save unavailable');};
  const write=e.storage.setItem;let writes=0;e.storage.setItem=(...args)=>{if(++writes===2)throw Error('rollback blocked');write(...args);};
  assert.deepEqual(applyPreparedConfig(e.options),{status:'incomplete',persistence:'uncertain'});
  assert.equal(e.host.q,e.owner);assert.equal(e.current(),e.owner);assert.notEqual(e.cache(),'old raw layout');
});

test('a second save exception must not be presented as a completely recovered operation',()=>{
  const e=fixture();e.options.save=()=>{throw Error('host unavailable');};
  assert.deepEqual(applyPreparedConfig(e.options),{status:'incomplete',persistence:'uncertain'});
  assert.equal(e.host.q,e.owner);assert.equal(e.current(),e.owner);assert.equal(e.cache(),'old raw layout');
});

test('current-settings assignment failure attempts every needed rollback and leaves persistence untouched',()=>{
  const e=fixture();e.options.setCurrent=value=>{if(value===e.prepared)throw Error();};
  assert.equal(applyPreparedConfig(e.options).status,'reverted');
  assert.equal(e.host.q,e.owner);assert.equal(e.cache(),'old raw layout');assert.equal(e.saved.length,0);
});

test('undo captures original configuration and exact before/after layout without exposing it in the result',()=>{
  const e=fixture('raw prior'),undo=createConfigUndoSlot();
  const result=applyPreparedConfig({...e.options,undo});assert.equal(result.status,'applied');
  const recovery=undo.read(e.current());assert.deepEqual(recovery.settings,{theme:'old'});
  assert.deepEqual(recovery.layout,{available:true,raw:'raw prior'});assert.equal(recovery.layoutAfter.raw,e.cache());
  assert.doesNotMatch(JSON.stringify(result),/raw prior|theme/);
});

test('restoring a session snapshot preserves absent or invalid old cache exactly without new timestamps',()=>{
  for(const raw of [null,'old invalid JSON','{"width":10}']){
    const e=fixture(raw),undo=createConfigUndoSlot();e.owner.proseLayout={width:10,updatedAt:1};
    applyPreparedConfig({...e.options,undo});const recovery=undo.read(e.current());
    const result=applyPreparedConfig({...e.options,owner:e.current(),prepared:recovery.settings,layoutSnapshot:recovery.layout});
    assert.equal(result.status,'applied');assert.equal(e.cache(),raw);assert.equal(e.current().proseLayout.updatedAt,1);
  }
});

test('uncapturable recovery state rejects before writes and failed arming compensates the completed handoff',()=>{
  const broken=fixture(),undo=createConfigUndoSlot();broken.owner.fn=()=>{};
  assert.equal(applyPreparedConfig({...broken.options,undo}).status,'rejected');assert.equal(broken.saved.length,0);assert.equal(broken.current(),broken.owner);
  const e=fixture();let cleared=0;
  const result=applyPreparedConfig({...e.options,undo:{remember:()=>false,clear:()=>cleared++}});
  assert.equal(result.status,'reverted');assert.equal(result.persistence,'uncertain');assert.equal(e.current(),e.owner);assert.equal(e.cache(),'old raw layout');assert.equal(cleared,1);
});

test('only synchronous rendering updates may advance the import undo baseline, not earlier user edits',async()=>{
  for(const changed of [false,true]){
    const e=fixture(),undo=createConfigUndoSlot();
    await finishConfigRestore({...e.options,undo,current:e.current,afterApply(){},
      inject:async()=>{if(changed)e.current().userEdit='new';},render:()=>{e.current().lastTab='plug';},notify(){}});
    assert.equal(undo.available(e.current()),!changed);
    if(!changed)assert.deepEqual(undo.read(e.current()).settings,{theme:'old'});
  }
});

test('unexpected async rendering is awaited for errors but never renews undo authority',async()=>{
  const e=fixture(),undo=createConfigUndoSlot(),notices=[];
  const result=await finishConfigRestore({...e.options,undo,current:e.current,afterApply(){},inject:async()=>{},
    render:async()=>{throw Error('synthetic renderer');},notify:(...args)=>notices.push(args)});
  assert.equal(result.view,'incomplete');assert.equal(undo.available(e.current()),false);assert.equal(notices.at(-1)[1],'warning');
});
