import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectReleaseFiles} from '../scripts/build-release.mjs';

const root = new URL('../',import.meta.url), version = '1.59.427';
const files = await collectReleaseFiles();
const sources = new Map(await Promise.all(files.filter(file => file.endsWith('.js'))
  .map(async file => [file,await readFile(new URL(file,root),'utf8')])));
const refs = source => [...source.matchAll(/(['"])(\.\/[^'"\r\n]+\.js(?:\?[^'"\r\n]*)?)\1/g)].map(match => match[2]);

test('changed host, guard and import paths have fresh literal addresses through their actual reverse closure',() => {
  const changed = new Set(['qianmu-st-context-sources.js','qianmu-storyboard-preparation-guard.js',
    'qianmu-storyboard-package-draft.js','qianmu-storyboard-bundle-configuration.js']);
  const inbound = new Map([...changed].map(file => [file,[]]));
  for (const [file,source] of sources) for (const specifier of refs(source)) {
    const target = specifier.slice(2).split('?')[0];
    if (!changed.has(target)) continue;
    assert.equal(specifier,`./${target}?v=${target === 'qianmu-st-context-sources.js' ? '1.59.445' : version}`,`${file} cannot retain a stale child URL`);
    inbound.get(target).push(file);
  }
  assert.deepEqual(inbound.get('qianmu-st-context-sources.js'),['index.js']);
  assert.deepEqual(inbound.get('qianmu-storyboard-preparation-guard.js'),['index.js']);
  assert.deepEqual(inbound.get('qianmu-storyboard-package-draft.js').sort(),['index.js','qianmu-storyboard-bundle-configuration.js']);
  assert.deepEqual(inbound.get('qianmu-storyboard-bundle-configuration.js'),['index.js']);
});

test('every actual state-normalizer import uses the current core while injected and unchanged consumers remain narrow',async () => {
  const consumers = [];
  for (const [file,source] of sources) {
    if (!source.includes('normalizeStoryboardState')) continue;
    const specifier = /from\s*['"](\.\/qianmu-storyboard\.js(?:\?[^'"]*)?)['"]/.exec(source)?.[1];
    if (!specifier) continue;
    consumers.push(file);
    const consumerVersion=file==='index.js'?'1.59.440':version;
    assert.equal(specifier,`./qianmu-storyboard.js?v=${consumerVersion}`,`${file}: old normalization must not discard confirmed selections`);
  }
  assert.deepEqual(consumers.sort(),['index.js','qianmu-storyboard-package-draft.js']);
  assert.match(sources.get('qianmu-config-connections.js'),/\{clone, mergeDefaults, normalizeStoryboardState,/,'full-config restore receives the fresh function from the entry');
  assert.ok(refs(sources.get('index.js')).includes('./qianmu-feature-runtime.js?v=1.59.425'),'unchanged local-loader identity stays shared');
  assert.ok(refs(sources.get('index.js')).includes('./qianmu-storyboard-floor-capture.js?v=1.59.414'),'unrelated capture runtime is not version-bumped');
  const {createStoryboardDefaults} = await import(new URL(`qianmu-storyboard.js?v=${version}`,root));
  const {prepareStoryboardPackageDraft} = await import(new URL(`qianmu-storyboard-package-draft.js?v=${version}`,root));
  const local = createStoryboardDefaults(), incoming = createStoryboardDefaults();
  incoming.promptCompiler.personaWorldSelections = [{kind:'user',owner:'synthetic.png',book:'Synthetic',enabled:true,
    entryIds:Array.from({length:125},(_,index) => `Synthetic::${index}`)}];
  const prepared = prepareStoryboardPackageDraft({settings:local,chat:{},incoming,images:[],collections:[],chatKey:'synthetic'});
  assert.equal(prepared.settings.promptCompiler.personaWorldSelections[0].entryIds.length,125);
  assert.deepEqual(local.promptCompiler.personaWorldSelections,[]);
});

test('all three new worldbook modules ship through the real static entry path, without developer previews',() => {
  for (const file of ['qianmu-storyboard-persona-world.js','qianmu-storyboard-worldbooks.js','qianmu-storyboard-worldbook-view.js']) assert.ok(files.includes(file),file);
  assert.ok(refs(sources.get('index.js')).includes(`./qianmu-storyboard-worldbooks.js?v=${version}`));
  for (const target of ['qianmu-storyboard-persona-world.js','qianmu-storyboard-worldbook-view.js']) {
    assert.ok(refs(sources.get('qianmu-storyboard-worldbooks.js')).some(ref => ref.split('?')[0] === `./${target}`));
  }
  assert.ok(refs(sources.get('qianmu-storyboard.js')).some(ref => ref.split('?')[0] === './qianmu-storyboard-persona-world.js'));
  assert.ok(!files.includes('scripts/preview-persona-worldbooks.mjs'));
});
