import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectReleaseFiles,buildRelease} from '../scripts/build-release.mjs';

const root=new URL('../',import.meta.url),version='1.59.442',viewVersion='1.59.441';
const edge=(parent,...children)=>children.map(child=>[parent,`qianmu-${child}.js`]);
const affectedEdges=[
  ...edge('index.js','image-info-view','gallery-collections-view','gallery-taxonomy','gallery-summary'),
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

test('gallery toolbar CSS release preserves existing view and metadata module URLs',async()=>{
  const files=await collectReleaseFiles(),sources=new Map(await Promise.all(files.filter(file=>file.endsWith('.js')).map(async file=>[file,await source(file)])));
  const actual=new Set();
  for(const [parent,content] of sources)for(const match of content.matchAll(/['"]\.\/([^'"\r\n]+\.js)\?v=1\.59\.441['"]/g))actual.add(key([parent,match[1]]));
  assert.deepEqual([...actual].sort(),affectedEdges.map(key).sort(),'do not expand a focused release into a repository-wide cache change');
  for(const [parent,child] of affectedEdges){
    assert.ok(files.includes(child));
    assert.ok(sources.get(parent).includes(`'./${child}?v=${viewVersion}'`),`${parent} must retain the unchanged child address`);
    assert.ok(!sources.get(parent).includes(`'./${child}'`),`${parent} cannot also consume the stale bare export`);
  }
  for(const content of sources.values())assert.doesNotMatch(content,/['"]\.\/[^'"\r\n]+\.js\?v=1\.59\.442['"]/,'a CSS-only fix must not refresh unchanged module URLs');
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
