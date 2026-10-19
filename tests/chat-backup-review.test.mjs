import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createChatBackupService } from '../qianmu-chat-backup-service.js';

const body = text => JSON.stringify({ chat_metadata: { integrity: 'synthetic-only', other: { untouched: true } } }) + '\n' + JSON.stringify({ mes: text, name: '合成角色' }) + '\n';
const accountInput = { expectedAccount: 'st-user:default-user' };
const settings = { ...accountInput, enabled: true, intervalMinutes: 15, limitMiB: 256 };
async function setup(t, options = {}) {
    const temp = await fs.realpath(os.tmpdir()), container = await fs.mkdtemp(path.join(temp, 'qianmu-backup-review-'));
    const root = path.join(container, '独立 data root'), owner = path.join(root, 'default-user'), chats = path.join(owner, 'chats'), backup = path.join(owner, 'qianmu-chat-backups');
    await fs.mkdir(chats, { recursive: true });
    const user = { profile: { handle: 'default-user', enabled: true }, directories: { root: owner, chats } };
    let stamp = Date.UTC(2026, 9, 19, 3), services = [];
    const make = overrides => { const service = createChatBackupService({ dataRoot: root, accounts: async () => [user], now: () => stamp, timers: { setTimeout: () => 1, clearTimeout() {} }, ...options, ...overrides }); services.push(service); return service; };
    const service = make(), req = { user };
    const write = async (text, role = 'role', filename = 'chat.jsonl') => { const directory = path.join(chats, role); await fs.mkdir(directory, { recursive: true }); const file = path.join(directory, filename); await fs.writeFile(file, body(text)); return file; };
    t.after(async () => { await Promise.all(services.map(service => service.close())); const resolved = await fs.realpath(container); assert.equal(path.dirname(resolved), temp); assert.match(path.basename(resolved), /^qianmu-backup-review-/); await fs.rm(resolved, { recursive: true }); });
    return { root, owner, chats, backup, user, req, service, make, write, advance: () => { stamp += 16 * 60000; } };
}

test('independent review: absolute external data roots work without assuming cwd/default data layout', async t => {
    const f = await setup(t), source = await f.write('外置目录合成正文'), before = await fs.readFile(source);
    await f.service.configure(f.req, settings); await f.service.run();
    const entries = (await f.service.list(f.req, accountInput)).entries;
    assert.equal(entries.length, 1); assert.deepEqual(await fs.readFile(source), before);
    const forged = { user: { profile: f.user.profile, directories: { root: path.dirname(f.owner), chats: f.chats } } };
    await assert.rejects(f.service.list(forged, accountInput), { status: 403 });
    assert.throws(() => createChatBackupService({ dataRoot: './data', accounts: async () => [f.user] }), { code: 'chat_backup_host' });
});

test('independent review: a partially written descriptor fails closed without replacing earlier snapshots', async t => {
    let failWrite = false;
    const f = await setup(t, { io: { ...fs, open: async (file, ...args) => {
        const handle = await fs.open(file, ...args);
        if (failWrite && args[0] === 'wx' && /[\\/][a-f0-9-]{36}\.json$/.test(file)) {
            handle.writeFile = async () => { await handle.write('{'); throw Object.assign(new Error('synthetic partial write'), { code: 'EIO' }); };
        }
        return handle;
    } } });
    await f.write('原始完整副本'); await f.service.configure(f.req, settings); await f.service.run();
    const original = (await f.service.list(f.req, accountInput)).entries[0], raw = await fs.readFile(path.join(f.backup, original.id + '.jsonl'));
    failWrite = true; await f.write('新正文'); f.advance(); await f.service.run();
    assert.deepEqual(await fs.readFile(path.join(f.backup, original.id + '.jsonl')), raw);
    await assert.rejects(f.service.list(f.req, accountInput), { code: 'chat_backup_corrupt' });
    const names = await fs.readdir(f.backup); assert.equal(names.filter(name => name.endsWith('.jsonl')).length, 2);
    assert.equal(names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).length, 2);
});

