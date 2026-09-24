import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageAttemptStore } from '../qianmu-image-attempt-store.js';
import {imageAttemptScopeKey,importImageAttempts} from '../qianmu-image-attempts.js';
const scope = { namespace: 'test', chatKey: 'chat', messageKey: 'message', revisionId: 'revision' };
const request = { attemptId: 'a', logicalShotId: 's', operationKey: 'o', ownerId: 'page', kind: 'automatic', maxAutomatic: 3, imageCount: 1 };

function readonlyDatabase(initial=[]){
  const rows=new Map(initial),modes=[],reads=[];
  const indexedDB={open(){const open={};queueMicrotask(()=>{open.result={close(){},transaction(name,mode){
    assert.equal(name,'scopes');assert.equal(mode,'readonly');modes.push(mode);let waiting=0,ended=false;
    const tx={abort(){ended=true;queueMicrotask(()=>tx.onabort?.());}};
    const read=(kind,key)=>{const req={};waiting++;reads.push([kind,key]);queueMicrotask(()=>{if(ended)return;
      req.result=structuredClone(kind==='count'?rows.size:rows.get(key));req.onsuccess?.();waiting--;
      if(!waiting)queueMicrotask(()=>{if(!ended&&!waiting){ended=true;tx.oncomplete?.();}});
    });return req;};
    tx.objectStore=()=>({count:()=>read('count'),get:key=>read('get',key),put:()=>assert.fail('preflight must not write')});return tx;
  }};open.onsuccess?.();});return open;}};
  return {rows,modes,reads,store:createImageAttemptStore({indexedDB,now:()=>100,maxScopes:2})};
}

test('real batch preflight uses one readonly transaction, preserves occupied history, and creates no scopes',async()=>{
  const history=Array.from({length:250},(_,i)=>({attemptId:`old${i}`,logicalShotId:`old${i}`,operationKey:`old${i}`,automaticSlot:false,status:'unknown'}));
  const ledger=importImageAttempts(null,scope,history,100),f=readonlyDatabase([[imageAttemptScopeKey(scope),ledger]]),before=structuredClone([...f.rows]);
  const inputs=Array.from({length:7},(_,i)=>({...request,attemptId:`new${i}`,logicalShotId:`new${i}`,operationKey:`new${i}`,maxAutomatic:7}));
  assert.deepEqual(await f.store.preflight([{scope,inputs,history:[]}]),{ok:false,code:'ledger_full'});
  assert.deepEqual([...f.rows],before);assert.deepEqual(f.modes,['readonly']);assert.equal(f.reads.filter(row=>row[0]==='get').length,1);
  assert.equal((await f.store.preflight([{scope,inputs:inputs.slice(0,6),history:[]}])).ok,true);assert.deepEqual([...f.rows],before);f.store.close();
});

test('batch scope capacity accounts for every new scope together without partially creating any',async()=>{
  const f=readonlyDatabase([[imageAttemptScopeKey(scope),importImageAttempts(null,scope,[],100)]]);
  const groups=['new-a','new-b'].map(messageKey=>({scope:{...scope,messageKey},inputs:[request],history:[]}));
  assert.deepEqual(await f.store.preflight(groups),{ok:false,code:'storage_full'});assert.equal(f.rows.size,1);
  await assert.rejects(f.store.preflight([groups[0],groups[0]]),{code:'image_attempt_identity'});assert.equal(f.modes.length,1);f.store.close();
});

test('preflight transaction creation failure rejects promptly instead of leaving a pending promise',async()=>{
  const indexedDB={open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction(){throw Error('transaction unavailable');}};request.onsuccess();});return request;}};
  const store=createImageAttemptStore({indexedDB,timeoutMs:100});
  await assert.rejects(store.preflight([{scope,inputs:[request],history:[]}]),{code:'image_attempt_storage'});store.close();
});

test('preflight timeout settles even when a stalled transaction never emits abort', async () => {
  let aborted=0;
  const indexedDB={open(){const opening={};queueMicrotask(()=>{
    opening.result={close(){},transaction(){return {abort(){aborted++;},objectStore(){return {count:()=>({}),get:()=>({})};}};}};
    opening.onsuccess();
  });return opening;}};
  const store=createImageAttemptStore({indexedDB,timeoutMs:100});
  await assert.rejects(store.preflight([{scope,inputs:[request],history:[]}]),{code:'image_attempt_storage_timeout'});
  assert.equal(aborted,1);store.close();
});

test('ledger factory and disposal are lazy and never touch legacy media databases', () => {
  let opens = 0;
  const store = createImageAttemptStore({ indexedDB: { open() { opens++; } } });
  assert.equal(opens, 0); store.close(); assert.equal(opens, 0);
});

test('invalid identity fails before opening storage and disabled storage never grants admission', async () => {
  let opens = 0;
  const store = createImageAttemptStore({ indexedDB: { open() { opens++; throw new Error('mock private browser'); } } });
  await assert.rejects(() => store.claim({ ...scope, namespace: '' }, request), { code: 'image_attempt_identity' });
  assert.equal(opens, 0);
  await assert.rejects(() => store.claim(scope, request), { code: 'image_attempt_storage' }); assert.equal(opens, 1);
  await assert.rejects(() => store.claim(scope, request), { code: 'image_attempt_storage' }); assert.equal(opens, 2, 'a failed open is not cached forever');
  store.close();
});

test('blocked open rejects promptly and closes a late success instead of reviving its request', async () => {
  const pending = {}; let closes = 0;
  const store = createImageAttemptStore({ indexedDB: { open: () => pending } });
  const claim = store.claim(scope, request); pending.onblocked();
  await assert.rejects(() => claim, { code: 'image_attempt_storage_blocked' });
  pending.result = { close: () => { closes++; } }; pending.onsuccess();
  assert.equal(closes, 1); store.close();
});

test('opening timeout is bounded and late database handles are closed', async () => {
  const pending = {}; let closes = 0;
  const store = createImageAttemptStore({ indexedDB: { open: () => pending }, timeoutMs: 100 });
  await assert.rejects(() => store.claim(scope, request), { code: 'image_attempt_storage_timeout' });
  pending.result = { close: () => { closes++; } }; pending.onsuccess();
  assert.equal(closes, 1); store.close();
});

test('a closed session never resolves an outstanding open as authorized', async () => {
  const pending = {}; let closes = 0;
  const store = createImageAttemptStore({ indexedDB: { open: () => pending } });
  const claim = store.claim(scope, request); store.close();
  pending.result = { close: () => { closes++; } }; pending.onsuccess();
  await assert.rejects(() => claim, { code: 'image_attempt_closed' }); assert.equal(closes, 1);
  await assert.rejects(() => store.inspect(scope), { code: 'image_attempt_closed' });
});
