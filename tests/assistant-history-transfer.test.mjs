import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantManagerFixture,account,namespace,sha} from './helpers/assistant-history-manager-fixture.mjs';
import {validateAssistantHistoryBackup} from '../qianmu-assistant-history-transfer.js';
import {emptyProseAssistantHistory} from '../qianmu-prose-assistant-history-contract.js';
import {captureProseAssistantChatSource} from '../qianmu-prose-assistant-source.js';

const key=(id,owner='A.png',integrity=null)=>JSON.stringify(['qianmu-prose-assistant-v2',account,'char:'+owner,{kind:'character',chatId:id,avatar:owner},integrity]);
const sourceFor=target=>{let closed=0,live=true;return {key:target,guard:async()=>live&&closed===0,assertCurrent:()=>live&&closed===0,close(){closed++;},get closed(){return closed;},expire(){live=false;}};};
async function backup(f){const page=await f.manager.page();return f.manager.backup(page.rows.map(row=>row.id));}
async function pair(t,count=2,options={}){const old=await assistantManagerFixture(t,count),text=await backup(old),fresh=await assistantManagerFixture(t,0,options),page=await fresh.manager.reviewBackup(text);return {old,fresh,text,page,ids:page.rows.map(row=>row.id)};}
const preserved=(files,before)=>{for(const [name,text]of before)if(JSON.parse(text).schema==='qianmu.st-account-document.v1')assert.equal(files.get(name),text);};

test('backup round trip previews before writing and restores exact complete original histories without catalogue dependency',async t=>{
 const old=await assistantManagerFixture(t,0),reply='隐私正文\n'.repeat(15000)+'END';await old.add('Chat-A',[{id:4,user:'<img src=x>\n问题',assistant:reply,status:'complete',reference:{floor:21,replyId:'swipe:2',mode:'selection',range:{start:6,end:200}}}]);await old.add('offstage');
 const text=await backup(old),fresh=await assistantManagerFixture(t,0);fresh.loadPage=()=>assert.fail('import must not require catalogue backend');const preview=await fresh.manager.reviewBackup(text),ids=preview.rows.map(row=>row.id);assert.equal(fresh.writes,0);assert.equal(fresh.loads,0);
 const viewed=await fresh.manager.viewBackup(ids[0]);viewed.rows.length=0;assert.equal((await fresh.manager.viewBackup(ids[0])).rows.length,1);
 let confirms=0;const result=await fresh.manager.restoreBackup(ids,()=>{confirms++;assert.equal(fresh.writes,0);return true;});assert.equal(confirms,1);assert.deepEqual(result,{status:'complete',operation:'restore',copied:2,already:0,skipped:0,total:2,retainedOriginals:true});
 for(const row of old.records)assert.deepEqual((await fresh.store.read(row.slot)).value,row.state);assert.equal(await backup(old),text);assert.equal(fresh.writes,2);
});

