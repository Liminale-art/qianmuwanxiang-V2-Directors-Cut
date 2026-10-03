import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { init, exit } from '../server-plugin.js';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createComfyTargetStore } from '../qianmu-comfy-target-store.js';

const account = () => ({ user: { profile: { handle: 'host-root-fixture', enabled: true, admin: true } } });
const response = () => ({
  statusCode: 200, headers: {}, body: undefined,
  status(value) { this.statusCode = value; return this; },
  set(name, value) { this.headers[name] = value; return this; },
  json(value) { this.body = value; return this; },
});
const capabilityRoutes = ['/image/comfy/cloud/capabilities', '/image/tasks/capabilities', '/image/vibe/capabilities'];

async function fixture(t, { rootValue = './data', options = {} } = {}) {
  const initialCwd = process.cwd(), initialRoot = Object.getOwnPropertyDescriptor(globalThis, 'DATA_ROOT');
  const parent = await fs.realpath(os.tmpdir()), host = await fs.mkdtemp(path.join(parent, 'qianmu-host-root-'));
  const data = path.join(host, 'data'), laterCwd = path.join(host, 'later'), attacker = path.join(host, 'client-directory');
  await Promise.all([data, laterCwd, attacker].map(directory => fs.mkdir(directory)));
  t.after(async () => {
    await exit();
    process.chdir(initialCwd);
    if (initialRoot) Object.defineProperty(globalThis, 'DATA_ROOT', initialRoot); else delete globalThis.DATA_ROOT;
    const real = await fs.realpath(host);
    assert.equal(path.dirname(real), parent); assert.match(path.basename(real), /^qianmu-host-root-/);
    await fs.rm(real, { recursive: true });
  });
  t.mock.method(globalThis, 'fetch', () => assert.fail('no real or simulated provider request is allowed'));
  process.chdir(host);
  globalThis.DATA_ROOT = typeof rootValue === 'function' ? rootValue({ host, data }) : rootValue;
  const routes = new Map();
  await init({ get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) }, {
    comfyTransportOptions: {
      resolveHost: () => assert.fail('data-root checks must not perform DNS'),
      requestImpl: () => assert.fail('data-root checks must not submit paid work'),
    },
    ...options,
  });
  const call = async (method, route, request = account()) => {
    const result = response(); await routes.get(`${method} ${route}`)(request, result); return result;
  };
  return { host, data, laterCwd, attacker, call };
}

test('actual plugin accepts the host default relative DATA_ROOT without creating files or calling providers', async t => {
  const f = await fixture(t);
  for (const route of capabilityRoutes) {
    const result = await f.call('GET', route);
    assert.equal(result.statusCode, 200, result.body?.message); assert.equal(result.body.ok, true);
  }
  const targets = await f.call('GET', '/image/comfy/targets');
  assert.equal(targets.statusCode, 200, targets.body?.message); assert.deepEqual(targets.body.targets, []);
  assert.deepEqual(await fs.readdir(f.data), []);
});

test('lazy stores resolve relative host paths against init cwd even after cwd changes, never request paths', async t => {
  const f = await fixture(t);
  process.chdir(f.laterCwd);
  const result = await f.call('POST', '/image/comfy/targets', { ...account(),
    dataRoot: f.attacker, query: { dataRoot: f.attacker }, headers: { 'x-data-root': f.attacker },
    body: { action: 'trust', expectedRevision: 0, baseUrl: 'https://comfy.example.test', name: 'Synthetic target',
      dataRoot: f.attacker, root: f.attacker, directory: f.attacker },
  });
  assert.equal(result.statusCode, 200, result.body?.message);
  const saved = JSON.parse(await fs.readFile(path.join(f.data, '.qianmu-service', 'comfy-targets-v1', 'registry.json'), 'utf8'));
  assert.equal(saved.state.targets.length, 1); assert.equal(saved.state.targets[0].name, 'Synthetic target');
  assert.deepEqual(await fs.readdir(f.laterCwd), []); assert.deepEqual(await fs.readdir(f.attacker), []);
  for (const route of capabilityRoutes) assert.equal((await f.call('GET', route)).statusCode, 200);
});

test('an explicit trusted host option is resolved independently of a missing global root', async t => {
  const f = await fixture(t, { rootValue: null, options: { dataRoot: './data' } });
  const result = await f.call('GET', '/image/comfy/targets');
  assert.equal(result.statusCode, 200, result.body?.message); assert.deepEqual(await fs.readdir(f.data), []);
});

