import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,readdir,stat} from 'node:fs/promises';
import {createLocalChunkLoader,createFeatureRuntime} from '../qianmu-feature-runtime.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {QIANMU_IDLE_CHUNKS} from '../qianmu-idle-preload.js';
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

test('library and assistant prewarming shares the exact explicit-click code entries and bounded recovery',async()=>{
  const urls=[],module={ready:true};const loader=createLocalChunkLoader({pause:async()=>{},importer:async url=>{urls.push(url);return module;}});
  for(const url of QIANMU_IDLE_CHUNKS){assert.equal(await loader(url),module);assert.equal(await loader(url),module);}
  assert.equal(urls.length,QIANMU_IDLE_CHUNKS.length);assert.equal(new Set(urls).size,urls.length);
  assert.match(QIANMU_IDLE_CHUNKS[0],/prose-assistant-panel/);assert.match(QIANMU_IDLE_CHUNKS[1],/prose-assistant-native/);
  const entry=await readFile(new URL('../index.js',import.meta.url),'utf8'),runtimeUrl=entry.match(/from '(\.\/qianmu-feature-runtime\.js\?v=[^']+)'/)[1];
  for(const file of ['qianmu-prose-assistant-floor.js','qianmu-prose-floor-tools.js','qianmu-text-collection-floor.js','qianmu-idle-preload.js','qianmu-focus-library-runtime.js']){
    const source=await readFile(new URL('../'+file,import.meta.url),'utf8');assert.ok(source.includes(`from '${runtimeUrl}'`),file+' must share the entry loader instance');
  }
  for(const url of QIANMU_IDLE_CHUNKS.filter(url=>/character-archive|vibe-library|ensemble-ui|comfy-(?:library|pool|route)/.test(url)))assert.ok(entry.includes(`loadLocalChunk('${url}')`),url+' must match the click URL');
});

test('character library root import failures retry through a shared in-flight load, not the same cached failed URL',async()=>{
  let calls=0;const urls=[];const load=createLocalChunkLoader({pause:async()=>{},importer:async url=>{calls++;urls.push(url);if(calls<=2)throw new TypeError('Failed to fetch dynamically imported module');return {ok:true};}});
  const runtime=createFeatureRuntime({characterArchive:()=>load('./qianmu-character-archive-view.js?v=test')});
  await assert.rejects(runtime.load('characterArchive'),error=>error.code==='qianmu_chunk_load'&&/刷新页面/.test(error.message));assert.equal(calls,2);
  const [first,second]=await Promise.all([runtime.load('characterArchive'),runtime.load('characterArchive')]);assert.equal(first,second);assert.equal(calls,3);
  assert.equal(new Set(urls).size,3);assert.equal(new URL(urls[2]).searchParams.get('qm_retry'),'2');
});

test('character first-use static graph excludes workflow backup and legacy reconciliation',async()=>{
  const seen=new Set();async function visit(url){const key=url.href.split('?')[0];if(seen.has(key))return;seen.add(key);const source=await readFile(new URL(key),'utf8');
    for(const found of source.matchAll(/(?:import|export)\s+(?:[^;\n]+?\s+from\s+)?['"](\.\/[^'"]+)['"]/g))await visit(new URL(found[1],key));
  }
  await visit(new URL('../qianmu-character-archive-view.js',import.meta.url));
  assert.ok(seen.size<=30,`角色库首开静态依赖回涨：${seen.size}`);
  for(const name of ['qianmu-comfy-library-backup.js','qianmu-character-source-native.js','qianmu-character-reconciliation.js'])assert.ok(![...seen].some(file=>file.endsWith('/'+name)),name);
});

test('Comfy library cold graph does not eagerly load the explicit backup package parser and its transfer graph',async()=>{
  const seen=new Set();async function visit(url){const key=url.href.split('?')[0];if(seen.has(key))return;seen.add(key);const source=await readFile(new URL(key),'utf8');
    for(const found of source.matchAll(/(?:import|export)\s+(?:[^;\n]+?\s+from\s+)?['"](\.\/[^'"]+)['"]/g))await visit(new URL(found[1],key));
  }
  await visit(new URL('../qianmu-comfy-library-view.js',import.meta.url));
  assert.ok(seen.size<=55,`工作流库首开依赖回涨：${seen.size}`);
  for(const name of ['qianmu-storyboard-package-input.js','qianmu-storyboard-package-assets.js'])assert.ok(![...seen].some(file=>file.endsWith('/'+name)),name);
});

