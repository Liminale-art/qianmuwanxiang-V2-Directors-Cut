import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {checkEntryBudget} from '../scripts/check-entry-budget.mjs';
test('governed entry cannot silently grow back into the feature implementation container',async()=>{
  checkEntryBudget(await readFile(new URL('../index.js',import.meta.url),'utf8'));
});
test('the entry ratchet checks real UTF8 size and lines, not OS line endings',()=>{
  assert.deepEqual(checkEntryBudget('a\r\nb\r\n',{lines:2,bytes:4}),checkEntryBudget('a\nb\n',{lines:2,bytes:4}));
  assert.throws(()=>checkEntryBudget('a\nb\nc',{lines:2,bytes:100}),/line budget/);
  assert.throws(()=>checkEntryBudget('千幕',{lines:2,bytes:5}),/byte budget/);
});
test('moving a module into a folder does not consume entry budget, but new code still does',()=>{
  const flat="import {a} from './qianmu-a.js?v=1';\nimport('./assets/logos/x.png');\n";
  const moved="import {a} from './features/tts/qianmu-a.js?v=1';\nimport('./x.png');\n";
  assert.deepEqual(checkEntryBudget(moved,{lines:2,bytes:100}).bytes,checkEntryBudget(flat,{lines:2,bytes:100}).bytes);
  assert.throws(()=>checkEntryBudget(moved+'const extra = 1;',{lines:3,bytes:checkEntryBudget(flat,{lines:2,bytes:100}).bytes}),/byte budget/);
});
