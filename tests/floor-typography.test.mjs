import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

test('floor tools share the main panel typography scale without touching prose settings', () => {
    assert.match(css, /#story-director-modal,\s*#story-director-floor-nav\s*\{\s*--qm-type-page-title: 20px;[\s\S]*?--qm-type-feature-title: 17px;/);
    assert.match(css, /#story-director-modal,\s*#story-director-floor-nav\s*\{\s*--qm-type-card-title: 13px;\s*--qm-type-body: 12px;\s*--qm-type-label: 11px;/);
    for (const [selector, token] of [['h3', 'feature-title'], ['header p', 'caption'], ['.sd-floor-input', 'body'], ['.sd-prose-control > span', 'label'], ['.sd-prose-control small', 'caption']]) {
        const selectorStart = `#story-director-floor-nav ${selector} {`;
        const rule = css.slice(css.indexOf(selectorStart), css.indexOf('}', css.indexOf(selectorStart)));
        assert.ok(rule.includes(`font-size: var(--qm-type-${token})`), `${selector} uses shared ${token} size`);
    }
    assert.match(css, /#story-director-floor-nav :is\(button, input\) \{ font: inherit; \}/);
    assert.match(css, /#story-director-floor-nav \.sd-floor-tabs button \{[^}]*font-size: 13\.5px;/);
    assert.match(css, /#story-director-modal \.sd-tabs button \{ font-size: 13\.5px !important;/);
    assert.match(css, /font-size: var\(--sd-prose-font-size\) !important;/, 'actual prose size remains user-controlled');
});

test('floor typography keeps existing touch targets and does not shrink mobile labels separately', () => {
    assert.match(css, /#story-director-floor-nav \.sd-floor-tabs button \{[^}]*min-height: 36px;/);
    assert.match(css, /#story-director-floor-nav \.sd-floor-actions button \{[^}]*min-height: 42px;/);
    assert.doesNotMatch(css, /#story-director-floor-nav \.sd-prose-checks label \{[^}]*font-size:/);
});
