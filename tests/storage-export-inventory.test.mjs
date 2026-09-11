import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';

for(const [name,method] of [['exportPinnedNotesBackup','listNotes'],['exportTtsFavoritesBackup','listFavorites']]){
  test(name+' requests committed inventory and never labels a failed read as an empty library',async()=>{
    const notices=[],c=vm.createContext({blobStore:{[method]:async options=>{assert.equal(options.requireCommit,true);throw Error('inventory interrupted');}},toast:(...args)=>notices.push(args)});
    vm.runInContext(source(name),c);await c[name]();
    assert.equal(notices.length,1);assert.equal(notices[0][1],'error');assert.match(notices[0][0],/inventory interrupted/);assert.doesNotMatch(notices[0][0],/没有可导出/);
  });
  test(name+' treats only a successfully scanned empty library as empty',async()=>{
    const notices=[],c=vm.createContext({blobStore:{[method]:async options=>{assert.equal(options.requireCommit,true);return [];}},toast:(...args)=>notices.push(args)});
    vm.runInContext(source(name),c);await c[name]();assert.equal(notices.length,1);assert.equal(notices[0][1],'info');assert.match(notices[0][0],/没有可导出/);
  });
}
