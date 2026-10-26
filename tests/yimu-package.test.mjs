import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildYimu, FRONTEND, BACKEND } from '../scripts/build-yimu.mjs';
import { VERSION } from '../yimu/contract.mjs';

test('candidate packages are self-contained, preserve logo geometry, refuse overwrites and never enter Qianmu release', async t => {
    const parent = await fs.realpath(os.tmpdir());
    const temp = await fs.mkdtemp(path.join(parent, 'yimu-package-test-'));
    t.after(async () => {
        const resolved = await fs.realpath(temp);
        assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^yimu-package-test-/);
        await fs.rm(resolved, { recursive: true });
    });
    const out = path.join(temp, 'candidate');
    const stamp = await buildYimu(out);
    assert.equal(stamp.version, VERSION);
    await assert.rejects(buildYimu(out), { code: 'EEXIST' });
    for (const [kind, files] of [['frontend', FRONTEND], ['server', BACKEND]]) {
        for (const name of files) {
            const target = path.join(out, kind, 'yimu', name);
            const text = await fs.readFile(target, 'utf8');
            if (name.endsWith('.mjs')) {
                for (const match of text.matchAll(/(?:from\s+|import\()['"]([^'"]+)['"]/g)) {
                    if (match[1].startsWith('node:')) continue;
                    assert.ok(match[1].startsWith('./'), `${name} is not allowed to depend on Qianmu or ST filesystem paths`);
                    await fs.access(path.resolve(path.dirname(target), match[1]));
                }
            }
        }
    }
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'frontend/yimu/manifest.json'), 'utf8'));
    const pkg = JSON.parse(await fs.readFile(path.join(out, 'server/yimu/package.json'), 'utf8'));
    assert.equal(manifest.version, VERSION); assert.equal(pkg.version, VERSION);
    const server = await import(pathToFileURL(path.join(out, 'server/yimu/server-plugin.mjs')));
    assert.equal(server.info.id, 'yimu');
    const frontend = await import(pathToFileURL(path.join(out, 'frontend/yimu/index.mjs')));
    assert.equal(typeof frontend.boot, 'function');
    const packagedLogo = await fs.readFile(path.join(out, 'frontend/yimu/logo.svg'), 'utf8');
    const sourceLogo = await fs.readFile(new URL('../yimu/logo.svg', import.meta.url), 'utf8');
    assert.equal(createHash('sha256').update(packagedLogo).digest('hex'), createHash('sha256').update(sourceLogo).digest('hex'), 'build preserves the current Yimu logo asset');
    const embedded = packagedLogo.match(/xlink:href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
    assert.ok(embedded, 'the user PNG is embedded locally, not fetched or replaced with the Qianmu hive');
    const original = Buffer.from(embedded[1], 'base64');
    assert.equal(original.length, 226760);
    assert.equal(createHash('sha256').update(original).digest('hex'), '0eaf11c7a68943fbe0721dce97944518fd6da334742270b74f34369da678483f', 'fixed source hash verifies original PNG including its alpha and texture, without a desktop/CI dependency');
    assert.equal(original.readUInt32BE(16), 1254); assert.equal(original.readUInt32BE(20), 1254); assert.equal(original[25], 6, 'PNG is RGBA');
    assert.match(packagedLogo, /viewBox="0 0 1254 1254"/); assert.doesNotMatch(packagedLogo, /<path|https?:\/\/(?!www\.w3\.org)/);
    const qianmu = JSON.parse(await fs.readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
    assert.equal(qianmu.files.some(file => file.startsWith('yimu/')), false);
});
