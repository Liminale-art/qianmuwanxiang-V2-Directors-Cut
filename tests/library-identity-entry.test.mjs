import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {createFeatureRuntime,createLocalChunkLoader,mountLocalChunkFailure} from '../qianmu-feature-runtime.js';
import {readFile} from 'node:fs/promises';

for(const [entry,key,view,factory,holder] of [
 ['storyboardMountCharacterArchive','characterArchive','characters','createCharacterArchiveController','storyboardCharacterArchiveController'],
 ['storyboardMountComfyLibrary','comfyLibrary','workflows','createComfyLibraryController','storyboardComfyLibraryController'],
 ['storyboardMountComfyPools','comfyPools','comfy-pools','createComfyPoolController','storyboardComfyPoolController'],
])test(`${entry} loads its UI without image admission, retains live identity and refuses stale entry results`,async()=>{
 let namespace='st-user:first',options,finish,mounts=0;
 const state={view,source:'comfy',characterArchive:{}},host={isConnected:true},root={isConnected:true,querySelector:()=>host};
 const identity=async()=>namespace,loaded=[],runtime={[factory]:value=>{options=value;return {mount(){mounts++;},dispose(){}};}};
 const context=vm.createContext({resolveImageAccountNamespace:identity,storyboardState:()=>state,activeTab:'imagegen',[holder]:null,storyboardComfyLibraryError:'',
  featureRuntime:{load:requested=>{loaded.push(requested);assert.equal(requested,key,'ordinary reads must not load admission');return new Promise(resolve=>finish=resolve);}},
  storyboardCharacterArchiveContext(){},storyboardOpenUserAliases(){},storyboardRequestHeaders(){},renderCoreadIdentity(){},toast(){},confirmDialog(){},htmlEscape:String,applyQianmuIcons(){},ttsDownloadBlob(){}});
 vm.runInContext(source(entry),context);
 const abandoned=context[entry](root);host.isConnected=false;finish(runtime);await abandoned;assert.equal(mounts,0);assert.equal(options,undefined);
 host.isConnected=true;const live=context[entry](root);finish(runtime);await live;assert.equal(mounts,1);
 assert.equal(options.resolveNamespace,identity);assert.equal(await options.resolveNamespace(),'st-user:first');namespace='st-user:second';
 assert.equal(await options.resolveNamespace(),'st-user:second','entry callback has no cached account');state.view='create';assert.equal(options.isCurrent(),false);
 assert.deepEqual(loaded,[key,key]);
});

