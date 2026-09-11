import test from 'node:test';
import assert from 'node:assert/strict';
import {createConfigUndoSlot} from '../qianmu-config-undo.js';

test('recovery is session-only, detached and remains retryable until explicitly released',()=>{
  const slot=createConfigUndoSlot(),current={theme:'new'},previous={settings:{theme:'old'},layoutRaw:'invalid old JSON'};
  assert.equal(slot.available(current),false);assert.equal(slot.read(current),null);
  assert.equal(slot.remember(previous,current),true);previous.settings.theme='mutated';
  const first=slot.read(current);assert.equal(first.settings.theme,'old');assert.equal(first.layoutRaw,'invalid old JSON');
  first.settings.theme='modified attempt';assert.equal(slot.read(current).settings.theme,'old');
  assert.equal(createConfigUndoSlot().available(current),false,'fresh page instances must not inherit secrets or undo records');
  slot.clear();assert.equal(slot.available(current),false);assert.equal(slot.read(current),null);
});

test('new reader progress or another owner cannot be silently overwritten by a recovery snapshot',()=>{
  const slot=createConfigUndoSlot(),current={coread:{books:[{progress:.5}]}};
  slot.remember({settings:{theme:'old'},layoutRaw:null},current);
  assert.equal(slot.available(structuredClone(current)),false);
  current.coread.books[0].progress=.75;
  assert.equal(slot.available(current),false);assert.equal(slot.read(current),null);assert.equal(current.coread.books[0].progress,.75);
});

test('only the latest recovery point is retained and failed arming cannot expose an earlier owner',()=>{
  const slot=createConfigUndoSlot(),a={id:'a'},b={id:'b'};
  slot.remember({settings:{id:'before-a'}},a);slot.remember({settings:{id:'before-b'}},b);
  assert.equal(slot.read(a),null);assert.equal(slot.read(b).settings.id,'before-b');
  const circular={};circular.self=circular;
  assert.equal(slot.remember({settings:{}},circular),false);assert.equal(slot.read(b),null);
  assert.equal(slot.remember({settings:b},b),false);
  for(const previous of [null,{}, {settings:null},{settings:[]},{settings:'invalid'}])assert.equal(slot.remember(previous,b),false);
});

test('snapshot failure leaves no partially armed recovery record',()=>{
  const slot=createConfigUndoSlot({clone:()=>{throw Error('private fixture');}});
  const current={};assert.equal(slot.remember({settings:{}},current),false);assert.equal(slot.available(current),false);assert.equal(slot.read(current),null);
});
