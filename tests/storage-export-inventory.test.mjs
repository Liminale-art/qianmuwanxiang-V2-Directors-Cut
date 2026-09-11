import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {exportLibraryBackup} from '../qianmu-library-backup.js';

function fixture(){
  const f={notes:[{id:'note',body:'完整原文',pinned:true},{id:'temporary',body:'session only',pinned:false}],favorites:[{id:'voice',blob:new Blob(['synthetic audio'],{type:'audio/mpeg'}),label:'收藏',meta:{speaker:'角色',apiKey:'never export'},createdAt:123}],downloads:[],notices:[]};
  f.icon={className:'original-icon'};f.button={isConnected:true,disabled:false,querySelector:()=>f.icon};
  f.modal={isConnected:true,open:true,classList:{contains:()=>f.modal.open}};f.other={};
  const c=vm.createContext({exportLibraryBackup,confirmDialog:async()=>true,settings:{},storyboardAdmissionEpoch:1,MODAL_ID:'fixture',document:{getElementById:()=>f.modal},Blob,clone:structuredClone,blobStore:{listNotes:async()=>f.notes,listFavorites:async()=>f.favorites},
    fileStamp:()=> 'fixture',blobToBase64:async blob=>Buffer.from(await blob.arrayBuffer()).toString('base64'),
    ttsDownloadBlob:(blob,name)=>f.downloads.push({blob,name}),toast:(...args)=>f.notices.push(args),setQianmuIconClass:(icon,name)=>icon.className=name});
  vm.runInContext(['createStorageBackupCheck','storageSafeFavoriteMeta','exportPinnedNotesBackup','exportTtsFavoritesBackup'].map(source).join('\n'),c);
  c.configRestoreActivity=(cleanup=true,own=null)=>({transfer:own!==c.exportPinnedNotesBackup&&c.exportPinnedNotesBackup.busy||own!==c.exportTtsFavoritesBackup&&c.exportTtsFavoritesBackup.busy,...f.other});
  f.c=c;return f;
}

test('normal module exports preserve pinned prose and audio bytes with their existing credential-free format',async()=>{
  const f=fixture();await f.c.exportPinnedNotesBackup(f.button);await f.c.exportTtsFavoritesBackup(f.button);
  const notes=JSON.parse(await f.downloads[0].blob.text()),favorites=JSON.parse(await f.downloads[1].blob.text());
  assert.equal(notes.type,'qianmu-notes');assert.equal(notes.version,1);assert.equal(notes.credentialsIncluded,false);
  assert.deepEqual(notes.notes,[f.notes[0]]);assert.equal(f.notes.length,2,'export does not delete temporary notes');
  assert.equal(favorites.type,'qianmu-tts-favorites');assert.equal(favorites.version,1);assert.equal(favorites.credentialsIncluded,false);
  assert.equal(Buffer.from(favorites.entries[0].data,'base64').toString(),'synthetic audio');
  assert.equal(favorites.entries[0].meta.speaker,'角色');assert.equal(favorites.entries[0].meta.apiKey,undefined);
  assert.equal(f.downloads[0].name,'qianmu-notes-fixture.json');assert.equal(f.downloads[1].name,'qianmu-语音收藏-fixture.json');
  assert.equal(f.button.disabled,false);assert.equal(f.icon.className,'original-icon');
});

test('missing, empty or unreadable audio never produces a partial successful backup even after a good first row',async()=>{
  for(const mode of ['missing','empty','invalid','read-failed','empty-encoding','invalid-encoding']){
    const f=fixture(),bad={id:'second',blob:new Blob(['second'])};
    if(mode==='missing')delete bad.blob;if(mode==='empty')bad.blob=new Blob([]);if(mode==='invalid')bad.blob={};
    f.favorites.push(bad);const encode=f.c.blobToBase64;
    f.c.blobToBase64=async blob=>{if(blob!==bad.blob)return encode(blob);if(mode==='read-failed')throw Error('read failed');if(mode==='empty-encoding')return '';if(mode==='invalid-encoding')return null;return encode(blob);};
    await f.c.exportTtsFavoritesBackup(f.button);assert.equal(f.downloads.length,0);assert.equal(f.notices.at(-1)[1],'error');
    assert.equal(f.favorites.length,2);assert.equal(f.button.disabled,false);assert.equal(f.icon.className,'original-icon');
  }
});

for(const name of ['exportPinnedNotesBackup','exportTtsFavoritesBackup'])test(name+' uses shared download cleanup on click failure and restores the initiating control',async()=>{
  const f=fixture(),c=f.c;let removed=0,revoked=0,release;
  c.URL={createObjectURL:()=> 'blob:synthetic',revokeObjectURL:()=>revoked++};
  c.document={...c.document,createElement:()=>({click(){throw Error('download failed');},remove(){removed++;}}),body:{appendChild(){}}};
  c.setTimeout=fn=>release=fn;
  vm.runInContext(source('ttsDownloadBlob'),c);
  await c[name](f.button);assert.equal(removed,1);assert.equal(typeof release,'function');release();assert.equal(revoked,1);
  assert.equal(f.notices.at(-1)[1],'error');assert.equal(f.notices.some(n=>n[1]==='success'),false);
  assert.equal(f.button.disabled,false);assert.equal(f.icon.className,'original-icon');
});

