import test from 'node:test';
import assert from 'node:assert/strict';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';
import { isNewerYimuVersion, mountYimuVersionBadge } from '../yimu/release-version.mjs';
test('semantic release comparison is numeric and malformed versions never become NEW', () => {
    assert.equal(isNewerYimuVersion('0.8.0', '0.9.0'), true); assert.equal(isNewerYimuVersion('0.9.0', '0.10.0'), true);
    assert.equal(isNewerYimuVersion('0.8.0', '0.8.0'), false); assert.equal(isNewerYimuVersion('0.8.0', 'script'), false);
});
test('mount makes no request, checks are read-only, coalesced and cached, updates point to paired install', async () => {
    const f = textCollectionDom(), calls = [], notices = []; let now = 0, finish;
    const badge = mountYimuVersionBadge(f.parent, { document: f.doc, version: '0.8.0', now: () => now, onNotice: (...args) => notices.push(args),
        fetchImpl: (url, options) => { calls.push({ url, options }); return new Promise(resolve => { finish = resolve; }); } });
    assert.deepEqual(calls, []); const first = badge.check(), second = badge.check(); assert.equal(calls.length, 1);
    finish(Response.json({ version: '0.9.0' })); await Promise.all([first, second]);
    assert.equal(f.parent.children[0].textContent, 'NEW'); assert.equal(badge.latest(), '0.9.0');
    assert.equal((await badge.check()).version, '0.9.0'); assert.equal(calls.length, 1);
    f.parent.children[0].click(); assert.match(notices[0][0], /成对更新前后端/);
    assert.match(calls[0].url, /\/yimu\/manifest\.json$/); assert.equal(calls[0].options.credentials, 'omit');
    badge.destroy(); assert.equal(f.parent.children.length, 0); now++;
});
test('no browser fetch and failed checks remain factual, never display a false up-to-date state', async () => {
    const f = textCollectionDom(), badge = mountYimuVersionBadge(f.parent, { document: f.doc, version: '0.8.0' });
    assert.equal((await badge.check()).status, 'unavailable'); badge.destroy();
    const other = mountYimuVersionBadge(f.parent, { document: f.doc, version: '0.8.0', fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal((await other.check()).status, 'unknown'); assert.equal(other.latest(), ''); assert.equal(f.parent.children[0].textContent, 'v0.8.0'); other.destroy();
});
