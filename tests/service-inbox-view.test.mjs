import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function fixture(rows){
  const host={dataset:{},isConnected:true,innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null},calls=[];
  const root={querySelector:()=>host};let c;
  const service={list:async()=>{calls.push('list');return rows;},catalog:async()=>{calls.push('catalog');return {namespace:'synthetic',originals:rows,tasks:rows,totals:{count:rows.length,tasks:rows.length,imageBytes:1024,metadataBytes:0,temporaryBytes:0,reservedBytes:4096}};}};
  c=vm.createContext({settings:{},storyboardAdmissionEpoch:0,getChatKey:()=> 'synthetic',uid:()=> 'id',storyboardImageServiceRuntime:async()=>service,
    htmlEscape:escape,formatDateTime:()=> 'synthetic-time',formatStorageBytes:value=>String(value)+' B',applyQianmuIcons:()=>calls.push('icons')});
  vm.runInContext(storyboardFunctionSource('storyboardPaintServiceInbox'),c);
  return {c,host,root,calls,service,paint:server=>c.storyboardPaintServiceInbox(root,{server})};
}
test('NAI keeps result-uncertain caution and review in view while optional capacity is initially folded',async()=>{
  const f=fixture([{attemptId:'original',status:'uncertain',model:'<unsafe>',snapshot:{profile:{model:'<unsafe>'}},createdAt:1}]);
  await f.paint(true);const visible=f.host.innerHTML.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
  assert.match(f.host.innerHTML,/<details class="sd-service-inbox-details"><summary>存储详情<\/summary>/);
  assert.doesNotMatch(f.host.innerHTML,/<details[^>]*\sopen|<unsafe>/);
  assert.doesNotMatch(visible,/等待预留|1024 B|4096 B/);assert.match(visible,/原请求结果待核查，请勿直接重新生成，以免重复付费/);
  assert.match(visible,/data-service-review-index="0">核查原请求/);assert.match(visible,/data-service-receive-index="0" disabled/);
  assert.match(visible,/data-service-scope="server" aria-pressed="true"/);assert.deepEqual(f.calls,['catalog','icons']);
});
test('NAI completed receipts do not get a speculative risk warning, and original scope checks still discard late data',async()=>{
  const f=fixture([{attemptId:'complete',status:'succeeded',resultAvailable:true,model:'synthetic',createdAt:1,snapshot:{profile:{}}}]);
  await f.paint(false);assert.doesNotMatch(f.host.innerHTML,/sd-service-inbox-caution|sd-service-inbox-details/);assert.deepEqual(f.calls,['list','icons']);
  const before=f.host.innerHTML,load=f.service.catalog;f.service.catalog=async()=>{const result=await load();f.c.storyboardAdmissionEpoch++;return result;};
  await f.paint(true);assert.equal(f.host.innerHTML,before);assert.deepEqual(f.calls,['list','icons','catalog']);
});