for(const [name,method] of [['exportPinnedNotesBackup','listNotes'],['exportTtsFavoritesBackup','listFavorites']]){
  test(name+' requests committed inventory and never labels a failed read as an empty library',async()=>{
    const f=fixture(),{c,notices}=f;c.blobStore[method]=async options=>{assert.equal(options.requireCommit,true);throw Error('inventory interrupted');};await c[name]();
    assert.equal(notices.length,1);assert.equal(notices[0][1],'error');assert.match(notices[0][0],/inventory interrupted/);assert.doesNotMatch(notices[0][0],/没有可导出/);
  });
  test(name+' treats only a successfully scanned empty library as empty',async()=>{
    const f=fixture(),{c,notices}=f;c.blobStore[method]=async options=>{assert.equal(options.requireCommit,true);return [];};await c[name]();assert.equal(notices.length,1);assert.equal(notices[0][1],'info');assert.match(notices[0][0],/没有可导出/);
  });
}

for(const [name,method,phase] of [['exportPinnedNotesBackup','listNotes','read'],['exportTtsFavoritesBackup','listFavorites','read'],['exportTtsFavoritesBackup','listFavorites','encode']])test(name+' '+phase+' waits cannot download after page, owner or activity changes',async()=>{
  for(const mode of ['settings','epoch','button','modal','closed','activity']){
    const f=fixture();let release;
    if(phase==='read')f.c.blobStore[method]=()=>new Promise(r=>release=()=>r(method==='listNotes'?f.notes:f.favorites));
    else f.c.blobToBase64=()=>new Promise(r=>release=()=>r('YQ=='));
    const pending=f.c[name](f.button);await new Promise(r=>setImmediate(r));assert.equal(f.c[name].busy,true);
    if(mode==='settings')f.c.settings={};if(mode==='epoch')f.c.storyboardAdmissionEpoch++;
    if(mode==='button')f.button.isConnected=false;if(mode==='modal')f.modal.isConnected=false;if(mode==='closed')f.modal.open=false;if(mode==='activity')f.other={reader:true};
    release();await pending;assert.equal(f.downloads.length,0);assert.equal(f.c[name].busy,false);assert.equal(f.button.disabled,false);assert.equal(f.notices.at(-1)[1],'error');
  }
});

test('each pending export blocks duplicate and opposite exports until its own finally releases activity',async()=>{
  for(const [name,method,opposite] of [['exportPinnedNotesBackup','listNotes','exportTtsFavoritesBackup'],['exportTtsFavoritesBackup','listFavorites','exportPinnedNotesBackup']]){
    const f=fixture();let release,reads=0;f.c.blobStore[method]=()=>{reads++;return new Promise(r=>release=()=>r(method==='listNotes'?f.notes:f.favorites));};
    const pending=f.c[name](f.button);await new Promise(r=>setImmediate(r));assert.equal(f.c.configRestoreActivity().transfer,true);
    await f.c[name]();await f.c[opposite]();assert.equal(reads,1);assert.equal(f.downloads.length,0);
    release();await pending;assert.equal(f.downloads.length,1);assert.equal(!!f.c.configRestoreActivity().transfer,false);
  }
});

test('real export entries retain their activity and page check through the preservation confirmation',async()=>{
  for(const favorites of [false,true])for(const mode of ['confirm','cancel','page']){
    const f=fixture(),name=favorites?'exportTtsFavoritesBackup':'exportPinnedNotesBackup';let asks=0;
    if(favorites)f.favorites=Array.from({length:2001},(_,i)=>({...f.favorites[0],id:'audio-'+i}));
    else f.notes=Array.from({length:1001},(_,i)=>({...f.notes[0],id:'note-'+i}));
    f.c.confirmDialog=async title=>{asks++;assert.match(title,/保全/);assert.equal(f.c[name].busy,true);if(mode==='page')f.modal.open=false;return mode!=='cancel';};
    await f.c[name](f.button);assert.equal(asks,1);assert.equal(f.downloads.length,mode==='confirm'?1:0);assert.equal(f.c[name].busy,false);assert.equal(f.button.disabled,false);
    if(mode==='confirm'){assert.match(f.downloads[0].name,/preservation/);assert.equal(f.notices.at(-1)[1],'warning');}
  }
});

test('active work blocks exports before reading and icon setup failure cannot strand a busy flag',async()=>{
  for(const name of ['exportPinnedNotesBackup','exportTtsFavoritesBackup']){
    const f=fixture();f.other={image:true};await f.c[name](f.button);assert.equal(f.downloads.length,0);assert.equal(!!f.c[name].busy,false);
    f.other={};f.c.setQianmuIconClass=(icon,value)=>{if(value.includes('spinner'))throw Error('icon failed');icon.className=value;};
    await f.c[name](f.button);assert.equal(f.c[name].busy,false);assert.equal(f.button.disabled,false);assert.equal(f.downloads.length,0);
  }
});
