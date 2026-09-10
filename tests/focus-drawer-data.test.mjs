import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {sanitizeFolder} from '../qianmu-storyboard-utils.js';
import {createFocusVoiceCache} from '../qianmu-focus-voice-cache.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture(state={sessionVoiceCues:[],history:[]}) {
  const trace=[],favorites=new Map(),blob=new Blob(['local audio']),button={};
  const c=vm.createContext({Date,Number,Blob,sanitizeFolder,
    focusClockState:()=>{trace.push(['state']);return state;},
    focusClockVoiceCueBlob:async cue=>{trace.push(['blob',cue.cacheKey]);return blob;},
    blobStore:{blobStoreAvailable:()=>true,
      hasFavorite:async id=>{trace.push(['has',id]);return favorites.has(id);},
      removeFavorite:async id=>{trace.push(['remove',id]);favorites.delete(id);},
      addFavorite:async(id,audio,meta,text)=>{trace.push(['add',id]);favorites.set(id,{audio,meta,text});}},
    ttsSetFavoriteButton:(target,active)=>{trace.push(['button',active]);target.active=active;},
    toast:(...args)=>trace.push(['toast',...args])});
  vm.runInContext(['ttsSafeFilenamePart','ttsCompactStamp','focusClockVoiceCueFileBase',
    'focusClockVoiceDrawerRows','focusClockSyncVoiceDrawerFavorites','focusClockToggleVoiceCueFavorite'].map(section).join('\n'),c);
  return {c,state,trace,favorites,blob,button};
}

test('drawer rows keep current-played priority, legacy identity deduplication and the sixteen-row limit',()=>{
  const first={id:'a',played:true,cacheKey:'a'},history={id:'history',cacheKey:'h'},fallback={cacheKey:'fallback'};
  const state={sessionVoiceCues:[null,{id:'silent',cacheKey:'s'},first,{played:true}],history:[null,
    {task:'原任务',voiceCues:[{id:'a',cacheKey:'duplicate'},history,fallback,{cacheKey:'fallback'},null]},
    {voiceCues:'damaged'}, {voiceCues:Array.from({length:20},(_,i)=>({id:`old${i}`,cacheKey:`k${i}`}))}]};
  const e=fixture(state),rows=e.c.focusClockVoiceDrawerRows();
  assert.equal(rows.length,16);assert.equal(rows[0],first);assert.equal(rows[1],history);assert.equal(rows[2],fallback);
  assert.equal(rows.at(-1).id,'old12');assert.equal(history.task,'原任务');assert.equal(rows[3].task,'专注');
  // Preserve existing lazy repair and object identity: regeneration updates the original history cue.
  assert.equal(state.history[1].voiceCues[0].task,'原任务');assert.equal(state.history.at(-1).voiceCues.at(-1).task,'专注');
  assert.deepEqual(e.trace,[['state']]);e.trace.length=0;e.c.focusClockVoiceDrawerRows(state);assert.deepEqual(e.trace,[]);
});

test('cue filenames preserve speaker/task sanitizing, individual limits and one-based source line numbering',()=>{
  const {c}=fixture(),sourceTime=new Date(2026,8,11,1,2,3).getTime();
  assert.equal(c.focusClockVoiceCueFileBase({speaker:'甲/乙',task:'阅读:今日. ',sourceTime,lineIndex:2}),
    '甲_乙-阅读_今日-20260911-010203-03');
  assert.equal(c.focusClockVoiceCueFileBase({sourceTime}),'角色-专注-20260911-010203-01');
  const name=c.focusClockVoiceCueFileBase({speaker:'甲'.repeat(50),task:'书'.repeat(50),sourceTime,lineIndex:15});
  assert.equal(name,`${'甲'.repeat(28)}-${'书'.repeat(30)}-20260911-010203-16`);
});

