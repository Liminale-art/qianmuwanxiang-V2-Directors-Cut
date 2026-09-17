import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {AUDIO_CACHE_LIMITS,audioCacheMeta,validateAudioCacheBackup,readAudioCacheBackup,prepareAudioCacheBackup,exportAudioCacheBackup,importAudioCacheBackup} from '../qianmu-audio-cache-backup.js';
const entry=(key='one')=>({key,type:'audio/mpeg',createdAt:123,data:'YQ==',meta:{text:'对白',speaker:'甲',apiKey:'never copy',chatKey:'chat'}});
const pack=(entries=[entry()])=>({type:'qianmu-tts-audio-cache',version:1,count:entries.length,entries});
const file=data=>new Blob([JSON.stringify(data)]),encode=async blob=>Buffer.from(await blob.arrayBuffer()).toString('base64');
const decode=(text,type)=>new Blob([Buffer.from(text,'base64')],{type});
function fixture(){
  const records=new Map(),downloads=[],prompts=[],notices=[],progress={added:0,skipped:0,failed:0};let active=true,allowed=true,reads=0,writes=0;
  const check=()=>assert.ok(active,'scope changed');
  const options={check,confirm:async(title,text)=>{prompts.push({title,text});return allowed;},progress,decode,encode,
    reader:{listAudio:async()=>{reads++;return [...records].map(([key,row])=>({key,...row}));}},
    writer:{bulkPutAudio:async(entries,{onProgress})=>{writes++;let added=0,skipped=0;for(const row of entries){if(records.has(row.key))skipped++;else{records.set(row.key,row);added++;}}const result={added,skipped,failed:0};onProgress(result);return result;}},
    download:(blob,name)=>downloads.push({blob,name}),stamp:()=> 'fixture',notify:(...args)=>notices.push(args)};
  return {records,downloads,prompts,notices,progress,options,stop(){active=false;},cancel(){allowed=false;},get reads(){return reads;},get writes(){return writes;}};
}
test('cache export restores exact media and identifiers in the existing v1 format without secrets or fake chat-only naming',async()=>{
  const f=fixture();f.records.set('one',{blob:new Blob(['a'],{type:'audio/ogg; codecs=opus'}),meta:entry().meta,createdAt:123});
  const original=await f.records.get('one').blob.text();await exportAudioCacheBackup(f.options);
  assert.equal(f.downloads[0].name,'qianmu-语音缓存-fixture.json');
  const data=JSON.parse(await f.downloads[0].blob.text());assert.equal(data.credentialsIncluded,false);assert.equal(data.entries[0].data,'YQ==');assert.equal(data.entries[0].meta.apiKey,undefined);
  assert.equal(data.entries[0].meta.text,'对白');assert.equal(data.entries[0].key,'one');assert.equal(await f.records.get('one').blob.text(),original);
  const g=fixture();await importAudioCacheBackup(f.downloads[0].blob,g.options);assert.equal(await g.records.get('one').blob.text(),'a');assert.equal(g.records.get('one').blob.type,'audio/ogg; codecs=opus');assert.equal(g.records.get('one').createdAt,123);
  assert.match(g.prompts[0].text,/多个聊天.*不是按当前角色/);assert.match(g.prompts[0].text,/不覆盖/);assert.equal(g.progress.added,1);
});
test('same cache keys retain recipient originals and unknown metadata cannot transfer credentials',async()=>{
  const f=fixture();f.records.set('one',{blob:new Blob(['existing'])});
  await importAudioCacheBackup(file(pack([entry(),entry('two')])),f.options);
  assert.equal(await f.records.get('one').blob.text(),'existing');assert.equal(f.progress.skipped,1);assert.equal(f.progress.added,1);
  assert.equal(f.records.get('two').meta.apiKey,undefined);assert.deepEqual(audioCacheMeta({text:'keep',authorization:'secret',extra:{apiKey:'secret'}}),{text:'keep'});
});
test('every malformed row is rejected before confirmation, decoding or writing any earlier valid row',async()=>{
  const invalid=[{...entry(),key:''},{...entry(),key:1},{...entry(),type:'text/html'},{...entry(),data:'YQ='},{...entry(),data:'YR=='},{...entry(),meta:[]},{...entry(),meta:{text:{nested:'invalid'}}},{...entry(),createdAt:-1},{...entry(),meta:{text:'x'.repeat(12001)}}];
  for(const row of invalid){const f=fixture();await assert.rejects(importAudioCacheBackup(file(pack([entry('good'),row])),f.options));assert.equal(f.writes,0);assert.equal(f.prompts.length,0);}
  for(const data of [pack([entry(),entry()]),{...pack(),count:2},{...pack(),version:2},{...pack(),version:true},{...pack(),type:'qianmu-tts-favorites'}]){
    const f=fixture();await assert.rejects(importAudioCacheBackup(file(data),f.options));assert.equal(f.writes,0);
  }
});
test('strict JSON and actual byte/entry limits are checked before a destination is opened',async()=>{
  for(const text of ['{"type":"x","type":"qianmu-tts-audio-cache"}','{"__proto__":{}}','{"x":1e999}','['.repeat(42)+'0'+']'.repeat(42)])await assert.rejects(readAudioCacheBackup(new Blob([text]),{check(){}}));
  let reads=0;for(const size of [0,-1,NaN,Infinity,AUDIO_CACHE_LIMITS.bytes+1])await assert.rejects(readAudioCacheBackup({size,text:async()=>{reads++;return '{}';}},{check(){}}));assert.equal(reads,0);
  assert.throws(()=>validateAudioCacheBackup(pack(Array.from({length:2001},(_,i)=>entry(String(i))))),/2000/);
  assert.equal((await readAudioCacheBackup(file({...pack(),version:'1'}),{check(){}})).version,'1');
});
test('cancelled or stale confirmation cannot write; successful commits are counted before a later invalidation',async()=>{
  const f=fixture();f.cancel();assert.equal((await importAudioCacheBackup(file(pack()),f.options)).status,'cancelled');assert.equal(f.writes,0);
  const g=fixture();g.options.confirm=async()=>{g.stop();return true;};await assert.rejects(importAudioCacheBackup(file(pack()),g.options),/scope changed/);assert.equal(g.writes,0);
  const h=fixture(),write=h.options.writer.bulkPutAudio;h.options.writer.bulkPutAudio=async(...args)=>{await write(...args);h.stop();};
  await assert.rejects(importAudioCacheBackup(file(pack([entry(),entry('later')])),h.options),/scope changed/);assert.equal(h.progress.added,1);assert.equal(h.writes,1);assert.equal(h.records.has('later'),false);
});
test('a partial writer result is explicit and never reported as all imported',async()=>{
  const f=fixture();f.options.writer.bulkPutAudio=async(_,{onProgress})=>onProgress({added:0,skipped:0,failed:1});
  assert.equal((await importAudioCacheBackup(file(pack()),f.options)).status,'partial');assert.deepEqual(f.progress,{added:0,skipped:0,failed:1});
});
test('invalid media read or encoding never produces a partial successful export',async()=>{
  for(const blob of [null,new Blob([]),{}]){const f=fixture();f.records.set('good',{blob:new Blob(['a'])});f.records.set('bad',{blob});await assert.rejects(exportAudioCacheBackup(f.options));assert.equal(f.downloads.length,0);}
  const f=fixture();f.records.set('a',{blob:new Blob(['a'])});f.options.encode=async()=> 'YWI=';await assert.rejects(exportAudioCacheBackup(f.options),/编码不完整/);assert.equal(f.downloads.length,0);
});
test('oversized source prose is preserved in a labelled preservation copy, never silently shortened',async()=>{
  const f=fixture(),text='长'.repeat(12001);f.records.set('one',{blob:new Blob(['a']),meta:{text}});
  await exportAudioCacheBackup(f.options);assert.match(f.downloads[0].name,/preservation/);assert.equal(JSON.parse(await f.downloads[0].blob.text()).entries[0].meta.text,text);
  assert.equal(f.notices[0][1],'warning');await assert.rejects(readAudioCacheBackup(f.downloads[0].blob,{check(){}}));
  assert.equal(prepareAudioCacheBackup(pack()).preservationOnly,false);
});
test('empty caches and unreadable/stale sources do not manufacture downloads',async()=>{
  const f=fixture();assert.equal((await exportAudioCacheBackup(f.options)).status,'empty');assert.equal(f.downloads.length,0);
  f.stop();await assert.rejects(exportAudioCacheBackup(f.options),/scope changed/);assert.equal(f.reads,1);
  const g=fixture();g.options.reader.listAudio=async()=>{throw Error('scan failed');};await assert.rejects(exportAudioCacheBackup(g.options),/scan failed/);assert.equal(g.downloads.length,0);
});
test('production UI keeps only cache policy in voice and centralizes backup imports without a second clear handler',async()=>{
  const src=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
  const view=src.slice(src.indexOf('function renderTtsTab('),src.indexOf('function bindTtsEvents('));
  assert.match(view,/sd-tts-cache-limit/);assert.doesNotMatch(src,/sd-tts-cache-(?:export|import|clear)/);
  assert.match(src,/case 'audio': void ttsExportAudioCache/);assert.match(src,/case 'audio': await ttsImportAudioCache/);
  assert.match(src,/createReaderPackageWriter\(\{ check \}\)/);assert.doesNotMatch(src.slice(src.indexOf('async function transferAudioCache('),src.indexOf('// 试听某音色：')),/clearAudioCache|\.putAudio\(/);
});
