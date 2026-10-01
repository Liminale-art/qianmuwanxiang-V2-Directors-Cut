import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import { bindHistoricalGalleryPreviewSelection } from '../qianmu-historical-gallery-consumer.js';

test('historical gallery consumer binds once and applies the verified preview to the live artist editor', async () => {
    const source = await readFile(new URL('../qianmu-historical-gallery-consumer.js', import.meta.url), 'utf8');
    const productionUrl = source.match(/await\s+load\((['"])([^'"]+)\1\)/)?.[2] || '';
    assert.match(productionUrl, /^\.\/qianmu-gallery-directory-view\.js\?v=\d+\.\d+\.\d+$/, 'the directory has its own explicit cache version, independent of unrelated releases');
    const listeners = new Map();
    const button = {
        dataset: {}, disabled: false, isConnected: true,
        addEventListener(type, handler) { listeners.set(type, handler); },
    };
    const sources = { querySelector(selector) { assert.equal(selector, '.sd-storyboard-artist-preview-history'); return button; } };
    const root = { classList: { contains(value) { return value === 'open'; } }, querySelector(selector) {
        assert.equal(selector, '.sd-storyboard-artist-preview-sources'); return sources;
    } };
    const context = { chatMetadata: { id: 'same-chat' } };
    let opened, applied, loadedPath;
    const blob = new Blob(['verified'], { type: 'image/png' });
    bindHistoricalGalleryPreviewSelection({
        root, ctx: () => context, epoch: () => 7,
        load(path) { loadedPath = path; return { openGalleryDirectory(options) {
            opened = options;
            return { finished: options.select({ blob, record: { id: 'img-1' } }) };
        } }; },
        encode: async value => { assert.equal(value, blob); return 'data:image/png;base64,verified'; },
        apply(value) { applied = value; },
    });
    assert.equal(listeners.has('click'), true);
    assert.equal(loadedPath, undefined, 'binding the editor must not eagerly load the historical directory');
    await listeners.get('click')({ preventDefault() {} });
    assert.equal(loadedPath, productionUrl);
    assert.equal(opened.parent, root);
    assert.equal(button.disabled, false);
    assert.equal(applied, 'data:image/png;base64,verified');
    assert.equal(typeof opened.select, 'function');
});
