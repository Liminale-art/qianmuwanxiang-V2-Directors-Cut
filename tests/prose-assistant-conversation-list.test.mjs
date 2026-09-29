import test from 'node:test';
import assert from 'node:assert/strict';
import {createProseAssistantConversationList} from '../qianmu-prose-assistant-conversation-list.js';
import {proseAssistantPanelDom} from './helpers/prose-assistant-panel-dom.mjs';

function fixture({onRename}={}){
 const dom=proseAssistantPanelDom(),calls=[];
 const view=createProseAssistantConversationList({document:dom.doc,onOpen:key=>calls.push(['open',key]),onNew:()=>calls.push(['new']),onDelete:keys=>calls.push(['delete',keys]),onRefresh:()=>calls.push(['refresh']),onRename});
 dom.parent.append(view.element);
 return {dom,view,calls,search:dom.get('搜索特助对话'),rows:()=>view.element.querySelectorAll('[data-pa-conversation-key]'),action:name=>view.element.querySelector(`[data-pa-list-action="${name}"]`),list:view.element.querySelector('.qm-pa-conversation-rows')};
}
const entries=count=>Array.from({length:count},(_,index)=>({key:`key-${index}`,title:`角色 ${index}`,createdAt:new Date(2026,8,29,12).getTime(),updatedAt:index+1,lastUsedAt:index+1,deleted:false}));

test('conversation list displays metadata, current state and real local action icons without loading messages',()=>{
 const f=fixture(),data=entries(3);data[0].lastUsedAt=10;data[0].title='<b>角色甲</b>';
 for(const entry of data)Object.defineProperty(entry,'messages',{get(){assert.fail('list must not read message bodies');}});
 f.view.render({entries:data,currentKey:'key-1'});
 assert.deepEqual(f.rows().map(row=>row.dataset.paConversationKey),['key-0','key-2','key-1']);
 assert.equal(f.rows()[0].querySelector('.qm-pa-conversation-title').textContent,'<b>角色甲</b>');
 assert.equal(f.rows()[2].getAttribute('aria-current'),'true');assert.equal(f.rows()[2].querySelector('.qm-pa-conversation-current').hidden,false);
 assert.match(f.rows()[0].textContent,/2026\/9\/29/);assert.deepEqual(f.calls,[]);
 for(const name of ['refresh','new','select','delete'])assert.ok(f.action(name).querySelector('svg')?.innerHTML.length>0,`${name} must have a rendered glyph`);
 f.rows()[0].click();f.action('new').click();f.action('refresh').click();
 assert.deepEqual(f.calls,[['open','key-0'],['new'],['refresh']]);f.view.dispose();
});

test('list appends thirty rows per scroll and preserves loaded rows and scroll on owner status renders',()=>{
 const f=fixture(),data=entries(65);f.view.render({entries:data});assert.equal(f.rows().length,30);
 const first=f.rows()[0];Object.assign(f.list,{scrollHeight:1800,clientHeight:600,scrollTop:1200});f.list.emit('scroll');
 assert.equal(f.rows().length,60);assert.equal(f.rows()[0],first);
 f.view.render({entries:data,busy:true});f.view.render({entries:data,busy:false});assert.equal(f.rows().length,60);assert.equal(f.rows()[0],first);assert.equal(f.list.scrollTop,1200);
 f.list.emit('scroll');assert.equal(f.rows().length,65);f.list.emit('scroll');assert.equal(f.rows().length,65);f.view.dispose();
});

test('multi-select targets whole loaded rows and collapses after the last deselection or owner reset',()=>{
 const f=fixture();f.view.render({entries:entries(65)});f.action('select').click();assert.equal(f.action('select').getAttribute('aria-pressed'),'true');assert.equal(f.action('delete').hidden,true);
 f.rows()[0].click();assert.equal(f.rows()[0].getAttribute('aria-pressed'),'true');assert.deepEqual(f.calls,[]);
 f.action('select').click();f.action('delete').click();assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].length,30);assert.deepEqual(f.calls[0][1],f.rows().map(row=>row.dataset.paConversationKey));
 f.view.resetSelection();assert.equal(f.action('delete').hidden,true);assert.equal(f.action('select').getAttribute('aria-pressed'),'false');assert.equal(f.rows()[0].getAttribute('aria-pressed'),null);
 f.action('select').click();f.rows()[0].click();f.rows()[0].click();assert.equal(f.action('select').getAttribute('aria-pressed'),'false');assert.equal(f.action('delete').hidden,true);f.view.dispose();
});

