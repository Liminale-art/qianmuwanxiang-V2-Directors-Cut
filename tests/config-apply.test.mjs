import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPreparedConfig} from '../qianmu-config-apply.js';

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
