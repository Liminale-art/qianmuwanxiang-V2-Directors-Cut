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
test('manual RunningHub retry loads the workbench with workflow-link confirmation',async()=>{
  const entry=await readFile(new URL('index.js',root),'utf8');
  assert.ok(entry.includes("loadLocalChunk('./qianmu-comfy-workbench.js?v=1.59.435')"));
  const files=await collectReleaseFiles();assert.ok(files.includes('qianmu-comfy-workbench.js'));
  const runtime=await import('../qianmu-comfy-workbench.js?v=1.59.435');
  assert.equal(typeof runtime.confirmRunningHubRetryExecution,'function');
});
test('installed cloud execution and inbox use fresh reachable release addresses',async()=>{
  // Refresh the request-building client, retaining unchanged execution and inbox identities.
  for(const [parent,child,version] of [['index.js','qianmu-comfy-recovery-client.js','1.59.435'],
    ['qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-execution.js','1.59.429'],
    ['index.js','qianmu-comfy-inbox-view.js','1.59.433']]) {
    const source=await readFile(new URL(parent,root),'utf8');
    assert.ok(source.includes(`'./${child}?v=${version}'`),`${parent} must use its intended child version`);
  }
  const files=await collectReleaseFiles();
  for(const file of ['server-plugin.js','qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-execution.js','qianmu-comfy-inbox-view.js'])assert.ok(files.includes(file));
  assert.ok(!files.includes('scripts/preview-storyboard-logs.mjs'),'synthetic preview stays development-only');
  const runtime=await import('../qianmu-comfy-recovery-client.js?v=1.59.435');
  assert.equal(typeof runtime.createComfyRecoveryClient,'function');
});

test('RunningHub workflow-id consumers have an explicit local cache closure',async()=>{
  for(const [parent,child] of [
    ['index.js','qianmu-comfy-console.js'],
    ['index.js','qianmu-comfy-library-view.js'],
    ['qianmu-comfy-workbench.js','qianmu-comfy-console.js'],
    ['qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-request.js'],
    ['qianmu-comfy-cloud-request.js','qianmu-comfy-console.js'],
  ]) {
    const source=await readFile(new URL(parent,root),'utf8');
    assert.ok(source.includes(`'./${child}?v=1.59.435'`),`${parent} must load the new ${child} contract`);
    assert.ok(!source.includes(`from './${child}'`),`${parent} must not also use the stale bare contract`);
  }
  const files=await collectReleaseFiles();
  assert.equal(files.length,684,'the existing release whitelist is sufficient');
  for(const file of ['qianmu-comfy-console.js','qianmu-comfy-cloud-request.js','qianmu-comfy-library-view.js','qianmu-comfy-validation-scope.js'])assert.ok(files.includes(file));
  const helper=await import('../qianmu-comfy-console.js?v=1.59.435');
  assert.equal(helper.runningHubWorkflowId({comfyConsoleUrl:'https://www.runninghub.cn/post/1234567890123456789?source=workspace'},{baseUrl:'https://www.runninghub.cn'}),'1234567890123456789');
});

test('workflow-id release leaves compatible preload and feature-loader addresses unchanged',async()=>{
  // These old consumers use unchanged exports, not the new workflow-id helper.
  const entry=await readFile(new URL('index.js',root),'utf8');
  const preload=await readFile(new URL('qianmu-idle-preload.js',root),'utf8');
  const floorTools=await readFile(new URL('qianmu-prose-floor-tools.js',root),'utf8');
  assert.ok(entry.includes("'./qianmu-feature-runtime.js?v=1.59.425'"));
  assert.ok(floorTools.includes("'./qianmu-idle-preload.js?v=1.59.425'"));
  assert.ok(entry.includes("'./qianmu-prose-floor-tools.js?v=1.59.425'"));
  assert.ok(preload.includes('qianmu-comfy-library-view.js?v=1.59.414') || floorTools.includes('qianmu-comfy-library-view.js?v=1.59.414'));
});
