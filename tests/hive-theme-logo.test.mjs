import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { QIANMU_HIVE_THEME_LOGO } from '../qianmu-hive-theme-logo.js';

test('theme hive vector keeps two original shape regions and excludes embedded raster or external references', () => {
    assert.match(QIANMU_HIVE_THEME_LOGO, /viewBox="0 0 1254 1254"/);
    assert.equal((QIANMU_HIVE_THEME_LOGO.match(/<path /g) || []).length, 2);
    assert.equal((QIANMU_HIVE_THEME_LOGO.match(/fill-rule="evenodd"/g) || []).length, 2, 'film perforations must remain transparent');
    assert.match(QIANMU_HIVE_THEME_LOGO, /fill="var\(--qm-ink\)"/);
    assert.match(QIANMU_HIVE_THEME_LOGO, /fill="var\(--qm-accent\)"/);
    assert.doesNotMatch(QIANMU_HIVE_THEME_LOGO, /<image|<script|<foreignObject|href=|onload=|data:image|#[0-9a-f]{3,8}\b/i);
    assert.ok(QIANMU_HIVE_THEME_LOGO.length < 30000);
});

test('new-theme logo cannot create a duplicate accessible button or paint over classic without opt-in', () => {
    assert.match(QIANMU_HIVE_THEME_LOGO, /aria-hidden="true"/);
    assert.match(QIANMU_HIVE_THEME_LOGO, /focusable="false"/);
    assert.match(QIANMU_HIVE_THEME_LOGO, /style="display:none"/);
    assert.doesNotMatch(QIANMU_HIVE_THEME_LOGO, /tabindex|<button|<title|role="button"/);
});

test('the production floating button retains classic image plus theme vector, without changing click and drag mounting', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const begin = source.indexOf('function renderFloatButton()');
    const end = source.indexOf('\nfunction scheduleFloatButtonRecovery', begin);
    const render = source.slice(begin, end);
    assert.match(source, /import\s*\{\s*QIANMU_HIVE_THEME_LOGO\s*\}\s*from\s*['"]\.\/qianmu-hive-theme-logo\.js['"]/);
    assert.match(render, /<img[^\n]+\$\{QIANMU_HIVE_THEME_LOGO\}\$\{QUICK_HEX_BORDER_SVG\}/);
    assert.match(render, /bindFloatDrag\(btn\)/);
    assert.match(render, /appearanceSession\.mount\(btn,\{role:'hive-main'\}\)/);
});