test('independent review: a dead-process lock is retained and cannot silently restart writes', async t => {
    const f = await setup(t, { processStatus: () => 'dead' });
    await f.write('已有副本'); await f.service.configure(f.req, settings); await f.service.run();
    const old = (await f.service.list(f.req, accountInput)).entries[0];
    const lock = JSON.stringify({ version: 1, owner: '00000000-0000-4000-8000-000000000001', pid: 999999 });
    await fs.writeFile(path.join(f.backup, '.operation.lock'), lock); await f.write('等待管理员核查'); f.advance(); await f.service.run();
    const status = await f.service.status(f.req, accountInput);
    assert.match(status.lastResult.error, /中断.*保存锁/); assert.equal((await f.service.list(f.req, accountInput)).entries[0].id, old.id);
    assert.equal(await fs.readFile(path.join(f.backup, '.operation.lock'), 'utf8'), lock);
});

test('independent review: no old version is retired if another source has no verified surviving copy', async t => {
    const f = await setup(t); await f.write('a'.repeat(150000), 'first'); await f.write('second original', 'second');
    await f.service.configure(f.req, settings); await f.service.run();
    const initial = (await f.service.list(f.req, accountInput)).entries, second = initial.find(row => row.avatar === 'second.png');
    const saved = await Promise.all(initial.map(row => fs.readFile(path.join(f.backup, row.id + '.json'))));
    await fs.writeFile(path.join(f.backup, second.id + '.jsonl'), body('damaged saved copy'));
    const used = (await f.service.status(f.req, accountInput)).usedBytes, filler = await fs.open(path.join(f.backup, '.retained-review-filler'), 'wx');
    await filler.truncate(256 * 1024 * 1024 - used - 1000); await filler.close();
    await f.write('b'.repeat(50000), 'first'); f.advance(); await f.service.run();
    for (let index = 0; index < initial.length; index++) assert.deepEqual(await fs.readFile(path.join(f.backup, initial[index].id + '.json')), saved[index]);
    assert.match((await f.service.status(f.req, accountInput)).lastResult.error, /完整备份|校验失败/);
});

test('independent review: source folder replacement is detected and original bytes remain untouched', async t => {
    let armed = false, moved = false, f;
    f = await setup(t, { io: { ...fs, open: async (file, ...args) => {
        if (armed && !moved && String(file).endsWith(path.join('role', 'chat.jsonl'))) {
            await fs.rename(path.join(f.chats, 'role'), path.join(f.chats, 'preserved-role')); moved = true;
            await fs.mkdir(path.join(f.chats, 'role')); await fs.writeFile(path.join(f.chats, 'role', 'chat.jsonl'), body('replacement'));
        }
        return fs.open(file, ...args);
    } } });
    await f.write('original'); await f.service.configure(f.req, settings); armed = true; await f.service.run();
    assert.equal(moved, true); assert.equal(await fs.readFile(path.join(f.chats, 'preserved-role', 'chat.jsonl'), 'utf8'), body('original'));
    const entries = (await f.service.list(f.req, accountInput)).entries;
    assert.equal(entries.some(entry => entry.avatar === 'role.png'), false);
    assert.ok((await f.service.status(f.req, accountInput)).lastResult.error);
});

