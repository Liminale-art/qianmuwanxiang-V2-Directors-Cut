import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(extra={}){
  const c=vm.createContext({ttsRestoreTasks:0,setQianmuIconClass(){},toast(){},...extra});
  vm.runInContext(['ttsPlayResolvedLine','ttsDownloadLine','ttsFavoriteLine'].map(section).join('\n'),c);return c;
}
test('single-line playback and downloads retain the guard beyond synthesis',async()=>{
  const play=deferred();let c,downloaded=false;
  c=fixture({ttsSynthCached:async()=>({blob:{},params:{}}),ttsPlayBlob:()=>play.promise,ttsHighlightEls:()=>[],ttsLineSourceMeta(){assert.equal(c.ttsRestoreTasks,1);return {};},
    ttsLineFilenameBase:()=> 'fixture',ttsDownloadBlob(){assert.equal(c.ttsRestoreTasks,1);downloaded=true;}});
  const task=c.ttsPlayResolvedLine({},null,0,null);await Promise.resolve();assert.equal(c.ttsRestoreTasks,1);play.resolve();await task;assert.equal(c.ttsRestoreTasks,0);
  await c.ttsDownloadLine({},null);assert.equal(downloaded,true);assert.equal(c.ttsRestoreTasks,0);
});
test('favorite writes and asynchronous final button refresh are protected until both finish',async()=>{
  const write=deferred(),refresh=deferred();let c;
  c=fixture({blobStore:{blobStoreAvailable:()=>true,hasFavorite:async()=>false,addFavorite:()=>write.promise},ttsFavoriteIdentity:()=>({id:'fav'}),
    ttsSynthCached:async()=>({blob:{},params:{providerId:'fixture'}}),cacheKeyForTts:()=> 'key',ttsLineSourceMeta:()=>({}),sanitizeFolder:x=>x,ttsLineFilenameBase:()=> 'name',ttsSetFavoriteButton(){},ttsSyncFavoriteButton:()=>refresh.promise});
  const task=c.ttsFavoriteLine({speaker:'a',text:'line'},{querySelector:()=>null});await Promise.resolve();await Promise.resolve();assert.equal(c.ttsRestoreTasks,1);
  write.resolve();await Promise.resolve();assert.equal(c.ttsRestoreTasks,1);refresh.resolve();await task;assert.equal(c.ttsRestoreTasks,0);
});
test('both voice-library preview handlers retain their guard through model writeback',async()=>{
  for(const [selector,next,field] of [['.sd-tts-lib-test','.sd-tts-lib-edit','voiceLibrary'],['.sd-tts-narch-test','.sd-tts-narch-edit','npcArchetypes']]){
    const wait=deferred(),voice={id:'v',voiceId:'voice',model:'auto'},btn={dataset:{id:'v'},addEventListener:(_event,fn)=>{handler=fn;}};let handler,c;
    c=vm.createContext({ttsRestoreTasks:0,p:{[field]:[voice]},providerId:'doubao',root:{querySelectorAll:()=>[btn],querySelector:()=>({value:'text'})},
      ttsPreviewVoice:()=>wait.promise,saveSettings(){assert.equal(c.ttsRestoreTasks,1);},toast(){},ttsDoubaoVoiceModelLabel:x=>x,renderModal(){assert.equal(c.ttsRestoreTasks,1);}});
    const start=source.indexOf(`  root.querySelectorAll('${selector}')`),end=source.indexOf(`  root.querySelectorAll('${next}')`,start+1);assert.ok(start>=0&&end>start);
    vm.runInContext(source.slice(start,end),c);const task=handler({currentTarget:btn});assert.equal(c.ttsRestoreTasks,1);
    wait.resolve({resolvedModel:'resolved'});await task;assert.equal(voice.model,'resolved');assert.equal(c.ttsRestoreTasks,0);
  }
});
test('connection-test credential rejection and unsupported favorites never leave a stuck guard',async()=>{
  let handler;const btn={addEventListener:(_event,fn)=>{handler=fn;}};
  const c=fixture({root:{querySelector:selector=>selector==='.sd-tts-test-conn'?btn:null},p:{},providerId:'doubao',provider:{label:'fixture'},ttsProviderHasCredentials:()=>false,blobStore:{blobStoreAvailable:()=>false}});
  const start=source.indexOf("  root.querySelector('.sd-tts-test-conn')"),end=source.indexOf("  root.querySelector('.sd-tts-save-conn')",start+1);
  vm.runInContext(source.slice(start,end),c);await handler({currentTarget:btn});assert.equal(c.ttsRestoreTasks,0);
  await c.ttsFavoriteLine({},null);assert.equal(c.ttsRestoreTasks,0);
});