test('favorites retain the existing narration namespace and safe provenance, and removal never needs audio',async()=>{
  const e=fixture(),cue=Object.freeze({cacheKey:'audio-a',speaker:'甲',text:'这一程',providerId:'minimax',
    format:'wav',task:'阅读',sourceTime:1000000,lineIndex:3,chatKey:'old-chat',apiKey:'not-exported'});
  await e.c.focusClockToggleVoiceCueFavorite(cue,e.button);
  const saved=e.favorites.get('fav:audio-a');assert.equal(saved.audio,e.blob);assert.equal(saved.text,cue.text);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.meta)),{speaker:'甲',text:'这一程',format:'wav',provider:'minimax',
    folder:sanitizeFolder('甲'),fileNameBase:e.c.focusClockVoiceCueFileBase(cue),chatKey:'old-chat',sourceTime:1000000,lineIndex:3,source:'focus'});
  assert.equal(e.button.active,true);e.trace.length=0;
  await e.c.focusClockToggleVoiceCueFavorite(cue,e.button);
  assert.deepEqual(e.trace.map(row=>row[0]),['has','remove','button','toast']);
  assert.equal(e.favorites.size,0);assert.equal(e.button.active,false);
});

test('unavailable storage, expired audio and failed writes never report a successful favorite',async()=>{
  for(const failure of ['unavailable','expired','write']) {
    const e=fixture();
    if(failure==='unavailable')e.c.blobStore.blobStoreAvailable=()=>false;
    if(failure==='expired')e.c.focusClockVoiceCueBlob=async()=>null;
    if(failure==='write')e.c.blobStore.addFavorite=async()=>{throw Error('disk full');};
    await e.c.focusClockToggleVoiceCueFavorite({cacheKey:'a'},e.button);
    assert.equal(e.favorites.size,0);assert.equal(e.button.active,undefined);
    assert.equal(e.trace.some(row=>row[0]==='toast'&&row.at(-1)==='success'),false);
    assert.equal(e.trace.at(-1).at(-1),failure==='unavailable'?'warning':'error');
  }
});

test('a favorite keeps its clicked audio and metadata when regeneration replaces the cue during either read',async()=>{
  for(const stage of ['has','blob'])for(const expired of [false,true]) {
    const e=fixture(),cue={cacheKey:'old',speaker:'甲',text:'原句',providerId:'minimax',format:'mp3',sourceTime:1000000};
    const original={...cue},oldBlob=new Blob(['old']),newBlob=new Blob(['new']);
    let resume,entered;
    const wait=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    e.c.blobStore.hasFavorite=async()=>{if(stage==='has'){entered();await wait;}return false;};
    const cache=createFocusVoiceCache({available:()=>true,read:async key=>{
      if(stage==='blob'){entered();await wait;}
      return {blob:key==='old'?(expired?null:oldBlob):newBlob};
    }});
    e.c.focusClockVoiceCueBlob=cache.cueBlob;
    const run=e.c.focusClockToggleVoiceCueFavorite(cue,e.button);await started;
    Object.assign(cue,{cacheKey:'new',format:'wav',providerId:'doubao'});resume();await run;
    assert.equal(cue.cacheKey,'new','saving must not roll back regeneration');
    assert.equal(e.favorites.has('fav:new'),false);
    if(expired){assert.equal(e.favorites.size,0);assert.equal(e.button.active,undefined);continue;}
    const saved=e.favorites.get('fav:old');assert.equal(saved.audio,oldBlob,stage);
    assert.equal(saved.meta.format,original.format,stage);assert.equal(saved.meta.provider,original.providerId,stage);
    assert.equal(saved.meta.fileNameBase,e.c.focusClockVoiceCueFileBase(original));
  }
});

test('favorite badges read current rows for each button and a failed lookup only clears that badge',async()=>{
  const e=fixture({sessionVoiceCues:[{id:'a',played:true,cacheKey:'ka'},{id:'b',played:true,cacheKey:'kb'}],history:[]});
  const buttons=['missing','a','b'].map(id=>({dataset:{cueId:id}}));e.favorites.set('fav:ka',{});
  const original=e.c.blobStore.hasFavorite;e.c.blobStore.hasFavorite=async id=>{if(id==='fav:kb')throw Error('unreadable');return original(id);};
  await e.c.focusClockSyncVoiceDrawerFavorites({querySelectorAll:()=>buttons});
  assert.equal(buttons[0].active,undefined);assert.equal(buttons[1].active,true);assert.equal(buttons[2].active,false);
  assert.equal(e.trace.filter(row=>row[0]==='state').length,3);assert.equal(e.trace.some(row=>row[0]==='toast'),false);
  e.trace.length=0;await e.c.focusClockSyncVoiceDrawerFavorites(null);assert.deepEqual(e.trace,[]);
});