test('search filters names and dates locally even while busy and never keeps invisible selections',()=>{
 const f=fixture(),data=entries(2);data[0].title='角色甲';data[1].title='角色乙';data[1].createdAt=new Date(2026,8,28,12).getTime();
 f.view.render({entries:data});f.action('select').click();f.rows()[0].click();
 f.search.value='角色甲 2026/9/29';f.search.emit('input');assert.equal(f.rows().length,1);assert.equal(f.rows()[0].dataset.paConversationKey,'key-0');assert.equal(f.action('delete').hidden,true);
 f.view.render({entries:data,busy:true});assert.equal(f.search.disabled,false);f.search.value='2026-09-28';f.search.emit('input');assert.equal(f.rows().length,1);assert.equal(f.rows()[0].disabled,true);
 f.rows()[0].click();for(const name of ['new','refresh','select','delete'])f.action(name).click();assert.deepEqual(f.calls,[]);
 f.search.value='不存在';f.search.emit('input');assert.equal(f.rows().length,0);assert.equal(f.view.element.querySelector('.qm-pa-conversation-empty').textContent,'没有匹配的对话');f.view.dispose();
});

test('removed entries leave selection, tombstones stay hidden and disposed controls have no callbacks',()=>{
 const f=fixture(),data=entries(3);data[2].deleted=true;f.view.render({entries:data});assert.equal(f.rows().length,2);
 f.action('select').click();f.rows()[0].click();f.view.render({entries:[data[0],data[2]]});assert.equal(f.action('delete').hidden,true);assert.equal(f.action('select').getAttribute('aria-pressed'),'false');
 const create=f.action('new'),row=f.rows()[0];f.view.dispose();create.click();row.click();f.view.render({entries:data});f.view.resetSelection();assert.deepEqual(f.calls,[]);assert.equal(f.view.element.isConnected,false);
});

test('recoverable busy state enables only refresh among list actions and keeps local search available',()=>{
 const f=fixture(),data=entries(2);f.view.render({entries:data});f.action('select').click();f.rows()[0].click();
 f.view.render({entries:data,busy:true,refreshable:true});
 assert.equal(f.view.element.getAttribute('aria-busy'),'true');assert.equal(f.action('refresh').disabled,false);assert.equal(f.search.disabled,false);
 for(const name of ['new','select','delete']){assert.equal(f.action(name).disabled,true);f.action(name).click();}
 assert.equal(f.action('delete').hidden,false);assert.equal(f.rows()[0].disabled,true);f.rows()[0].click();assert.deepEqual(f.calls,[]);
 f.action('refresh').click();assert.deepEqual(f.calls,[['refresh']]);assert.equal(f.rows()[0].getAttribute('aria-pressed'),'true');
 f.view.render({entries:data,busy:true});assert.equal(f.action('refresh').disabled,true);f.action('refresh').click();assert.deepEqual(f.calls,[['refresh']]);
 f.view.render({entries:data});assert.equal(f.action('new').disabled,false);assert.equal(f.action('delete').disabled,false);assert.equal(f.rows()[0].disabled,false);f.view.dispose();
});

