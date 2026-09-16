import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {syncQianmuNotesTheme} from '../qianmu-notes-theme.js';

function fixture() {
  const nodes = new Map();
  const element = (id, classes = []) => {
    const values = new Map(), names = new Set(classes);
    const node = {id, values, children: new Map(),
      classList: { [Symbol.iterator]: () => names[Symbol.iterator](), add: name => names.add(name), remove: name => names.delete(name),
        toggle(name, on) { if (on) names.add(name); else names.delete(name); }, contains: name => names.has(name)},
      style: {setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key)},
      querySelector: selector => node.children.get(selector), remove: () => nodes.delete(node.id),
      get className() {return [...names].join(' ');}, set className(value) {names.clear(); value.split(/\s+/).filter(Boolean).forEach(name => names.add(name));}};
    return node;
  };
  const document = {getElementById: id => nodes.get(id), createElement: () => element(''), body: {appendChild: node => nodes.set(node.id, node)},
    defaultView: {getComputedStyle: () => ({getPropertyValue: name => name === '--sd-text' ? '#abcdef' : ''})}};
  return {nodes, element, document};
}
const palette = {lightFill: 'light-fill', darkFill: 'dark-fill', lightIcon: 'light-ink', darkIcon: 'dark-ink', edges: ['a', 'b', 'c']};

test('notes theme synchronization patches existing roots and three entry tokens only', () => {
  const {nodes, element, document} = fixture();
  const source = element('story-director-modal', ['sd-theme-light', 'open']); nodes.set(source.id, source);
  const panel = element('qianmu-notes-panel-layer', ['sd-theme-light', 'is-editing']); nodes.set(panel.id, panel);
  const floating = element('qianmu-notes-float-layer', ['sd-theme-light', 'sd-hive-theme-light', 'keep']); nodes.set(floating.id, floating);
  const entry = element('', ['sd-detached-notes-entry', 'is-glass-light', 'is-dragging']); floating.children.set('.sd-detached-notes-entry', entry);
  entry.values.set('left', '120px'); entry.values.set('top', '230px'); entry.values.set('width', '62px');
  panel.values.set('--sd-unused', 'stale'); panel.values.set('--sd-note-editor-font-size', '18px');
  syncQianmuNotesTheme({document, themeKey: 'future-theme', palette, appearance: {tone: 'dark', edgeIndex: 4}, variables: ['--sd-text', '--sd-unused']});
  assert.equal(nodes.get(panel.id), panel); assert.equal(nodes.get(floating.id), floating);
  assert.equal(panel.className, 'is-editing sd-theme-future-theme');
  assert.equal(floating.className, 'keep sd-theme-future-theme sd-hive-theme-future-theme');
  assert.equal(source.className, 'open sd-theme-future-theme');
  assert.equal(panel.values.get('--sd-text'), '#abcdef'); assert.equal(panel.values.has('--sd-unused'), false);
  assert.equal(panel.values.get('--sd-note-editor-font-size'), '18px');
  assert.equal(entry.values.get('--sd-wheel-edge'), 'b'); assert.equal(entry.values.get('--sd-wheel-glass-fill'), 'dark-fill');
  assert.equal(entry.values.get('--sd-wheel-icon'), 'dark-ink'); assert.equal(entry.classList.contains('is-dragging'), true);
  for (const [key, value] of [['left', '120px'], ['top', '230px'], ['width', '62px']]) assert.equal(entry.values.get(key), value);
});

test('a detached notes page can resolve its theme without leaving a temporary main panel', () => {
  const {nodes, element, document} = fixture();
  const panel = element('qianmu-notes-panel-layer'); nodes.set(panel.id, panel);
  syncQianmuNotesTheme({document, themeKey: 'dark', variables: ['--sd-text']});
  assert.equal(nodes.size, 1); assert.equal(nodes.has('story-director-modal'), false);
  assert.equal(panel.values.get('--sd-text'), '#abcdef');
  document.defaultView.getComputedStyle = () => {throw Error('view gone');};
  assert.throws(() => syncQianmuNotesTheme({document}), /view gone/);
  assert.equal(nodes.size, 1, 'temporary source must be removed on failure too');
});

test('invalid appearance indices are bounded and unsupported theme tokens are rejected', () => {
  const {nodes, element, document} = fixture();
  const floating = element('qianmu-notes-float-layer'), entry = element('');
  nodes.set(floating.id, floating); floating.children.set('.sd-detached-notes-entry', entry);
  for (const edgeIndex of [NaN, Infinity, -1, 'bad']) {
    syncQianmuNotesTheme({document, palette, appearance: {edgeIndex, tone: 'light'}});
    assert.equal(entry.values.get('--sd-wheel-edge'), 'a');
  }
  for (const themeKey of ['', 'dark bad', 'dark;}', null]) assert.throws(() => syncQianmuNotesTheme({document, themeKey}), TypeError);
});

test('the actual appearance change event synchronizes notes without rebuilding their content', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('modal._sdThemeMenuCleanup = bindQianmuThemeMenu');
  assert.ok(start >= 0, 'the appearance selection remains wired to the production menu');
  const event = source.slice(start, source.indexOf("modal.querySelectorAll('.sd-tab')", start));
  assert.match(event, /selectQianmuClassicTheme/);
  assert.match(event, /if \(appearanceSession.supported\)[\s\S]*return;[\s\S]*renderModal\(\)[\s\S]*syncNotesTheme\(\)/, 'modern browsers use in-place synchronization; the old fallback stays limited to unsupported browsers');
  assert.doesNotMatch(event, /renderNotesPanelPortal|renderFloatingNotes/);
  assert.match(source, /function renderFloatButton\(\) \{\s*syncNotesTheme\(\);/, 'settings restoration and appearance refreshes use the same notes sync');
  const helper = await readFile(new URL('../qianmu-notes-theme.js', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /innerHTML|replaceChildren|replaceWith|\.focus\(|setSelectionRange|releasePointerCapture|localStorage|indexedDB|fetch\(/);
});
