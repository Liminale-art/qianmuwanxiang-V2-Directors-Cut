import test from 'node:test';import assert from 'node:assert/strict';
import {mappingReceiptsFixture,namespace} from './fixtures/storyboard-mapping-receipts.mjs';
import {mappingHead} from '../qianmu-storyboard-mapping-contract.js';
import {runMappingRegistry} from '../qianmu-storyboard-mapping-registry.js';
import {runMappingImport} from '../qianmu-mapping-import.js';
import {MAPPING_IMPORT_LIMIT,validateMappingImportInput,validateMappingImportPreview,validateMappingImportResult} from '../qianmu-mapping-import-contract.js';
import {inspectBundleMappingReceipt} from '../qianmu-bundle-mappings.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {renderMappingRegistry} from '../qianmu-storyboard-mapping-view.js';
const previewAction='mapping-import-preview',applyAction='mapping-import-apply';
async function fixture(){
  const rows=await mappingReceiptsFixture(),state={records:new Map(),heads:[],reads:0,writes:0,alive:true,locks:[]};
  const source={listMappingHeads:async()=>rows.map(row=>row.head),loadMappingReceipt:async(ns,kind,id)=>structuredClone(rows.find(row=>row.kind===kind&&row.head.digest===id).receipt)};
  const files=[];for(const row of rows)files.push((await runMappingRegistry('mapping-export',{namespace,journal:source,input:{kind:row.kind,digest:row.head.digest}})).file);
  const journal={listMappingHeads:async()=>{state.onList?.();return structuredClone(state.heads);},loadMappingReceipt:async(ns,kind,id)=>{state.reads++;return structuredClone(state.records.get(kind+id)||null);},
    importMappingReceipt:async(receipt,{head,confirmed})=>{assert.equal(confirmed,true);await inspectBundleMappingReceipt(receipt,head,namespace);if(!state.records.has(head.kind+head.digest)){state.records.set(head.kind+head.digest,structuredClone(receipt));state.heads.push(structuredClone(head));state.writes++;}state.afterSave?.();}};
  const options={namespace,journal,guard:async()=>{if(!state.alive)throw Error('account changed');},locks:{request:async(name,mode,work)=>{state.locks.push(name);return work({});}}};
  const preview=(file=files[0])=>runMappingImport(previewAction,{...options,input:{file}}),apply=(view,file=files[0])=>runMappingImport(applyAction,{...options,input:{file,fileDigest:view.fileDigest,planDigest:view.planDigest,confirmed:true}});
  return {rows,files,source,state,journal,options,preview,apply};
}
test('all four actual exported receipt variants import unchanged without replay and are idempotent only after a fresh preview',async()=>{
  const f=await fixture();for(const [i,file] of f.files.entries()){
    const p=await f.preview(file);assert.equal(p.state,'new');assert.equal(p.beforeCount,i);assert.equal(p.afterCount,i+1);assert.equal(f.state.writes,i);assert.equal(p.restoreAuthorized,false);
    const result=await f.apply(p,file);assert.equal(result.outcome,'added');assert.deepEqual(f.state.records.get(f.rows[i].kind+f.rows[i].head.digest),f.rows[i].receipt);
    await assert.rejects(f.apply(p,file),/确认已过期/);const fresh=await f.preview(file);assert.equal(fresh.state,'same');assert.equal(fresh.addedBytes,0);assert.equal((await f.apply(fresh,file)).outcome,'reused');assert.equal(f.state.writes,i+1);
  }assert.ok(f.state.locks.every(name=>name===`qianmu:package-import:${namespace}`));assert.deepEqual(f.state.heads.map(row=>row.version),[1,1,2,3]);
});
test('import shape, consent and size are checked before parsing and unavailable or occupied locks never write',async()=>{
  const f=await fixture(),p=await f.preview();for(const input of [{file:f.files[0],confirmed:true},{file:new Blob([])},{file:new Blob([new Uint8Array(MAPPING_IMPORT_LIMIT+1)])},{file:f.files[0],verified:true}])assert.throws(()=>validateMappingImportInput(previewAction,input));
  await assert.rejects(runMappingImport(applyAction,{...f.options,input:{file:f.files[0],fileDigest:p.fileDigest,planDigest:p.planDigest,confirmed:false}}),/确认不完整/);
  for(const locks of [null,{request:async(name,mode,work)=>work(null)}])await assert.rejects(runMappingImport(applyAction,{...f.options,locks,input:{file:f.files[0],fileDigest:p.fileDigest,planDigest:p.planDigest,confirmed:true}}),/恢复锁|另一页面/);
  assert.equal(f.state.writes,0);
});
test('strict file decoding rejects unknown envelope fields, duplicate keys, malformed UTF8 and incomplete receipt semantics',async()=>{
  const f=await fixture(),text=await f.files[0].text(),envelope=JSON.parse(text);
  for(const file of [new Blob([text.replace('{','{"kind":"subjects",')]),new Blob([JSON.stringify({...envelope,approved:true})]),new Blob([new Uint8Array([0xff,0xfe,0x00])]),new Blob([JSON.stringify({...envelope,receipt:{...envelope.receipt,review:{...envelope.receipt.review,digest:'0'.repeat(64)}}})])])await assert.rejects(f.preview(file));
  assert.equal(f.state.writes,0);assert.equal(f.state.heads.length,0);
});
test('a receipt from a different account is not silently rewritten or used as identity authorization',async()=>{
  const f=await fixture();await assert.rejects(runMappingImport(previewAction,{...f.options,namespace:'st-user:other',input:{file:f.files[0]}}),/跨账户派生/);assert.equal(f.state.writes,0);
});
test('both changed raw file spelling and newly added local records expire the approved plan',async()=>{
  const f=await fixture(),p=await f.preview(),sameContent=new Blob([' ',await f.files[0].text()]);await assert.rejects(f.apply(p,sameContent),/确认已过期/);
  await f.apply(await f.preview(f.files[1]),f.files[1]);await assert.rejects(f.apply(p),/确认已过期/);assert.equal(f.state.writes,1);
});
test('same identifier with a different first timestamp or a corrupt full record cannot be overwritten',async()=>{
  const f=await fixture();await f.apply(await f.preview());const row=structuredClone(f.rows[0].receipt);row.createdAt++;f.state.records.set(f.rows[0].kind+f.rows[0].head.digest,row);f.state.heads[0]=mappingHead('environment',row);
  await assert.rejects(f.preview(),/首次记录不同/);f.state.heads[0]=f.rows[0].head;await assert.rejects(f.preview(),/目录不符/);assert.equal(f.state.writes,1);
});
test('merged per-kind capacity blocks before writing and a directory change during inspection is rejected',async()=>{
  const f=await fixture(),base=f.rows[0].head;for(let i=0;i<256;i++){const digest=i.toString(16).padStart(64,'0');f.state.heads.push({...base,key:JSON.stringify([namespace,'environment',digest]),digest});}
  await assert.rejects(f.preview(),/名额或空间不足/);assert.equal(f.state.writes,0);
  f.state.heads=[];let calls=0;f.state.onList=()=>{if(++calls===2)f.state.heads.push(f.rows[1].head);};await assert.rejects(f.preview(),/目录已变化/);assert.equal(f.state.writes,0);
});
test('cancellation and a failed write readback never return an import success or silently roll back saved records',async()=>{
  const f=await fixture(),p=await f.preview();f.state.alive=false;await assert.rejects(f.apply(p),/account changed/);assert.equal(f.state.writes,0);f.state.alive=true;
  f.state.afterSave=()=>{f.state.records.get(f.rows[0].kind+f.rows[0].head.digest).createdAt++;};await assert.rejects(f.apply(p),/目录不符/);assert.equal(f.state.writes,1);assert.equal(f.state.heads.length,1);
});
test('import summaries and saved results cannot claim authority or carry a substituted scope',async()=>{
  const f=await fixture(),p=await f.preview();for(const value of [{...p,restoreAuthorized:true},{...p,afterCount:7},{...p,addedBytes:0},{...p,receipt:f.rows[0].receipt}])assert.throws(()=>validateMappingImportPreview(value,namespace));
  const input={file:f.files[0],fileDigest:p.fileDigest,planDigest:p.planDigest,confirmed:true},result=await f.apply(p);assert.throws(()=>validateMappingImportResult({...result,fileDigest:'0'.repeat(64)},namespace,input));assert.throws(()=>validateMappingImportResult({...result,restoreAuthorized:true},namespace,input));
});
class FakeWorker{static handler;static instances=[];constructor(){this.events={};FakeWorker.instances.push(this);}addEventListener(key,fn){this.events[key]=fn;}postMessage(message){queueMicrotask(()=>FakeWorker.handler(this,structuredClone(message)));}emit(value){this.events.message({data:value});}terminate(){this.closed=true;}}
test('short Worker import requests are typed and read-only requests cannot turn into writes or alias RPCs',async()=>{
  const f=await fixture(),p=await f.preview(),options={namespace,guard:async()=>{},WorkerClass:FakeWorker,input:{file:f.files[0]}};
  FakeWorker.handler=(worker,message)=>worker.emit({id:message.id,result:p});assert.deepEqual(await runRestoreStorage(previewAction,options),p);assert.equal(FakeWorker.instances.at(-1).closed,true);
  FakeWorker.handler=(worker,message)=>worker.emit({id:message.id,result:{...p,restoreAuthorized:true}});await assert.rejects(runRestoreStorage(previewAction,options));
  FakeWorker.handler=(worker,message)=>worker.emit({id:message.id,aliasTargets:{request:1,targets:[]}});await assert.rejects(runRestoreStorage(previewAction,options),/核对请求无效/);
  const before=FakeWorker.instances.length;await assert.rejects(runRestoreStorage(applyAction,{...options,input:{file:f.files[0],fileDigest:p.fileDigest,planDigest:p.planDigest,confirmed:false}}));assert.equal(FakeWorker.instances.length,before);
});
test('aborted apply releases the Worker and reports an unconfirmed possible save, never automatic retry',async()=>{
  const f=await fixture(),p=await f.preview(),controller=new AbortController();FakeWorker.handler=()=>{};
  const pending=runRestoreStorage(applyAction,{namespace,guard:async()=>{},WorkerClass:FakeWorker,signal:controller.signal,input:{file:f.files[0],fileDigest:p.fileDigest,planDigest:p.planDigest,confirmed:true}});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,/可能已保存.*不会自动重试/);assert.equal(FakeWorker.instances.at(-1).closed,true);
});
test('import view escapes the filename, requires its own confirmation and does not present a binding action',async()=>{
  const f=await fixture(),p=await f.preview(),state={importing:true,importReview:p,importConfirmed:false,fileName:'<script>.mapping.json'},format=value=>`${value} B`;
  const html=renderMappingRegistry(state,format);assert.match(html,/&lt;script&gt;/);assert.match(html,/data-mapping-action="import-apply" disabled/);assert.match(html,/不执行旧的人物绑定/);
  assert.doesNotMatch(renderMappingRegistry({...state,importConfirmed:true},format),/data-mapping-action="import-apply" disabled/);
  await assert.rejects(runMappingRegistry(applyAction,{...f.options,input:{file:f.files[0]}}),/操作无效/);
});

