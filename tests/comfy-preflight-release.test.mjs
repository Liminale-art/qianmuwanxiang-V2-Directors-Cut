import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectReleaseFiles} from '../scripts/build-release.mjs';

const root=new URL('../',import.meta.url);
test('manual RunningHub retry loads the updated local workbench without refreshing cloud submission code',async()=>{
  const entry=await readFile(new URL('index.js',root),'utf8');
  assert.ok(entry.includes("loadLocalChunk('./qianmu-comfy-workbench.js?v=1.59.430')"));
  const files=await collectReleaseFiles();assert.ok(files.includes('qianmu-comfy-workbench.js'));
  const runtime=await import('../qianmu-comfy-workbench.js?v=1.59.430');
  assert.equal(typeof runtime.confirmRunningHubRetryExecution,'function');
});
test('installed cloud execution and inbox use fresh reachable release addresses',async()=>{
  for(const [parent,child] of [['index.js','qianmu-comfy-recovery-client.js'],
    ['qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-execution.js'],
    ['index.js','qianmu-comfy-inbox-view.js']]) {
    const source=await readFile(new URL(parent,root),'utf8');
    assert.ok(source.includes(`'./${child}?v=1.59.429'`),`${parent} must refresh its changed child`);
  }
  const files=await collectReleaseFiles();
  for(const file of ['server-plugin.js','qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-execution.js','qianmu-comfy-inbox-view.js'])assert.ok(files.includes(file));
  assert.ok(!files.includes('scripts/preview-storyboard-logs.mjs'),'synthetic preview stays development-only');
  const runtime=await import('../qianmu-comfy-recovery-client.js?v=1.59.429');
  assert.equal(typeof runtime.createComfyRecoveryClient,'function');
});
