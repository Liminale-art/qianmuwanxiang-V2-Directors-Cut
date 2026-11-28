import test from 'node:test';
import assert from 'node:assert/strict';
import {finishCoreadPackageImport,createCoreadImportProgress} from '../qianmu-reader-package.js';
function fixture(){
  const books=[{id:'already-committed'}],nested={profile:'local'},reader={books,enabled:true,fontSize:16,nested},calls=[],notices=[];
  const progress={...createCoreadImportProgress(),ok:1};
  const options={reader,progress,hasPrefs:true,check(){},preparePrefs:()=>({...structuredClone(reader),fontSize:22,nested:{profile:'changed'},newPref:'incoming'}),
    save(){calls.push(['save',reader.fontSize,reader.books]);},refresh(){calls.push(['refresh']);},notify:(text,level)=>notices.push({text,level})};
  return {reader,books,nested,calls,notices,options,run:()=>finishCoreadPackageImport(options)};
}
test('successful preference handoff retains original index identity and only reports requested persistence',()=>{
  const e=fixture(),r=e.run();assert.equal(e.reader.fontSize,22);assert.equal(e.reader.books,e.books);assert.equal(e.reader.enabled,true);
  assert.deepEqual(r,{preferences:'applied',persistence:'requested',view:'updated'});assert.equal(e.calls.filter(c=>c[0]==='save').length,1);
});
test('preparation failure never mutates preferences but still schedules the successfully restored shelf',()=>{
  const e=fixture();e.options.preparePrefs=()=>{throw Error('cannot prepare');};const r=e.run();
  assert.equal(e.reader.fontSize,16);assert.equal(e.reader.nested,e.nested);assert.equal(e.reader.books,e.books);assert.equal(e.calls[0][0],'save');
  assert.equal(r.preferences,'retained');assert.equal(e.notices[0].level,'warning');
});
for(const alwaysFail of [false,true])test('throwing save restores old preference references, not originals; bounded compensation '+alwaysFail,()=>{
  const e=fixture();let saves=0;e.options.save=()=>{e.calls.push(e.reader.fontSize);if(++saves===1||alwaysFail)throw Error('host failure');};
  const r=e.run();assert.deepEqual(e.calls.slice(0,2),[22,16]);assert.equal(saves,2);assert.equal(e.reader.nested,e.nested);
  assert.equal(e.reader.fontSize,16);assert.equal(e.reader.books,e.books);assert.equal(e.reader.newPref,undefined);
  assert.equal(r.persistence,'uncertain');assert.equal(r.preferences,'retained');assert.equal(e.notices[0].level,'error');assert.match(e.notices[0].text,/设置保存结果未确认/);
});
test('a failed book no longer blocks the package preferences; each part reports its own outcome',()=>{
  const e=fixture();e.options.progress.failed=1;
  const r=e.run();assert.equal(r.preferences,'applied');assert.equal(e.reader.fontSize,22);assert.equal(e.reader.newPref,'incoming');assert.equal(e.calls[0][2],e.books);
  assert.match(e.notices[0].text,/失败 1 项[\s\S]*阅读偏好已恢复。/);assert.equal(e.notices[0].level,'warning');
});
test('unreadable package preferences are reported while the books stay restored',()=>{
  const e=fixture();e.options.hasPrefs=false;e.options.progress.prefsUnreadable=1;
  const r=e.run();assert.equal(r.preferences,'unchanged');assert.equal(e.reader.fontSize,16);assert.match(e.notices[0].text,/包内阅读偏好无法读取，未应用。/);assert.equal(e.notices[0].level,'warning');
});
test('the live reading log is reloaded after preferences change and again after a compensating restore',()=>{
  const e=fixture(),seen=[];e.options.reload=()=>seen.push(e.reader.fontSize);
  e.run();assert.deepEqual(seen,[22]);
  const f=fixture(),later=[];let saves=0;f.options.reload=()=>later.push(f.reader.fontSize);f.options.save=()=>{if(++saves===1)throw Error('host failure');};
  f.run();assert.deepEqual(later,[22,16]);
  const g=fixture();g.options.reload=()=>{throw Error('reload failed');};
  const r=g.run();assert.equal(r.preferences,'applied');assert.match(g.notices[0].text,/阅读记录未能刷新/);assert.equal(g.notices[0].level,'warning');
});
test('view failure is reported after successful handoff and does not save or import twice',()=>{
  const e=fixture();e.options.refresh=()=>{throw Error('view failure');};const r=e.run();
  assert.equal(e.reader.fontSize,22);assert.equal(r.view,'incomplete');assert.equal(r.preferences,'applied');
  assert.equal(e.calls.length,1);assert.equal(e.notices.length,1);assert.equal(e.notices[0].level,'warning');assert.match(e.notices[0].text,/不必重复导入/);
});
test('a changed owner during preparation cannot start handoff, saving or rendering',()=>{
  const e=fixture();let current=true;e.options.check=()=>{if(!current)throw Error('stale');};e.options.preparePrefs=()=>{current=false;return {fontSize:22};};
  assert.throws(e.run,/stale/);assert.equal(e.reader.fontSize,16);assert.deepEqual(e.calls,[]);assert.deepEqual(e.notices,[]);
});
test('an incomplete synchronous compensation cannot queue mixed settings or refresh a misleading view',()=>{
  const e=fixture();let value=16;
  Object.defineProperty(e.reader,'fontSize',{enumerable:true,get:()=>value,set:next=>{if(next===16)throw Error('cannot restore');value=next;}});
  e.options.save=()=>{throw Error('save failed');};const r=e.run();
  assert.equal(r.preferences,'incomplete');assert.equal(r.persistence,'uncertain');assert.equal(r.view,'skipped');assert.deepEqual(e.calls,[]);
  assert.equal(e.reader.books,e.books);assert.match(e.notices[0].text,/还原未完成/);
});
