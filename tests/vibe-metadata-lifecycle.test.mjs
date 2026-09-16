import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// Execute the actual private metadata owner. Browser tests cover the real DOM,
// caret, native controls and preview URL ownership, not this narrow seam.
const source=await readFile(new URL('../qianmu-vibe-library-view.js',import.meta.url),'utf8');
const start=source.indexOf('  async function loadDraftAsset(){'),end=source.indexOf('\n  function informationControl(){',start);
assert.ok(start>=0&&end>start);const implementation=source.slice(start,end);
const head={summary:{hasImage:false,variants:[{model:'v4full',information:0},{model:'v4full',information:1}]}};
function fixture(){
  const f={current:true,reads:[],updates:[],notices:[],syncs:0};
  const context=vm.createContext({draft:{name:'typing',info:'0',assetRef:{version:1,namespace:'st-user:synthetic',id:'a'.repeat(64)}},
    assets:{head:ref=>new Promise((resolve,reject)=>f.reads.push({ref,resolve,reject}))},live:()=>f.current,
    syncFields:()=>f.syncs++,syncInformationControl:()=>f.updates.push({head:context.draft.assetHead,error:context.draft.assetError,loading:context.draft.loadingHead}),report:error=>f.notices.push(error.message)});
  vm.runInContext(implementation,context);return {...f,context,state:f,load:()=>context.loadDraftAsset()};
}

test('metadata is read once while pending and only the information control is updated',async()=>{
  const f=fixture(),draft=f.context.draft,first=f.load();await f.load();assert.equal(f.reads.length,1);
  draft.name='still typing';f.reads[0].resolve(head);await first;
  assert.equal(f.context.draft,draft);assert.equal(draft.name,'still typing');assert.equal(draft.info,'0');assert.equal(draft.assetHead,head);
  assert.equal(draft.loadingHead,false);assert.equal(f.state.syncs,1);assert.equal(f.updates.length,1);assert.deepEqual(f.notices,[]);
  await f.load();assert.equal(f.reads.length,1);
});

for(const owner of ['closed','draft','source'])for(const outcome of ['resolve','reject'])test(`late metadata ${outcome} is ignored after ${owner} changes`,async()=>{
  const f=fixture(),draft=f.context.draft,pending=f.load();
  if(owner==='closed')f.state.current=false;
  if(owner==='draft')f.context.draft={name:'new editor',assetRef:{...draft.assetRef}};
  if(owner==='source')draft.assetRef=null;
  if(outcome==='resolve')f.reads[0].resolve(head);else f.reads[0].reject(Error('obsolete read failure'));
  await pending;assert.equal(draft.loadingHead,false);assert.equal(draft.assetHead,undefined);assert.equal(f.updates.length,0);assert.deepEqual(f.notices,[]);
});

test('read failure is retryable without resetting the draft, parameters or source',async()=>{
  const f=fixture(),draft=f.context.draft,asset=draft.assetRef,first=f.load();f.reads[0].reject(Error('metadata unavailable'));await first;
  assert.equal(draft.assetRef,asset);assert.equal(draft.info,'0');assert.equal(draft.assetError,'metadata unavailable');assert.equal(draft.loadingHead,false);
  const retry=f.load();assert.equal(f.reads.length,2);assert.equal(draft.assetError,'');assert.equal(f.updates.at(-1).loading,true);
  f.reads[1].resolve(head);await retry;assert.equal(draft.assetHead,head);assert.equal(draft.info,'0');assert.deepEqual(f.notices,['metadata unavailable']);
});

test('a missing asset gets the same bounded retry path, without publishing an empty draft',async()=>{
  const f=fixture(),draft=f.context.draft,pending=f.load();f.reads[0].resolve(null);await pending;
  assert.equal(f.context.draft,draft);assert.equal(draft.name,'typing');assert.equal(draft.assetHead,null);assert.match(draft.assetError,/已被清理/);
  assert.equal(draft.loadingHead,false);assert.equal(f.notices.length,1);
});