test('an existing absolute host root remains authoritative after cwd changes', async t => {
  const f = await fixture(t, { rootValue: ({ data }) => data });
  process.chdir(f.laterCwd);
  const result = await f.call('GET', '/image/comfy/targets');
  assert.equal(result.statusCode, 200, result.body?.message);
  assert.deepEqual(await fs.readdir(f.data), []); assert.deepEqual(await fs.readdir(f.laterCwd), []);
});

for (const rootValue of ['D:data', 'D:', 'C:data']) test(`native host handles ${rootValue} without consulting drive-local cwd`, async t => {
  const f = await fixture(t, { rootValue });
  process.chdir(f.laterCwd);
  if (process.platform !== 'win32') await fs.mkdir(path.join(f.host, rootValue));
  for (const route of capabilityRoutes) {
    const result = await f.call('GET', route);
    if (process.platform === 'win32') {
      assert.notEqual(result.statusCode, 200);
      assert.equal(result.body.message, '增强服务缺少可信的 ST 数据目录');
      assert.equal(result.body.submissionState, 'not_submitted');
    } else assert.equal(result.statusCode, 200, result.body?.message);
  }
  assert.deepEqual(await fs.readdir(f.laterCwd), []);
});

test('actual host resolver rejects Windows drive-relative roots but preserves Linux colon directory names', async () => {
  const source = await fs.readFile(new URL('../server-plugin.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const hostWorkingDirectory = process.cwd();');
  const end = source.indexOf('  installStoryboardServerBatchV2Routes', start);
  assert.ok(start > 0 && end > start);
  const resolverSource = `${source.slice(start, end)}\nhostDataRoot;`;
  for (const platform of ['win32', 'linux']) {
    let cwd = platform === 'win32' ? 'C:\\ST' : '/srv/ST';
    let resolves = 0;
    const semantics = platform === 'win32' ? path.win32 : path.posix;
    const options = { dataRoot: './data' };
    const resolveRoot = vm.runInNewContext(resolverSource, {
      options, process: { platform, cwd: () => cwd },
      path: { ...semantics, resolve: (...args) => { resolves++; return semantics.resolve(...args); } },
    });
    cwd = platform === 'win32' ? 'D:\\changed' : '/changed';
    assert.equal(resolveRoot(), platform === 'win32' ? 'C:\\ST\\data' : '/srv/ST/data');
    for (const value of ['D:data', 'D:', 'C:data']) {
      options.dataRoot = value;
      const before = resolves;
      assert.equal(resolveRoot(), platform === 'win32' ? value : `/srv/ST/${value}`);
      assert.equal(resolves - before, platform === 'win32' ? 0 : 1);
    }
    const absolute = platform === 'win32' ? 'D:\\trusted\\data' : '/trusted/data';
    options.dataRoot = absolute;
    assert.equal(resolveRoot(), absolute);
  }
});

for (const [label, rootValue] of [
  ['missing', () => undefined], ['null', null], ['empty', ''], ['whitespace', '   '],
  ['number', 42], ['object', {}], ['array', ['./data']], ['NUL', './data\0wrong'],
  ['filesystem root', ({ host }) => path.parse(host).root], ['relative filesystem root', ({ host }) => path.relative(host, path.parse(host).root)],
]) test(`invalid ${label} host root stays rejected despite client-provided paths`, async t => {
  const f = await fixture(t, { rootValue });
  const request = { ...account(), dataRoot: f.data, body: { dataRoot: f.data }, query: { dataRoot: f.data } };
  for (const route of [...capabilityRoutes, '/image/comfy/targets']) {
    const result = await f.call('GET', route, request);
    assert.notEqual(result.statusCode, 200); assert.equal(result.body.ok, false);
    assert.equal(result.body.message, '增强服务缺少可信的 ST 数据目录');
    assert.equal(result.body.submissionState, 'not_submitted');
  }
  const submit = await f.call('POST', '/image/comfy/cloud/tasks/submit', request);
  assert.notEqual(submit.statusCode, 200); assert.equal(submit.body.submissionState, 'not_submitted');
  assert.deepEqual(await fs.readdir(f.data), []);
});

test('unauthenticated calls remain rejected before host storage is constructed', async t => {
  const f = await fixture(t);
  for (const route of [...capabilityRoutes, '/image/comfy/targets']) {
    assert.equal((await f.call('GET', route, { body: { dataRoot: f.data } })).statusCode, 401);
  }
  assert.deepEqual(await fs.readdir(f.data), []);
});

test('store contracts still reject raw relative roots outside the trusted plugin boundary', () => {
  for (const create of [createImageServiceStore, createComfyTargetStore]) {
    assert.throws(() => create({ dataRoot: './data' }), /增强服务缺少可信的 ST 数据目录/);
  }
});
