import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readCoreadPackageFile,coreadPackageSafeKey,COREAD_PACKAGE_LIMITS,createCoreadImportProgress,coreadImportProgressText} from '../qianmu-reader-package.js';
import {isPlainObject,clone} from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
const file=text=>({size:Buffer.byteLength(text),text:async()=>text});
test('legacy reader packs retain original content and all supported v1-v5 variants',async()=>{
  for(const version of [undefined,1,2,3,4,5]){
    const value={type:'qianmu-coread',version,books:[{meta:{id:'book'},fullText:'__proto__ is ordinary prose'}],prefs:{fontSize:18}};
    assert.deepEqual(await readCoreadPackageFile(file(JSON.stringify(value))),JSON.parse(JSON.stringify(value)));
  }
});
test('unreadably large input is rejected before reading or allocating its contents',async()=>{
  let reads=0;await assert.rejects(()=>readCoreadPackageFile({size:COREAD_PACKAGE_LIMITS.bytes+1,text(){reads++;}}),/256 MiB/);assert.equal(reads,0);
});
test('dangerous keys, duplicate fields, excessive nesting and invalid envelopes fail closed',async()=>{
  const invalid=[
    '{"type":"qianmu-coread","books":[],"prefs":{"__proto__":{"polluted":true}}}',
    '{"type":"qianmu-coread","books":[],"prefs":{"\\u0063onstructor":{}}}',
    '{"type":"qianmu-coread","books":[],"books":[1]}',
    '{"type":"qianmu-coread","books":[],"prefs":{"x":1e999}}',
    JSON.stringify({type:'qianmu-coread',books:[],version:6}),
    JSON.stringify({type:'qianmu-coread',books:[],audio:{}}),
    JSON.stringify({type:'qianmu-coread',books:[],prefs:[]}),
    '['.repeat(41)+'0'+']'.repeat(41),
  ];for(const text of invalid)await assert.rejects(()=>readCoreadPackageFile(file(text)));
});
test('actual merge and export helpers cannot mutate prototypes even if called without the reader',()=>{
  const c=vm.createContext({isPlainObject,clone,coreadPackageSafeKey});
  vm.runInContext(['coreadIsCredentialKey','coreadSanitizePackageValue','coreadMergePackageValue'].map(source).join('\n'),c);
  const result=vm.runInContext(`const bad=JSON.parse('{"__proto__":{"qianmuAuditMarker":true},"constructor":{},"safe":"keep"}');
    const merged=coreadMergePackageValue({},bad),clean=coreadSanitizePackageValue(bad);
    ({polluted:({}).qianmuAuditMarker===true,merged:JSON.stringify(merged),clean:JSON.stringify(clean)});`,c);
  assert.equal(result.polluted,false);assert.equal(result.merged,'{"safe":"keep"}');assert.equal(result.clean,'{"safe":"keep"}');
});
test('the actual import rejects unsafe packs before any confirmation or storage action',async()=>{
  const notices=[],reader={},c=vm.createContext({createCoreadImportProgress,coreadImportProgressText,settings:{},storyboardAdmissionEpoch:1,coread:()=>reader,configRestoreActivity:()=>({}),readCoreadPackageFile,toast:m=>notices.push(m)});
  vm.runInContext(source('coreadImportDataFile'),c);
  await c.coreadImportDataFile(file('{"type":"qianmu-coread","books":[],"prototype":{}}'));
  assert.match(notices[0],/未写入内容/);
});
