import test from 'node:test';
import assert from 'node:assert/strict';
import {createProseAssistantHistoryStore} from '../qianmu-prose-assistant-history.js';
import {validateProseAssistantCleanupPlan as validate} from '../qianmu-prose-assistant-history-contract.js';
const namespace='st-user:'+'a'.repeat(64),other='st-user:'+'b'.repeat(64);
const key=JSON.stringify(['qianmu-prose-assistant-v2',namespace,'char:A.png',{kind:'character',chatId:'A',avatar:'A.png'},null]);
const plan=()=>({version:1,namespace,entries:[{key,revision:1,updatedAt:1,count:2,bytes:500}]});

test('cleanup plan carries only exact account/file/version metadata, not questions, replies or credentials',()=>{
 const value=plan();assert.equal(validate(value,namespace),value);assert.equal(validate({...value,entries:[]},namespace).entries.length,0);
 for(const changed of [{...value,apiKey:'secret'},{...value,namespace:other},{...value,entries:[{...value.entries[0],text:'PRIVATE'}]},{...value,entries:Array(1)},{...value,entries:[...value.entries,...value.entries]}])assert.throws(()=>validate(changed,namespace));
});
test('cleanup cannot include empty marker records, legacy ambiguous keys, foreign owners or unincrementable revisions',()=>{
 for(const changed of [{count:0},{count:101},{bytes:0},{revision:0},{revision:Number.MAX_SAFE_INTEGER},{updatedAt:NaN},{key:key.replace(namespace,other)},{key:key.replace('assistant-v2','assistant-v1')}])assert.throws(()=>validate({...plan(),entries:[{...plan().entries[0],...changed}]},namespace));
});
test('unconfirmed, altered or stale cleanup requests fail before opening a database; empty confirmed scope writes nothing',async()=>{
 let opened=0;const store=createProseAssistantHistoryStore({indexedDB:{open(){opened++;throw Error('must not open');}}});
 await assert.rejects(store.clearPlan(namespace,plan()),{code:'prose_assistant_history_confirmation'});await assert.rejects(store.clearPlan(other,plan(),{confirmed:true}));await assert.rejects(store.clearPlan(namespace,plan(),{confirmed:true,now:NaN}));
 await assert.rejects(store.clearPlan(namespace,plan(),{confirmed:true,guard:()=>false}));assert.equal(opened,0);
 assert.deepEqual(await store.clearPlan(namespace,{...plan(),entries:[]},{confirmed:true}),{status:'complete',clearedConversations:0,clearedTurns:0,retainedRevisionMarkers:true});assert.equal(opened,0);store.close();
 await assert.rejects(store.clearPlan(namespace,{...plan(),entries:[]},{confirmed:true}),{code:'prose_assistant_history_closed'});
});
