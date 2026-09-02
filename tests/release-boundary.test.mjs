import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildRelease, loadReleaseConfig } from '../scripts/build-release.mjs';

const config = await loadReleaseConfig();
const result = await buildRelease({ dryRun: true });
const files = new Set(result.files);

assert.equal(config.schemaVersion, 1);
assert.equal(result.manifest.version, result.packageJson.version, 'manifest and service package versions must match');
assert.ok(result.files.length >= 40, 'the release closure must contain the complete client, service, assets, and notices');
for (const required of ['manifest.json', 'index.js', 'style.css', 'server-plugin.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  assert.ok(files.has(required), `release is missing ${required}`);
}
for (const forbidden of ['tests', 'node_modules', '.git', '.claude', '关于千幕.md', '千幕V2实测流程.md', '千幕V2视觉规范.md']) {
  assert.ok(!result.files.some((file) => file === forbidden || file.startsWith(`${forbidden}/`)), `${forbidden} must stay outside public snapshots`);
}
assert.ok(result.files.some((file) => file.startsWith('assets/focus-sounds/')), 'bundled focus sounds must remain installable offline');

const script = await readFile(new URL('../scripts/build-release.mjs', import.meta.url), 'utf8');
assert.match(script, /unlisted dependencies/, 'the builder must reject a runtime import missing from the whitelist');
assert.match(script, /assetMatcher[\s\S]*import\\\.meta\\\.url/, 'runtime assets created through import.meta.url must also stay in the dependency closure');
assert.match(script, /manifest\/package version mismatch/, 'the builder must reject split client and service versions');
assert.match(script, /SHA256SUMS\.txt/, 'each clean snapshot must carry deterministic checksums');
assert.match(script, /isSymbolicLink\(\)/, 'release directories may not smuggle external files through symlinks');

console.log('Public release boundary contract OK');