test('rename is a sibling action, saves once on Enter and never opens or selects the conversation',async()=>{
 const data=entries(1),renames=[];let release;
 const f=fixture({onRename:(key,title)=>{renames.push([key,title]);return new Promise(resolve=>{release=()=>{data[0]={...data[0],title};f.view.render({entries:data,currentKey:key});resolve(true);};});}});
 f.view.render({entries:data,currentKey:'key-0'});const row=f.rows()[0],rename=f.action('rename');
 assert.equal(rename.parentElement,row.parentElement);assert.equal(row.querySelectorAll('button').length,0);assert.ok(rename.querySelector('svg')?.innerHTML.length>0);
 let escaped=0;f.dom.parent.addEventListener('keydown',()=>escaped++);rename.click();const input=f.dom.get('对话名称');
 assert.equal(row.hidden,true);assert.equal(rename.hidden,true);assert.equal(f.search.disabled,true);assert.equal(input.value,'角色 0');assert.deepEqual(f.calls,[]);
 input.value='  新名字  ';const enter=input.emit('keydown',{key:'Enter'});input.emit('keydown',{key:'Enter'});f.action('save-name').click();
 assert.equal(enter.defaultPrevented,true);assert.equal(escaped,0);assert.deepEqual(renames,[['key-0','新名字']]);assert.equal(input.disabled,true);assert.equal(f.action('cancel-name').disabled,true);
 release();await f.dom.wait(()=>!f.view.element.querySelector('[data-pa-conversation-editor]'));
 assert.equal(f.rows()[0],row);assert.equal(row.hidden,false);assert.equal(row.querySelector('.qm-pa-conversation-title').textContent,'新名字');assert.deepEqual(f.calls,[]);f.view.dispose();
});

test('rename cancellation and validation keep stored titles intact and respect composition, busy and selection states',()=>{
 const renames=[],data=entries(1),f=fixture({onRename:(...args)=>{renames.push(args);return true;}});f.view.render({entries:data});
 f.action('rename').click();let input=f.dom.get('对话名称');input.value='';input.emit('keydown',{key:'Enter'});assert.deepEqual(renames,[]);assert.match(f.view.element.querySelector('.qm-pa-conversation-error').textContent,/1–40/);
 input.value='尚未提交';input.emit('keydown',{key:'Enter',isComposing:true});assert.deepEqual(renames,[]);f.rows()[0].click();f.action('select').click();assert.deepEqual(f.calls,[]);assert.equal(f.action('select').getAttribute('aria-pressed'),'false');
 const escape=input.emit('keydown',{key:'Escape'});assert.equal(escape.defaultPrevented,true);assert.equal(f.view.element.querySelector('[data-pa-conversation-editor]'),null);assert.equal(f.rows()[0].querySelector('.qm-pa-conversation-title').textContent,'角色 0');
 f.view.render({entries:data,busy:true});assert.equal(f.action('rename').disabled,true);f.action('rename').click();assert.equal(f.view.element.querySelector('[data-pa-conversation-editor]'),null);
 f.view.render({entries:data});f.action('select').click();assert.equal(f.action('rename').hidden,true);f.action('rename').click();assert.equal(f.view.element.querySelector('[data-pa-conversation-editor]'),null);
 f.view.resetSelection();f.action('rename').click();input=f.dom.get('对话名称');input.value='取消按钮草稿';f.action('cancel-name').click();assert.deepEqual(renames,[]);assert.equal(data[0].title,'角色 0');f.view.dispose();
});

test('failed rename retains its draft until retry confirms, including owner-driven recovery completion',async()=>{
 const data=entries(1);let attempts=0;
 const f=fixture({onRename:async()=>{attempts++;if(attempts===1)throw Error('private server detail');return false;}});f.view.render({entries:data});f.action('rename').click();const input=f.dom.get('对话名称');input.value='保留草稿';f.action('save-name').click();
 await f.dom.wait(()=>!input.disabled);assert.match(f.view.element.querySelector('.qm-pa-conversation-error').textContent,/重试/);assert.doesNotMatch(f.view.element.textContent,/private server detail/);assert.equal(input.value,'保留草稿');
 f.view.render({entries:data,busy:true,refreshable:true});assert.equal(input.disabled,true);assert.equal(f.action('refresh').disabled,false);f.action('refresh').click();assert.deepEqual(f.calls,[['refresh']]);
 f.view.render({entries:data});assert.equal(f.dom.get('对话名称'),input);assert.equal(input.value,'保留草稿');f.action('save-name').click();await f.dom.wait(()=>!input.disabled);assert.equal(attempts,2);assert.equal(f.dom.get('对话名称'),input);
 f.view.finishRename('another-key');assert.equal(f.dom.get('对话名称'),input);data[0]={...data[0],title:'保留草稿'};f.view.render({entries:data});f.view.finishRename('key-0');f.view.finishRename('key-0');
 assert.equal(f.view.element.querySelector('[data-pa-conversation-editor]'),null);assert.equal(f.rows()[0].querySelector('.qm-pa-conversation-title').textContent,'保留草稿');f.view.dispose();
});

