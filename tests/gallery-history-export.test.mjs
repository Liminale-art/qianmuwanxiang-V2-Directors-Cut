import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {historyExportFixture,png} from './helpers/history-export-fixture.mjs';
import {inspectHistoricalStoryboardBundle} from '../qianmu-historical-storyboard-bundle.js';
import {openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {createGalleryCatalogManagement} from '../qianmu-gallery-catalog-management.js';
const wait=()=>new Promise(done=>setTimeout(done,20));

test('confirmed exact historical chat downloads one verified scoped QMB from real saved sources and original bytes',async t=>{
  const f=await historyExportFixture(t),before=await readFile(f.file),result=await f.run();
  assert.equal(result.count,2);assert.equal(result.summary.restoreSupported,false);assert.equal(f.downloads.length,1);assert.match(result.filename,/^qianmu-history-originals-2-\d+\.qmb$/);
  const restored=await inspectHistoricalStoryboardBundle(f.downloads[0].blob);assert.deepEqual(restored.source.saved,f.saved);
  assert.deepEqual(restored.source.selection,{ids:['inline','server'],total:2});
  const opened=await openStoryboardBundle(f.downloads[0].blob),image=opened.manifest.entries.find(row=>row.id.startsWith('image:'));
  assert.deepEqual(Buffer.from((await opened.read(image.id)).bytes),png);assert.deepEqual(await readFile(f.file),before);
  assert.deepEqual(f.progress.map(row=>row.phase),['source','images','images','packing','saving']);
  assert.ok(f.calls.every(row=>row.credentials==='same-origin'&&row.cache==='no-store'&&row.redirect==='error'&&!row.headers.Authorization));
  for(const row of f.calls){assert.deepEqual(row.body.target,f.target);assert.ok(!Object.hasOwn(row.body,'snapshot'));}
  assert.deepEqual(f.mediaCalls.map(row=>row.url),['/user/images/inline.png','/user/images/server.png']);
  assert.ok(f.mediaCalls.every(row=>row.credentials==='same-origin'&&row.redirect==='error'&&row.cache==='no-store'&&!row.headers));
});

test('explicit confirmation and one exact source are mandatory before any source or image access',async t=>{
  const f=await historyExportFixture(t);
  for(const options of [{confirmed:false},{confirmed:1},{source:{}},{source:{ownerKey:'char:Alice.png'}},{source:{ownerKey:'char:../Alice.png',chatKey:'chat-one'}},
    {source:{ownerKey:'char:Alice.png',chatKey:'chat-one',count:1}},{save:null},{resolveNamespace:null},{guard:null},{timeoutMs:Infinity}])await assert.rejects(f.run(options));
  assert.equal(f.calls.length,0);assert.equal(f.mediaCalls.length,0);assert.equal(f.downloads.length,0);
});

test('other account or identically named chat in another role never falls back to current context',async t=>{
  const f=await historyExportFixture(t);f.account='st-user:bob';await assert.rejects(f.run(),/账户/);assert.equal(f.calls.length,0);
  f.account='st-user:alice';await assert.rejects(f.run({source:{ownerKey:'char:Bob.png',chatKey:'chat-one'}}));assert.equal(f.mediaCalls.length,0);assert.equal(f.downloads.length,0);
});

test('no saved gallery is not fabricated but a genuinely saved empty gallery retains original drafts',async t=>{
  const f=await historyExportFixture(t);delete f.saved.storyboardImages;await f.write();await assert.rejects(f.run(),/没有已保存/);assert.equal(f.downloads.length,0);
  f.rows.splice(0);f.saved.storyboardImages=f.rows;await f.write();const result=await f.run();assert.equal(result.count,0);assert.equal(f.mediaCalls.length,0);
  assert.deepEqual((await inspectHistoricalStoryboardBundle(f.downloads[0].blob)).source.saved.characterDrafts,f.saved.characterDrafts);
});

test('over 400 saved records fails before reading recipes or images instead of exporting a catalog subset',async t=>{
  const f=await historyExportFixture(t);f.rows.splice(0,f.rows.length,...Array.from({length:401},(_,i)=>({id:'r'+i,createdAt:i,url:'/user/images/a.png'})));await f.write();
  await assert.rejects(f.run(),/400/);assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.endsWith('/receipt'));assert.equal(f.downloads.length,0);assert.equal(f.mediaCalls.length,0);
});

test('missing or legacy-local-only recipe stops whole export before any original read and does not write archives',async t=>{
  const f=await historyExportFixture(t);f.rows.push({id:'lost',createdAt:3,snapshotRef:'old-device',url:'/user/images/lost.png'});await f.write();
  await assert.rejects(f.run(),/旧设备引用/);assert.equal(f.mediaCalls.length,0);assert.equal(f.downloads.length,0);assert.ok(f.calls.every(row=>!row.url.endsWith('/preserve')));
});

test('external original URL is never fetched and missing second image never creates a partial download',async t=>{
  const f=await historyExportFixture(t);f.rows[0].url='https://external.invalid/image.png';await f.write();
  await assert.rejects(f.run());assert.equal(f.mediaCalls.length,0);assert.equal(f.downloads.length,0);
  f.rows[0].url='/user/images/inline.png';await f.write();let n=0;
  await assert.rejects(f.run({loadImage:async(url,opts)=>{if(++n===2)throw Error('missing second');return f.loadImage(url,opts);}}),/missing second/);assert.equal(f.downloads.length,0);
});

