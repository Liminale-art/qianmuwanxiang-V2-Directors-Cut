import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectReleaseFiles,buildRelease} from '../scripts/build-release.mjs';

const root=new URL('../',import.meta.url),version='1.59.440';
const edge=(parent,...children)=>children.map(child=>[parent,`qianmu-${child}.js`]);
const affectedEdges=[
  ...edge('index.js','prose-floor-tools','storyboard-inline-reading','image-info-view','image-zoom','gallery-collections-view',
    'comfy-recovery-action','service-recovery-action','storyboard-original-recovery','storyboard','image-direct',
    'image-admission','comfy-recovery-client','character-shot-view','service-capabilities','comfy-character-plan',
    'comfy-character-readiness','comfy-preflight','comfy-readiness','storage-backup-view','icon-renderer',
    'gallery-inspector','gallery-taxonomy','gallery-choice-picker','gallery-keywords-view','gallery-narrative'),
  ...edge('qianmu-gallery-taxonomy.js','gallery-choice-picker'),
  ...edge('qianmu-gallery-keywords-view.js','gallery-choice-picker'),
  ...edge('qianmu-prose-floor-tools.js','prose-floor-entries'),
  ...edge('qianmu-character-shot-view.js','character-shot-edit'),
  ...edge('qianmu-character-shot-edit.js','comfy-character-plan'),
  ...edge('qianmu-storyboard.js','comfy-workflow'),
  ...edge('qianmu-image-direct.js','comfy-workflow','comfy-results','comfy-audit'),
  ...edge('qianmu-image-admission.js','comfy-audit'),
  ...edge('qianmu-comfy-preflight.js','comfy-workflow','comfy-audit'),
  ...edge('qianmu-comfy-readiness.js','comfy-workflow','comfy-preflight'),
  ...edge('qianmu-comfy-character-readiness.js','comfy-readiness'),
  ...edge('qianmu-comfy-character-plan.js','comfy-workflow'),
  ...edge('qianmu-comfy-recovery-client.js','comfy-cloud-request'),
  ...edge('qianmu-comfy-cloud-request.js','comfy-audit','comfy-workflow','comfy-cloud-workflow'),
  ...edge('qianmu-comfy-cloud-workflow.js','comfy-workflow'),
  ...edge('qianmu-comfy-audit.js','comfy-workflow'),
];
const source=file=>readFile(new URL(file,root),'utf8');
const key=pair=>pair.join(' -> ');

test('illustration entry, stylesheet and host package advertise one local version',async()=>{
  const result=await buildRelease({dryRun:true});
  assert.equal(result.dryRun,true);
  assert.equal(result.manifest.version,version);assert.equal(result.packageJson.version,version);
  assert.equal(result.manifest.js,`index.js?v=${version}`);assert.equal(result.manifest.css,`style.css?v=${version}`);
  assert.ok((await source('index.js')).includes(`const VERSION = '${version}';`));
  assert.match(await source('server-plugin.js'),/async function pluginVersion\(\)[\s\S]*?import\('\.\/package\.json'[\s\S]*?module.default\?\.version/,
    'the service reports the shared package version rather than a second hard-coded value');
  for(const file of ['qianmu-image-info-view.js','qianmu-image-zoom.js','qianmu-storyboard-inline-reading.js','qianmu-storyboard-original-recovery.js'])
    assert.ok(result.files.includes(file),`${file} must be available offline in the installed extension`);
});

test('reading and candidate execution load exactly their affected cache ancestors',async()=>{
  const files=await collectReleaseFiles(),sources=new Map(await Promise.all(files.filter(file=>file.endsWith('.js')).map(async file=>[file,await source(file)])));
  const actual=new Set();
  for(const [parent,content] of sources)for(const match of content.matchAll(/['"]\.\/([^'"\r\n]+\.js)\?v=1\.59\.440['"]/g))actual.add(key([parent,match[1]]));
  assert.deepEqual([...actual].sort(),affectedEdges.map(key).sort(),'do not expand a focused release into a repository-wide cache change');
  for(const [parent,child] of affectedEdges){
    assert.ok(files.includes(child));
    assert.ok(sources.get(parent).includes(`'./${child}?v=${version}'`),`${parent} must refresh the literal child address`);
    assert.ok(!sources.get(parent).includes(`'./${child}'`),`${parent} cannot also consume the stale bare export`);
  }
  const unchanged=[
    ['qianmu-prose-assistant-floor.js','qianmu-prose-floor-entries.js?v=1.59.419'],
    ['qianmu-text-collection-floor.js','qianmu-prose-floor-entries.js?v=1.59.419'],
    ['qianmu-prose-floor-tools.js','qianmu-idle-preload.js?v=1.59.425'],
    ['qianmu-comfy-recovery-client.js','qianmu-comfy-cloud-execution.js?v=1.59.429'],
    ['qianmu-comfy-library.js','qianmu-comfy-workflow.js'],
    ['qianmu-comfy-references.js','qianmu-comfy-results.js'],
    ['index.js','qianmu-feature-runtime.js?v=1.59.425'],
    ['index.js','qianmu-storyboard-contract.js?v=1.59.439'],
  ];
  for(const [parent,child] of unchanged)assert.ok(sources.get(parent).includes(`'./${child}'`),`${parent} uses unchanged behavior from ${child}`);
  for(const file of ['scripts/preview-storyboard-logs.mjs','tests/storyboard-inline-reading.test.mjs','tests/illustration-release.test.mjs'])
    assert.ok(!files.includes(file),'developer verification code must remain outside the public release');
});
