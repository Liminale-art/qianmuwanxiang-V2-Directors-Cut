import test from 'node:test';
import assert from 'node:assert/strict';
import {proseAssistantHistoryKey as key,emptyProseAssistantHistory as empty,validateProseAssistantHistory as validate,createProseAssistantHistoryStore as create} from '../qianmu-prose-assistant-history.js';
import {measureProseAssistantHistory as measure} from '../qianmu-prose-assistant-history-contract.js';
const account='st-user:'+'a'.repeat(64),other='st-user:'+'b'.repeat(64);
const id=(accountId=account,owner='char:A.png',target={kind:'character',chatId:'Chat A',avatar:'A.png'},integrity=null)=>JSON.stringify(['qianmu-prose-assistant-v1',accountId,owner,target,integrity]);
const row=()=>({id:1,user:'问题\r\n😀',assistant:'<b>纯文本回复</b>',status:'complete',reference:{floor:0,replyId:'swipe:1',mode:'selection',range:{start:3,end:5}}});
const state=()=>({...empty(id()),revision:1,updatedAt:1,rows:[row()]});
test('exact account/owner/file/integrity partition is stable while same-name roles, group zero and cloned files remain separate',()=>{
 assert.equal(key(id(),account),id());assert.equal(key(id(account,'group:0',{kind:'group',chatId:'Chat A'})),id(account,'group:0',{kind:'group',chatId:'Chat A'}));
 for(const value of [id(other),id(account,'char:B.png',{kind:'character',chatId:'Chat A',avatar:'B.png'}),id(account,'char:A.png',{kind:'character',chatId:'Chat B',avatar:'A.png'}),id(account,'char:A.png',undefined,'integrity')])assert.notEqual(value,id());
 assert.throws(()=>key(id(other),account));assert.throws(()=>key(id(account,'char:wrong.png')));assert.throws(()=>key(id(account,'group:',{kind:'group',chatId:'Chat A'})));
 assert.throws(()=>key(id().replace('null]','null,1]')));assert.throws(()=>key(id().replace('"kind":"character"','"kind":"character","kind":"character"')));
});
test('completed and stopped records preserve literal Unicode and references without automatically resuming a running request',()=>{
 const value=state();value.rows.push({...row(),id:3,assistant:'半截',status:'cancelled'}, {...row(),id:4,assistant:'',status:'failed',reference:null});assert.equal(validate(value,id()),value);
 assert.equal(value.rows[0].user,'问题\r\n😀');assert.equal(value.rows[0].assistant,'<b>纯文本回复</b>');assert.deepEqual(empty(id()).rows,[]);
 for(const patch of [{status:'running'},{status:'complete',assistant:''},{status:'complete',reference:null},{user:'\ud800'},{reference:{...row().reference,replyId:'swipe:01'}},{reference:{...row().reference,range:{start:1,end:200001}}}])assert.throws(()=>validate({...state(),rows:[{...row(),...patch}]},id()));
});
test('strict schema rejects credential fields, unknown content and corrupt versions without silently dropping original data',()=>{
 for(const patch of [{apiKey:'secret'},{namespace:id(other)},{revision:0},{revision:-1},{updatedAt:NaN},{rows:[row(),row()]},{rows:[{...row(),apiKey:'secret'}]},{rows:Array(1)},{rows:[{...row(),reference:{...row().reference,text:'extra unselected text'}}]}])assert.throws(()=>validate({...state(),...patch},id()));
 const oversized=Array.from({length:6},(_,n)=>({...row(),id:n+1,assistant:'x'.repeat(180000)}));assert.throws(()=>validate({...state(),rows:oversized},id()),{code:'prose_assistant_history_capacity'});assert.equal(oversized[5].assistant.length,180000);
});
test('storage is lazy and isolated; mismatched accounts or invalid snapshots fail before opening, unavailable persistence never claims saved',async()=>{
 let opened=0;const store=create({indexedDB:{open(name){opened++;assert.equal(name,'qianmu-prose-assistant-history');throw Error('private internal');}}});assert.equal(opened,0);
 assert.throws(()=>store.read(other,id()));assert.throws(()=>store.write(account,id(),0,[{...row(),status:'running'}]));assert.equal(opened,0);
 await assert.rejects(store.read(account,id()),{code:'prose_assistant_history_storage'});assert.equal(opened,1);store.close();await assert.rejects(store.read(account,id()),{code:'prose_assistant_history_closed'});
});

test('usage measures exact persisted UTF-8 including metadata but exposes no dialogue, file names or credentials',()=>{
 const value=state();value.rows.push({...row(),id:2,status:'failed',assistant:'半截'}, {...row(),id:3,status:'cancelled',assistant:''});const copy=structuredClone(value),size=measure(value,id(),account);
 assert.deepEqual(size,{bytes:new TextEncoder().encode(JSON.stringify(value)).byteLength,count:3,complete:1,failed:1,cancelled:1});assert.deepEqual(value,copy);
 assert.doesNotMatch(JSON.stringify(size),/问题|半截|Chat A|apiKey|st-user:/);assert.ok(Object.isFrozen(size));
 const marker=measure({...empty(id()),revision:2},id(),account);assert.equal(marker.count,0);assert.ok(marker.bytes>0,'clear revision markers occupy metadata even with no dialogue');
});

test('usage cannot account a foreign or damaged document as a successful partial summary',()=>{
 assert.throws(()=>measure(state(),id(),other));assert.throws(()=>measure({...state(),extra:'secret'},id(),account));assert.throws(()=>measure(state(),id()));
});

test('usage validates account/range capability before opening and never reports unavailable storage as zero',async()=>{
 let opens=0;const store=create({indexedDB:{open(){opens++;throw Error();}},keyRange:null});assert.equal(opens,0);
 await assert.rejects(store.usage(other+'suffix'),{code:'prose_assistant_history_invalid'});await assert.rejects(store.usage(account),{code:'prose_assistant_history_storage'});assert.equal(opens,0);store.close();
});
