import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {NOTES_BACKUP_LIMITS,FAVORITES_BACKUP_LIMITS,NOTE_TEXT_LIMITS,FAVORITE_TEXT_LIMITS,prepareLibraryBackup,exportLibraryBackup} from '../qianmu-library-backup.js';
import {importQianmuNotesBackup} from '../qianmu-notes.js';
const note=()=>({id:'original',body:'月光与原文',pinned:true});
const pack=(favorites=false,count=1)=>favorites?{type:'qianmu-tts-favorites',version:1,credentialsIncluded:false,entries:Array.from({length:count},(_,i)=>({id:'audio-'+i,data:'YQ==',mime:'audio/mpeg'}))}:{type:'qianmu-notes',version:1,credentialsIncluded:false,notes:Array.from({length:count},(_,i)=>({...note(),id:'note-'+i}))};

test('ordinary note exports remain compatible with the actual importer, without changing originals',async()=>{
  const payload=pack(),before=structuredClone(payload),prepared=prepareLibraryBackup(payload),saved=[];
  assert.equal(prepared.preservationOnly,false);
  const result=await importQianmuNotesBackup(prepared.blob,{check(){},read:async()=>[],write:async n=>saved.push(n),uid:()=> 'unexpected'});
  assert.equal(result.imported,1);assert.equal(saved[0].body,payload.notes[0].body);assert.deepEqual(payload,before);
  assert.deepEqual(NOTES_BACKUP_LIMITS,{bytes:12582912,entries:1000});
  assert.deepEqual(FAVORITES_BACKUP_LIMITS,{bytes:268435456,entries:2000,encodedBytes:67108864,audioBytes:50331648});
});

test('entry boundaries match current import limits and preserve overflow without dropping a row',async()=>{
  for(const favorites of [false,true]){
    const limit=favorites?2000:1000;
    assert.equal(prepareLibraryBackup(pack(favorites,limit)).preservationOnly,false);
    const payload=pack(favorites,limit+1),result=prepareLibraryBackup(payload);
    assert.equal(result.preservationOnly,true);assert.deepEqual(JSON.parse(await result.blob.text()),payload);
  }
});

test('the same serializer uses exact UTF8 bytes and individual audio limits without requiring huge test allocations',async()=>{
  const c=vm.createContext({Blob,JSON,NOTE_TEXT_LIMITS,FAVORITE_TEXT_LIMITS,NOTES_BACKUP_LIMITS:{bytes:1e6,entries:1000},FAVORITES_BACKUP_LIMITS:{bytes:1e6,entries:2000,encodedBytes:4}});
  vm.runInContext(prepareLibraryBackup.toString(),c);
  const payload=pack(),bytes=Buffer.byteLength(JSON.stringify(payload));c.NOTES_BACKUP_LIMITS.bytes=bytes;
  assert.equal(c.prepareLibraryBackup(payload).preservationOnly,false);c.NOTES_BACKUP_LIMITS.bytes--;
  const large=c.prepareLibraryBackup(payload);assert.equal(large.preservationOnly,true);assert.deepEqual(JSON.parse(await large.blob.text()),payload);
  const audio=pack(true);assert.equal(c.prepareLibraryBackup(audio).preservationOnly,false);audio.entries[0].data='YWFhYQ==';
  const result=c.prepareLibraryBackup(audio);assert.equal(result.preservationOnly,true);assert.deepEqual(JSON.parse(await result.blob.text()),audio);
});

test('preservation requires consent and a still-current operation; cancellation and stale confirmation download nothing',async()=>{
  for(const favorites of [false,true])for(const mode of ['confirm','cancel','stale']){
    const payload=pack(favorites,favorites?2001:1001),downloads=[],notices=[];let current=true,asks=0;
    const options={check(){if(!current)throw Error('stale');},confirm:async(title,message)=>{asks++;assert.match(title,/保全/);assert.match(message,/不能直接完整恢复/);if(mode==='stale')current=false;return mode!=='cancel';},download:(blob,name)=>downloads.push({blob,name}),stamp:()=> 'fixture',notify:(...args)=>notices.push(args)};
    if(mode==='stale')await assert.rejects(exportLibraryBackup(payload,options),/stale/);else await exportLibraryBackup(payload,options);
    assert.equal(asks,1);assert.equal(downloads.length,mode==='confirm'?1:0);
    if(mode==='confirm'){assert.match(downloads[0].name,/preservation/);assert.deepEqual(JSON.parse(await downloads[0].blob.text()),payload);assert.equal(notices[0][1],'warning');}
    else assert.equal(notices.length,0);
  }
});

test('serialization and download failures propagate without success notices',async()=>{
  assert.throws(()=>prepareLibraryBackup({type:'unknown',version:1,notes:[]}));
  const circular=pack();circular.self=circular;assert.throws(()=>prepareLibraryBackup(circular));
  const notices=[];await assert.rejects(exportLibraryBackup(pack(),{check(){},confirm(){throw Error('not expected');},download(){throw Error('failed');},stamp:()=> 'fixture',notify:(...args)=>notices.push(args)}),/failed/);assert.equal(notices.length,0);
});

test('note titles and prose use Unicode code points while imported IDs retain their UTF16 limit',async()=>{
  const payload=pack();payload.notes[0]={id:'😀'.repeat(60),title:'😀'.repeat(120),body:'😀'.repeat(20000),pinned:true};
  assert.equal(prepareLibraryBackup(payload).preservationOnly,false);
  for(const [field,value] of [['id','😀'.repeat(61)],['title','😀'.repeat(121)],['body','😀'.repeat(20001)],['id',' padded ']]){
    const changed={...payload,notes:[{...payload.notes[0],[field]:value}]},result=prepareLibraryBackup(changed);
    assert.equal(result.preservationOnly,true);assert.equal(JSON.parse(await result.blob.text()).notes[0][field],value);
  }
});

test('favorite name and allowed metadata limits are classified before any restoration would shorten them',async()=>{
  for(const patch of [{id:'i'.repeat(241)},{label:'l'.repeat(1001)},{meta:{text:'t'.repeat(12001)}},{meta:{speaker:'s'.repeat(513)}}]){
    const payload=pack(true);Object.assign(payload.entries[0],patch);const result=prepareLibraryBackup(payload);
    assert.equal(result.preservationOnly,true);assert.deepEqual(JSON.parse(await result.blob.text()),payload);
  }
  const exact=pack(true);Object.assign(exact.entries[0],{id:'i'.repeat(240),label:'l'.repeat(1000),meta:{text:'t'.repeat(12000),speaker:'s'.repeat(512)}});
  assert.equal(prepareLibraryBackup(exact).preservationOnly,false);
});
