import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionOwner} from '../qianmu-text-collection-owner.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

test('default local chunk loader reaches the shipped view and opens it without an injected viewFactory', async t => {
    const dom = textCollectionDom(); let reads = 0, mounts = 0, closes = 0;
    const owner = createTextCollectionOwner({document: dom.doc, window: new EventTarget(),
        isCurrent: () => true, resolveNamespace: async () => 'st-user:default-entry', headers: () => ({}),
        mountPortal() { mounts++; return () => { closes++; }; },
        storeFactory: async () => ({
            async read() { reads++; return {exists: false, fingerprint: null, value: null}; },
            async write() { throw Error('Entry test must not write'); }, close() {},
        }),
    });
    t.after(() => owner.dispose());
    const opening = owner.open();
    await dom.wait(() => dom.doc.head.querySelectorAll('link').length === 2, 'Default lazy entry did not load');
    dom.doc.head.querySelectorAll('link').forEach(link => link.emit('load'));
    assert.equal(await opening, true); assert.equal(reads, 1); assert.equal(mounts, 1);
    dom.get('关闭收藏').click(); assert.equal(await owner.open(), true);
    assert.equal(reads, 1); assert.equal(mounts, 1);
    owner.dispose(); assert.equal(closes, 1); assert.equal(dom.doc.head.querySelectorAll('link').length, 0);
});