test('changed draft during actual image reading rejects final bundle and preserves saved files',async t=>{
  const f=await historyExportFixture(t);let n=0;
  await assert.rejects(f.run({loadImage:async(url,opts)=>{const image=await f.loadImage(url,opts);if(++n===1){f.saved.characterDrafts.items[0].future.note='later';await f.write();}return image;}}),/变化/);
  assert.equal(f.downloads.length,0);assert.equal(f.saved.characterDrafts.items[0].future.note,'later');
});

test('user cancel, parent close and whole timeout settle stalled image reads without late download',async t=>{
  const f=await historyExportFixture(t);
  for(const mode of ['user','parent','timeout']){
    let started,release;const ready=new Promise(done=>started=done),gate=new Promise(done=>release=done),controller=new AbortController();
    const rejected=assert.rejects(f.run({...(mode==='parent'?{parentSignal:controller.signal}:{signal:controller.signal}),timeoutMs:mode==='timeout'?180:5000,
      loadImage:async()=>{started();await gate;return {blob:new Blob([png],{type:'image/png'})};}}),/取消|超时|停止/);
    await ready;if(mode!=='timeout')controller.abort();await rejected;const calls=f.calls.length;release();await wait();assert.equal(f.calls.length,calls);assert.equal(f.downloads.length,0);
  }
});

test('already aborted request and stalled account resolver are bounded before any source reads',async t=>{
  const f=await historyExportFixture(t),c=new AbortController();c.abort();await assert.rejects(f.run({signal:c.signal}),/停止|取消/);
  let release;await assert.rejects(f.run({timeoutMs:100,resolveNamespace:()=>new Promise(done=>release=done)}),/超时/);release('st-user:alice');await wait();
  assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0);
});

test('account change at saving boundary prevents browser handoff; blocked handoff is not success',async t=>{
  const f=await historyExportFixture(t);await assert.rejects(f.run({onProgress:value=>{if(value.phase==='saving')f.account='st-user:bob';}}),/账户/);assert.equal(f.downloads.length,0);
  f.account='st-user:alice';await assert.rejects(f.run({save:()=>{throw Error('browser blocked');}}),/browser blocked/);
});

test('old backend failure remains visible without current-config fallback or image access',async t=>{
  const f=await historyExportFixture(t),request=f.fetch;
  await assert.rejects(f.run({fetchImpl:(url,options)=>url.endsWith('/state')?Promise.resolve(new Response('old',{status:404})):request(url,options)}),/更新千幕配套后端/);
  assert.equal(f.mediaCalls.length,0);assert.equal(f.downloads.length,0);
});

test('manager delegates confirmed export without reading catalog rows; locks cleanup and cancels on close',async t=>{
  const f=await historyExportFixture(t);let closed=0,started,release;
  const ready=new Promise(done=>started=done),gate=new Promise(done=>release=done);
  const session=await createGalleryCatalogManagement({resolveNamespace:async()=>f.account,headers:f.options().headers,
    createStore:()=>({close(){closed++;},inspectPage:()=>assert.fail('catalog is not original source'),clearScopeBatch:()=>assert.fail('no cleanup')})});
  const rejected=assert.rejects(session.exportHistory(f.exportOptions().source,f.exportOptions().save,{confirmed:true,fetchImpl:f.fetch,
    loadImage:async()=>{started();await gate;return {blob:new Blob([png])};}}),/取消|停止/);
  await ready;await assert.rejects(session.inspect(),/正在处理/);await assert.rejects(session.exportHistory(f.exportOptions().source,()=>{}),/正在处理/);
  await assert.rejects(session.clear({}, {confirmed:true}));session.close();await rejected;release();await wait();assert.ok(closed>=1);assert.equal(f.downloads.length,0);
});

test('manager export resolver stalled after opening remains cancellable, with no unbounded preflight outside export lifetime',async t=>{
  const f=await historyExportFixture(t);let stalled=false,release;
  const session=await createGalleryCatalogManagement({resolveNamespace:()=>stalled?new Promise(done=>release=done):Promise.resolve(f.account),createStore:()=>({close(){}})});
  stalled=true;const rejected=assert.rejects(session.exportHistory(f.exportOptions().source,()=>assert.fail('save'),{confirmed:true,fetchImpl:f.fetch,timeoutMs:100}),/超时/);
  await rejected;release?.(f.account);session.close();await wait();assert.equal(f.calls.length,0);
});

test('manager captures exact chat scope and confirmation before lazy loading, not a mutable caller object',async t=>{
  const f=await historyExportFixture(t),source=f.exportOptions().source,options={confirmed:true,fetchImpl:f.fetch,loadImage:f.loadImage};
  const session=await createGalleryCatalogManagement({resolveNamespace:async()=>f.account,headers:f.options().headers,createStore:()=>({close(){}})});t.after(()=>session.close());
  const pending=session.exportHistory(source,f.exportOptions().save,options);source.ownerKey='char:Bob.png';options.confirmed=false;
  assert.equal((await pending).count,2);assert.equal(f.downloads.length,1);
});
