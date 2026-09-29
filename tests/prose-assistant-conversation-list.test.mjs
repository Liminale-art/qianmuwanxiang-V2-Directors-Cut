import test from 'node:test';
import assert from 'node:assert/strict';
import {createProseAssistantConversationList} from '../qianmu-prose-assistant-conversation-list.js';
import {proseAssistantPanelDom} from './helpers/prose-assistant-panel-dom.mjs';

function fixture(){
 const dom=proseAssistantPanelDom(),calls=[];
 const view=createProseAssistantConversationList({document:dom.doc,onOpen:key=>calls.push(['open',key]),onNew:()=>calls.push(['new']),onDelete:keys=>calls.push(['delete',keys]),onRefresh:()=>calls.push(['refresh'])});
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
