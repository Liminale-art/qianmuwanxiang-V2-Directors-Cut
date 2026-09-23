import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('index.js', root), 'utf8');
const css = await readFile(new URL('style.css', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const galleryView = await readFile(new URL('qianmu-gallery-collections-view.js', root), 'utf8');
const gallery = source.slice(source.indexOf('function renderStoryboardGallery(state)'), source.indexOf('function renderStoryboardGalleryKindSwitch'));

assert.equal(manifest.version, '1.59.317');
assert.match(source, /function storyboardGalleryCollections\(\)[\s\S]*storyboardCollections/, 'collections must persist with chat metadata');
assert.match(source, /function storyboardGalleryGroupId[\s\S]*variantRootId[\s\S]*planShotId[\s\S]*groupId/, 'old and new image records need stable variant grouping');
assert.match(source, /function storyboardCreateRecord[\s\S]*variantRootId: job\.variantRootId \|\| job\.planShotId \|\| job\.id/, 'new images must record their variant root');
assert.match(source, /function storyboardRedrawRecord[\s\S]*job\.variantRootId = storyboardGalleryGroupId\(record\)/, 'redraws must append variants instead of replacing the original');
assert.match(gallery, /galleryBrowserWindow[\s\S]*sd-gallery-browser-main[\s\S]*renderGalleryCollectionTile[\s\S]*renderGalleryImageCard/, 'ordinary gallery must share a bounded waterfall for collections and full image groups');
assert.doesNotMatch(gallery, /sd-media-library-shell|storyboardMediaSidebarMarkup/, 'old library sidebar must not return to ordinary browsing');
assert.match(galleryView, /sd-storyboard-stack-count">\$\{group\.variants\.length\}/, 'extracted image cards must preserve complete variant counts');
assert.match(source, /sd-storyboard-gallery-new-folder[\s\S]*sd-media-collection-rename[\s\S]*sd-media-collection-delete/, 'collections need create, rename, and dissolve controls');
assert.match(source, /bindGalleryBulkCollections\(root,\{readCollections:storyboardGalleryCollections,readRecords:storyboardGalleryRecords,readSelection:\(\)=>storyboardGallerySelection/, 'entry must wire bulk collection membership to the current records and selection');
const taxonomy = await readFile(new URL('qianmu-gallery-taxonomy.js', root), 'utf8');
assert.match(taxonomy, /applyGalleryCollectionTarget\(records,chosen,target\)/, 'shared bulk handler must validate all changes before applying memberships');
assert.match(source, /const collections=clone\(storyboardGalleryCollections\(\)\)[\s\S]*chat: \{ images: records, collections \}/, 'storyboard exports must include the captured media collections rather than reading a later chat');
assert.match(source, /prepareStoryboardPackageDraft\(\{[\s\S]*collections: incomingCollections/, 'cross-device imports prepare collections in the detached batch');
assert.match(source, /data-storyboard-chat-action="redraw"/, 'redraw remains an inline chat action');
assert.match(source, /data-storyboard-chat-action="artist"/, 'artist replacement remains an inline chat action');
assert.match(source, /sd-storyboard-lightbox-delete[\s\S]*store\.storyboardImages = storyboardGalleryRecords\(\)\.filter/, 'individual variants remain deletable');
assert.match(css, /\.sd-gallery-browser-main \.sd-storyboard-gallery \{ columns: 3 180px/, 'ordinary gallery must use its full available width');
assert.match(css, /\.sd-gallery-browser-main \.sd-storyboard-gallery \{ columns: 2 118px/, 'narrow gallery must retain responsive waterfall columns');
assert.match(css, /\.sd-storyboard-gallery-card\.is-stack::before[\s\S]*\.sd-storyboard-gallery-card\.is-stack::after/, 'variant groups must retain their stack treatment');
assert.match(css, /\.sd-storyboard-lightbox-detail[\s\S]*overflow: auto/, 'mobile details must scroll independently');

console.log('Storyboard gallery and media-library contract OK');
