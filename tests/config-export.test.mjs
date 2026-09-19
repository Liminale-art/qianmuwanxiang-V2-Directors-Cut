import test from 'node:test';
import assert from 'node:assert/strict';
import {exportConfiguration} from '../qianmu-config-export.js';
import {readConfigFile,readConfigEnvelope} from '../qianmu-config-connections.js';
function fixture(settings={theme:'moon'}) {
  const f={current:settings,downloads:[],notes:[],answers:[false],prompts:[]};
  f.options={current:()=>f.current,clone:structuredClone,confirm:async(title)=>{f.prompts.push(title);return f.answers.shift()??false;},
    normalize:structuredClone,isPlainObject:v=>v&&typeof v==='object'&&!Array.isArray(v),plans:async(v,options)=>{assert.equal(options.strict,true);return v;},
    stamp:()=> 'fixture',download:(blob,name)=>f.downloads.push({blob,name}),notify:(...v)=>f.notes.push(v)};
  f.run=()=>exportConfiguration(f.options);return f;
}
const deep=()=>{let value={text:'original'};for(let i=0;i<42;i++)value={child:value};return value;};
test('normal export is accepted by the exact import reader and excludes credentials without changing its source',async()=>{
  const f=fixture({theme:'moon',apiKey:'private fixture',imagegen:{shotPlans:[]}}),before=structuredClone(f.current);
  assert.deepEqual(await f.run(),{status:'exported',preservationOnly:false});
  const parsed=await readConfigFile(f.downloads[0].blob);assert.equal(readConfigEnvelope(parsed).settings.theme,'moon');assert.equal(parsed.settings.apiKey,undefined);
  assert.deepEqual(f.current,before);assert.equal(f.downloads[0].name,'qianmu-config-fixture.json');assert.equal(f.notes[0][1],'success');
});

test('assistant dedicated credentials are excluded even from explicitly API-included packs while ordinary API consent is preserved',async()=>{
  for(const includeApi of [false,true]){
    const f=fixture({apiKey:'ordinary-key',proseAssistant:{systemPrompt:'keep exact prompt',selection:{mode:'custom',transport:'direct',connection:{apiUrl:'https://assistant.invalid/v1',apiKey:'assistant-private-key',model:'m'}}}}),before=structuredClone(f.current);f.answers=[includeApi];
    assert.equal((await f.run()).status,'exported');const data=await readConfigFile(f.downloads[0].blob);
    assert.equal(data.includeApi,includeApi);assert.doesNotMatch(JSON.stringify(data),/assistant-private-key/);assert.equal(data.settings.apiKey,includeApi?'ordinary-key':undefined);
    assert.equal(data.settings.proseAssistant.systemPrompt,'keep exact prompt');assert.deepEqual(f.current,before);
    if(includeApi){assert.equal(data.settings.proseAssistant.selection.connection.apiUrl,'https://assistant.invalid/v1');assert.equal(data.settings.proseAssistant.selection.connection.apiKey,undefined);}
    else assert.equal(data.settings.proseAssistant.selection,undefined);
  }
});

test('opaque assistant credentials or authorization embedded in addresses refuse included export rather than leaking',async()=>{
  for(const connection of [{apiUrl:'https://assistant.invalid/?token=secret'}, {headers:{Authorization:'secret'}}, ['not-a-connection']]){
    const f=fixture({proseAssistant:{selection:{mode:'custom',connection}}});f.answers=[true];
    assert.equal((await f.run()).status,'error');assert.equal(f.downloads.length,0);assert.doesNotMatch(JSON.stringify(f.notes),/secret|Authorization|assistant.invalid/);
  }
});
test('non-restorable settings require explicit consent and remain complete in a clearly named preservation copy',async()=>{
  const f=fixture({custom:deep(),apiKey:'private fixture'});f.answers=[false,true];
  assert.deepEqual(await f.run(),{status:'exported',preservationOnly:true});
  const saved=JSON.parse(await f.downloads[0].blob.text());assert.deepEqual(saved.settings.custom,f.current.custom);assert.equal(saved.settings.apiKey,undefined);
  assert.match(f.downloads[0].name,/preservation/);assert.match(f.prompts[1],/保全/);assert.equal(f.notes[0][1],'warning');
  await assert.rejects(readConfigFile(f.downloads[0].blob));
});
test('cancelling preservation or changing account while its confirmation is open downloads nothing',async()=>{
  for(const mode of ['cancel','owner']){
    const f=fixture({custom:deep()});
    if(mode==='owner')f.options.confirm=async title=>{if(title==='仅保存保全副本')f.current={theme:'other account'};return true;};
    const result=await f.run();assert.equal(result.status,mode==='cancel'?'cancelled':'stale');assert.equal(f.downloads.length,0);
  }
});
test('unreadable historical originals cannot silently produce a partial configuration backup',async()=>{
  const f=fixture({imagegen:{shotPlans:[{archiveRef:'original'}]}});
  f.options.plans=async(_,options)=>{assert.equal(options.strict,true);throw Error('private fixture');};
  assert.equal((await f.run()).status,'error');assert.equal(f.downloads.length,0);assert.equal(f.notes[0][1],'error');assert.doesNotMatch(JSON.stringify(f.notes),/private fixture/);
});
test('serialization and download errors never claim a successful backup',async()=>{
  for(const mode of ['serialize','download']){
    const f=fixture(mode==='serialize'?{unsupported:1n}:{theme:'moon'});
    if(mode==='download')f.options.download=()=>{throw Error('private fixture');};
    assert.equal((await f.run()).status,'error');assert.equal(f.notes.at(-1)[1],'error');
  }
});
