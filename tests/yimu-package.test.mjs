import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildYimu, FRONTEND, BACKEND } from '../scripts/build-yimu.mjs';
import { VERSION } from '../yimu/contract.mjs';
import { QIANMU_HIVE_THEME_LOGO } from '../qianmu-hive-theme-logo.js';

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
    assert.equal((await fs.readFile(path.join(out, 'frontend/yimu/logo.svg'), 'utf8')).trim(), QIANMU_HIVE_THEME_LOGO.trim());
    const qianmu = JSON.parse(await fs.readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
    assert.equal(qianmu.files.some(file => file.startsWith('yimu/')), false);
});
