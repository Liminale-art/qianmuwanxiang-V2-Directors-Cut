import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildNativeBackupCatalog, normalizeAutomaticBackupEntries } from '../qianmu-chat-backup-catalog.js';

const row = name => ({ name, size: '120 B', messageCount: 2, lastMessageAt: 'not-backup-time', excerpt: '合成摘要' });
const file = (key, stamp = '20261019-032016') => `chat_${key}_${stamp}.jsonl`;
const character = avatar => ({ avatar, name: '显示名不参与关联' });
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 8);

test('ST 1.19 Qin Duo internal filename key matches; display name and old key never guess ownership', async () => {
    const originals = [row(file('__1_dc326dcf')), row(file('__c4516555')), row(file('__1')), row(file('deleted_role'))];
    const before = structuredClone(originals), roles = [{ avatar: '秦铎1.png', name: '秦铎' }];
    const entries = await buildNativeBackupCatalog(originals, roles, { crypto: webcrypto });
    assert.equal(entries.length, 4); assert.deepEqual(entries[0].candidateAvatars, ['秦铎1.png']);
    assert.equal(entries[0].match, 'candidate');
    assert.ok(entries.slice(1).every(entry => entry.match === 'unmatched'));
    assert.deepEqual(originals, before); assert.equal(entries[0].source, 'native');
});

test('ASCII sanitization and case collisions remain explicit candidates, not unique identity', async () => {
    const entries = await buildNativeBackupCatalog([row(file('a_b')), row(file('user'))], ['A-B.png', 'A B.png', 'User.png', 'user.png'].map(character));
    assert.deepEqual(entries[0].candidateAvatars, ['A-B.png', 'A B.png']);
    assert.deepEqual(entries[1].candidateAvatars, ['User.png', 'user.png']);
    assert.ok(entries.every(entry => entry.match === 'ambiguous'));
});

test('short hash collisions remain ambiguous and digest completion cannot reorder role candidates', async () => {
    const crypto = { subtle: { digest: async (_, bytes) => {
        if (new TextDecoder().decode(bytes) === '甲') await new Promise(resolve => setTimeout(resolve, 5));
        return new Uint8Array(32);
    } } };
    const entries = await buildNativeBackupCatalog([row(file('__00000000'))], ['甲.png', '乙.png'].map(character), { crypto });
    assert.equal(entries[0].match, 'ambiguous'); assert.deepEqual(entries[0].candidateAvatars, ['甲.png', '乙.png']);
});

test('current duplicate avatars are rejected for matching and all backup rows remain available', async () => {
    const roles = ['A.png', 'A.png', '../escape.png', 'CON.png', 'nul.other.png', 'x\u0000.png', 'x\u007f.png', 'x\ud800.png', '.png'].map(character);
    const sources = ['a', '.._escape', 'con', 'nul_other', 'x_', '', '_'].map(key => row(file(key)));
    const entries = await buildNativeBackupCatalog(sources, roles);
    assert.equal(entries.length, sources.length); assert.ok(entries.every(entry => entry.match === 'unmatched'));
});

