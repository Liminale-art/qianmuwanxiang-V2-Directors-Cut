import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
function rules(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'g'))].map(match => match[1]);
}

test('widget toggles stay in two columns and hive choices stay in three at every breakpoint', () => {
    const toggles = rules('#story-director-modal .sd-widget-toggle-row');
    const choices = rules('#story-director-modal .sd-wheel-custom-list');
    assert.equal(toggles.length, 1, 'a mobile override must not change the two-toggle layout');
    assert.equal(choices.length, 1, 'one shared choice grid covers narrow and wide panels');
    assert.match(toggles[0], /display:\s*grid/);
    assert.match(toggles[0], /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(choices[0], /display:\s*grid/);
    assert.match(choices[0], /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    assert.doesNotMatch(css, /\.sd-wheel-custom-row\b/, 'the former checkbox/order row is retired');
});

test('hive labels can wrap without shrinking their icons or forcing a fourth column', () => {
    const base = rules('#story-director-modal .sd-widget-toggle:not(.sd-btn)').join('\n');
    const icons = rules('#story-director-modal .sd-wheel-command-toggle > :is(i, .qm-glyph-icon)').join('\n');
    const labels = rules('#story-director-modal .sd-wheel-command-toggle > span').join('\n');
    assert.match(base, /min-width:\s*0/);
    assert.match(base, /min-height:\s*31px/);
    assert.match(icons, /flex:\s*0\s+0\s+14px/);
    assert.match(labels, /min-width:\s*0/);
    assert.match(labels, /white-space:\s*normal/);
    assert.match(labels, /overflow-wrap:\s*anywhere/);
});

test('the hive title and selected tags retain the existing theme system', () => {
    const summary = rules('#story-director-modal .sd-wheel-custom-details > summary > b').at(-1);
    const active = rules('#story-director-modal .sd-widget-toggle-row > .sd-widget-toggle.active').join('\n');
    assert.match(summary, /font-size:\s*var\(--qm-type-body\)/);
    assert.match(active, /var\(--sd-accent\)/);
    assert.match(active, /var\(--sd-card\)/);
    assert.doesNotMatch(css, /\.sd-wheel-command-toggle[^{}]*\{[^}]*border-radius/, 'choice buttons must share widget/theme corners');
    assert.match(theme, /data-qm-theme="editorial"[\s\S]*button:not\(\[data-coread-identity\]\)/);
    assert.match(theme, /\.sd-widget-toggle\.active[^{}]*\{\s*color:\s*var\(--qm-action-ink\)/);
});

test('tag selections share an opaque muted accent without recoloring primary actions', () => {
    const selected = rules(':is(#story-director-modal, [data-qm-theme]) .sd-option-chip:is(.active, :has(> input:checked))').join('\n');
    assert.match(css, /#story-director-modal button\.sd-btn\.sd-newcomer-toggle:is\(\.active, \[aria-pressed="true"\]\),/);
    assert.match(css, /#story-director-modal button\.sd-btn\.sd-stream-toggle\[aria-pressed="true"\],/);
    assert.match(css, /#story-director-modal \.sd-widget-card button\.sd-widget-toggle:is\(\.active, \[aria-pressed="true"\]\),/);
    assert.match(selected, /background:\s*var\(--sd-tag-selected-bg\) !important/);
    assert.match(selected, /color:\s*var\(--sd-text\) !important/);
    assert.match(selected, /border-color:\s*var\(--sd-tag-selected-border\) !important/);
    assert.doesNotMatch(selected, /--sd-primary|transparent/);
    assert.match(css, /--sd-tag-selected-bg:\s*color-mix\(in srgb, var\(--sd-accent\) 24%, color-mix\(in srgb, var\(--sd-text\) 10%, var\(--sd-sticky-bg\)\)\)/);
    assert.match(theme, /\[data-qm-theme\] \.sd-primary:not\(\.sd-option-chip\)\s*\{[^}]*background:\s*var\(--qm-accent\)/);
    assert.doesNotMatch(theme, /:is\(\.sd-primary, \.sd-option-chip/);
});