test('all production local-loader calls, injected history loaders and idle chunks are explicit shipped modules',async()=>{
  const root=new URL('../',import.meta.url),release=JSON.parse(await readFile(new URL('release-files.json',root),'utf8'));
  const shipped=new Set(release.files),entries=await readdir(root,{withFileTypes:true});
  // Audit all root production JS, including accidental unshipped callers, plus
  // any declared nested production module. Never scan tests/scripts/dist.
  const files=[...new Set([...entries.filter(entry=>entry.isFile()&&/\.m?js$/.test(entry.name)).map(entry=>entry.name),
    ...release.files.filter(file=>/\.m?js$/.test(file)&&!/(?:^|\/)(?:tests|scripts|dist|node_modules)\//.test(file))])];
  const sources=new Map(await Promise.all(files.map(async file=>[file,await readFile(new URL(file,root),'utf8')])));
  const calls=[],indirect=[],computed=[];
  for(const [file,source] of sources){
    assert.doesNotMatch(source,/\bloadLocalChunk\s+as\s+\w+/,`${file}: register renamed loader bindings in this contract before adding an alias`);
    for(const match of source.matchAll(/\bloadLocalChunk\s*\(\s*([^)]*)\)/g)){
      const argument=match[1].trim(),literal=argument.match(/^(['"])([^'"\r\n]+)\1$/);
      if(literal)calls.push({file,url:literal[2]});else computed.push({file,argument});
    }
    for(const match of source.matchAll(/\b(\w+)\s*:\s*(?:\w+\.)?loadLocalChunk\b/g))indirect.push(`${file}:${match[1]}`);
  }
  // Nonliteral and injected paths must be explicitly accounted for, not
  // silently ignored by the literal-call scan when a new feature is added.
  assert.deepEqual(computed,[{file:'qianmu-idle-preload.js',argument:'url'}]);
  assert.deepEqual(indirect,['index.js:load']);
  assert.match(sources.get('index.js'),/loadLocalChunk\(['"]\.\/qianmu-historical-gallery-consumer\.js[^'"]*['"]\)\.then\([\s\S]{0,250}\bload:\s*loadLocalChunk/);
  const historical=sources.get('qianmu-historical-gallery-consumer.js'),historyCalls=[...historical.matchAll(/\bload\(\s*(['"])([^'"]+)\1\s*\)/g)];
  assert.equal(historyCalls.length,1,'The injected historical-gallery adapter must remain part of the loader contract');
  calls.push(...historyCalls.map(match=>({file:'qianmu-historical-gallery-consumer.js',url:match[2]})),
    ...QIANMU_IDLE_CHUNKS.map(url=>({file:'qianmu-idle-preload.js',url})));
  const imported=[],value={ready:true},load=createLocalChunkLoader({importer:async url=>{imported.push(url);return value;}});
  const expected=new Set(),canonical=new Map();
  for(const call of calls){
    assert.match(call.url,/^\.\/[a-z0-9-]+\.js(?:\?v=[a-z0-9.-]+)?$/,`${call.file}: only an explicit owned module URL is allowed`);
    const filename=call.url.slice(2).split('?')[0];assert.ok(shipped.has(filename),`${call.file}: ${filename} is missing from release-files.json`);
    if(canonical.has(filename))assert.equal(call.url,canonical.get(filename),`${call.file}: ${filename} must share one canonical URL across direct, injected and idle loaders`);
    else canonical.set(filename,call.url);
    assert.ok((await stat(new URL(filename,root))).isFile(),`${filename} must exist locally`);
    expected.add(new URL(call.url,root).href);
    assert.equal(await load(call.url),value,`${call.file}: its actual module URL must pass the runtime allowlist`);
  }
  assert.deepEqual(new Set(imported),expected);assert.equal(imported.length,expected.size,'shared URLs import once');
  const allowlist=sources.get('qianmu-feature-runtime.js').match(/const localChunkNames=new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(allowlist);
  const names=[...allowlist[1].matchAll(/['"]([^'"]+)['"]/g)].map(match=>match[1]);
  assert.equal(new Set(names).size,names.length,'No duplicate or ambiguous module names');
  const calledNames=new Set(calls.map(call=>call.url.slice(2).split('?')[0]));
  assert.deepEqual(new Set(names),calledNames,'Allow only actual owned production call targets, not speculative module names');
});

test('new gallery targets retain bounded retry and never execute external or error-supplied URLs',async()=>{
  const names=['qianmu-storage-gallery-check.js','qianmu-gallery-recipe-review-view.js','qianmu-gallery-local-recipe-current.js',
    'qianmu-storyboard-export-scope-view.js','qianmu-gallery-archive-view.js','qianmu-gallery-location-view.js',
    'qianmu-gallery-directory-view.js','qianmu-historical-gallery-consumer.js'];
  for(const name of names){
    const urls=[],value={ready:true},load=createLocalChunkLoader({pause:async()=>{},importer:async url=>{
      urls.push(url);if(urls.length===1)throw new TypeError('Failed to fetch dynamically imported module: https://untrusted.invalid/payload.js');return value;
    }});
    assert.deepEqual(await Promise.all([load('./'+name+'?v=contract'),load('./'+name+'?v=contract')]),[value,value]);
    assert.equal(urls.length,2);assert.equal(new URL(urls[1]).searchParams.get('qm_retry'),'1');
    assert.ok(urls.every(url=>url.split('?')[0]===new URL('../'+name,import.meta.url).href));
    for(const invalid of ['https://untrusted.invalid/'+name,'../'+name,'./not-owned.js','./'+name+'#other'])await assert.rejects(load(invalid),/无效/);
    assert.equal(urls.length,2,'Invalid input cannot reach the importer');
  }
});
