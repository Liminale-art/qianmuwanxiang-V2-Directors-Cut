import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectReleaseFiles} from '../scripts/build-release.mjs';

const root=new URL('../',import.meta.url);
test('cloud retry confirmation loads the updated admission text without refreshing unchanged cloud modules',async()=>{
  const entry=await readFile(new URL('index.js',root),'utf8');
  assert.ok(entry.includes("loadLocalChunk('./qianmu-image-admission.js?v=1.59.434')"));
  const files=await collectReleaseFiles();assert.ok(files.includes('qianmu-image-admission.js'));
  const runtime=await import('../qianmu-image-admission.js?v=1.59.434');
  assert.equal(typeof runtime.createImageAdmission,'function');
});
test('manual RunningHub retry loads the updated local workbench without refreshing cloud submission code',async()=>{
  const entry=await readFile(new URL('index.js',root),'utf8');
  assert.ok(entry.includes("loadLocalChunk('./qianmu-comfy-workbench.js?v=1.59.430')"));
  const files=await collectReleaseFiles();assert.ok(files.includes('qianmu-comfy-workbench.js'));
  const runtime=await import('../qianmu-comfy-workbench.js?v=1.59.430');
  assert.equal(typeof runtime.confirmRunningHubRetryExecution,'function');
});
test('installed cloud execution and inbox use fresh reachable release addresses',async()=>{
  // Refresh the manual-review UI/client, retaining unchanged execution identity.
  for(const [parent,child,version] of [['index.js','qianmu-comfy-recovery-client.js','1.59.433'],
    ['qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-execution.js','1.59.429'],
    ['index.js','qianmu-comfy-inbox-view.js','1.59.433']]) {
    const source=await readFile(new URL(parent,root),'utf8');
    assert.ok(source.includes(`'./${child}?v=${version}'`),`${parent} must use its intended child version`);
  }
  const files=await collectReleaseFiles();
  for(const file of ['server-plugin.js','qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-execution.js','qianmu-comfy-inbox-view.js'])assert.ok(files.includes(file));
  assert.ok(!files.includes('scripts/preview-storyboard-logs.mjs'),'synthetic preview stays development-only');
  const runtime=await import('../qianmu-comfy-recovery-client.js?v=1.59.433');
  assert.equal(typeof runtime.createComfyRecoveryClient,'function');
});
