import test from 'node:test';
import assert from 'node:assert/strict';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';
import { isNewerYimuVersion, mountYimuVersionBadge } from '../yimu/release-version.mjs';
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
    f.parent.children[0].click(); assert.match(notices[0][0], /随千幕统一更新/);
    badge.destroy(); assert.equal(f.parent.children.length, 0);
});
test('paired badge remains factual when browser fetch is unavailable', async () => {
    const f = textCollectionDom(), badge = mountYimuVersionBadge(f.parent, { document: f.doc, version: '0.8.0' });
    assert.equal((await badge.check()).status, 'paired'); assert.equal(badge.latest(), '0.8.0');
    assert.equal(f.parent.children[0].textContent, 'v0.8.0'); badge.destroy();
});
