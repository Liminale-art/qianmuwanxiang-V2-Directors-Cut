// Development ratchet only: the installed plugin never runs this check.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// 2026-11-08: update guidance popup moved to qianmu-release-version.js, restoring the 2277000-byte budget.
// 2026-11-09: folder moves lengthen import paths without adding feature code, so the directory part of
// local specifiers ('./features/tts/qianmu-x.js' -> './qianmu-x.js') is not counted.
export const ENTRY_BUDGET = Object.freeze({lines:36450,bytes:2277000});
const stripFolders = source => source.replace(/(['"`])\.\/(?:[\w-]+\/)+(?=[\w.-]+\.(?:js|css|png)\b)/g, '$1./');
export function checkEntryBudget(source, budget = ENTRY_BUDGET) {
  const normalized=stripFolders(source.replace(/\r\n/g,'\n'));
  const lines=normalized.split('\n').length-(normalized.endsWith('\n')?1:0);
  const bytes=Buffer.byteLength(normalized,'utf8');
  assert.ok(lines<=budget.lines,`index.js line budget exceeded: ${lines}/${budget.lines}. Extract a bounded module; do not silently raise the budget.`);
  assert.ok(bytes<=budget.bytes,`index.js byte budget exceeded: ${bytes}/${budget.bytes}. New feature implementation belongs outside the entry.`);
  return {lines,bytes,budget,scope:'normalized LF source size, not runtime memory or load-time measurement'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  console.log(JSON.stringify(checkEntryBudget(await readFile(new URL('../index.js',import.meta.url),'utf8'))));
}
