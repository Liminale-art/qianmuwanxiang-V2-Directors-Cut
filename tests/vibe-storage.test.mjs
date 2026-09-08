import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeStorageOperations,createVibeStorageActions} from '../qianmu-vibe-storage.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {createVibeAssetStore} from '../qianmu-vibe-asset-store.js';
import {readFile} from 'node:fs/promises';
const namespace='st-user:storage',id='a'.repeat(64),otherId='b'.repeat(64),source='c'.repeat(64);
function fixture(){
  const local={heads:[{assetId:id,bytes:100,previewBytes:10,createdAt:1,summary:{name:'景色',type:'image',sourceId:source,variants:[{}]}},
    {assetId:otherId,bytes:50,createdAt:2,summary:{name:'编码',type:'encoding',sourceId:'d'.repeat(64),variants:[{}]}}],usage:{count:2,bytes:150,previewBytes:10,limit:512*1048576}};
  const receipts=[],writes=[];let available=true;
  const store={inventory:async ns=>{assert.equal(ns,namespace);return structuredClone(local);},remove:async(ns,ids,options)=>{writes.push({ns,ids,options});return {removed:ids.length,bytes:110};}};
  const encodings={list:async ns=>{assert.equal(ns,namespace);return structuredClone(receipts);}};
  const locks={request:async(name,options,work)=>{assert.equal(name,'qianmu:nai-maintenance');assert.deepEqual(options,{mode:'exclusive',ifAvailable:true});return work(available?{}:null);}};
  return {local,receipts,writes,store,encodings,locks,ops:createVibeStorageOperations({store,encodings,locks}),lock:()=>available=false};
}

test('Vibe space reads only metadata and counts original, preview and receipt bytes without equating them to disk quota',async()=>{
  const e=fixture();e.receipts.push({status:'unknown',identity:{sourceId:source}});
  const inventory=await e.ops.inventory(namespace);assert.equal(inventory.usage.bytes,150);assert.equal(inventory.usage.previewBytes,10);assert.equal(inventory.receiptCount,1);
  assert.equal(inventory.receiptBytes,new TextEncoder().encode(JSON.stringify(e.receipts[0])).length);assert.equal(inventory.items[0].pending,1);assert.equal(inventory.items[1].pending,0);
  assert.equal(inventory.usage.countLimit,1024);assert.match(inventory.fingerprint,/^[a-f0-9]{64}$/);assert.equal(e.writes.length,0);
});

test('legacy source IDs, source refs and cached refs all protect uncertain files and are not counted twice',async()=>{
  const e=fixture();e.receipts.push({status:'submitting',identity:{sourceId:source},sourceAssetRef:{id},assetRef:{id}},
    {status:'ready',identity:{sourceId:'different'},assetRef:{id}}, {status:'reviewed',identity:{sourceId:'different'},sourceAssetRef:{id}});
  const snapshot=await e.ops.inventory(namespace);assert.equal(snapshot.items[0].receiptCount,3);assert.equal(snapshot.items[0].pending,1);
  await assert.rejects(()=>e.ops.remove(namespace,[id],snapshot.fingerprint,true),/关联未决/);assert.equal(e.writes.length,0);
  await e.ops.remove(namespace,[otherId],snapshot.fingerprint,true);assert.equal(e.writes.length,1);assert.deepEqual(e.writes[0].ids,[otherId]);
});

test('cleanup requires exact consent, cross-page exclusivity and unchanged receipts/heads/usage before any write',async()=>{
  for(const change of [e=>e.lock(),e=>e.local.heads[0].createdAt++,e=>e.local.usage.bytes++,e=>e.receipts.push({status:'ready',identity:{sourceId:source}})]){
    const e=fixture(),snapshot=await e.ops.inventory(namespace);change(e);await assert.rejects(()=>e.ops.remove(namespace,[id],snapshot.fingerprint,true));assert.equal(e.writes.length,0);
  }
  for(const consent of [false,1,'true',undefined]){const e=fixture(),s=await e.ops.inventory(namespace);await assert.rejects(()=>e.ops.remove(namespace,[id],s.fingerprint,consent));assert.equal(e.writes.length,0);}
  const e=fixture(),s=await e.ops.inventory(namespace);await assert.rejects(()=>createVibeStorageOperations({...e,locks:null}).remove(namespace,[id],s.fingerprint,true),/不支持跨页/);
  for(const ids of [[],[id,id],['missing']])await assert.rejects(()=>e.ops.remove(namespace,ids,s.fingerprint,true));
  await e.ops.remove(namespace,[id],s.fingerprint,true);assert.deepEqual(e.writes[0].options,{expectedHeads:[e.local.heads[0]]});
});

