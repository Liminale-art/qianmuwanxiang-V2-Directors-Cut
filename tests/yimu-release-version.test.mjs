import test from 'node:test';
import assert from 'node:assert/strict';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';
import { isNewerYimuVersion, mountYimuVersionBadge, createYimuServiceReleaseReader } from '../yimu/release-version.mjs';
test('semantic release comparison is numeric and malformed versions never become NEW', () => {
    assert.equal(isNewerYimuVersion('0.8.0', '0.9.0'), true); assert.equal(isNewerYimuVersion('0.9.0', '0.10.0'), true);
    assert.equal(isNewerYimuVersion('0.8.0', '0.8.0'), false); assert.equal(isNewerYimuVersion('0.8.0', 'script'), false);
});
test('mount is a local paired-release badge and never queries a second update source', async () => {
    const f = textCollectionDom(), notices = [];
    const badge = mountYimuVersionBadge(f.parent, { document: f.doc, version: '0.8.0', onNotice: (...args) => notices.push(args) });
    assert.equal(f.parent.children[0].textContent, 'v0.8.0');
    assert.deepEqual(await badge.check(), { available: false, status: 'paired', version: '0.8.0' });
    assert.equal(badge.latest(), '0.8.0');
    f.parent.children[0].click(); assert.match(notices[0][0], /忆幕前端 v0\.8\.0 的修订请使用忆幕安装器/);
    badge.destroy(); assert.equal(f.parent.children.length, 0);
});
test('paired badge remains factual when browser fetch is unavailable', async () => {
    const f = textCollectionDom(), badge = mountYimuVersionBadge(f.parent, { document: f.doc, version: '0.8.0' });
    assert.equal((await badge.check()).status, 'paired'); assert.equal(badge.latest(), '0.8.0');
    assert.equal(f.parent.children[0].textContent, 'v0.8.0'); badge.destroy();
});
test('service release reader checks yimu/package.json only, validates it and caches the answer', async () => {
    const calls = []; let clock = 1000, body = JSON.stringify({ name: 'yimu', version: '0.8.10' });
    const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, redirected: false, headers: { get: () => null }, text: async () => body }; };
    const read = createYimuServiceReleaseReader({ fetchImpl, now: () => clock });
    assert.equal(await read(), '0.8.10');
    assert.match(calls[0].url, /\/yimu\/package\.json\?yimu_release=/);
    assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error');
    assert.equal(await read(), '0.8.10'); assert.equal(calls.length, 1, 'cached for half an hour');
    clock += 31 * 60 * 1000; body = JSON.stringify({ name: 'qianmu-omniscene', version: '9.9.9' });
    assert.equal(await read(), '', 'another package never reports a Yimu update');
    body = '<html>'; assert.equal(await read({ force: true }), '');
    assert.equal(await createYimuServiceReleaseReader({ fetchImpl: null })(), '');
    assert.equal(isNewerYimuVersion('0.8.9', '0.8.10'), true);
});
