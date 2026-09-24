import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantManagerFixture,account} from './helpers/assistant-history-manager-fixture.mjs';
test('manager lazily pages eight complete native histories and verifies opaque file references',async t=>{
 const f=await assistantManagerFixture(t,10);assert.equal(f.loads,0);const p=await f.manager.page();assert.equal(p.rows.length,8);assert.equal(p.nextOffset,8);assert.ok(p.rows.every(row=>row.status==='ready'&&row.owner==='A'&&row.count===1));
 const second=await f.manager.page(p.nextOffset,p.snapshot);assert.equal(second.rows.length,2);assert.equal(second.nextOffset,null);assert.equal(f.writes,0);await assert.rejects(f.manager.view(p.rows[0].id));
});
test('full backup preserves multiline private questions/replies/references and never uploads or truncates',async t=>{
 const f=await assistantManagerFixture(t,0),reply='正文\n'.repeat(15000)+'END',record=await f.add('A',[{id:1,user:'<img src=x>\n问题',assistant:reply,status:'complete',reference:{floor:2,replyId:'swipe:1',mode:'floor',range:{start:0,end:100}}}]);
 const p=await f.manager.page(),before=new Map(f.transport.files),backup=JSON.parse(await f.manager.backup([p.rows[0].id]));assert.equal(backup.schema,'qianmu.assistant-history-backup.v1');assert.equal(backup.account,account);assert.deepEqual(backup.items[0].history,record.state);assert.deepEqual(f.transport.files,before);assert.equal(f.writes,0);
});
test('view returns isolated copies; offstage histories remain distinguishable and no model calls occur',async t=>{
 const f=await assistantManagerFixture(t,0);await f.add('offstage');const p=await f.manager.page();assert.equal(p.rows[0].title,'场外会话');const copy=await f.manager.view(p.rows[0].id);copy.rows[0].assistant='changed';assert.notEqual((await f.manager.view(p.rows[0].id)).rows[0].assistant,'changed');assert.ok(f.transport.calls.every(call=>call.path.startsWith('/user/files/')||call.path==='/api/files/upload'));
});
test('clear affects only explicitly selected current histories and preserves every old immutable body',async t=>{
 const f=await assistantManagerFixture(t),before=new Map(f.transport.files),p=await f.manager.page(),selected=p.rows[0].id;let confirmations=0;
 const result=await f.manager.clear([selected],async(title,text)=>{confirmations++;assert.match(text,/旧不可变版本仍保留/);assert.match(text,/不保证多端/);return true;});
 assert.equal(result.status,'complete');assert.equal(result.confirmed,1);assert.equal(result.retainedVersions,true);assert.equal(confirmations,1);assert.equal(f.writes,1);
 assert.equal((await f.store.read(selected)).value.rows.length,0);assert.equal((await f.store.read(p.rows[1].id)).value.rows.length,1);
 for(const [name,text]of before){if(JSON.parse(text).schema==='qianmu.st-account-document.v1')assert.equal(f.transport.files.get(name),text);}
 const refreshed=await f.manager.page();assert.equal(refreshed.rows.find(row=>row.id===selected).count,0);assert.equal((await f.manager.clear([selected],()=>assert.fail('empty does not confirm'))).status,'empty');assert.equal(f.writes,1);
});
test('cancelled confirmation and forged/duplicate/other-page selections cannot write',async t=>{
 const f=await assistantManagerFixture(t),p=await f.manager.page(),id=p.rows[0].id;
 for(const ids of [[],[id,id],['assistant-'+'f'.repeat(64)]])await assert.rejects(f.manager.clear(ids,()=>true));
 assert.equal((await f.manager.clear([id],()=>false)).status,'cancelled');assert.equal(f.writes,0);
});
test('a formerly empty selected history that gained content is not falsely reported as still empty',async t=>{
 const f=await assistantManagerFixture(t,0),record=await f.add('A',[]),p=await f.manager.page();await f.store.write(record.slot,{...record.state,revision:2,rows:[{id:1,user:'新问题',assistant:'新回答',status:'complete',reference:null}]},{expectedFingerprint:record.result.fingerprint});
 await assert.rejects(f.manager.clear([p.rows[0].id],()=>true),{code:'assistant_history_manager_changed'});assert.equal(f.writes,0);
});
test('body loading has at most four active native reads and settles a complete bounded page',async t=>{
 const f=await assistantManagerFixture(t,9);let active=0,peak=0;
 f.transport.hook=async({path})=>{if(path.startsWith('/user/files/')){active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,3));active--;}};
 await f.manager.page();assert.equal(peak,4);assert.equal(active,0);assert.equal(f.writes,0);
});
test('changed version before or during confirmation aborts before all writes and preserves new content',async t=>{
 for(const at of ['before','during']){const f=await assistantManagerFixture(t),p=await f.manager.page(),id=p.rows[0].id,old=await f.store.read(id);const change=()=>f.store.write(id,{...old.value,revision:2,rows:[{...old.value.rows[0],assistant:'其他端新增'}]},{expectedFingerprint:old.fingerprint});
  if(at==='before')await change();await assert.rejects(f.manager.clear(p.rows.map(row=>row.id),async()=>{if(at==='during')await change();else assert.fail('preflight must reject before confirmation');return true;}),{code:'assistant_history_manager_changed'});assert.equal(f.writes,0);assert.equal((await f.store.read(id)).value.rows[0].assistant,'其他端新增');}
});
test('lost successful acknowledgement is reconciled by exact full readback without duplicate writes',async t=>{
 const f=await assistantManagerFixture(t),p=await f.manager.page();f.afterWrite=()=>{throw Error('PRIVATE lost acknowledgement');};const result=await f.manager.clear([p.rows[0].id],()=>true);assert.equal(result.status,'complete');assert.equal(f.writes,1);assert.equal((await f.store.read(p.rows[0].id)).value.revision,2);
});
test('partial batch retains confirmed count; explicit retry resumes original range only with no second confirmation',async t=>{
 const f=await assistantManagerFixture(t),p=await f.manager.page(),ids=p.rows.map(row=>row.id);let confirm=0;f.beforeWrite=()=>{if(f.writes===2)throw Error('PRIVATE second failure');};
 await assert.rejects(f.manager.clear(ids,()=>{confirm++;return true;}),error=>{assert.doesNotMatch(error.message,/PRIVATE/);return true;});assert.deepEqual(f.manager.progress(),{total:2,confirmed:1,uncertain:true});
 await assert.rejects(f.manager.page(),{code:'assistant_history_manager_pending'});await assert.rejects(f.manager.clear(ids.slice(0,1),()=>true),{code:'assistant_history_manager_pending'});
 f.beforeWrite=null;const result=await f.manager.clear(ids,()=>assert.fail('must not reconfirm an unchanged pending batch'));assert.equal(result.confirmed,2);assert.equal(f.writes,3);assert.equal(confirm,1);assert.equal(f.manager.progress(),null);
});
test('later concurrent history on retry is never mistaken for exact cleared version or overwritten',async t=>{
 const f=await assistantManagerFixture(t),p=await f.manager.page(),id=p.rows[0].id;f.beforeWrite=()=>{throw Error('lost');};await assert.rejects(f.manager.clear([id],()=>true));const old=await f.store.read(id);
 await f.store.write(id,{...old.value,revision:2,rows:[{...old.value.rows[0],assistant:'NEW'}]},{expectedFingerprint:old.fingerprint});f.beforeWrite=null;
 await assert.rejects(f.manager.clear([id],()=>true),{code:'assistant_history_manager_changed'});assert.equal(f.writes,1);assert.equal((await f.store.read(id)).value.rows[0].assistant,'NEW');
});
test('account/page change at confirmation aborts whole batch; closed manager releases store and cannot write',async t=>{
 for(const change of [f=>f.owner='st-user:bob',f=>f.live=false,f=>f.manager.close()]){const f=await assistantManagerFixture(t),p=await f.manager.page();await assert.rejects(f.manager.clear(p.rows.map(row=>row.id),()=>{change(f);return true;}));assert.equal(f.writes,0);}
});
test('damaged body remains an unavailable row, cannot be cleared, and is never silently replaced',async t=>{
 const f=await assistantManagerFixture(t,1),body=[...f.transport.files].find(([,text])=>JSON.parse(text).schema==='qianmu.st-account-document.v1');f.transport.files.set(body[0],body[1].replace('完整回答','损坏回答'));const before=new Map(f.transport.files),p=await f.manager.page();assert.equal(p.rows[0].status,'unavailable');await assert.rejects(f.manager.clear([p.rows[0].id],()=>true));assert.deepEqual(f.transport.files,before);
});
test('catalogue foreign namespace/scope and altered slot cannot expose a history to another identity',async t=>{
 for(const field of ['namespace','scope','slot']){const f=await assistantManagerFixture(t,1),load=f.loadPage;f.loadPage=async input=>{const p=await load(input);if(field==='namespace')p.namespace='st-user:bob';if(field==='scope')p.scope='f'.repeat(64);if(field==='slot')p.entries[0].slot='assistant-'+'f'.repeat(64);return p;};
  if(field==='slot')assert.equal((await f.manager.page()).rows[0].status,'unavailable');else await assert.rejects(f.manager.page());assert.equal(f.writes,0);}
});
test('safe catalogue notice survives the manager boundary so an old backend can be diagnosed, while unknown exceptions stay private',async t=>{
 const f=await assistantManagerFixture(t,1);f.loadPage=()=>{throw Object.assign(Error('配套后端尚未提供助手文件盘点，请更新后端；日常助手保存不受影响。'),{code:'assistant_history_catalogue_unavailable'});};
 await assert.rejects(f.manager.page(),error=>{assert.match(error.message,/请更新后端/);return true;});f.loadPage=()=>{throw Error('PRIVATE URL and key');};await assert.rejects(f.manager.page(),error=>{assert.doesNotMatch(error.message,/PRIVATE/);return true;});assert.equal(f.writes,0);
});
