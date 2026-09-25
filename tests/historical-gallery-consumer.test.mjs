import assert from 'node:assert/strict';
import test from 'node:test';
import { bindHistoricalGalleryPreviewSelection } from '../qianmu-historical-gallery-consumer.js';

test('historical gallery consumer binds once and applies the verified preview to the live artist editor', async () => {
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
    await listeners.get('click')({ preventDefault() {} });
    assert.equal(loadedPath, './qianmu-gallery-directory-view.js?v=1.59.388');
    assert.equal(opened.parent, root);
    assert.equal(button.disabled, false);
    assert.equal(applied, 'data:image/png;base64,verified');
    assert.equal(typeof opened.select, 'function');
});
