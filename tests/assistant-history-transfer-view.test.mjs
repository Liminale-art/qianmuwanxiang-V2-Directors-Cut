import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openAssistantHistoryManager as open} from '../qianmu-assistant-history-view.js';
import {ASSISTANT_BACKUP_LIMIT} from '../qianmu-assistant-history-transfer.js';
import {renderStorageBackupSection} from '../qianmu-storage-backup-view.js';
import {createProseAssistantFloorTools} from '../qianmu-prose-assistant-floor.js';
import {comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';
import {assistantManagerFixture,account,namespace,sha} from './helpers/assistant-history-manager-fixture.mjs';
import {assistantHistoryDom} from './helpers/assistant-history-dom.mjs';

async function fixture(t,{count=1,captureDestination,backend=true}={}){
 const original=await assistantManagerFixture(t,count),page=await original.manager.page(),text=await original.manager.backup(page.rows.map(row=>row.id));
 const f=await assistantManagerFixture(t,0,{captureDestination}),dom=assistantHistoryDom();if(!backend)f.loadPage=()=>{throw Object.assign(Error('配套后端未提供目录，请更新后端'),{code:'assistant_history_catalogue_unavailable'});};let accepted=true,confirms=0;
 const view=open({parent:dom.parent,isCurrent:()=>f.live,check(){if(!f.live)throw Error('stale');},confirm(){confirms++;return accepted;},download:()=>assert.fail('must not download during import'),createManager:()=>f.manager,captureDestination});t.after(()=>view.dispose());await dom.idle();
 const choose=async(file={size:Buffer.byteLength(text),text:async()=>text})=>{const input=dom.get('选择助手备份文件');input.files=[file];input.emit('change');await dom.idle();};
 return {f,dom,view,text,original,choose,setAccept(value){accepted=value;},get confirms(){return confirms;}};
}
test('complete file preview has no writes, renders full plain text, then explicit selection and confirmation restores',async t=>{
 const q=await fixture(t),{f,dom}=q;assert.match(dom.all().find(node=>node.tagName==='DIALOG').textContent,/没有助手会话/);await q.choose();assert.equal(f.writes,0);assert.equal(dom.get('选择助手备份文件').value,'');assert.match(dom.status().textContent,/尚未导入/);
 assert.equal(dom.get('清空选中助手会话').hidden,true);assert.equal(dom.get('备份选中助手记录').hidden,true);assert.equal(dom.get('上一页助手记录').hidden,true);assert.equal(dom.get('恢复选中助手备份').disabled,true);
 dom.get('查看 Chat-0').emit('click');await dom.idle();assert.match(dom.all().find(node=>node.tagName==='PRE').textContent,/USER\n问题 Chat-0/);dom.get('返回会话列表').emit('click');dom.get('选择本页全部记录').emit('click');dom.get('恢复选中助手备份').emit('click');await dom.idle();
 assert.equal(q.confirms,1);assert.equal(f.writes,1);assert.match(dom.status().textContent,/已恢复 1 份/);assert.doesNotMatch(dom.all().find(node=>node.tagName==='DIALOG').textContent,/尚未写入/);assert.deepEqual((await f.store.read(q.original.records[0].slot)).value,q.original.records[0].state);
 dom.get('返回会话列表').emit('click');await dom.idle();assert.equal(dom.get('恢复选中助手备份').hidden,true);assert.equal(dom.get('备份选中助手记录').disabled,true);assert.equal(dom.all().filter(node=>node.tagName==='ARTICLE').length,1);
});
test('cancel keeps selection for retry and never reports successful restore',async t=>{
 const q=await fixture(t);await q.choose();q.dom.get('选择本页全部记录').emit('click');q.setAccept(false);q.dom.get('恢复选中助手备份').emit('click');await q.dom.idle();assert.equal(q.f.writes,0);assert.match(q.dom.status().textContent,/已取消/);assert.equal(q.dom.get('恢复选中助手备份').disabled,false);
});
test('import works with empty account and unavailable catalogue backend, without converting catalogue error to empty',async t=>{
 const q=await fixture(t,{backend:false});assert.match(q.dom.status().textContent,/请更新后端/);assert.doesNotMatch(q.dom.all().find(node=>node.tagName==='DIALOG').textContent,/没有助手会话/);await q.choose();q.dom.get('选择本页全部记录').emit('click');q.dom.get('恢复选中助手备份').emit('click');await q.dom.idle();assert.equal(q.f.writes,1);assert.match(q.dom.status().textContent,/已恢复 1 份/);assert.equal(q.f.loads,0);
});
test('oversized file is refused before reading and malformed file cannot expose restore action',async t=>{
 const q=await fixture(t);await q.choose({size:ASSISTANT_BACKUP_LIMIT+1,text:()=>assert.fail('oversized file must not be read')});assert.match(q.dom.status().textContent,/48MiB/);assert.equal(q.f.writes,0);
 await q.choose({size:1,text:async()=>'{'});assert.match(q.dom.status().textContent,/校验未通过/);assert.equal(q.dom.get('恢复选中助手备份').disabled,true);assert.equal(q.dom.all().filter(node=>node.tagName==='ARTICLE').length,0);
});
test('late file read after close never previews, saves or reopens the dialog',async t=>{
 const q=await fixture(t);let resolve,read=false;const pending=new Promise(done=>resolve=done),input=q.dom.get('选择助手备份文件'),original=q.f.manager;
 input.files=[{size:Buffer.byteLength(q.text),text:()=>{read=true;return pending;}}];input.emit('change');await q.dom.wait(()=>read);q.dom.get('关闭助手记录').emit('click');await q.view.finished;resolve(q.text);await new Promise(done=>setTimeout(done,15));assert.equal(q.f.writes,0);assert.equal(q.dom.observers.size,0);assert.equal(q.dom.all().filter(node=>node.tagName==='DIALOG').length,0);await assert.rejects(original.page());
});
test('partial restore locks navigation, import, detail and selection while exposing only same-range retry',async t=>{
 const q=await fixture(t,{count:2});await q.choose();q.dom.get('选择本页全部记录').emit('click');q.f.beforeWrite=()=>{if(q.f.writes===2)throw Error('PRIVATE');};q.dom.get('恢复选中助手备份').emit('click');await q.dom.idle();assert.match(q.dom.status().textContent,/已确认 1\/2/);
 for(const name of ['导入助手备份','选择本页全部记录','返回会话列表','查看 Chat-0','选择 Chat-0'])assert.equal(q.dom.get(name).disabled,true,name);assert.equal(q.dom.get('恢复选中助手备份').disabled,false);assert.equal(q.dom.get('关闭助手记录').disabled,false);
 q.f.beforeWrite=null;q.dom.get('恢复选中助手备份').emit('click');await q.dom.idle();assert.equal(q.confirms,1);assert.equal(q.f.writes,3);assert.match(q.dom.status().textContent,/已恢复 2 份/);assert.equal(q.dom.get('导入助手备份').disabled,false);
});
test('backup reassociation requires one selected item and captured current target rather than original namespace',async t=>{
 const targetKey=JSON.stringify(['qianmu-prose-assistant-v2',account,'char:A.png',{kind:'character',chatId:'Renamed',avatar:'A.png'},null]);let closed=0;
 const q=await fixture(t,{count:2,captureDestination:async()=>({key:targetKey,guard:async()=>true,assertCurrent:()=>true,close(){closed++;}})});await q.choose();q.dom.get('选择本页全部记录').emit('click');assert.equal(q.dom.get('接回当前聊天').disabled,true);
 const checkbox=q.dom.get('选择 Chat-1');checkbox.checked=false;checkbox.emit('change');assert.equal(q.dom.get('接回当前聊天').disabled,false);q.dom.get('接回当前聊天').emit('click');await q.dom.idle();assert.equal(q.confirms,1);assert.equal(closed,1);assert.match(q.dom.status().textContent,/已接回 1 份/);assert.equal((await q.f.store.read('assistant-'+sha(targetKey))).value.namespace,targetKey);assert.equal((await q.f.store.read(q.original.records[0].slot)).exists,false);
});
test('storage offers management/import even with no data or backend and real entry passes the cleanup lifetime guard',async()=>{
 const html=renderStorageBackupSection({htmlEscape:value=>String(value)});assert.match(html,/场外特助会话/);assert.match(html,/sd-storage-assistant-library/);assert.match(html,/管理 \/ 恢复/);
 const source=await readFile(new URL('../index.js',import.meta.url),'utf8');assert.match(source,/onClick\(root\.querySelector\('\.sd-storage-assistant-library'\)[\s\S]*?storageCleanupSession\.begin\(root\)[\s\S]*?cleanupAssistant\(root,confirmDialog,\(\)=>task\.check\(\),undefined,0,true\)[\s\S]*?finally\{task\.release\(\);\}/);
 const floor=await readFile(new URL('../qianmu-prose-assistant-floor.js',import.meta.url),'utf8');assert.match(floor,/captureDestination:\(\{signal\}\)=>captureProseAssistantChatSource\(\{getContext,epoch:\(\)=>epoch,resolveNamespace,isCurrent:valid,signal\}\)/);
 const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));assert.ok(release.files.includes('qianmu-assistant-history-transfer.js'));
});