test('a malformed application acknowledgement reports possible persistence and terminates without repeating the write',async()=>{
  const f=await fixture(),p=await f.preview();FakeWorker.handler=async(worker,message)=>{const saved=await f.apply(p);worker.emit({id:message.id,result:{...saved,fileDigest:'0'.repeat(64)}});};
  await assert.rejects(runRestoreStorage(applyAction,{namespace,guard:async()=>{},WorkerClass:FakeWorker,input:{file:f.files[0],fileDigest:p.fileDigest,planDigest:p.planDigest,confirmed:true}}),/可能已保存.*不会自动重试/);assert.equal(f.state.writes,1);assert.equal(FakeWorker.instances.at(-1).closed,true);
});

test('late guard failure after a valid application acknowledgement also preserves an unconfirmed-save warning',async()=>{
  const f=await fixture(),p=await f.preview();let checks=0;FakeWorker.handler=async(worker,message)=>worker.emit({id:message.id,result:await f.apply(p)});
  await assert.rejects(runRestoreStorage(applyAction,{namespace,guard:async()=>{if(++checks>1)throw Error('account changed');},WorkerClass:FakeWorker,input:{file:f.files[0],fileDigest:p.fileDigest,planDigest:p.planDigest,confirmed:true}}),/可能已保存.*account changed/);assert.equal(f.state.writes,1);assert.equal(FakeWorker.instances.at(-1).closed,true);
});