test('independent review: legacy raw checksum is verified before adding the unlimited count default', async t => {
    const f = await setup(t); await fs.mkdir(f.backup);
    // Deliberately keep a different valid property order. Compatibility must
    // verify exactly the stored signed fields, not a reconstructed new schema.
    const legacy = { lastResult: { skipped: 0, unchanged: 0, created: 0 }, nextRunAt: null, lastSuccessAt: null, lastRunAt: null,
        limitMiB: 256, intervalMinutes: 15, enabled: false, expectedAccount: accountInput.expectedAccount, version: 1 };
    const signed = { ...legacy, checksum: createHash('sha256').update(JSON.stringify(legacy)).digest('hex') };
    const filename = path.join(f.backup, '.settings-v1.json'), bytes = Buffer.from(JSON.stringify(signed));
    await fs.writeFile(filename, bytes);
    assert.equal((await f.service.status(f.req, accountInput)).maxVersionsPerChat, 0);
    assert.deepEqual(await fs.readFile(filename), bytes, 'reading legacy settings must not rewrite or migrate the original');
    await fs.writeFile(filename, JSON.stringify({ ...signed, maxVersionsPerChat: 0 }));
    await assert.rejects(f.service.status(f.req, accountInput), { code: 'chat_backup_corrupt' });
    await fs.writeFile(filename, bytes);
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 3 });
    assert.equal((await f.service.configure(f.req, { ...settings, intervalMinutes: 30 })).maxVersionsPerChat, 3,
        'an old configure client omitting the new field must retain the chosen quota');
});

test('independent review: count quotas are per chat file, and an empty source cannot be trimmed by another healthy source', async t => {
    const f = await setup(t); await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 0 });
    for (let version = 0; version < 3; version++) {
        await f.write('a' + version, 'same-role', 'a.jsonl'); await f.write('b' + version, 'same-role', 'b.jsonl');
        await f.service.run(); f.advance();
    }
    const initial = (await f.service.list(f.req, accountInput)).entries;
    assert.equal(initial.length, 6, 'zero does not silently cap each chat to one version');
    const emptySource = path.join(f.chats, 'same-role', 'b.jsonl');
    await fs.writeFile(emptySource, JSON.stringify({ chat_metadata: { preservedEmpty: true } }) + '\n');
    const beforeEmpty = await fs.readFile(emptySource), preserved = initial.filter(entry => entry.chatFile === 'b.jsonl').map(entry => entry.id).sort();
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 1 });
    assert.equal((await f.service.list(f.req, accountInput)).entries.length, 6, 'configuration is not an eager destructive sweep');
    await f.service.run();
    const entries = (await f.service.list(f.req, accountInput)).entries;
    assert.equal(entries.filter(entry => entry.chatFile === 'a.jsonl').length, 1, 'stable unchanged nonempty source can converge next round');
    assert.deepEqual(entries.filter(entry => entry.chatFile === 'b.jsonl').map(entry => entry.id).sort(), preserved);
    assert.deepEqual(await fs.readFile(emptySource), beforeEmpty);
});

test('independent review: a damaged latest snapshot prevents unchanged-source count cleanup', async t => {
    const f = await setup(t); await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 0 });
    for (let version = 0; version < 3; version++) { await f.write('version' + version); await f.service.run(); f.advance(); }
    const initial = (await f.service.list(f.req, accountInput)).entries, latest = initial[0];
    await fs.writeFile(path.join(f.backup, latest.id + '.jsonl'), body('damaged but still valid JSONL'));
    const bytes = await Promise.all(initial.map(entry => fs.readFile(path.join(f.backup, entry.id + '.jsonl'))));
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 1 }); await f.service.run();
    assert.deepEqual((await f.service.list(f.req, accountInput)).entries.map(entry => entry.id), initial.map(entry => entry.id));
    for (let index = 0; index < initial.length; index++) assert.deepEqual(await fs.readFile(path.join(f.backup, initial[index].id + '.jsonl')), bytes[index]);
    assert.match((await f.service.status(f.req, accountInput)).lastResult.error, /校验失败/);
});

