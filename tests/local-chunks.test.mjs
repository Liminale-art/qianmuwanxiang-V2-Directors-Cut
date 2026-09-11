import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createLocalChunkLoader,createFeatureRuntime} from '../qianmu-feature-runtime.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const path='./qianmu-reader.js?v=test';
test('concurrent opens share one recovery, change only the known module URL, and reuse success',async()=>{
  const urls=[],waits=[],value={ready:true};const load=createLocalChunkLoader({pause:async ms=>waits.push(ms),importer:async url=>{urls.push(url);if(urls.length===1)throw new TypeError('Failed to fetch dynamically imported module');return value;}});
  assert.deepEqual(await Promise.all([load(path),load(path)]),[value,value]);assert.equal(urls.length,2);assert.deepEqual(waits,[180]);
  assert.equal(new URL(urls[0]).searchParams.get('v'),'test');assert.equal(new URL(urls[1]).searchParams.get('qm_retry'),'1');assert.equal(await load(path),value);assert.equal(urls.length,2);
});
test('a failed load can retry on explicit action, while automatic retries and per-session attempts stay bounded',async()=>{
  let calls=0;const load=createLocalChunkLoader({pause:async()=>{},importer:async()=>{calls++;throw new TypeError('Importing a module script failed.');}});
  for(let i=0;i<4;i++)await assert.rejects(load(path));assert.equal(calls,8);await assert.rejects(load(path),/刷新/);assert.equal(calls,8);
});
test('evaluation and syntax errors are not automatically executed again; unapproved targets never run',async()=>{
  for(const error of [new SyntaxError('bad syntax'),new TypeError('cannot read undefined')]){let calls=0;const load=createLocalChunkLoader({importer:async()=>{calls++;throw error;}});await assert.rejects(load(path));assert.equal(calls,1);}
  const load=createLocalChunkLoader({importer:()=>{throw Error('should not execute');}});
  for(const value of ['https://evil.test/qianmu-reader.js','../qianmu-reader.js','./index.js','./qianmu-reader.js#other'])await assert.rejects(load(value),/无效/);
});
test('warming does nothing at startup, registers once, loads only targeted chunks and does not spin on failure',async()=>{
  let calls=0;const runtime=createFeatureRuntime({reader:{intent:'.reader',load:async()=>{calls++;throw Error('offline');}},other:async()=>{throw Error('not requested');}});
  const listeners={},root={addEventListener:(key,fn)=>{assert.equal(listeners[key],undefined);listeners[key]=fn;}};runtime.bindIntent(root);runtime.bindIntent(root);assert.equal(calls,0);
  listeners.pointerover({target:{closest:selector=>selector==='.reader'}});await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  listeners.focusin({target:{closest:()=>true}});await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});
test('entering reader during warmup subscribes to completion instead of leaving its loading card stuck',async()=>{
  let finish,renders=0;const runtime=createFeatureRuntime({readerCore:()=>new Promise(r=>finish=r)});
  const c=vm.createContext({reader:null,featureRuntime:runtime,activeTab:'coread',MODAL_ID:'m',document:{getElementById:()=>({classList:{contains:()=>true}})},renderModal:()=>renders++});
  vm.runInContext(['coreadReaderRuntimeStatus','ensureCoreadReaderRuntime','renderCoreadRuntimeGate'].map(section).join('\n'),c);
  const warm=runtime.load('readerCore');await Promise.resolve();assert.match(c.renderCoreadRuntimeGate(),/正在准备/);finish({ready:true});await warm;await new Promise(r=>setImmediate(r));assert.equal(renders,1);assert.equal(c.reader.ready,true);
});
test('ordinary startup and warmup do not migrate dialogue data, seed theaters or generate audio',async()=>{
  const source=await readFile(new URL('../qianmu-focus-library-runtime.js',import.meta.url),'utf8');
  const warm=source.slice(source.indexOf('function warm()'),source.indexOf('async function lines'));
  assert.match(warm,/Promise.all/);assert.doesNotMatch(warm,/snapshot|save\(|resolveNamespace|store\.|generate\(/);
  assert.match(source,/dialoguePromise=null;throw error/);assert.match(source,/Promise.all\(\[loadLocalChunk.*dialogue\(\)/);
});