const mutations={
 'wrong schema':v=>v.schema='other', 'foreign account':v=>v.account='st-user:'+sha('bob'), 'negative timestamp':v=>v.createdAt=-1,
 'extra root field':v=>v.path='/secret', 'empty items':v=>v.items=[], 'too many items':v=>v.items=Array(9).fill(v.items[0]),
 'duplicate item':v=>v.items.push(v.items[0]), 'extra item field':v=>v.items[0].path='/secret',
 'foreign scope':v=>v.items[0].reference.scope='f'.repeat(64), 'altered slot':v=>v.items[0].reference.slot='assistant-'+'f'.repeat(64),
 'altered fingerprint':v=>v.items[0].reference.fingerprint='f'.repeat(64), 'wrong bytes':v=>v.items[0].reference.bytes++,
 'truncated body':v=>v.items[0].history.rows[0].assistant='', 'changed content':v=>v.items[0].history.rows[0].assistant='改写',
 'foreign identity':v=>v.items[0].history.namespace=v.items[0].history.namespace.replace(account,'st-user:'+sha('bob')),
 'bad row reference':v=>v.items[0].history.rows[0].reference={floor:-1}, 'extra state key':v=>v.items[0].history.extra=true,
};
for(const [name,mutate]of Object.entries(mutations))test('reject entire backup before writes: '+name,async t=>{
 const f=await assistantManagerFixture(t,1),value=JSON.parse(await backup(f));mutate(value);const before=new Map(f.transport.files);
 await assert.rejects(f.manager.reviewBackup(JSON.stringify(value)),{code:'assistant_history_transfer_invalid'});assert.equal(f.writes,0);assert.deepEqual(f.transport.files,before);
});
test('bounded parser rejects malformed, duplicate JSON keys and prototype pollution rather than normalizing input',async t=>{
 const f=await assistantManagerFixture(t,1),text=await backup(f);
 for(const input of [text.slice(0,-1),text.replace('"items":','"items": [], "items":'),text.replace('"schema":','"__proto__":{},"schema":')])await assert.rejects(f.manager.reviewBackup(input),{code:'assistant_history_transfer_invalid'});
 assert.equal({}.polluted,undefined);assert.equal(f.writes,0);
});
test('direct validation is lossless and guards every asynchronous digest boundary',async t=>{
 const f=await assistantManagerFixture(t,2),text=await backup(f);let checks=0;const parsed=await validateAssistantHistoryBackup(text,{account,scope:f.store.scope,guard:async()=>{checks++;return true;}});assert.deepEqual(parsed,JSON.parse(text));assert.ok(checks>=3);
 await assert.rejects(validateAssistantHistoryBackup(text,{account,scope:f.store.scope,guard:async()=>{throw Error('scope lost');}}),/scope lost/);
});
test('matching native records are an idempotent no-op; changed records and clear markers survive mixed restore',async t=>{
 const {old,fresh,ids}=await pair(t,4);
 await fresh.store.write(old.records[0].slot,old.records[0].state,{expectedFingerprint:null});
 for(const i of [1,2])await fresh.store.write(old.records[i].slot,{...old.records[i].state,revision:2,rows:i===1?[]:[{...old.records[i].state.rows[0],assistant:'NEW'}]},{expectedFingerprint:null});
 const before=new Map(fresh.transport.files),result=await fresh.manager.restoreBackup(ids,()=>true);assert.equal(result.copied,1);assert.equal(result.already,1);assert.equal(result.skipped,2);assert.equal(fresh.writes,1);preserved(fresh.transport.files,before);
 const again=await fresh.manager.restoreBackup(ids,()=>assert.fail('no new destination'));assert.equal(again.status,'existing');assert.equal(again.already,2);assert.equal(again.skipped,2);assert.equal(fresh.writes,1);
});
test('exact local legacy records and local clear markers are protected when native destination is absent',async t=>{
 const {old,fresh,ids}=await pair(t,3);fresh.legacy.set(old.records[0].state.namespace,old.records[0].state);fresh.legacy.set(old.records[1].state.namespace,{...old.records[1].state,revision:2,rows:[]});const local=structuredClone(fresh.legacy);
 const result=await fresh.manager.restoreBackup(ids,()=>true);assert.equal(result.copied,1);assert.equal(result.skipped,2);assert.deepEqual(fresh.legacy,local);assert.equal((await fresh.store.read(old.records[0].slot)).exists,false);assert.equal((await fresh.store.read(old.records[1].slot)).exists,false);
});
test('cancel and invalid selections never upload; all selected entries are preflighted before confirmation',async t=>{
 const {fresh,ids}=await pair(t,2);for(const selected of [[],[ids[0],ids[0]],['assistant-'+'f'.repeat(64)]])await assert.rejects(fresh.manager.restoreBackup(selected,()=>true));assert.equal((await fresh.manager.restoreBackup(ids,()=>false)).status,'cancelled');assert.equal(fresh.writes,0);
});
test('destination created natively or locally during confirmation aborts all writes, not only conflicting entry',async t=>{
 for(const local of [false,true]){const {old,fresh,ids}=await pair(t,2),record=old.records[1];await assert.rejects(fresh.manager.restoreBackup(ids,async()=>{
  if(local)fresh.legacy.set(record.state.namespace,{...record.state,revision:2,rows:[]});else await fresh.store.write(record.slot,{...record.state,revision:2,rows:[]},{expectedFingerprint:null});return true;
 }),{code:'assistant_history_transfer_changed'});assert.equal(fresh.writes,0);assert.equal(fresh.manager.progress(),null);}
});
test('partial restore retries only original selection and does not repeat confirmed writes or confirmation',async t=>{
 const {fresh,ids}=await pair(t,2);let confirms=0;fresh.beforeWrite=()=>{if(fresh.writes===2)throw Error('PRIVATE network detail');};
 await assert.rejects(fresh.manager.restoreBackup(ids,()=>{confirms++;return true;}),error=>{assert.doesNotMatch(error.message,/PRIVATE/);return true;});assert.deepEqual(fresh.manager.progress(),{operation:'restore',total:2,confirmed:1,uncertain:true});
 await assert.rejects(fresh.manager.restoreBackup(ids.slice(0,1),()=>true),{code:'assistant_history_transfer_pending'});await assert.rejects(fresh.manager.page());await assert.rejects(fresh.manager.discardBackup());await assert.rejects(fresh.manager.clear(ids,()=>true));
 fresh.beforeWrite=null;const result=await fresh.manager.restoreBackup(ids,()=>assert.fail('already confirmed'));assert.equal(result.copied,2);assert.equal(fresh.writes,3);assert.equal(confirms,1);assert.equal(fresh.manager.progress(),null);
});
test('successful upload with lost acknowledgement is read back exactly; no second upload',async t=>{
 const {fresh,ids}=await pair(t,1);fresh.afterWrite=()=>{throw Error('PRIVATE lost acknowledgement');};assert.equal((await fresh.manager.restoreBackup(ids,()=>true)).copied,1);assert.equal(fresh.writes,1);assert.equal(fresh.manager.progress(),null);
});
test('new target revision after failed upload is preserved on retry, not adopted as our success',async t=>{
 const {old,fresh,ids}=await pair(t,1);fresh.beforeWrite=()=>{throw Error('lost');};await assert.rejects(fresh.manager.restoreBackup(ids,()=>true));await fresh.store.write(ids[0],{...old.records[0].state,revision:2,rows:[]},{expectedFingerprint:null});fresh.beforeWrite=null;
 await assert.rejects(fresh.manager.restoreBackup(ids,()=>true),{code:'assistant_history_transfer_changed'});assert.equal(fresh.writes,1);assert.equal((await fresh.store.read(ids[0])).value.revision,2);
});
test('account change, page invalidation and close at confirmation prevent uploads',async t=>{
 for(const change of [f=>f.owner='st-user:bob',f=>f.live=false,f=>f.manager.close()]){const {fresh,ids}=await pair(t,1);await assert.rejects(fresh.manager.restoreBackup(ids,()=>{change(fresh);return true;}));assert.equal(fresh.writes,0);}
});
test('legacy connection is lazy, reused while open, read fresh and closed with manager',async t=>{
 let opened=0,closed=0,reads=0;const {fresh,ids}=await pair(t,1,{legacyFactory:()=>{opened++;return {read:async(a,k,{guard})=>{assert.equal(guard(),true);reads++;return emptyProseAssistantHistory(k);},close(){closed++;}};}});
 assert.equal(opened,0);await fresh.manager.restoreBackup(ids,()=>true);assert.equal(opened,1);assert.ok(reads>=3);fresh.manager.close();assert.equal(closed,1);
});
test('unavailable legacy store fails closed rather than hiding older local records',async t=>{
 const {fresh,ids}=await pair(t,1,{legacyFactory:()=>({read:async()=>{throw Error('PRIVATE IDB unavailable');},close(){}})});await assert.rejects(fresh.manager.restoreBackup(ids,()=>assert.fail('preflight failed')),error=>{assert.doesNotMatch(error.message,/PRIVATE/);return true;});assert.equal(fresh.writes,0);
});