test('ordinary first-open entry sources use the lightweight resolver, while actual admission still loads its ledger runtime',()=>{
 for(const name of ['notesSyncControls','storyboardMountCharacterArchive','storyboardMountComfyLibrary','storyboardMountComfyPools','storyboardMountEnsembleLibrary','storyboardMountVibeLibrary','storyboardMountVibeWorkbenchPreviews']){
  assert.match(source(name),/resolveImageAccountNamespace/);assert.doesNotMatch(source(name),/load\(['"]imageAdmission['"]\)/,name);
 }
 assert.match(source('storyboardImageAdmissionRuntime'),/load\('imageAdmission'\)[\s\S]*createImageAdmission/);
});

for(const [name,view,label] of [
 ['storyboardMountCharacterArchive','characters','角色库'],
 ['storyboardMountComfyLibrary','workflows','工作流库'],
 ['storyboardMountComfyPools','comfy-pools','方案库'],
])test(`${name} removes dead Retry after local import exhaustion but keeps transient Retry`,async()=>{
  const state={view,source:'comfy'},host={isConnected:true,innerHTML:'',retry:null,
    querySelector(selector){return this.innerHTML.includes('sd-local-chunk-retry')&&selector==='.sd-local-chunk-retry'
      ?{addEventListener:(_type,handler)=>this.retry=handler}:null;}};
  const root={isConnected:true,querySelector:()=>host};let currentError={code:'qianmu_chunk_exhausted'},imports=0;
  const context=vm.createContext({storyboardState:()=>state,activeTab:'imagegen',featureRuntime:{load:async()=>{imports++;throw currentError;}},
    mountLocalChunkFailure,storyboardComfyLibraryError:'',storyboardCharacterArchiveController:null,
    storyboardComfyLibraryController:null,storyboardComfyPoolController:null});
  vm.runInContext(source(name),context);
  await context[name](root);assert.equal(imports,1);assert.match(host.innerHTML,/刷新 ST 页面/);assert.match(host.innerHTML,new RegExp(label));
  assert.doesNotMatch(host.innerHTML,/sd-local-chunk-retry/);assert.equal(host.retry,null);
  currentError={code:'qianmu_chunk_load'};host.innerHTML='';
  if(name==='storyboardMountComfyLibrary')context.storyboardComfyLibraryError='';
  await context[name](root);assert.equal(imports,2);assert.match(host.innerHTML,/sd-local-chunk-retry/);
  assert.equal(typeof host.retry,'function');
  host.retry();await new Promise(resolve=>setImmediate(resolve));assert.equal(imports,3);
});

test('workflow rerender uses the same exhausted-aware UI rather than recreating a Retry',()=>{
  const code=source('bindStoryboardTabEvents');
  assert.match(code,/mountLocalChunkFailure\(host,storyboardComfyLibraryError,'工作流库'/);
  assert.doesNotMatch(code,/sd-comfy-library-retry/);
});

test('Vibe library rerender never recreates a dead Retry after eight import failures',async()=>{
  let imports=0;const load=createLocalChunkLoader({pause:async()=>{},importer:async()=>{imports++;throw new TypeError('Failed to fetch dynamically imported module');}});
  const runtime=createFeatureRuntime({vibeLibrary:()=>load('./qianmu-vibe-library-view.js?v=test'),vibeAssets:async()=>({})});
  const state={},notices=[],host={isConnected:true,innerHTML:'',retry:null,querySelector(selector){return selector==='.sd-local-chunk-retry'&&this.innerHTML.includes('sd-local-chunk-retry')?{addEventListener:(_type,handler)=>{this.retry=handler;}}:null;}};
  const root={querySelector:selector=>selector==='.sd-vibe-library-host'?host:null};
  const context=vm.createContext({storyboardState:()=>state,storyboardAdmissionEpoch:0,getChatKey:()=>'',activeTab:'imagegen',featureRuntime:runtime,
    resolveImageAccountNamespace:async()=>'',mountLocalChunkFailure,toast:message=>notices.push(message)});
  vm.runInContext(source('storyboardMountVibeLibrary'),context);
  for(let attempt=1;attempt<=4;attempt++){
    await context.storyboardMountVibeLibrary(root);
    assert.equal(imports,attempt*2,JSON.stringify({notices,html:host.innerHTML}));
    if(attempt<4){assert.match(host.innerHTML,/sd-local-chunk-retry/);assert.equal(typeof host.retry,'function');}
    else{assert.match(host.innerHTML,/刷新 ST 页面/);assert.doesNotMatch(host.innerHTML,/sd-local-chunk-retry/);}
  }
  assert.equal(notices.length,3,'exhausted state uses only the in-panel notice');
  await context.storyboardMountVibeLibrary(root);assert.equal(imports,8);assert.doesNotMatch(host.innerHTML,/sd-local-chunk-retry/);
});

test('shot-group library likewise hides Retry after its eighth local import failure',async()=>{
  let imports=0;const load=createLocalChunkLoader({pause:async()=>{},importer:async()=>{imports++;throw new TypeError('Failed to fetch dynamically imported module');}});
  const runtime=createFeatureRuntime({ensembleLibrary:()=>load('./qianmu-ensemble-ui.js?v=test')});
  const state={},host={isConnected:true,innerHTML:'',querySelector:()=>null},root={querySelector:selector=>selector==='.sd-ensemble-library-host'?host:null};
  const context=vm.createContext({storyboardState:()=>state,storyboardAdmissionEpoch:0,getChatKey:()=>'',featureRuntime:runtime,
    resolveImageAccountNamespace:async()=>'',mountLocalChunkFailure});
  vm.runInContext(source('storyboardMountEnsembleLibrary'),context);
  for(let attempt=1;attempt<=4;attempt++){
    await context.storyboardMountEnsembleLibrary(root);assert.equal(imports,attempt*2);
    if(attempt<4)assert.match(host.innerHTML,/sd-local-chunk-retry/);
    else{assert.match(host.innerHTML,/刷新 ST 页面/);assert.doesNotMatch(host.innerHTML,/sd-local-chunk-retry/);}
  }
  await context.storyboardMountEnsembleLibrary(root);assert.equal(imports,8);
});

test('Comfy workbench joins the bounded local loader with the same shipped URL',async()=>{
  const entry=await readFile(new URL('../index.js',import.meta.url),'utf8');
  assert.match(entry,/comfyWorkbench:\s*\{\s*label: 'Comfy 镜头台',\s*load: \(\) => loadLocalChunk\('\.\/qianmu-comfy-workbench\.js\?v=[^']+'\)/);
});