test('optional rename stays hidden and late rename completion cannot revive a disposed list',async()=>{
 const plain=fixture();plain.view.render({entries:entries(1)});assert.equal(plain.action('rename').hidden,true);plain.action('rename').click();assert.equal(plain.view.element.querySelector('[data-pa-conversation-editor]'),null);plain.view.dispose();
 let finish;const f=fixture({onRename:()=>new Promise(resolve=>{finish=resolve;})});f.view.render({entries:entries(1)});f.action('rename').click();f.dom.get('对话名称').value='新名字';f.action('save-name').click();f.view.dispose();finish(true);await Promise.resolve();
 assert.equal(f.view.element.isConnected,false);assert.deepEqual(f.calls,[]);
});

test('metadata reordering does not discard an active rename outside the loaded slice',()=>{
 const data=entries(35),f=fixture({onRename:()=>false});f.view.render({entries:data});const first=f.rows()[0];f.action('rename').click();const input=f.dom.get('对话名称');input.value='尚未保存的名字';
 const changed=data.map(entry=>entry.key===first.dataset.paConversationKey?{...entry,lastUsedAt:.5,updatedAt:.5}:entry);f.view.render({entries:changed});
 assert.equal(f.dom.get('对话名称'),input);assert.equal(input.value,'尚未保存的名字');assert.equal(input.isConnected,true);assert.ok(f.rows().includes(first));
 f.action('cancel-name').click();assert.equal(f.rows().length,30);assert.equal(data.at(-1).title,'角色 34');f.view.dispose();
});

test('manual titles allow forty Unicode code points and reject invalid names before the callback',async()=>{
 const renames=[],f=fixture({onRename:(...args)=>{renames.push(args);return true;}});f.view.render({entries:entries(1)});f.action('rename').click();let input=f.dom.get('对话名称');
 for(const value of ['', ' '.repeat(3), '字'.repeat(41),'😀'.repeat(41)]){
  input.value=value;f.action('save-name').click();assert.match(f.view.element.querySelector('.qm-pa-conversation-error').textContent,/1–40/);assert.equal(input.value,value);assert.equal(renames.length,0);
 }
 for(const value of ['甲\u0000乙','甲\u001f乙','甲\u007f乙','甲\u0085乙','甲\u009f乙','甲\u200b乙','甲\n乙','甲\r乙','甲\u2028乙','甲\u2029乙','<甲>','甲\ud800乙']){
  input.value=value;f.action('save-name').click();assert.match(f.view.element.querySelector('.qm-pa-conversation-error').textContent,/不能包含/);assert.equal(input.value,value);assert.equal(renames.length,0);
 }
 const fortyEmoji='😀'.repeat(40);assert.equal(fortyEmoji.length,80);input.value=fortyEmoji;f.action('save-name').click();await f.dom.wait(()=>!f.view.element.querySelector('[data-pa-conversation-editor]'));assert.deepEqual(renames,[['key-0',fortyEmoji]]);
 f.action('rename').click();input=f.dom.get('对话名称');input.value='字'.repeat(40);f.action('save-name').click();await f.dom.wait(()=>!f.view.element.querySelector('[data-pa-conversation-editor]'));assert.equal(renames.at(-1)[1],'字'.repeat(40));f.view.dispose();
});

test('opening an old long default name never truncates it or rewrites it when unchanged',()=>{
 const data=entries(1),renames=[];data[0].title='原有角色名😀'.repeat(25);const f=fixture({onRename:(...args)=>{renames.push(args);return true;}});f.view.render({entries:data});f.action('rename').click();const input=f.dom.get('对话名称');
 assert.equal(input.value,data[0].title);assert.equal(Object.hasOwn(input,'maxLength'),false);assert.equal(input.getAttribute('maxlength'),null);
 f.action('save-name').click();assert.equal(f.view.element.querySelector('[data-pa-conversation-editor]'),null);assert.deepEqual(renames,[]);assert.equal(f.rows()[0].querySelector('.qm-pa-conversation-title').textContent,data[0].title);f.view.dispose();
});