test('independent review: an unchanged source turning empty after its read cannot trigger count cleanup', async t => {
    let armed = false, sourceRead = false, changed = false, source;
    const f = await setup(t, { io: { ...fs, open: async (file, ...args) => {
        if (armed && file === source) sourceRead = true;
        if (armed && sourceRead && !changed && /[\\/][a-f0-9-]{36}\.json$/.test(file)) {
            changed = true; await fs.writeFile(source, JSON.stringify({ chat_metadata: { becameEmpty: true } }) + '\n');
        }
        return fs.open(file, ...args);
    } } });
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 0 });
    for (let version = 0; version < 3; version++) { source = await f.write('version' + version); await f.service.run(); f.advance(); }
    const initial = (await f.service.list(f.req, accountInput)).entries;
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 1 }); armed = true; await f.service.run();
    assert.equal(changed, true, 'the synthetic source changed after its initial read');
    assert.deepEqual((await f.service.list(f.req, accountInput)).entries.map(entry => entry.id), initial.map(entry => entry.id));
    assert.ok((await f.service.status(f.req, accountInput)).lastResult.error);
});

test('independent review: a new snapshot verification failure cannot retire versions to meet the count limit', async t => {
    let damage = false;
    const f = await setup(t, { io: { ...fs, open: async (file, ...args) => {
        const handle = await fs.open(file, ...args);
        if (damage && args[0] === 'wx' && /[\\/][a-f0-9-]{36}\.jsonl$/.test(file)) {
            const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); await handle.write(Buffer.from('!'), 0, 1, 0); };
        }
        return handle;
    } } });
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 0 });
    for (let version = 0; version < 3; version++) { await f.write('version' + version); await f.service.run(); f.advance(); }
    const initial = (await f.service.list(f.req, accountInput)).entries;
    const bytes = await Promise.all(initial.map(entry => fs.readFile(path.join(f.backup, entry.id + '.jsonl'))));
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 1 }); damage = true;
    const source = await f.write('new source after lower count'); await f.service.run();
    assert.deepEqual((await f.service.list(f.req, accountInput)).entries.map(entry => entry.id), initial.map(entry => entry.id));
    for (let index = 0; index < initial.length; index++) assert.deepEqual(await fs.readFile(path.join(f.backup, initial[index].id + '.jsonl')), bytes[index]);
    assert.equal(await fs.readFile(source, 'utf8'), body('new source after lower count'));
});

test('independent review: impossible lower byte and count limits preserve all old versions before reporting insufficient space', async t => {
    const f = await setup(t); await f.service.configure(f.req, { ...settings, limitMiB: 1024, maxVersionsPerChat: 0 });
    for (let version = 0; version < 3; version++) { await f.write('v' + version); await f.service.run(); f.advance(); }
    const initial = (await f.service.list(f.req, accountInput)).entries;
    const bytes = await Promise.all(initial.map(entry => fs.readFile(path.join(f.backup, entry.id + '.jsonl'))));
    const used = (await f.service.status(f.req, accountInput)).usedBytes;
    const filler = await fs.open(path.join(f.backup, '.retained-review-incompressible'), 'wx');
    await filler.truncate(256 * 1024 * 1024 - used + 10000); await filler.close();
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 1 }); await f.service.run();
    assert.deepEqual((await f.service.list(f.req, accountInput)).entries.map(entry => entry.id), initial.map(entry => entry.id));
    for (let index = 0; index < initial.length; index++) assert.deepEqual(await fs.readFile(path.join(f.backup, initial[index].id + '.jsonl')), bytes[index]);
    assert.match((await f.service.status(f.req, accountInput)).lastResult.error, /空间|上限/);
});

