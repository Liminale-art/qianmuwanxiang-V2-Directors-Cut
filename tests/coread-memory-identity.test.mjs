import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as reader from '../qianmu-reader.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
function vectors(){
  const writes=[],c=vm.createContext({readerDialog:{bucket:'A::book',slices:[{id:'same',summary:'A memory'}]},coreadVecCache:null,
    coreadVectorStates:new Map(),isPlainObject:o=>o&&typeof o==='object',rerenderMoreIfOpen:()=>{},
    blobStore:{getReaderVectors:async()=>null,putReaderVectors:async(...args)=>writes.push(structuredClone(args))},
    coreadWithRetry:async(_,task)=>task(),coreadEmbed:async()=>[[1,0]]});
  vm.runInContext(['coreadSliceFingerprint','coreadEnsureVectors'].map(section).join('\n'),c);
  return {c,writes,m:{vectorModel:'model'}};
}
test('late vector storage reads cannot replace the new companion cache',async()=>{
  const {c,m,writes}=vectors(),pending=defer();c.blobStore.getReaderVectors=()=>pending.promise;
  const run=c.coreadEnsureVectors(m);const bCache={bucket:'B::book',model:'model',vecs:{same:[0,1]}};
  c.readerDialog={bucket:'B::book',slices:[{id:'same',summary:'B memory'}]};c.coreadVecCache=bCache;
  pending.resolve({model:'model',vecs:{same:[1,0]}});assert.equal(await run,null);assert.equal(c.coreadVecCache,bCache);assert.equal(writes.length,0);
});
test('an in-flight embedding cannot overwrite same-named slices or clean another companion vectors',async()=>{
  const {c,m,writes}=vectors(),pending=defer(),started=defer();
  c.coreadEmbed=()=>{started.resolve();return pending.promise;};const run=c.coreadEnsureVectors(m);await started.promise;
  const aCache=c.coreadVecCache,bCache={bucket:'B::book',vecs:{same:[0,1]}};
  c.readerDialog={bucket:'B::book',slices:[{id:'same',summary:'B memory'}]};c.coreadVecCache=bCache;
  pending.resolve([[1,0]]);assert.equal(await run,null);assert.equal(c.coreadVecCache,bCache);assert.deepEqual(Object.keys(aCache.vecs),[]);assert.equal(writes.length,0);
});
test('vector writes already issued keep their original bucket and cannot report success for a new reader',async()=>{
  const {c,m}=vectors(),pending=defer(),started=defer();let key;
  c.blobStore.putReaderVectors=(bucket)=>{key=bucket;started.resolve();return pending.promise;};
  const run=c.coreadEnsureVectors(m);await started.promise;c.readerDialog={bucket:'B::book',slices:[]};pending.resolve();
  assert.equal(await run,null);assert.equal(key,'A::book');
});
test('unchanged vectors are reused within their owner without unnecessary requests',async()=>{
  const {c,m,writes}=vectors();const cache=await c.coreadEnsureVectors(m);assert.equal(writes.length,1);
  c.coreadEmbed=()=>{throw Error('must reuse');};assert.equal(await c.coreadEnsureVectors(m),cache);assert.equal(writes.length,1);
});

test('new mirror IDs include archive identity and explicit copies never reuse source worldbook pointers',async()=>{
  const source={messages:[{text:'source'}],slices:[{id:'shared',src:'dialog',summary:'Original',loreUid:42,loreBook:'source world',provenance:{bucket:'A::book',bookId:'book',readTo:100}}],readBoundary:{bookId:'book',readTo:100}};
  const before=structuredClone(source),mirrors=[],c=vm.createContext({readerDialog:{bookId:'book',bucket:'B::book',readBoundary:{bookId:'book',readTo:800}},
    coreadMemoryWrites:0,coreadBookMeta:()=>({}),clone:structuredClone,reader,coreadSummaryProgressFromRecord:()=>({cursor:0,summaryFloor:0}),
    coreadEchoTtl:new Map(),coreadVecCache:null,coreadTargetBook:async()=>'shared world',coreadMirrorUidMap:async()=>new Map(),
    coreadSaveDialog:async()=>true,coreadRefreshContainer:async()=>{}});
  vm.runInContext(['coreadNormalizeSlices','coreadSliceLogicalId','coreadMigrateFromChat'].map(section).join('\n'),c);
  c.coreadSyncSliceMirror=async slice=>{assert.equal(slice.loreUid,undefined);assert.equal(slice.loreBook,undefined);mirrors.push(c.coreadSliceLogicalId(slice));return true;};
  await c.coreadMigrateFromChat(source);
  assert.deepEqual(source,before);assert.match(mirrors[0],/B%3A%3Abook/);assert.equal(c.readerDialog.slices[0].provenance.bucket,'A::book');
  assert.equal(c.readerDialog.slices[0].provenance.readTo,100);assert.equal(c.coreadMemoryWrites,0);
  assert.notEqual(c.coreadSliceLogicalId(source.slices[0]),mirrors[0]);
});

test('memory write gate is released on failed mutation, never leaving selection permanently locked',async()=>{
  const c=vm.createContext({coreadMemoryWrites:0,readerDialog:{slices:[{id:'x',summary:'old'}]},uniqueClean:x=>x,coreadVectorStates:new Map(),
    coreadSliceFingerprint:()=>'',coreadPipelineCircuits:new Map(),coreadVecCache:null,coreadUpdateComicDescriptionForSlice:async()=>{throw Error('disk');}});
  vm.runInContext(section('coreadSaveSliceEdit'),c);await assert.rejects(c.coreadSaveSliceEdit('x','new','tag'),/disk/);assert.equal(c.coreadMemoryWrites,0);
});

test('slice formation boundary is frozen before asynchronous mirror writing',async()=>{
  let boundary={bookId:'book',readTo:100,chapterIndex:0,progress:10};const pending=defer();
  const c=vm.createContext({reader,readerDialog:{bookId:'book',bucket:'A::book',slices:[]},coreadNextBatch:()=>1,uid:()=>'s',
    coreadCurrentReadBoundarySync:()=>boundary,coreadTargetBook:()=>pending.promise,coreadMemory:()=>({vectorEnabled:false}),
    coreadVectorStates:new Map(),coreadSliceFingerprint:()=>'',console,MODULE_NAME:'fixture'});
  vm.runInContext(['coreadSliceLogicalId','coreadPersistSlice'].map(section).join('\n'),c);
  const run=c.coreadPersistSlice({summary:'formed at 10%',keywords:[]},{},{src:'dialog'});
  boundary={bookId:'book',readTo:800,chapterIndex:2,progress:80};pending.resolve('');await run;
  assert.equal(c.readerDialog.slices[0].provenance.readTo,100);assert.equal(c.readerDialog.slices[0].provenance.bucket,'A::book');
});