test('explicit native reassociation copies full original rows to same-owner current chat and retains source files',async t=>{
 const target=sourceFor(key('Renamed')),f=await assistantManagerFixture(t,1,{captureDestination:async()=>target}),page=await f.manager.page(),before=new Map(f.transport.files);let confirms=0;
 const result=await f.manager.reassociate(page.rows[0].id,{confirm:(title,text)=>{confirms++;assert.match(text,/来源：Chat-0/);assert.match(text,/当前目标：Renamed/);assert.match(text,/同一聊天/);return true;}});
 assert.equal(result.copied,1);assert.equal(confirms,1);assert.equal(target.closed,1);assert.deepEqual((await f.store.read('assistant-'+sha(target.key))).value,{...f.records[0].state,namespace:target.key});preserved(f.transport.files,before);assert.deepEqual((await f.store.read(f.records[0].slot)).value,f.records[0].state);
});
test('backup reassociation uses explicit current target, not original availability or catalogue',async t=>{
 const target=sourceFor(key('Renamed')), {fresh,ids,old}=await pair(t,1,{captureDestination:async()=>target});const result=await fresh.manager.reassociate(ids[0],{fromBackup:true,confirm:()=>true});assert.equal(result.copied,1);assert.equal((await fresh.store.read(ids[0])).exists,false);assert.deepEqual((await fresh.store.read('assistant-'+sha(target.key))).value.rows,old.records[0].state.rows);
});
test('reassociation refuses offstage, different owner, integrity mismatch, same key and another account',async t=>{
 for(const targetKey of [JSON.stringify(['qianmu-prose-assistant-offstage-v1',account]),key('Renamed','B.png'),key('Renamed','A.png','different'),key('Chat-0'),key('Renamed').replace(account,'st-user:'+sha('bob'))]){
  const target=sourceFor(targetKey),f=await assistantManagerFixture(t,1,{captureDestination:async()=>target}),page=await f.manager.page();await assert.rejects(f.manager.reassociate(page.rows[0].id,{confirm:()=>assert.fail('incompatible identity')}));assert.equal(f.writes,0);assert.equal(target.closed,1);
 }
});
test('offstage source cannot be claimed by an active chat',async t=>{
 const target=sourceFor(key('Renamed')),f=await assistantManagerFixture(t,0,{captureDestination:async()=>target});await f.add('offstage');const page=await f.manager.page();await assert.rejects(f.manager.reassociate(page.rows[0].id,{confirm:()=>true}),{code:'assistant_history_transfer_target'});assert.equal(f.writes,0);assert.equal(target.closed,1);
});
test('same group and exact integrity can be reassociated without reconstructing or reordering references',async t=>{
 const groupKey=id=>JSON.stringify(['qianmu-prose-assistant-v2',account,'group:42',{kind:'group',chatId:id},'persistent-integrity']),target=sourceFor(groupKey('New')),f=await assistantManagerFixture(t,0,{captureDestination:async()=>target});
 const state={version:1,namespace:groupKey('Old'),revision:2,updatedAt:50,rows:[{id:5,user:'Q',assistant:'A',status:'complete',reference:{floor:9,replyId:'swipe:2',mode:'floor',range:{start:0,end:30}}}]};await f.store.write('assistant-'+sha(state.namespace),state,{expectedFingerprint:null});const page=await f.manager.page();await f.manager.reassociate(page.rows[0].id,{confirm:()=>true});assert.deepEqual((await f.store.read('assistant-'+sha(target.key))).value,{...state,namespace:target.key});
});
test('reassociation escapes user names in host HTML confirmation',async t=>{
 const target=sourceFor(key("new'&lt;img&gt;")),f=await assistantManagerFixture(t,0,{captureDestination:async()=>target});await f.add("old'&lt;script&gt;");const page=await f.manager.page();await f.manager.reassociate(page.rows[0].id,{confirm:(title,text)=>{assert.match(text,/old&#39;&amp;lt;script&amp;gt;/);assert.match(text,/new&#39;&amp;lt;img&amp;gt;/);assert.doesNotMatch(text,/<img|<script/);return false;}});assert.equal(f.writes,0);assert.equal(target.closed,1);
});
test('reassociation source changes before or during confirmation prevent copy',async t=>{
 for(const during of [false,true]){const target=sourceFor(key('New')),f=await assistantManagerFixture(t,1,{captureDestination:async()=>target}),page=await f.manager.page(),record=f.records[0];const change=()=>f.store.write(record.slot,{...record.state,revision:2},{expectedFingerprint:record.result.fingerprint});if(!during)await change();
  await assert.rejects(f.manager.reassociate(page.rows[0].id,{confirm:async()=>{if(!during)assert.fail('source changed before confirm');await change();return true;}}),{code:'assistant_history_transfer_changed'});assert.equal(f.writes,0);assert.equal(target.closed,1);
 }
});
test('reassociation target source guard must remain live throughout confirmation',async t=>{
 const target=sourceFor(key('New')),f=await assistantManagerFixture(t,1,{captureDestination:async()=>target}),page=await f.manager.page();await assert.rejects(f.manager.reassociate(page.rows[0].id,{confirm:()=>{target.expire();return true;}}),{code:'assistant_history_transfer_scope'});assert.equal(f.writes,0);assert.equal(target.closed,1);
});
test('occupied native or local reassociation target remains untouched, including clear markers',async t=>{
 for(const local of [false,true]){const target=sourceFor(key('New')),f=await assistantManagerFixture(t,1,{captureDestination:async()=>target}),page=await f.manager.page(),state={version:1,namespace:target.key,revision:3,updatedAt:200,rows:[]};if(local)f.legacy.set(target.key,state);else await f.store.write('assistant-'+sha(target.key),state,{expectedFingerprint:null});
  const result=await f.manager.reassociate(page.rows[0].id,{confirm:()=>assert.fail('occupied target')});assert.equal(result.copied,0);assert.equal(result.skipped,1);assert.equal(f.writes,0);assert.equal(target.closed,1);
 }
});
test('reassociation retry keeps captured destination and closes it only on completion or disposal',async t=>{
 const target=sourceFor(key('New'));let captures=0;const f=await assistantManagerFixture(t,1,{captureDestination:async()=>{captures++;return target;}}),page=await f.manager.page(),id=page.rows[0].id;f.beforeWrite=()=>{throw Error('transport failed');};await assert.rejects(f.manager.reassociate(id,{confirm:()=>true}));assert.equal(target.closed,0);assert.equal(f.manager.progress().operation,'reassociate');await assert.rejects(f.manager.reassociate(id,{fromBackup:true,confirm:()=>true}),{code:'assistant_history_transfer_pending'});
 f.beforeWrite=null;await f.manager.reassociate(id,{confirm:()=>assert.fail('already confirmed')});assert.equal(captures,1);assert.equal(target.closed,1);assert.equal(f.writes,2);
});
test('exact copied target reconciles lost acknowledgement even if original changes afterward',async t=>{
 const target=sourceFor(key('New')),f=await assistantManagerFixture(t,1,{captureDestination:async()=>target}),page=await f.manager.page(),old=f.records[0];f.afterWrite=async()=>{await f.store.write(old.slot,{...old.state,revision:2},{expectedFingerprint:old.result.fingerprint});throw Error('lost acknowledgement');};assert.equal((await f.manager.reassociate(page.rows[0].id,{confirm:()=>true})).copied,1);assert.equal(f.writes,1);assert.equal((await f.store.read(old.slot)).value.revision,2);
});
test('actual chat-source capture uses live host file/integrity identity and rejects a switched chat',async t=>{
 const context={chatId:'Renamed',characterId:0,characters:[{avatar:'A.png',chat:'Renamed'}],chat:[],chatMetadata:{}},getContext=()=>context;let epoch=0;
 const f=await assistantManagerFixture(t,1,{captureDestination:({signal})=>captureProseAssistantChatSource({getContext,epoch:()=>epoch,resolveNamespace:async()=>namespace,isCurrent:()=>true,signal})}),page=await f.manager.page();
 await assert.rejects(f.manager.reassociate(page.rows[0].id,{confirm:()=>{epoch++;context.chatId='Other';context.characters[0].chat='Other';return true;}}));assert.equal(f.writes,0);
});