test('Unicode hashing uses the raw UTF-8 name and does not normalize Unicode', async () => {
    const names = ['é', 'e\u0301', '😀', '秦铎1'];
    const sources = names.map(name => row(file(name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_' + hash(name))));
    const entries = await buildNativeBackupCatalog(sources, names.map(name => character(name + '.png')), { crypto: webcrypto });
    for (let i = 0; i < names.length; i++) assert.deepEqual(entries[i].candidateAvatars, [names[i] + '.png']);
});

test('valid avatar byte limit is 255; overlong and truncated aliases are not matched', async () => {
    const valid = '中'.repeat(83) + 'ab.png', invalid = '中'.repeat(84) + '.png';
    assert.equal(Buffer.byteLength(valid), 255); assert.equal(Buffer.byteLength(invalid), 256);
    const names = [valid, invalid].map(avatar => avatar.replace('.png', ''));
    const sources = names.map(name => row(file(name.replace(/[^a-z0-9]/gi, '_') + '_' + hash(name))));
    const entries = await buildNativeBackupCatalog(sources, [valid, invalid].map(character), { crypto: webcrypto });
    assert.deepEqual(entries[0].candidateAvatars, [valid]); assert.equal(entries[1].match, 'unmatched');
});

test('native first .png replacement and safe trailing-dot cleanup match the host protocol', async () => {
    const entries = await buildNativeBackupCatalog([row(file('ab_png')), row(file('a'))], ['A.pngB.png', 'a..png', 'A .png'].map(character));
    assert.deepEqual(entries[0].candidateAvatars, ['A.pngB.png']);
    assert.deepEqual(entries[1].candidateAvatars, ['a..png', 'A .png']); assert.equal(entries[1].match, 'ambiguous');
});

test('no crypto or a rejected digest leaves Unicode backups unmatched without hiding ASCII or rows', async () => {
    for (const crypto of [undefined, {}, { subtle: { digest: async () => { throw Error('unavailable'); } } }, { subtle: { digest: async () => new Uint8Array(4) } }]) {
        const entries = await buildNativeBackupCatalog([row(file('__1_dc326dcf')), row(file('ascii'))], ['秦铎1.png', 'ASCII.png'].map(character), { crypto });
        // An explicitly undefined option follows the public default.
        if (crypto === undefined && typeof globalThis.crypto?.subtle?.digest === 'function') assert.equal(entries[0].match, 'candidate');
        else assert.equal(entries[0].match, 'unmatched');
        assert.deepEqual(entries[1].candidateAvatars, ['ASCII.png']); assert.equal(entries.length, 2);
    }
});

test('filename parsing is exact and never turns summaries or similar prefixes into a match', async () => {
    const sources = [row(file('role2')), row('chat_role_20261019-032016.jsonl.extra'), row('prefix_' + file('role')), { ...row('unrecognized.jsonl'), excerpt: 'role', lastMessageAt: '2026-10-19T03:20:16Z' }];
    const entries = await buildNativeBackupCatalog(sources, [character('role.png')]);
    assert.ok(entries.every(entry => entry.match === 'unmatched')); assert.equal(entries[3].backupSort, null);
});

test('native date fields validate real calendar dates, leap years, and time bounds', async () => {
    const stamps = ['20261019-032016', '20240229-235959', '20260229-120000', '20261301-000000', '20260431-000000', '20260101-240000', '20260101-006000', '20260101-000060', '00000101-000000'];
    const entries = await buildNativeBackupCatalog(stamps.map(stamp => row(file('role', stamp))), [character('role.png')]);
    assert.equal(entries[0].backupTimeLabel, '2026-10-19 03:20:16'); assert.equal(entries[0].backupDay, '2026-10-19');
    assert.equal(entries[0].backupSort, Date.UTC(2026, 9, 19, 3, 20, 16));
    assert.equal(entries[1].backupTimeLabel, '2024-02-29 23:59:59');
    assert.ok(entries.slice(2).every(entry => entry.backupSort === null && entry.backupTimeLabel === '时间未知'));
    assert.ok(entries.every(entry => entry.timeZoneLabel === '服务器时间' && entry.backupTimeZone === 'server'));
});

test('automatic backup fields preserve receipt information but use explicit UTC instants for local display', () => {
    const input = [{ id: 'synthetic-id', avatar: '角色.png', chatFile: '原聊天.jsonl', createdAt: '2026-10-19T03:20:16.123Z', messageCount: 13, sizeBytes: 1234, sha256: 'a'.repeat(64) }];
    const before = structuredClone(input), result = normalizeAutomaticBackupEntries(input)[0];
    assert.equal(result.name, 'qianmu:synthetic-id'); assert.equal(result.source, 'qianmu'); assert.equal(result.sourceLabel, '千幕备份');
    assert.equal(result.backupSort, Date.parse(input[0].createdAt)); assert.equal(result.timeZoneLabel, '本机时间'); assert.equal(result.backupTimeZone, 'local');
    assert.deepEqual(result.candidateAvatars, ['角色.png']); assert.equal(result.size, '1234 B'); assert.equal(result.sha256, input[0].sha256); assert.deepEqual(input, before);
});

test('automatic non-UTC or invalid timestamps are not silently normalized', () => {
    const entries = normalizeAutomaticBackupEntries(['2026-10-19T03:20:16+08:00', '2026-02-29T03:20:16Z', '2026-10-19T24:00:00Z', 'not a date', undefined].map((createdAt, i) => ({ id: String(i), avatar: '../escape.png', createdAt })));
    assert.ok(entries.every(entry => entry.backupSort === null && entry.match === 'unmatched'));
});

test('non-UTC browser timezone never shifts native server wall time and does localize automatic time', () => {
    const moduleUrl = new URL('../qianmu-chat-backup-catalog.js', import.meta.url).href;
    const script = `import{buildNativeBackupCatalog,normalizeAutomaticBackupEntries}from ${JSON.stringify(moduleUrl)};const n=await buildNativeBackupCatalog([{name:'chat_role_20261019-032016.jsonl'}],[]);const a=normalizeAutomaticBackupEntries([{id:'x',avatar:'role.png',createdAt:'2026-10-19T03:20:16Z'}]);console.log(JSON.stringify([n[0],a[0]]));`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'Asia/Hong_Kong' }, encoding: 'utf8' });
    const [native, automatic] = JSON.parse(output);
    assert.equal(native.backupTimeLabel, '2026-10-19 03:20:16'); assert.equal(native.timeZoneLabel, '服务器时间');
    assert.equal(automatic.backupTimeLabel, '2026-10-19 11:20:16'); assert.equal(automatic.timeZoneLabel, '本机时间');
});

