import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_DEFAULT_ACCENT, readAppearancePreferences, updateAppearancePreferences, appearanceThemeOptions } from '../qianmu-appearance-settings.js';

test('classic settings remain the default and are never migrated by a read', () => {
    for (const theme of ['light', 'dark', 'summer', 'candy', 'kraft', 'dream', 'unknown']) {
        const settings = { theme, notes: { appearance: { tone: 'dark', edgeIndex: 2 } } }, before = structuredClone(settings);
        const value = readAppearancePreferences(settings);
        assert.equal(value.family, 'classic'); assert.equal(value.mode, theme === 'dark' ? 'dark' : 'light');
        assert.equal(value.accent, APPEARANCE_DEFAULT_ACCENT); assert.equal(value.source, 'cover');
        assert.equal(appearanceThemeOptions(value, '#ff0000'), null);
        assert.deepEqual(settings, before); assert.equal(Object.isFrozen(value), true);
    }
});

test('missing, malformed, unversioned and future configurations fall back without destroying stored values', () => {
    for (const appearance of [undefined, null, [], 'glass', 1, { family: 'glass' }, { version: 2, family: 'glass', future: true }]) {
        const settings = { theme: 'dark', appearance }, before = structuredClone(settings);
        assert.equal(readAppearancePreferences(settings).family, 'classic');
        assert.deepEqual(settings, before);
    }
    for (const settings of [null, undefined, [], 1]) assert.equal(readAppearancePreferences(settings).family, 'classic');
});

test('validated preferences round-trip through the existing ordinary settings JSON shape', () => {
    const settings = { theme: 'dream', other: { draft: 'keep' }, notes: { appearance: { tone: 'light' } } };
    const appearance = updateAppearancePreferences(settings, { family: 'glass', mode: 'dark', source: 'manual', accent: '#AbC', harmony: 'complementary' });
    assert.deepEqual(appearance, { version: 1, family: 'glass', mode: 'dark', source: 'manual', accent: '#aabbcc', harmony: 'complementary' });
    assert.equal(Object.hasOwn(settings, 'appearance'), false);
    const saved = JSON.parse(JSON.stringify({ ...settings, appearance }));
    assert.deepEqual(readAppearancePreferences(saved), appearance);
    assert.equal(saved.theme, 'dream'); assert.equal(saved.other.draft, 'keep'); assert.equal(saved.notes.appearance.tone, 'light');
    const classic = updateAppearancePreferences(saved, { family: 'classic' });
    assert.equal(classic.accent, '#aabbcc'); assert.equal(saved.appearance.family, 'glass');
});

test('unsupported edits fail before changing the caller configuration', () => {
    const settings = { theme: 'light', appearance: { version: 1, family: 'editorial', accent: '#123456' } }, before = structuredClone(settings);
    for (const patch of [null, [], '', { family: 'future' }, { mode: 'dream' }, { accent: 'red' }, { accent: '#1234' }, { accent: 'url(secret)' }, { source: 'recent-gallery' }, { harmony: 'random' }, { version: 2 }, { constructor: 'x' }]) {
        assert.throws(() => updateAppearancePreferences(settings, patch), TypeError);
        assert.deepEqual(settings, before);
    }
    assert.throws(() => updateAppearancePreferences({ appearance: { version: 2, future: 'preserve' } }, { family: 'classic' }), /Unsupported/);
});

test('valid version with invalid individual fields has stable readable defaults', () => {
    const value = readAppearancePreferences({ theme: 'dark', appearance: { version: 1, family: 'editorial', mode: 'wrong', accent: 'red', harmony: 'random', source: 'wrong' } });
    assert.deepEqual(value, { version: 1, family: 'editorial', mode: 'dark', accent: APPEARANCE_DEFAULT_ACCENT, harmony: 'dominant', source: 'cover' });
});

test('only cover mode consumes the current-cover supplied accent; missing colors use a stable fallback', () => {
    const cover = updateAppearancePreferences({}, { family: 'glass', accent: '#456' });
    assert.deepEqual(appearanceThemeOptions(cover, '#AbC'), { theme: 'glass', mode: 'light', accent: '#aabbcc' });
    for (const invalid of [null, undefined, '', 'red', 'url(secret)', '#00000000']) assert.equal(appearanceThemeOptions(cover, invalid).accent, '#445566');
    const manual = updateAppearancePreferences({ appearance: cover }, { source: 'manual' });
    assert.equal(appearanceThemeOptions(manual, '#abc').accent, '#445566');
    assert.equal(Object.isFrozen(appearanceThemeOptions(manual)), true);
});
