import test from 'node:test';
import assert from 'node:assert/strict';
import {saveProseAssistantConnection as save,createProseAssistantAutosave} from '../qianmu-prose-assistant-preferences.js';
const custom=()=>({mode:'custom',transport:'direct',connection:{apiUrl:'https://fixture.invalid/api/v3/chat/completions',apiKey:'private-key',model:'m',stream:false,ignored:'not saved'}});
function fixture(){const f={owner:{apiProfiles:[{id:'p',apiUrl:'https://profile.invalid/v1',apiKey:'profile-key',model:'pm'}],proseAssistant:{systemPrompt:'keep exact'},other:{value:1}},calls:0,live:true};f.options={selection:custom(),current:()=>f.owner,persist:()=>{f.calls++;},guard:async()=>true,isCurrent:()=>f.live};return f;}

test('reference floor count is saved with connection settings and invalid ranges do not mutate preferences',async()=>{
 const f=fixture();delete f.options.selection.transport;await save({...f.options,referenceFloors:3});assert.equal(f.owner.proseAssistant.referenceFloors,3);assert.equal(f.owner.proseAssistant.selection.transport,'st-proxy');
 await save({...f.options,referenceFloors:0});assert.equal(f.owner.proseAssistant.referenceFloors,0);
 for(const referenceFloors of [-1,10,2.5,NaN]){const before=structuredClone(f.owner);await assert.rejects(save({...f.options,referenceFloors}));assert.deepEqual(f.owner,before);}
});

test('autosaved partial connection and optional persona survive reopen without bypassing strict request validation',async()=>{
 const f=fixture();f.options.selection={mode:'custom',connection:{apiUrl:'https:',apiKey:'',model:''}};
 await save({...f.options,allowIncomplete:true,referenceFloors:0,systemPrompt:''});assert.deepEqual(f.owner.proseAssistant.selection.connection,{apiUrl:'https:',apiKey:'',model:''});assert.equal(f.owner.proseAssistant.systemPrompt,'');
 await assert.rejects(save({...f.options,allowIncomplete:false}),{code:'prose_assistant_connection'});
});

test('autosave coalesces bursts and close flush waits for the latest edit made during an active save',async()=>{
 let value='A',release;const writes=[];const autosave=createProseAssistantAutosave({read:()=>value,isCurrent:()=>true,delayMs:10000,save:async draft=>{writes.push(draft);if(writes.length===1)await new Promise(resolve=>{release=resolve;});return {status:'applied'};}});
 autosave.change();value='B';autosave.change();const flushing=autosave.flush();await Promise.resolve();await Promise.resolve();value='C';autosave.change();release();assert.equal(await flushing,true);assert.deepEqual(writes,['B','C']);assert.equal(autosave.state().dirty,false);autosave.close();
});

test('failed autosave retains latest dirty input and retries without claiming a successful save',async()=>{
 let value='draft',fail=true;const autosave=createProseAssistantAutosave({read:()=>value,isCurrent:()=>true,delayMs:10000,save:async()=>({status:fail?'reverted':'applied'})});autosave.change();assert.equal(await autosave.flush(),false);assert.equal(autosave.state().dirty,true);assert.equal(autosave.state().failed,true);
 value='latest';autosave.change();fail=false;assert.equal(await autosave.flush(),true);assert.equal(autosave.state().dirty,false);autosave.close();
});
test('explicit custom save schedules only whitelisted connection settings and never claims durable acknowledgement',async()=>{
 const f=fixture(),other=f.owner.other,input=structuredClone(f.options.selection);const result=await save(f.options);
 assert.deepEqual(result,{status:'applied',persistence:'requested'});assert.equal(f.calls,1);assert.equal(f.owner.other,other);assert.equal(f.owner.proseAssistant.systemPrompt,'keep exact');
 const value=f.owner.proseAssistant.selection.connection;assert.equal(value.apiUrl,'https://fixture.invalid/api/v3');assert.equal(value.apiKey,'private-key');assert.equal(value.stream,false);assert.equal(value.ignored,undefined);assert.deepEqual(f.options.selection,input);assert.doesNotMatch(JSON.stringify(result),/private-key|fixture.invalid/);
});
test('saving a profile keeps only its reference and never duplicates that profile credentials',async()=>{
 const f=fixture();f.options.selection={mode:'profile',profileId:'p',transport:'st-proxy',connection:custom().connection};await save(f.options);
 assert.deepEqual(f.owner.proseAssistant.selection,{mode:'profile',profileId:'p',transport:'st-proxy'});assert.doesNotMatch(JSON.stringify(f.owner.proseAssistant),/private-key|profile-key/);
});
test('invalid or absent explicit connection rejects before identity work or settings publication',async()=>{
 for(const selection of [null,{mode:'custom',transport:'direct',connection:{...custom().connection,apiKey:''}},{mode:'profile',profileId:'absent',transport:'direct'}]){
  const f=fixture(),before=structuredClone(f.owner);f.options.selection=selection;f.options.guard=()=>{throw Error('must not reach identity');};await assert.rejects(save(f.options),{code:'prose_assistant_connection'});assert.deepEqual(f.owner,before);assert.equal(f.calls,0);
 }
});
test('source/owner/config changes during identity wait never publish a late setting or overwrite an intervening edit',async()=>{
 for(const mode of ['source','owner','config','profile']){
  const f=fixture(),old=f.owner;let resume;f.options.guard=()=>new Promise(resolve=>{resume=resolve;});if(mode==='profile')f.options.selection={mode:'profile',profileId:'p',transport:'direct'};
  const pending=save(f.options);if(mode==='source')f.live=false;if(mode==='owner')f.owner={};if(mode==='config')old.proseAssistant.systemPrompt='new user edit';if(mode==='profile')old.apiProfiles=[];
  resume(true);await assert.rejects(pending);assert.equal(f.calls,0);assert.equal(old.proseAssistant.selection,undefined);if(mode==='config')assert.equal(old.proseAssistant.systemPrompt,'new user edit');
 }
});
test('a throwing scheduling call restores the exact old settings and requests compensation without exposing its error',async()=>{
 const f=fixture(),old=f.owner.proseAssistant;f.options.persist=()=>{if(++f.calls===1)throw Error('private-key internal-path');};
 assert.deepEqual(await save(f.options),{status:'reverted',persistence:'uncertain'});assert.equal(f.owner.proseAssistant,old);assert.equal(f.calls,2);
 const missing=fixture();delete missing.owner.proseAssistant;missing.options.persist=()=>{if(++missing.calls===1)throw Error();};await save(missing.options);assert.equal(Object.hasOwn(missing.owner,'proseAssistant'),false);
});
test('failed compensation or replaced owner reports uncertainty, never claims success or overwrites a new owner',async()=>{
 for(const replace of [false,true]){
  const f=fixture(),old=f.owner;f.options.persist=()=>{if(replace)f.owner={new:true};throw Error('secret');};assert.deepEqual(await save(f.options),{status:'incomplete',persistence:'uncertain'});if(replace)assert.deepEqual(f.owner,{new:true});else assert.equal(old.proseAssistant.selection,undefined);
 }
});
