import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectReleaseFiles} from '../scripts/build-release.mjs';

const root=new URL('../',import.meta.url);
test('cloud admission loads bounded-candidate validation without refreshing unchanged cloud execution modules',async()=>{
  const entry=await readFile(new URL('index.js',root),'utf8');
  assert.ok(entry.includes("loadLocalChunk('./qianmu-image-admission.js?v=1.59.440')"));
  const files=await collectReleaseFiles();assert.ok(files.includes('qianmu-image-admission.js'));
  const runtime=await import('../qianmu-image-admission.js?v=1.59.440');
  assert.equal(typeof runtime.createImageAdmission,'function');
});
test('manual RunningHub retry loads the workbench with workflow-link confirmation',async()=>{
  const entry=await readFile(new URL('index.js',root),'utf8');
  assert.ok(entry.includes("loadLocalChunk('./qianmu-comfy-workbench.js?v=1.59.435')"));
  const files=await collectReleaseFiles();assert.ok(files.includes('qianmu-comfy-workbench.js'));
  const runtime=await import('../qianmu-comfy-workbench.js?v=1.59.435');
  assert.equal(typeof runtime.confirmRunningHubRetryExecution,'function');
});
test('installed cloud execution remains reachable while the retired inbox has no entry address',async()=>{
  // Original-task reception remains available without the old inbox frontend.
  for(const [parent,child,version] of [['index.js','qianmu-comfy-recovery-client.js','1.59.440'],
    ['qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-execution.js','1.59.429']]) {
    const source=await readFile(new URL(parent,root),'utf8');
    assert.ok(source.includes(`'./${child}?v=${version}'`),`${parent} must use its intended child version`);
  }
  const files=await collectReleaseFiles();
  for(const file of ['server-plugin.js','qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-execution.js'])assert.ok(files.includes(file));
  assert.doesNotMatch(await readFile(new URL('index.js',root),'utf8'),/import\(['"]\.\/qianmu-comfy-inbox-view/);
  assert.ok(!files.includes('scripts/preview-storyboard-logs.mjs'),'synthetic preview stays development-only');
  const runtime=await import('../qianmu-comfy-recovery-client.js?v=1.59.440');
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
    const version=child==='qianmu-comfy-cloud-request.js'?'1.59.440':'1.59.435';
    assert.ok(source.includes(`'./${child}?v=${version}'`),`${parent} must load the intended ${child} contract`);
    assert.ok(!source.includes(`from './${child}'`),`${parent} must not also use the stale bare contract`);
  }
  const files=await collectReleaseFiles();
  assert.equal(files.length,691,'four creative runtime modules extend the existing whitelist');
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
  assert.ok(entry.includes("'./qianmu-prose-floor-tools.js?v=1.59.443'"));
  assert.ok(preload.includes('qianmu-comfy-library-view.js?v=1.59.414') || floorTools.includes('qianmu-comfy-library-view.js?v=1.59.414'));
});

test('illustration update preserves host node evidence and refreshes original-task recovery actions',async()=>{
  const files=await collectReleaseFiles();
  for(const file of ['qianmu-comfy-cloud-response.js','qianmu-comfy-cloud-query.js','qianmu-runninghub-results.js','qianmu-runninghub-download.js','qianmu-comfy-cloud-receive.js'])assert.ok(files.includes(file));
  const entry=await readFile(new URL('index.js',root),'utf8');
  assert.ok(entry.includes("const VERSION = '1.59.443';"));
  assert.deepEqual([...entry.matchAll(/'\.\/([^']+\.js)\?v=1\.59\.439'/g)].map(match=>match[1]),
    ['qianmu-world-shot.js','qianmu-comfy-prompt.js','qianmu-storyboard-contract.js']);
  assert.ok(entry.includes("'./qianmu-comfy-recovery-action.js?v=1.59.440'"));
  assert.ok(!entry.includes("from './qianmu-comfy-recovery-action.js'"),'manual receipt must not load the stale action');
  const action=await import('../qianmu-comfy-recovery-action.js?v=1.59.440');
  assert.equal(typeof action.receiveComfyImage,'function');
  const {comfyCloudReadFailureDiagnostic}=await import('../qianmu-comfy-cloud-response.js');
  assert.deepEqual(comfyCloudReadFailureDiagnostic({code:'runninghub_results_match'},{stage:'outputs'}),
    {stage:'outputs',reason:'output_match',hasKnownTaskId:true});
  const {runningHubNeedsNodeEvidence}=await import('../qianmu-runninghub-results.js');
  assert.equal(runningHubNeedsNodeEvidence({results:[{nodeId:'9'}]}),false);
  assert.equal(runningHubNeedsNodeEvidence({results:[{}]}),true);
});

test('authored still guidance and tag projection use only their complete local cache closure',async()=>{
  const edges=[['index.js','qianmu-comfy-prompt.js'],['index.js','qianmu-world-shot.js'],
    ['index.js','qianmu-storyboard-contract.js'],['qianmu-storyboard-contract.js','qianmu-storyboard-focused-extraction.js'],
    ['qianmu-storyboard-focused-extraction.js','qianmu-still-frame-instructions.js'],['qianmu-world-shot.js','qianmu-still-frame-instructions.js']];
  const files=await collectReleaseFiles(),actual=[];
  for(const file of files.filter(file=>file.endsWith('.js'))){
    const source=await readFile(new URL(file,root),'utf8');
    for(const match of source.matchAll(/'\.\/([^']+\.js)\?v=1\.59\.439'/g))actual.push([file,match[1]]);
  }
  assert.deepEqual(actual.sort(),edges.sort(),'unrelated browser dependencies keep their existing identities');
  assert.equal(files.length,691);
  const {compileComfyPromptRendering}=await import('../qianmu-comfy-prompt.js?v=1.59.439');
  const rendered=compileComfyPromptRendering({format:'tags',global:'1 person',characters:[{character_id:'a',positive:'short black hair'}]},
    {characters:[{id:'a',name:'Alice'}]});
  assert.equal(rendered.prompt,'1 person, short black hair');
  const instructions=await import('../qianmu-still-frame-instructions.js?v=1.59.439');
  assert.match(instructions.STORYBOARD_STILL_EXPRESSION_INSTRUCTIONS.join('\n'),/最终生图提示默认使用英文/);
});
