import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blobStoreDatabaseName } from '../qianmu-blobstore.js';
import { createBrowserCredentialStore } from '../qianmu-browser-credentials.js';

const memory = (initial = {}) => { const data = { ...initial }; return { data, getItem: key => Object.hasOwn(data, key) ? data[key] : null, setItem: (key, value) => { data[key] = String(value); }, removeItem: key => { delete data[key]; } }; };
const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };

test('local store: the first account keeps the existing database, every other account gets its own', () => {
  const storage = memory();
  assert.equal(blobStoreDatabaseName('st-user:alice', storage), 'qianmu-blobstore', 'first opener adopts the existing database');
  assert.equal(storage.data['qianmu.blobstore.owner.v1'], 'st-user:alice');
  assert.equal(blobStoreDatabaseName('st-user:alice', storage), 'qianmu-blobstore', 'and keeps it on later opens');
  assert.equal(blobStoreDatabaseName('st-user:bob', storage), 'qianmu-blobstore::st-user:bob');
  assert.equal(blobStoreDatabaseName('st-user:carol', storage), 'qianmu-blobstore::st-user:carol');
  assert.throws(() => blobStoreDatabaseName('', storage), /账户未确认/, 'an unknown account never falls back to a shared database');
  assert.equal(blobStoreDatabaseName('st-user:alice', blocked), 'qianmu-blobstore::st-user:alice', 'if the claim cannot be recorded, nobody is treated as the owner');
});

test('the entry injects the account before any use, and an unconfigured store behaves as before', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /blobStore\.configureBlobStoreAccount\(\{ resolveNamespace: resolveImageAccountNamespace, onBlocked: /);
  const store = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');
  assert.match(store, /const name = accountResolver \? blobStoreDatabaseName\(await accountResolver\(\)\) : DB_NAME;/);
  assert.doesNotMatch(store, /indexedDB\.open\(DB_NAME/, 'the database is always opened by the resolved name');
});

test('browser key copies are per account; the old shared copy goes to the first account and is then removed', () => {
  const keys = { legacyKey: 'legacy', prefix: 'v2::', ownerKey: 'owner' };
  const storage = memory({ legacy: JSON.stringify({ nai: 'KEY-1', bad: '' }) });
  const alice = createBrowserCredentialStore({ storage, ...keys });
  assert.equal(alice.read('nai'), '', 'nothing is readable before the account is known'); assert.equal(alice.write('nai', 'x'), false); assert.deepEqual(alice.all(), {});
  alice.setAccount('st-user:alice');
  assert.equal(alice.read('nai'), 'KEY-1'); assert.equal(storage.data.legacy, undefined, 'the shared plaintext entry is gone'); assert.equal(storage.data.owner, 'st-user:alice');
  const bob = createBrowserCredentialStore({ storage, ...keys }); bob.setAccount('st-user:bob');
  assert.equal(bob.read('nai'), '', 'another account cannot read the first account\'s keys');
  assert.equal(bob.write('nai', ' KEY-2 '), true); assert.equal(bob.read('nai'), 'KEY-2'); assert.equal(alice.read('nai'), 'KEY-1');
  assert.equal(alice.write('nai', ''), true); assert.equal(alice.read('nai'), ''); assert.equal(bob.read('nai'), 'KEY-2');

  // A shared copy that appears after hand-over (an old tab still running) is not handed to a second account.
  storage.setItem('legacy', JSON.stringify({ nai: 'STALE' })); bob.setAccount('st-user:bob'); assert.equal(bob.read('nai'), 'KEY-2'); assert.equal(storage.data.legacy !== undefined, true);
  // Storage failures never throw and never drop the shared copy.
  const failing = createBrowserCredentialStore({ storage: blocked, ...keys }); failing.setAccount('st-user:x');
  assert.equal(failing.read('nai'), ''); assert.equal(failing.write('nai', 'k'), false);
  // An account that already has its own entry keeps it when adopting.
  const mixed = memory({ legacy: JSON.stringify({ nai: 'OLD' }), 'v2::st-user:d': JSON.stringify({ nai: 'OWN' }) });
  const dana = createBrowserCredentialStore({ storage: mixed, ...keys }); dana.setAccount('st-user:d');
  assert.equal(dana.read('nai'), 'OWN'); assert.equal(mixed.data.legacy, undefined);
});

test('the entry waits for the account on every asynchronous key path', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  for (const name of ['storyboardVideoCredentialConfigured', 'storyboardResolveVideoCredential', 'storyboardResolveApiKey', 'storyboardRememberApiKey', 'storyboardForgetApiKey', 'storyboardRefreshSecretState']) {
    const at = entry.indexOf(`async function ${name}(`); assert.ok(at > 0, name);
    assert.ok(entry.slice(at, at + 1400).includes('await storyboardCredentialAccount();'), name + ' must wait for the account');
  }
  assert.match(entry, /void storyboardCredentialAccount\(\);/);
  assert.doesNotMatch(entry, /localStorage\.(?:getItem|setItem)\(STORYBOARD_BROWSER_CREDENTIALS_KEY/, 'the shared entry is only touched through the store');
});
