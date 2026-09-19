import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TEXT_COLLECTION_LIMITS, captureTextCollectionSource, createTextCollection, textCollectionRecord, updateTextCollection, textCollectionListLabel, textCollectionPreview } from '../qianmu-text-collection.js';

const time = new Date(2026, 8, 19, 12).getTime();
const input = (text = '第一行\r\n 第二行 😀 ', extra = {}) => ({ account: `st-user:${'a'.repeat(64)}`, chatId: 'chat-1', messageId: 0, replyId: 'reply-1', charName: '角色', userName: '读者', text, ...extra });
const make = (text, extra = {}) => createTextCollection({ id: 'collection-1', source: captureTextCollectionSource(input(text)), mode: 'full', createdAt: time, ...extra });

test('full originals retain every character and are immutable independent snapshots', () => {
    const raw = input(), source = captureTextCollectionSource(raw), record = make(raw.text);
    raw.charName = 'renamed'; raw.text = 'chat deleted';
    assert.equal(source.text, '第一行\r\n 第二行 😀 ');
    assert.equal(record.text, source.text);
    assert.equal(record.source.charName, '角色');
    assert.equal(textCollectionListLabel(record), '角色 & 读者 · 2026-09-19');
    for (const value of [source, record, record.source, record.range]) assert.equal(Object.isFrozen(value), true);
    assert.throws(() => { record.source.charName = 'other'; }, TypeError);
    assert.deepEqual(textCollectionRecord(JSON.parse(JSON.stringify(record))), record);
});

test('selection preserves exact UTF16 boundaries and never persists unselected original text', () => {
    const original = '未选私密段落\n你好😀 世界\n另一未选段落', start = original.indexOf('你好');
    const record = make(original, { mode: 'selection', start, end: start + '你好😀 世界'.length });
    assert.equal(record.text, '你好😀 世界');
    assert.deepEqual(record.range, { start, end: start + 7 });
    assert.equal('text' in record.source, false);
    assert.doesNotMatch(JSON.stringify(record), /未选私密段落|另一未选段落/);
    assert.equal(make(' x ', { mode: 'selection', start: 0, end: 3 }).text, ' x ');
});

test('invalid selections fail without clipping, coercion or splitting emoji', () => {
    for (const [start, end] of [[-1, 2], [0, 20], [2, 2], [3, 1], ['0', 2], [0.5, 2], [2, 3], [1, 2]]) {
        assert.throws(() => make('A😀B', { mode: 'selection', start, end }), { code: 'text_collection_range' });
    }
    assert.throws(() => make('abc', { start: 0, end: 3 }), { code: 'text_collection_range' });
    assert.throws(() => make('abc', { mode: 'unknown' }), { code: 'text_collection_mode' });
});

test('bad identity, empty originals, broken Unicode and oversize text fail visibly', () => {
    for (const extra of [{ account: 'user' }, { chatId: '' }, { messageId: -1 }, { replyId: '' }, { charName: '' }, { userName: null }, { chatId: ' x' }]) {
        assert.throws(() => captureTextCollectionSource(input('x', extra)), { code: 'text_collection_source' });
    }
    for (const value of ['', ' \n ', '\ud800', '\udc00', 'x\0y', 'x'.repeat(TEXT_COLLECTION_LIMITS.text + 1)]) {
        assert.throws(() => captureTextCollectionSource(input(value)), { code: 'text_collection_text' });
    }
    assert.equal(make('x'.repeat(TEXT_COLLECTION_LIMITS.text)).text.length, TEXT_COLLECTION_LIMITS.text);
    for (const createdAt of [NaN, '2026-09-19', -1, Infinity]) assert.throws(() => make('x', { createdAt }), { code: 'text_collection_time' });
});

test('edits use revision CAS, preserve source/date and cannot alter account or title snapshots', () => {
    const before = make('original'), after = updateTextCollection(before, { text: 'edited\ntext' }, 1, time + 1);
    assert.equal(after.revision, 2); assert.equal(after.text, 'edited\ntext');
    assert.equal(before.text, 'original'); assert.equal(before.revision, 1);
    assert.deepEqual(after.source, before.source); assert.deepEqual(after.range, before.range);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(textCollectionListLabel(after), textCollectionListLabel(before));
    assert.throws(() => updateTextCollection(after, { text: 'lost update' }, 1, time + 2), { code: 'text_collection_conflict' });
    assert.throws(() => updateTextCollection(after, { text: 'x', source: before.source }, 2, time + 2), { code: 'text_collection_edit' });
    assert.throws(() => updateTextCollection(after, { text: 'x' }, 2, time), { code: 'text_collection_revision' });
    assert.throws(() => updateTextCollection(after, { text: '' }, 2, time + 2), { code: 'text_collection_text' });
    assert.equal(updateTextCollection(after, { text: 'same time allowed' }, 2, time + 1).revision, 3);
});

test('HTML-shaped content stays plain text and preview only compresses display whitespace', () => {
    const record = make(' <img src=x onerror=alert(1)>\n\t你好😀 ');
    assert.equal(record.text, ' <img src=x onerror=alert(1)>\n\t你好😀 ');
    assert.equal(textCollectionPreview(record), '<img src=x onerror=alert(1)> 你好😀');
    assert.equal(textCollectionPreview(make('😀😀😀'), 2), '😀😀…');
    assert.throws(() => textCollectionPreview(record, 0), { code: 'text_collection_preview' });
});

test('serialized records reject hidden original text, malformed ranges and unsupported fields', () => {
    const original = make('text'), clone = () => JSON.parse(JSON.stringify(original));
    for (const mutate of [r => { r.source.text = 'hidden'; }, r => { r.apiKey = 'private'; }, r => { r.range.end = 2; }, r => { r.revision = 0; }, r => { r.updatedAt = time - 1; }]) {
        const record = clone(); mutate(record);
        assert.throws(() => textCollectionRecord(record), { code: 'text_collection_record' });
    }
});

test('contract is isolated from chat, browser globals, network and storage', async () => {
    const code = await readFile(new URL('../qianmu-text-collection.js', import.meta.url), 'utf8');
    assert.doesNotMatch(code, /\b(?:import|fetch|document|window|localStorage|indexedDB|globalThis)\b/);
    const before = Reflect.ownKeys(globalThis);
    make('no external state');
    assert.deepEqual(Reflect.ownKeys(globalThis), before);
});
