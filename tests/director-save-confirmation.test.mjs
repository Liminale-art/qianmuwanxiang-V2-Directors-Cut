import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDirectorSaveSnapshot as capture, confirmDirectorSave as confirm } from '../qianmu-director-save-confirmation.js';

const origin = 'https://synthetic.invalid';
const endpoint = `${origin}/api/chats/export`;
const unconfirmed = { code: 'DIRECTOR_SAVE_UNCONFIRMED' };
function fixture(kind = 'character') {
    const target = kind === 'character' ? { kind, chatId: 'Chat A', avatar: 'A.png' } : { kind, chatId: 'Group A' };
    const metadata = { integrity: 'same-host-slug', another_plugin: { keep: ['unchanged'] }, story_director_liminale: {
        directorPlanRevisionId: 'new-rev', plan: { story: 'synthetic plan' }, history: [{ old: 'retained' }], factions: [{ name: 'kept world' }],
    } };
    const messages = [{ name: 'A', is_user: false, mes: 'synthetic正文', extra: { media: [], private_unknown: { keep: 1 } }, swipes: ['first', 'second'] },
        { name: 'B', is_user: true, is_system: false, mes: 'synthetic reply', send_date: '2026-10-17T00:00:00.000Z' }];
    return { target, metadata, messages };
}
const rows = f => [{ chat_metadata: f.metadata, user_name: 'unused', character_name: 'unused' }, ...f.messages];
const jsonl = f => rows(f).map(row => JSON.stringify(row)).join('\n');
function response(value, options = {}) {
    return new Response(JSON.stringify({ message: 'Chat saved to undefined', result: value }), { headers: { 'Content-Type': 'application/json' }, ...options });
}
function options(fetchImpl, rest = {}) { return { origin, guard: () => {}, fetchImpl, ...rest }; }
const never = () => new Promise(() => {});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('single chat confirms full JSON projection using only fixed native export and CSRF', async () => {
    const f = fixture(), before = JSON.stringify(f), snapshot = capture(f); let calls = 0, guards = 0;
    assert.ok(Object.isFrozen(snapshot)); assert.deepEqual(Object.keys(snapshot), []);
    assert.deepEqual(await confirm(snapshot, options(async (url, request) => {
        calls++; assert.equal(url, endpoint); assert.equal(request.method, 'POST');
        assert.equal(request.credentials, 'same-origin'); assert.equal(request.cache, 'no-store'); assert.equal(request.redirect, 'error');
        assert.deepEqual(request.headers, { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': 'synthetic-token' });
        assert.deepEqual(JSON.parse(request.body), { file: 'Chat A.jsonl', format: 'jsonl', is_group: false, avatar_url: 'A.png' });
        assert.equal(request.body.includes('synthetic plan'), false); assert.equal(request.body.includes('force'), false);
        return response(jsonl(f));
    }, { headers: () => ({ 'X-CSRF-Token': 'synthetic-token', Authorization: 'must-not-forward', 'X-Api-Key': 'must-not-forward' }), guard: () => { guards++; } })), { status: 'confirmed' });
    assert.equal(calls, 1); assert.equal(guards, 3); assert.equal(JSON.stringify(f), before);
});

test('group uses native export group locator and the same complete header', async () => {
    const f = fixture('group');
    await confirm(capture(f), options(async (_, request) => {
        assert.deepEqual(JSON.parse(request.body), { file: 'Group A.jsonl', format: 'jsonl', is_group: true }); return response(jsonl(f));
    }));
});

test('later mutations never replace the captured locator, metadata, message or old history', async () => {
    const f = fixture(), wanted = jsonl(f), snapshot = capture(f);
    f.target.avatar = 'B.png'; f.target.chatId = 'Chat B'; f.messages[0].mes = 'new edit'; f.metadata.story_director_liminale.history[0].old = 'later';
    await confirm(snapshot, options(async (_, request) => { assert.equal(JSON.parse(request.body).avatar_url, 'A.png'); return response(wanted); }));
    assert.equal(f.messages[0].mes, 'new edit'); assert.equal(f.metadata.story_director_liminale.history[0].old, 'later');
});

test('object order, CRLF, terminal newline and BOM do not alter JSON meaning', async () => {
    const f = fixture(), reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
    const value = '\uFEFF' + rows(f).map(row => JSON.stringify(reorder(row))).join('\r\n') + '\r\n';
    await confirm(capture(f), options(async () => response(value)));
});

test('Date, undefined and non-enumerable media alias follow native JSON serialization without mutation', async () => {
    const f = fixture(); f.metadata.undefinedField = undefined; f.messages[0].when = new Date('2026-10-17T00:00:00Z');
    Object.defineProperty(f.messages[0].extra, 'image', { enumerable: false, value: 'legacy-image' });
    await confirm(capture(f), options(async () => response(jsonl(f))));
    assert.ok(f.messages[0].when instanceof Date); assert.equal(f.messages[0].extra.image, 'legacy-image');
});

for (const [name, change] of [
    ['revision', f => { f.metadata.story_director_liminale.directorPlanRevisionId = 'old-rev'; }],
    ['plan', f => { f.metadata.story_director_liminale.plan.story = 'other'; }],
    ['history', f => { f.metadata.story_director_liminale.history = []; }],
    ['world', f => { delete f.metadata.story_director_liminale.factions; }],
    ['deleted field reappears', f => { f.metadata.story_director_liminale.injectOverride = false; }],
    ['non-Q metadata', f => { f.metadata.another_plugin.keep = []; }],
    ['integrity', f => { delete f.metadata.integrity; }],
    ['body text', f => { f.messages[0].mes = 'later edit'; }],
    ['unknown message field', f => { delete f.messages[0].extra.private_unknown; }],
    ['swipe order', f => { f.messages[0].swipes.reverse(); }],
    ['message order', f => { f.messages.reverse(); }],
    ['deleted body row', f => { f.messages.pop(); }],
    ['new body row', f => { f.messages.push({ mes: 'newer' }); }],
]) test(`complete comparison rejects changed ${name} without rollback or retry`, async () => {
    const f = fixture(), snapshot = capture(f); change(f); const before = JSON.stringify(f); let calls = 0;
    await assert.rejects(confirm(snapshot, options(async () => { calls++; return response(jsonl(f)); })), unconfirmed);
    assert.equal(calls, 1); assert.equal(JSON.stringify(f), before);
});

for (const [name, mutate] of [
    ['unknown header field', list => { list[0].extra_header = 'not from this writer'; }],
    ['wrong display placeholder', list => { list[0].user_name = 'not-unused'; }],
    ['missing metadata', list => { delete list[0].chat_metadata; }],
]) test(`header is not silently narrowed: ${name}`, async () => {
    const f = fixture(), list = rows(structuredClone(f)); mutate(list);
    await assert.rejects(confirm(capture(f), options(async () => response(list.map(JSON.stringify).join('\n')))), unconfirmed);
});

for (const [name, value] of [
    ['empty', ''], ['malformed line', '{'], ['invalid middle line', '{}\nnot JSON\n{}'], ['blank middle line', '{}\n\n{}'],
    ['duplicate keys', '{"chat_metadata":{},"chat_metadata":{}}'], ['unsafe key', '{"__proto__":{}}'], ['nonfinite number', '{"value":1e999}'],
    ['array row', '[]'], ['null row', 'null'],
]) test(`rejects ${name} JSONL`, async () => {
    await assert.rejects(confirm(capture(fixture()), options(async () => response(value))), unconfirmed);
});

test('duplicate JSONL keys cannot mask changed data even at the expected row count', async () => {
    const f = fixture(), value = jsonl(f).replace('"directorPlanRevisionId":"new-rev"', '"directorPlanRevisionId":"old-rev","directorPlanRevisionId":"new-rev"');
    await assert.rejects(confirm(capture(f), options(async () => response(value))), unconfirmed);
});

test('native large group gen_id survives but a different rounded number is never confirmed', async () => {
    const f = fixture('group'); f.messages[0].extra.gen_id = 9007199254740992;
    await confirm(capture(f), options(async () => response(jsonl(f))));
    await assert.rejects(confirm(capture(f), options(async () => response(jsonl(f).replace('9007199254740992', '9007199254740993')))), unconfirmed);
});

test('different high-precision decimal cannot round into a false positive; numeric text is untouched', async () => {
    const f = fixture(); f.messages[0].extra.number = 0.1; f.messages[0].mes = '9007199254740993 / 0.10000000000000001';
    await confirm(capture(f), options(async () => response(jsonl(f))));
    await assert.rejects(confirm(capture(f), options(async () => response(jsonl(f).replace('"number":0.1', '"number":0.10000000000000001')))), unconfirmed);
});

for (const status of [404, 409, 500, 503]) test(`HTTP ${status} is unconfirmed and never retried`, async () => {
    const f = fixture(); let calls = 0;
    await assert.rejects(confirm(capture(f), options(async () => { calls++; return response(jsonl(f), { status }); })), unconfirmed); assert.equal(calls, 1);
});

for (const [name, make] of [
    ['wrong content type', f => response(jsonl(f), { headers: { 'Content-Type': 'text/html' } })],
    ['oversized declared body', f => response(jsonl(f), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(64 * 1024 * 1024 + 1) } })],
    ['redirect', f => { const result = response(jsonl(f)); Object.defineProperty(result, 'redirected', { value: true }); return result; }],
    ['missing result', () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })],
    ['invalid UTF8', () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json' } })],
    ['duplicate result', () => new Response('{"result":"","result":""}', { headers: { 'Content-Type': 'application/json' } })],
]) test(`transport rejects ${name}`, async () => {
    const f = fixture(); await assert.rejects(confirm(capture(f), options(async () => make(f))), unconfirmed);
});