for(const operation of ['restore','reassociate'])test('actual floor host, local-store guard and native transport execute explicit '+operation,async t=>{
 const old=await assistantManagerFixture(t,1),oldPage=await old.manager.page(),text=await old.manager.backup(oldPage.rows.map(row=>row.id)),f=await assistantManagerFixture(t,0),dom=assistantHistoryDom(),idb=comfySceneJournalFixture();
 const previousFetch=globalThis.fetch,previousIDB=globalThis.indexedDB;t.after(()=>{globalThis.fetch=previousFetch;globalThis.indexedDB=previousIDB;});f.transport.configure();
 // Reuse the serialized accounts-table double, adapting IDB's accepted string
 // storeNames form. It supplies only empty local reads; production code executes.
 globalThis.indexedDB={open(name,version){assert.equal(name,'qianmu-prose-assistant-history');const request=idb.indexedDB.open(name,version),wrapper={};request.onsuccess=()=>{const db=request.result;wrapper.result={...db,transaction:(names,mode)=>db.transaction(Array.isArray(names)?names:[names],mode)};wrapper.onsuccess?.();};return wrapper;}};
 globalThis.fetch=async(url,init)=>{assert.equal(url,'/api/plugins/qianmu-tts/assistant/history-catalogue');const {namespace:raw,status,...wire}=await f.loadPage(JSON.parse(init.body));return new Response(JSON.stringify(wire),{headers:{'content-type':'application/json'}});};
 const context={chatId:'Renamed',characterId:0,characters:[{avatar:'A.png',chat:'Renamed'}],chat:[],chatMetadata:{}},before=structuredClone(context);let confirms=0,detached=0;
 const floor=createProseAssistantFloorTools({getContext:()=>context,resolveNamespace:async()=>namespace,isCurrent:()=>true,download:()=>assert.fail('no export'),headers:()=>({}),mountPortal:()=>()=>detached++});t.after(()=>floor.disposeFloor());
 const finished=floor.cleanupStorage(dom.parent,()=>{confirms++;return true;},()=>{},undefined,0,true);await dom.idle();const input=dom.get('选择助手备份文件');input.files=[{size:Buffer.byteLength(text),text:async()=>text}];input.emit('change');await dom.idle();dom.get('选择本页全部记录').emit('click');dom.get(operation==='restore'?'恢复选中助手备份':'接回当前聊天').emit('click');await dom.idle();
 assert.equal(confirms,1);assert.match(dom.status().textContent,/已(?:恢复|接回) 1 份/);const nextKey=operation==='restore'?old.records[0].state.namespace:JSON.stringify(['qianmu-prose-assistant-v2',account,'char:A.png',{kind:'character',chatId:'Renamed',avatar:'A.png'},null]);assert.deepEqual((await f.store.read('assistant-'+sha(nextKey))).value,{...old.records[0].state,namespace:nextKey});assert.deepEqual(context,before);assert.equal(idb.state.writes.length,0);assert.ok(idb.state.reads.length>=3);
 dom.get('关闭助手记录').emit('click');await finished;assert.equal(detached,1);assert.equal(dom.observers.size,0);
});
