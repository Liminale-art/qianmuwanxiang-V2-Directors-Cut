import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeChatScopedStorageSelections as select} from '../qianmu-blobstore.js';

test('chat cleanup selections retain complete keys with a shared long prefix', () => {
  const keys=['x'.repeat(512)+'A','x'.repeat(512)+'B','x'.repeat(512),'书友😀','é','e\u0301'];
  const rows=keys.map(chatKey=>({name:'audio',chatKey}));
  assert.deepEqual(select([...rows,rows[0]]),rows);
});

test('invalid chat keys never become valid deletion selections through coercion or trimming', () => {
  const invalid=[undefined,null,0,123,{},['scope'],'',' ',' scope','scope ','scope\n','sc\u0000ope','sc\u007fope','\ud800','\udfff'];
  assert.deepEqual(select(invalid.map(chatKey=>({name:'audio',chatKey}))),[]);
  assert.deepEqual(select(null),[]);
});

test('only supported store and exact key pairs are deduplicated', () => {
  assert.deepEqual(select([{store:'audio',chatKey:'scope'},{name:'audio',chatKey:'scope'},
    {name:'tts_lines',chatKey:'scope'},{name:'notes',chatKey:'scope'},{name:'storyboard_inbox',chatKey:'scope'}]),
  [{name:'audio',chatKey:'scope'},{name:'tts_lines',chatKey:'scope'}]);
});
