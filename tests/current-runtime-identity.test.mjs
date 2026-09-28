import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {currentRuntimeUrl,importCurrentRuntime} from './helpers/current-runtime.mjs';

const root = new URL('../', import.meta.url);
const files = (await readdir(root)).filter(file => /^qianmu-.*\.js$/.test(file) || file === 'index.js');
const sources = await Promise.all(files.map(async file => ({file,source:await readFile(new URL(file,root),'utf8')})));
for (const module of [
    'qianmu-ensemble-handoff.js', 'qianmu-ensemble-history.js',
    'qianmu-storyboard-stream-source.js', 'qianmu-storyboard-stream-coverage.js',
    'qianmu-storyboard-continuation-proof.js', 'qianmu-storyboard-floor-take.js',
]) test(`private runtime ${module} has one address shared by actual consumers and fixtures`, async () => {
    const expected = currentRuntimeUrl(module).href;
    const imports = [];
    for (const {file,source} of sources) {
        for (const [,specifier] of source.matchAll(/(?:from\s+|import\(\s*)['"](\.\/qianmu-[^'"]+\.js(?:\?[^'"]*)?)['"]/g)) {
            if (specifier.split('?')[0] !== `./${module}`) continue;
            imports.push(specifier);
            assert.equal(new URL(specifier,new URL(file,root)).href,expected,`${file} splits ${module}'s private state`);
        }
    }
    assert.ok(imports.length,`${module} must still have real production consumers`);
    assert.strictEqual(await import(expected),await importCurrentRuntime(module));
});
