import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectReleaseFiles} from '../scripts/build-release.mjs';

const root=new URL('../',import.meta.url);
test('grounding feedback reaches the entry through fresh contract, focused and binder addresses',async()=>{
  for(const [parent,child,version] of [['index.js','qianmu-storyboard-contract.js','1.59.439'],
    ['qianmu-storyboard-contract.js','qianmu-storyboard-focused-extraction.js','1.59.439'],
    ['qianmu-storyboard-focused-extraction.js','qianmu-storyboard-continuity-events.js','1.59.428']]) {
    const source=await readFile(new URL(parent,root),'utf8');
    assert.ok(source.includes(`'./${child}?v=${version}'`),`${parent} must use its intended child address`);
  }
  const index=await readFile(new URL('index.js',root),'utf8');
  assert.ok(index.includes("'./qianmu-feature-runtime.js?v=1.59.425'"),'unchanged loader identity stays shared');
  assert.ok(index.includes("'./qianmu-storyboard-worldbooks.js?v=1.59.427'"),'worldbook controller is unchanged');
  const files=await collectReleaseFiles();
  for(const file of ['qianmu-storyboard-contract.js','qianmu-storyboard-focused-extraction.js','qianmu-storyboard-continuity-events.js'])assert.ok(files.includes(file));
  const runtime=await import('../qianmu-storyboard-contract.js?v=1.59.439');
  assert.equal(typeof runtime.completeStoryboardFocusedExtraction,'function');
});
