import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openAssistantHistoryManager as open} from '../qianmu-assistant-history-view.js';
import {createProseAssistantFloorTools} from '../qianmu-prose-assistant-floor.js';
import {assistantManagerFixture,namespace} from './helpers/assistant-history-manager-fixture.mjs';
import {assistantHistoryDom} from './helpers/assistant-history-dom.mjs';
async function fixture(t,count=2){const f=await assistantManagerFixture(t,count),dom=assistantHistoryDom(),downloads=[];let accepted=true;
 const manager=()=>f.manager,options={parent:dom.parent,isCurrent:()=>f.live,check:()=>{if(!f.live)throw Error('scope');},confirm:async()=>accepted,download:(blob,name)=>downloads.push({blob,name}),createManager:manager};
 const view=open(options);t.after(()=>view.dispose());await dom.idle();return {...f,dom,downloads,view,options,setAccept(value){accepted=value;}};
}
test('detached management controls render the installed local Lucide SVGs without relying on an ancestor icon observer',async t=>{
 const f=await fixture(t);const buttons=f.dom.all().filter(node=>node.tagName==='BUTTON');assert.ok(buttons.length>=10);
 for(const button of buttons){const glyph=button.children.find(node=>node.tagName==='SVG');assert.ok(glyph,button.attrs['aria-label']);assert.equal(glyph.attrs.stroke,'currentColor');assert.equal(glyph.attrs['stroke-width'],'2.25');assert.equal(glyph.attrs.viewBox,'0 0 24 24');assert.ok(glyph.innerHTML.includes('<path'),button.attrs['aria-label']);}
});
test('list/view uses plain full text; detail cannot clear a different selected row and backup needs explicit selection',async t=>{
 const f=await fixture(t),{dom}=f;assert.equal(dom.get('备份选中助手记录').disabled,true);assert.equal(dom.all().filter(node=>node.tagName==='ARTICLE').length,2);
 dom.get('选择本页全部记录').emit('click');dom.get('备份选中助手记录').emit('click');await dom.idle();assert.equal(f.downloads.length,1);const backup=JSON.parse(await f.downloads[0].blob.text());assert.equal(backup.items.length,2);assert.equal(f.downloads[0].name,'qianmu-assistant-history.json');
 dom.get('查看 Chat-0').emit('click');await dom.idle();assert.match(dom.all().find(node=>node.tagName==='PRE').textContent,/USER\n问题 Chat-0\n\n场外特助\n完整回答 Chat-0/);assert.equal(dom.get('清空选中助手会话').disabled,true);
 dom.get('返回会话列表').emit('click');assert.equal(dom.get('清空选中助手会话').disabled,false);assert.match(dom.status().textContent,/已发起完整备份下载/);
});
test('navigation resets page selection and closed storage guard closes the management view',async t=>{
 const f=await fixture(t,10),{dom}=f;dom.get('选择本页全部记录').emit('click');dom.get('下一页助手记录').emit('click');await dom.idle();assert.equal(dom.all().filter(node=>node.tagName==='ARTICLE').length,2);assert.equal(dom.get('备份选中助手记录').disabled,true);
 f.manager.close();dom.get('刷新助手记录').emit('click');await f.view.finished;assert.equal(dom.all().some(node=>node.tagName==='DIALOG'),false);
});
test('failed refresh clears stale actionable rows without reporting an empty account',async t=>{
 const dom=assistantHistoryDom();let loads=0;const view=open({parent:dom.parent,isCurrent:()=>true,check(){},confirm:()=>true,download(){},createManager:async()=>({guard:async()=>true,close(){},progress:()=>null,page:async()=>{if(++loads>1)throw Error('PRIVATE');return {offset:0,total:1,nextOffset:null,rows:[{id:'one',status:'ready',title:'one',owner:'A',count:1,bytes:10}]};}})});t.after(()=>view.dispose());
 await dom.idle();dom.get('选择本页全部记录').emit('click');dom.get('刷新助手记录').emit('click');await dom.idle();assert.equal(dom.all().filter(node=>node.tagName==='ARTICLE').length,0);assert.equal(dom.get('清空选中助手会话').disabled,true);assert.match(dom.status().textContent,/未按空记录处理/);assert.doesNotMatch(dom.status().textContent,/PRIVATE/);
});
test('clear cancel does not write and complete clear reports retained files; close releases observer and scope',async t=>{
 const f=await fixture(t),{dom}=f;dom.get('选择本页全部记录').emit('click');f.setAccept(false);dom.get('清空选中助手会话').emit('click');await dom.idle();assert.match(dom.status().textContent,/已取消/);assert.equal((await f.store.read(f.records[0].slot)).value.rows.length,1);
 f.setAccept(true);dom.get('清空选中助手会话').emit('click');await dom.idle();assert.match(dom.status().textContent,/已清空 2 份.*未释放/);assert.equal(dom.get('备份选中助手记录').disabled,true);
 dom.get('关闭助手记录').emit('click');await f.view.finished;assert.equal(dom.observers.size,0);await assert.rejects(f.manager.page());
});
test('late manager creation after close is disposed and never reads a page',async t=>{
 const dom=assistantHistoryDom();let resolve,closed=0,reads=0;const pending=new Promise(done=>resolve=done),view=open({parent:dom.parent,isCurrent:()=>true,check(){},confirm:()=>true,download(){},createManager:()=>pending});
 dom.get('关闭助手记录').emit('click');await view.finished;resolve({close(){closed++;},page(){reads++;}});await dom.wait(()=>closed===1);assert.equal(reads,0);assert.equal(dom.observers.size,0);
});
test('successful clear receipt remains visible if followup catalogue refresh fails',async t=>{
 const dom=assistantHistoryDom(),row={id:'one',status:'ready',title:'one',owner:'A',count:1,bytes:10};let loads=0,clears=0;
 const view=open({parent:dom.parent,isCurrent:()=>true,check(){},confirm:()=>true,download(){},createManager:async()=>({guard:async()=>true,close(){},progress:()=>null,page:async()=>{if(++loads>1)throw Error('PRIVATE');return {offset:0,total:1,nextOffset:null,rows:[row]};},clear:async()=>{clears++;return {status:'complete',confirmed:1};}})});t.after(()=>view.dispose());
 await dom.idle();dom.get('选择本页全部记录').emit('click');dom.get('清空选中助手会话').emit('click');await dom.idle();assert.equal(clears,1);assert.match(dom.status().textContent,/已清空 1 份.*列表暂未刷新/);assert.doesNotMatch(dom.status().textContent,/PRIVATE/);assert.equal(dom.get('清空选中助手会话').disabled,true);assert.equal(dom.all().filter(node=>node.tagName==='ARTICLE').length,0);
});
test('unavailable row stays unselectable after controls update and changed scope closes dialog',async t=>{
 const dom=assistantHistoryDom();let live=true,closed=0;const view=open({parent:dom.parent,isCurrent:()=>live,check(){},confirm:()=>true,download(){},createManager:async()=>({guard:async()=>true,close(){closed++;},progress:()=>null,page:async()=>({offset:0,total:1,nextOffset:null,rows:[{id:'one',status:'unavailable',title:'记录暂未读取',bytes:2}]})})});
 await dom.idle();assert.equal(dom.get('查看 记录暂未读取').disabled,true);assert.equal(dom.get('选择 记录暂未读取').disabled,true);live=false;dom.mutate();await view.finished;assert.equal(closed,1);assert.equal(dom.observers.size,0);
});
test('real floor host lazily opens native manager with passed download, excludes assistant, and disposes on shutdown',async t=>{
 const f=await assistantManagerFixture(t,1),dom=assistantHistoryDom(),original=globalThis.fetch;f.transport.configure();
 globalThis.fetch=async(url,init)=>{assert.equal(url,'/api/plugins/qianmu-tts/assistant/history-catalogue');const {namespace:raw,status,...wire}=await f.loadPage(JSON.parse(init.body));return new Response(JSON.stringify(wire),{headers:{'content-type':'application/json'}});};t.after(()=>globalThis.fetch=original);
 const downloads=[];let mounted=0,detached=0;const floor=createProseAssistantFloorTools({resolveNamespace:async()=>namespace,isCurrent:()=>true,download:(blob,name)=>downloads.push({blob,name}),headers:()=>({'X-CSRF-Token':'fixture'}),mountPortal:()=>{mounted++;return ()=>detached++;}});t.after(()=>floor.disposeFloor());
 const pending=floor.cleanupStorage(dom.parent,()=>true,()=>{},namespace,2,true);await dom.idle();assert.equal(mounted,1);assert.match(dom.all().find(node=>node.tagName==='DIALOG').textContent,/其他 2 个模块本次不处理/);assert.equal(await floor.openAssistant(),null);
 dom.get('选择本页全部记录').emit('click');dom.get('备份选中助手记录').emit('click');await dom.idle();assert.equal(downloads.length,1);assert.equal(JSON.parse(await downloads[0].blob.text()).items.length,1);
 floor.disposeFloor();await pending;assert.equal(detached,1);assert.equal(dom.observers.size,0);assert.equal(dom.all().filter(node=>node.tagName==='DIALOG').length,0);
});
test('actual entry has a separate ST management branch ahead of generic deletion; release and responsive styles include all runtime files',async()=>{
 const root=new URL('../',import.meta.url),source=await readFile(new URL('index.js',root),'utf8'),release=JSON.parse(await readFile(new URL('release-files.json',root),'utf8'));
 assert.match(source,/selected.includes\('__assistant_native__'\).*cleanupAssistant\(root,confirmDialog,\(\)=>cleanup.check\(\),inventory\?\.assistantStorage\?\.namespace,selected.length-1,true\)/);
 for(const file of ['qianmu-assistant-history-manager.js','qianmu-assistant-history-view.js','qianmu-assistant-history-view.css'])assert.ok(release.files.includes(file));
 const css=await readFile(new URL('qianmu-assistant-history-view.css',root),'utf8');assert.match(css,/@media\(max-width:620px\)/);assert.match(css,/overflow-wrap:anywhere/);assert.match(css,/100dvh/);assert.match(css,/background:var\(--sd-sticky-bg,/);
});
test('real floor rechecks the outer cleanup ownership inside writes, not only before and after the dialog',async t=>{
 const f=await assistantManagerFixture(t,1),dom=assistantHistoryDom(),original=globalThis.fetch;f.transport.configure();globalThis.fetch=async()=>{const {namespace:raw,status,...wire}=await f.loadPage({});return new Response(JSON.stringify(wire),{headers:{'content-type':'application/json'}});};t.after(()=>globalThis.fetch=original);
 let valid=true;const before=new Map(f.transport.files),floor=createProseAssistantFloorTools({resolveNamespace:async()=>namespace,isCurrent:()=>true,download(){},headers:()=>({})});t.after(()=>floor.disposeFloor());
 const pending=floor.cleanupStorage(dom.parent,()=>{valid=false;return true;},()=>{if(!valid)throw Error('outer scope changed');},namespace,0,true);await dom.idle();dom.get('选择本页全部记录').emit('click');dom.get('清空选中助手会话').emit('click');await pending;
 assert.deepEqual(f.transport.files,before);assert.equal(dom.all().some(node=>node.tagName==='DIALOG'),false);assert.equal(dom.observers.size,0);
});