test('response from a different URL is rejected even without a redirect flag', async () => {
    const f = fixture(); const returned = response(jsonl(f)); Object.defineProperty(returned, 'url', { value: 'https://other.invalid/api/chats/export' });
    await assert.rejects(confirm(capture(f), options(async () => returned)), unconfirmed);
});

test('UTF8 may cross chunk boundaries without changing Chinese message contents', async () => {
    const f = fixture(), bytes = new TextEncoder().encode(JSON.stringify({ result: jsonl(f) })); let at = 0;
    const streamed = new Response(new ReadableStream({ pull(controller) {
        if (at === bytes.length) controller.close(); else controller.enqueue(bytes.slice(at, ++at));
    } }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    await confirm(capture(f), options(async () => streamed));
});

test('undeclared oversized response is refused while streaming, never truncated into success', async () => {
    const f = fixture(), chunk = new Uint8Array(1024 * 1024).fill(32); let sent = 0, cancelled = 0;
    const streamed = new Response(new ReadableStream({ pull(controller) {
        if (sent++ < 66) controller.enqueue(chunk); else controller.close();
    }, cancel() { cancelled++; } }), { headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(confirm(capture(f), options(async () => streamed)), unconfirmed);
    assert.ok(sent <= 66); assert.equal(cancelled, 1);
});

test('browser origin mismatch stops before sending account cookies', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location'); let calls = 0;
    try {
        Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://actual-host.invalid' } });
        await assert.rejects(confirm(capture(fixture()), options(async () => { calls++; })), unconfirmed);
        assert.equal(calls, 0);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location;
    }
});

test('false or throwing guard prevents export and a late account/source change prevents success', async () => {
    const f = fixture(); let calls = 0;
    const fetchImpl = async () => { calls++; return response(jsonl(f)); };
    for (const guard of [() => false, () => { throw Error('changed'); }]) await assert.rejects(confirm(capture(f), options(fetchImpl, { guard })), unconfirmed);
    assert.equal(calls, 0); let count = 0;
    await assert.rejects(confirm(capture(f), options(fetchImpl, { guard: () => { if (++count === 3) throw Error('account changed'); } })), unconfirmed);
    assert.equal(calls, 1);
});

test('hanging fetch, reader, headers and guard cannot escape the deadline even if AbortSignal is ignored', async () => {
    const f = fixture(), pendingResponse = new Response(new ReadableStream({ pull: never }), { headers: { 'Content-Type': 'application/json' } });
    for (const extra of [{ fetchImpl: never }, { fetchImpl: async () => pendingResponse }, { headers: never }, { guard: never }]) {
        const start = Date.now();
        await assert.rejects(confirm(capture(f), options(async () => response(jsonl(f)), { timeoutMs: 15, ...extra })), unconfirmed);
        assert.ok(Date.now() - start < 1000);
    }
});

test('late completion after timeout cannot continue to fetch or return success', async () => {
    const f = fixture(), wait = deferred(); let calls = 0;
    await assert.rejects(confirm(capture(f), options(async () => { calls++; return response(jsonl(f)); }, { guard: () => wait.promise, timeoutMs: 10 })), unconfirmed);
    wait.resolve(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls, 0);
});

test('pre-abort and abort during export remain read-only and unconfirmed', async () => {
    const f = fixture(), aborted = new AbortController(); aborted.abort(); let calls = 0;
    await assert.rejects(confirm(capture(f), options(async () => { calls++; return response(jsonl(f)); }, { signal: aborted.signal })), unconfirmed);
    assert.equal(calls, 0); const controller = new AbortController();
    await assert.rejects(confirm(capture(f), options(async () => { calls++; controller.abort(); return response(jsonl(f)); }, { signal: controller.signal })), unconfirmed);
    assert.equal(calls, 1);
});

test('capture rejects invalid locators, unsafe JSON and oversized snapshots before any host call', () => {
    for (const change of [f => { f.target.chatId = '../other'; }, f => { f.messages = [null]; }, f => { f.metadata = null; },
        f => { f.metadata.circular = f.metadata; }, f => { f.metadata.unsafe = JSON.parse('{"constructor":1}'); },
        f => { f.messages[0].mes = 'x'.repeat(32 * 1024 * 1024); }]) {
        const f = fixture(); change(f); assert.throws(() => capture(f));
    }
});

test('opaque snapshots, guard and valid same-origin base are mandatory', async () => {
    const f = fixture(); let calls = 0; const fetchImpl = async () => { calls++; return response(jsonl(f)); };
    await assert.rejects(confirm({}, options(fetchImpl)), unconfirmed);
    await assert.rejects(confirm(capture(f), options(fetchImpl, { guard: undefined })), unconfirmed);
    for (const bad of ['file:///tmp/', 'https://u:p@synthetic.invalid', `${origin}/path`, `${origin}?query`, `${origin}#hash`]) {
        await assert.rejects(confirm(capture(f), options(fetchImpl, { origin: bad })), unconfirmed);
    }
    assert.equal(calls, 0);
});
