import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';

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
