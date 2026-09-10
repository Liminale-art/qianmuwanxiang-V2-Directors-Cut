import test from 'node:test';
import assert from 'node:assert/strict';
import {createFocusVoiceCache} from '../qianmu-focus-voice-cache.js';

test('construction and memory access never probe persistent storage, and clear releases only memory',async()=>{
  let reads=0,checks=0;
  const cache=createFocusVoiceCache({available:()=>{checks++;return true;},read:async()=>{reads++;return null;}});
  const blob=new Blob(['audio']);assert.equal(cache.size,0);cache.remember('cue',blob);
  assert.equal(cache.peek('cue'),blob);assert.equal(await cache.cueBlob({cacheKey:'cue'}),blob);
  assert.equal(checks,0);assert.equal(reads,0);cache.clear();cache.clear();
  assert.equal(cache.size,0);assert.equal(cache.peek('cue'),undefined);assert.equal(reads,0);
  assert.equal(Object.isFrozen(cache),true);
});

test('export lookup falls back to persistent storage without promoting references, and read rejection remains null',async()=>{
  let reads=0;const blob=new Blob(['stored']);
  const cache=createFocusVoiceCache({available:()=>true,read:async key=>{reads++;if(key==='bad')throw Error('unavailable');return {blob};}});
  assert.equal(await cache.cueBlob(null),null);assert.equal(reads,0);
  assert.equal(await cache.cueBlob({cacheKey:'stored'}),blob);assert.equal(cache.size,0);
  assert.equal(await cache.cueBlob({cacheKey:'bad'}),null);assert.equal(reads,2);
});

test('a repeated key keeps insertion order rather than silently turning the twelve-item ceiling into LRU',()=>{
  const cache=createFocusVoiceCache({available:()=>false,read:async()=>null});
  for(let i=0;i<12;i++)cache.remember(String(i),new Blob([String(i)]));
  cache.remember('0',new Blob(['updated']));cache.remember('12',new Blob(['new']));
  assert.equal(cache.size,12);assert.equal(cache.peek('0'),undefined);assert.ok(cache.peek('1'));
});
