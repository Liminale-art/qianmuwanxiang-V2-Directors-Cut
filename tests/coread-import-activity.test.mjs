import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';
function fixture(){
  const notices=[],calls=[];const c=vm.createContext({settings:{coread:{}},storyboardAdmissionEpoch:1,toast:m=>notices.push(m),
    readCoreadPackageFile:async()=>({books:[]}),confirmDialog:async()=>true,blobStore:{blobStoreAvailable:()=>true},isPlainObject:()=>false,
    base64ToBlob(){},MODULE_NAME:'fixture',saveSettings(){calls.push('save');},renderModal(){calls.push('render');},rerenderMoreIfOpen(){},
    applyCoreadPackageData:async()=>{calls.push('write');return {ok:0,chatOk:0,imageOk:0,vectorOk:0,audioOk:0,logOk:0};}});
  c.coread=()=>c.settings.coread;c.configRestoreActivity=()=>({transfer:c.coreadImportDataFile.busy||c.storageCleanupSession.busy});
  vm.runInContext(source('coreadImportDataFile'),c);
  c.storageCleanupSession=createStorageCleanupSession({owner:()=>c.settings,scope:()=>1,epoch:()=>c.storyboardAdmissionEpoch,activity:()=>({transfer:c.coreadImportDataFile.busy})});
  return {c,calls,notices,run:()=>c.coreadImportDataFile({})};
}
for(const phase of ['read','confirm'])test('reader '+phase+' holds cleanup lock and rejects old-owner confirmations',async()=>{
  for(const change of ['owner','reader','epoch']){
    const e=fixture();let release;e.c[phase==='read'?'readCoreadPackageFile':'confirmDialog']=()=>new Promise(r=>release=r);
    const pending=e.run();await new Promise(r=>setImmediate(r));assert.equal(e.c.coreadImportDataFile.busy,true);
    assert.equal(e.c.storageCleanupSession.begin({isConnected:true}),null);await e.run();
    if(change==='owner')e.c.settings={coread:{}};if(change==='reader')e.c.settings.coread={};if(change==='epoch')e.c.storyboardAdmissionEpoch++;
    release(phase==='read'?{books:[]}:true);await pending;assert.deepEqual(e.calls,[]);assert.equal(e.c.coreadImportDataFile.busy,false);assert.match(e.notices.at(-1),/状态已变化/);
  }
});
test('cancellation and invalid input release reader activity, while an existing cleanup is preserved',async()=>{
  const e=fixture(),token=e.c.storageCleanupSession.begin({isConnected:true});await e.run();assert.deepEqual(e.calls,[]);assert.equal(e.c.storageCleanupSession.busy,true);token.release();
  e.c.readCoreadPackageFile=async()=>{throw Error('bad file');};await e.run();assert.equal(e.c.coreadImportDataFile.busy,false);
  e.c.readCoreadPackageFile=async()=>({books:[]});e.c.confirmDialog=async()=>false;await e.run();assert.deepEqual(e.calls,[]);assert.equal(e.c.coreadImportDataFile.busy,false);
});
test('a completed writer cannot merge preferences or repaint a different reader owner',async()=>{
  const e=fixture();let release,captured;e.c.applyCoreadPackageData=async(data,options)=>{assert.equal(typeof options.check,'function');options.check();captured=options.coread();await new Promise(r=>release=r);return {ok:1};};
  const old=e.c.settings.coread,pending=e.run();await new Promise(r=>setImmediate(r));e.c.settings={coread:{newer:true}};
  release();await pending;assert.equal(captured,old);assert.deepEqual(e.calls,[]);assert.equal(e.c.coreadImportDataFile.busy,false);assert.match(e.notices.at(-1),/已写入内容保留/);
});
