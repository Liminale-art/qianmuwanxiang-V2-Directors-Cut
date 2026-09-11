import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t, { configured = true } = {}) {
  const temporaryParent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(temporaryParent, 'qianmu-release-cli-'));
  t.after(async () => {
    // Remove only the unique test directory created above, never a configured release path.
    assert.equal(path.dirname(path.resolve(root)), temporaryParent);
    assert.ok(path.basename(root).startsWith('qianmu-release-cli-'));
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, '发行 fixture');
  const script = path.join(project, 'scripts', 'build-release.mjs');
  await mkdir(path.dirname(script), { recursive: true });
  await copyFile(new URL('../scripts/build-release.mjs', import.meta.url), script);
  const output = path.join(project, 'dist', 'release');
  const destination = path.join(output, 'fixture-v1.2.3');
  if (configured) {
    const files = {
      'manifest.json': JSON.stringify({ version: '1.2.3', display_name: 'Fixture', js: 'index.js', css: 'style.css' }),
      'package.json': JSON.stringify({ version: '1.2.3', type: 'module' }),
      'index.js': 'export const fixture = true;\n',
      'style.css': '.fixture { color: inherit; }\n',
      'LICENSE': 'Fixture license\n',
      'THIRD_PARTY_NOTICES.md': 'Fixture notices\n',
      'README.md': 'Fixture readme\n',
    };
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(project, name), content);
    await writeFile(path.join(project, 'release-files.json'), JSON.stringify({
      schemaVersion: 1, bundleName: 'fixture', outputDirectory: 'dist/release', files: Object.keys(files), directories: [],
    }));
  }
  return {
    project, output, destination,
    run: (...args) => {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    },
  };
}

test('retryable local imports still reject missing runtime files before a package is written',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.project,'index.js'),"loadLocalChunk('./qianmu-reader.js?v=test');\n");
  const result=f.run('--dry-run');assert.notEqual(result.status,0);assert.match(result.stderr,/qianmu-reader\.js/);
});

async function snapshot(directory) {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const stat = await lstat(file);
    entries.push([name, stat.mtimeMs, stat.isDirectory() ? await snapshot(file) : (await readFile(file)).toString('hex')]);
  }
  return entries;
}

test('release CLI dry-run reports the plan without creating an output directory', async t => {
  const f = await fixture(t);
  const result = f.run('--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { version: '1.2.3', files: 7, destination: f.destination, dryRun: true });
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('release CLI dry-run preserves an existing snapshot, files and timestamps', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.destination, 'nested'), { recursive: true });
  await writeFile(path.join(f.destination, 'nested', 'keep.txt'), 'Previous package, do not overwrite');
  await writeFile(path.join(f.destination, 'SHA256SUMS.txt'), 'Previous checksums');
  const before = await snapshot(f.output);
  const result = f.run('--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await snapshot(f.output), before);
});

for (const args of [['--help'], ['-h'], ['--dry-run', '--help']]) {
  test(`release CLI ${args.join(' ')} prints help without reading a release configuration`, async t => {
    const f = await fixture(t, { configured: false });
    const result = f.run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:[\s\S]*--dry-run/);
    assert.match(result.stdout, /without.*writ/i);
    await assert.rejects(lstat(f.output), { code: 'ENOENT' });
  });
}

for (const args of [['--dryrun'], ['--dry-run=false'], ['--dry-run', 'false'], ['--root', '../'], ['--help', '--unknown'], ['--']]) {
  test(`release CLI rejects ${JSON.stringify(args)} before touching output or configuration`, async t => {
    const f = await fixture(t, { configured: false });
    await mkdir(f.destination, { recursive: true });
    await writeFile(path.join(f.destination, 'keep.txt'), 'Previous package');
    const before = await snapshot(f.output);
    const result = f.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown release argument/);
    assert.equal(result.stdout, '');
    assert.deepEqual(await snapshot(f.output), before);
  });
}

test('release CLI dry-run still validates versions and refuses invalid plans without output writes', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  const result = f.run('--dry-run');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /manifest\/package version mismatch/);
  assert.equal(result.stdout, '');
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('release CLI without flags still builds a complete clean snapshot with checksums', async t => {
  const f = await fixture(t);
  await mkdir(f.destination, { recursive: true });
  await writeFile(path.join(f.destination, 'obsolete.txt'), 'Only this synthetic snapshot may be replaced');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { version: '1.2.3', files: 7, destination: f.destination, dryRun: false });
  assert.equal(await readFile(path.join(f.destination, 'index.js'), 'utf8'), 'export const fixture = true;\n');
  const sums = await readFile(path.join(f.destination, 'SHA256SUMS.txt'), 'utf8');
  assert.match(sums, /^[a-f0-9]{64}  index\.js$/m);
  assert.match(sums, /^[a-f0-9]{64}  release-info\.json$/m);
  assert.equal(sums.trim().split('\n').length, 8);
  await assert.rejects(lstat(path.join(f.destination, 'obsolete.txt')), { code: 'ENOENT' });
});