test('10000 Unicode characters use bounded digest batches, yield between work, and retain every role including the last', async () => {
    const names = Array.from({ length: 10000 }, (_, index) => '合成角色' + index);
    const roles = names.map(name => character(name + '.png'));
    const sources = names.map(name => row(file(name.replace(/[^a-z0-9]/gi, '_') + '_' + hash(name))));
    let active = 0, maximum = 0, calls = 0, yields = 0, previousCalls = 0;
    const crypto = { subtle: { digest: async (algorithm, bytes) => {
        assert.equal(algorithm, 'SHA-256'); calls++; active++; maximum = Math.max(maximum, active);
        await new Promise(resolve => setImmediate(resolve));
        active--; return createHash('sha256').update(bytes).digest();
    } } };
    const entries = await buildNativeBackupCatalog(sources, roles, { crypto, yieldToMain: async () => {
        assert.equal(active, 0, 'all digest jobs in a batch finish before another batch is scheduled');
        assert.ok(calls - previousCalls <= 64, 'a batch cannot queue more than 64 digest jobs');
        previousCalls = calls; yields++; await new Promise(resolve => setImmediate(resolve));
    } });
    assert.equal(calls, 10000); assert.equal(maximum, 64); assert.ok(yields >= 156);
    assert.equal(entries.length, 10000);
    for (let index = 0; index < entries.length; index++) assert.deepEqual(entries[index].candidateAvatars, [roles[index].avatar]);
    assert.deepEqual(entries.at(-1).candidateAvatars, ['合成角色9999.png']);
});

test('batch boundaries preserve collision order and a duplicate in a later batch cannot be guessed', async () => {
    const avatars = Array.from({ length: 130 }, (_, index) => String.fromCodePoint(0x4e00 + index) + '.png');
    const duplicate = 'duplicate.png';
    const roles = [character(duplicate), ...avatars.map(character), character(duplicate)];
    const entries = await buildNativeBackupCatalog([row(file('__00000000')), row(file('duplicate'))], roles, {
        crypto: { subtle: { digest: async () => new Uint8Array(32) } }, yieldToMain: async () => {},
    });
    assert.deepEqual(entries[0].candidateAvatars, avatars); assert.equal(entries[0].match, 'ambiguous');
    assert.equal(entries[1].match, 'unmatched');
});

test('without crypto all source rows remain available and a role beyond the first batch still matches', async () => {
    let yields = 0;
    const names = Array.from({ length: 130 }, (_, index) => '中文角色' + index);
    const sources = [...names.map(name => row(file(name.replace(/[^a-z0-9]/gi, '_') + '_' + hash(name)))), row(file('last_ascii'))];
    const entries = await buildNativeBackupCatalog(sources, [...names.map(name => character(name + '.png')), character('Last_ASCII.png')], {
        crypto: {}, yieldToMain: async () => { yields++; },
    });
    assert.equal(entries.length, sources.length); assert.ok(entries.slice(0, -1).every(entry => entry.match === 'unmatched'));
    assert.deepEqual(entries.at(-1).candidateAvatars, ['Last_ASCII.png']); assert.ok(yields >= 2);
});

test('default batching yields to timer tasks, not only to promise microtasks', async () => {
    let timerRan = false; const timer = setTimeout(() => { timerRan = true; }, 0);
    try {
        await buildNativeBackupCatalog([], Array.from({ length: 129 }, (_, index) => character('ascii-' + index + '.png')));
        assert.equal(timerRan, true);
    } finally { clearTimeout(timer); }
});

test('an injected batch cancellation stops further hashing instead of returning a partial catalog', async () => {
    let calls = 0;
    await assert.rejects(buildNativeBackupCatalog([row(file('still_preserved'))], Array.from({ length: 130 }, (_, index) => character('合成角色' + index + '.png')), {
        crypto: { subtle: { digest: async () => { calls++; return new Uint8Array(32); } } },
        yieldToMain: async () => { throw Object.assign(new Error('catalog cancelled'), { code: 'context' }); },
    }), { code: 'context' });
    assert.equal(calls, 64);
});