test('corrupt metadata and invalid direct-store snapshots never authorize deletion',async()=>{
  const e=fixture(),s=await e.ops.inventory(namespace);e.encodings.list=async()=>{throw Error('corrupt receipts');};await assert.rejects(()=>e.ops.remove(namespace,[id],s.fingerprint,true),/corrupt/);assert.equal(e.writes.length,0);
  let opens=0;const store=createVibeAssetStore({indexedDB:{open(){opens++;throw Error('should not open');}}});
  for(const expectedHeads of [[],[{}],[e.local.heads[0]]])await assert.rejects(()=>store.remove(namespace,[id],{expectedHeads}));assert.equal(opens,0);store.close();
});

test('user selection can clear referenced nonpending files, with explicit loss and recovery warning, not automatic fee replay',async()=>{
  const e=fixture(),view=await e.ops.inventory(namespace),library=[{id:'library-one',assetRef:{namespace,id}}],calls=[];
  const actions=createVibeStorageActions({namespace,guard:async()=>{},items:()=>library,call:async(type,args)=>{calls.push([type,args]);return type==='storage-inventory'?view:{removed:1,bytes:110};}});
  const snapshot=await actions.list();
  assert.deepEqual(await actions.remove(snapshot,[id],async(title,text)=>{assert.match(text,/当前库有 1 处引用/);assert.match(text,/其他聊天和历史镜头/);assert.match(text,/不会自动重新编码或生图/);assert.match(text,/无法撤销/);return false;}),{cancelled:true});
  assert.equal(calls.length,1);await actions.remove(snapshot,[id],async()=>true);assert.equal(calls[1][0],'storage-remove');assert.deepEqual(calls[1][1],{namespace,ids:[id],proof:view.fingerprint,confirmed:true});
  const selected=[id];await actions.remove(snapshot,selected,async()=>{selected[0]=otherId;return true;});assert.deepEqual(calls[2][1].ids,[id],'confirmation cannot be repointed to another file');
});

test('account/page changes, changed current-library refs and ambiguous confirmations cannot invoke cleanup',async()=>{
  const e=fixture(),view=await e.ops.inventory(namespace),library=[];let live=true,writes=0;
  const actions=createVibeStorageActions({namespace,items:()=>library,guard:async()=>{if(!live)throw Error('changed');},call:async type=>{if(type==='storage-inventory')return view;writes++;return {};}}),snapshot=await actions.list();
  for(const consent of [1,'true',undefined])assert.deepEqual(await actions.remove(snapshot,[id],async()=>consent),{cancelled:true});
  await assert.rejects(()=>actions.remove({...snapshot,namespace:'st-user:other'},[id],async()=>assert.fail('wrong account')));
  await assert.rejects(()=>actions.remove(snapshot,[id],async()=>{live=false;return true;}),/changed/);live=true;
  await assert.rejects(()=>actions.remove(snapshot,[id],async()=>{library.push({id:'new',assetRef:{namespace,id}});return true;}),/引用已变化/);
  assert.equal(writes,0);
});

test('export batches are explicit and bounded; old unguarded worker remove can no longer bypass selection confirmation',async()=>{
  const e=fixture(),view=await e.ops.inventory(namespace),calls=[];
  const actions=createVibeStorageActions({namespace,guard:async()=>{},call:async(type,args)=>{calls.push([type,args]);return new Blob(['backup']);}});
  await actions.export(view,[id]);assert.deepEqual(calls[0],['export',{namespace,ids:[id],bundle:false}]);
  await actions.export(view,[id,otherId]);assert.equal(calls[1][1].bundle,true);
  await assert.rejects(()=>actions.export({...view,items:Array.from({length:17},(_,i)=>({id:String(i)}))},Array.from({length:17},(_,i)=>String(i))),/最多导出 16/);
  const run=createVibeAssetOperations({remove:()=>assert.fail('unguarded remove')});await assert.rejects(()=>run({type:'remove',namespace,ids:[id]}),/尚未明确确认/);
});

test('unsettled source files remain exportable for backup without becoming clearable',async()=>{
  const e=fixture();e.receipts.push({status:'unknown',identity:{sourceId:source}});const view=await e.ops.inventory(namespace),calls=[];
  const actions=createVibeStorageActions({namespace,guard:async()=>{},call:async(type,args)=>{calls.push(type);return new Blob(['backup']);}});
  await actions.export(view,[id]);assert.deepEqual(calls,['export']);
  await assert.rejects(()=>actions.remove(view,[id],async()=>assert.fail('no delete confirmation for pending source')),/关联未决/);assert.deepEqual(calls,['export']);
});

test('actual library mount provides lazy storage actions and the module is present in release whitelist',async()=>{
  const index=await readFile(new URL('../index.js',import.meta.url),'utf8'),view=await readFile(new URL('../qianmu-vibe-library-view.js',import.meta.url),'utf8');
  assert.match(index,/createStorage:async onClose=>\{const storage=await featureRuntime.load\('vibeStorage'\)/);
  assert.match(index,/createVibeStorageActions\(\{namespace,call:assetRuntime.callVibeAsset,guard,items:\(\)=>state.vibeLibrary\}/);
  assert.match(view,/\['storage',createStorage,'Vibe 文件空间','fa-database'\]/);
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url)));assert.ok(release.files.includes('qianmu-vibe-storage.js'));
});