test('independent review: combined count and byte rotation retires each UUID once and never touches native backups', async t => {
    const retired = [];
    const f = await setup(t, { io: { ...fs, rename: async (from, to) => {
        if (String(to).includes('.retired-') && /[\\/][a-f0-9-]{36}\.json$/.test(from)) retired.push(path.basename(from));
        return fs.rename(from, to);
    } } });
    const native = path.join(f.owner, 'backups'); await fs.mkdir(native); const nativeFile = path.join(native, 'chat_synthetic_20261019-030000.jsonl');
    await fs.writeFile(nativeFile, 'native bytes never rotated');
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 0 });
    for (let version = 0; version < 3; version++) {
        await f.write('a'.repeat(20000) + version, 'same-role', 'a.jsonl'); await f.write('b'.repeat(20000) + version, 'same-role', 'b.jsonl');
        await f.service.run(); f.advance();
    }
    const used = (await f.service.status(f.req, accountInput)).usedBytes;
    const filler = await fs.open(path.join(f.backup, '.retained-review-dual-limit'), 'wx');
    await filler.truncate(256 * 1024 * 1024 - used - 1000); await filler.close();
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 1 });
    await f.write('new'.repeat(17000), 'same-role', 'a.jsonl'); await f.service.run();
    const entries = (await f.service.list(f.req, accountInput)).entries, status = await f.service.status(f.req, accountInput);
    assert.equal(entries.filter(entry => entry.chatFile === 'a.jsonl').length, 1);
    assert.equal(entries.filter(entry => entry.chatFile === 'b.jsonl').length, 1);
    assert.equal(retired.length, 5); assert.equal(new Set(retired).size, retired.length);
    assert.ok(status.usedBytes <= 256 * 1024 * 1024); assert.equal(status.lastResult.error, undefined);
    assert.equal(await fs.readFile(nativeFile, 'utf8'), 'native bytes never rotated');
});

test('independent review: capacity pressure cannot borrow history from a now-empty source to admit another snapshot', async t => {
    const f = await setup(t); await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 0 });
    for (let version = 0; version < 3; version++) {
        if (version < 2) await f.write('a'.repeat(20000) + version, 'same-role', 'a.jsonl');
        await f.write('b'.repeat(20000) + version, 'same-role', 'b.jsonl');
        await f.service.run(); f.advance();
    }
    const initial = (await f.service.list(f.req, accountInput)).entries;
    assert.equal(initial.length, 5);
    const bytes = await Promise.all(initial.map(entry => fs.readFile(path.join(f.backup, entry.id + '.jsonl'))));
    const used = (await f.service.status(f.req, accountInput)).usedBytes;
    const filler = await fs.open(path.join(f.backup, '.retained-review-empty-source'), 'wx');
    await filler.truncate(256 * 1024 * 1024 - used - 1000); await filler.close();
    const empty = path.join(f.chats, 'same-role', 'b.jsonl'); await fs.writeFile(empty, JSON.stringify({ chat_metadata: {} }) + '\n');
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 1 });
    await f.write('new'.repeat(17000), 'same-role', 'a.jsonl'); await f.service.run();
    assert.deepEqual((await f.service.list(f.req, accountInput)).entries.map(entry => entry.id), initial.map(entry => entry.id));
    for (let index = 0; index < initial.length; index++) assert.deepEqual(await fs.readFile(path.join(f.backup, initial[index].id + '.jsonl')), bytes[index]);
    assert.ok((await f.service.status(f.req, accountInput)).lastResult.error);
});

test('independent review: count convergence exceeding the verification budget stops before retiring any UUID', async t => {
    let retired = 0;
    const f = await setup(t, { io: { ...fs, rename: async (from, to) => {
        if (String(to).includes('.retired-')) retired++;
        return fs.rename(from, to);
    } } });
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 0 });
    for (let version = 0; version < 3; version++) { await f.write('version' + version); await f.service.run(); f.advance(); }
    const initial = (await f.service.list(f.req, accountInput)).entries, size = initial[0].sizeBytes;
    await f.service.configure(f.req, { ...settings, maxVersionsPerChat: 1 }); await f.service.close();
    const bounded = f.make({ limits: { roundBytes: size * 4 } }); await bounded.run();
    assert.equal(retired, 0, 'no metadata or body moves to quarantine before the full plan is checked');
    assert.deepEqual((await bounded.list(f.req, accountInput)).entries.map(entry => entry.id), initial.map(entry => entry.id));
    assert.match((await bounded.status(f.req, accountInput)).lastResult.error, /安全上限/);
});
