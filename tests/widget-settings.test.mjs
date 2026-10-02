import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
import { QIANMU_HIVE_COMMANDS, upgradeProseHiveCommands } from '../qianmu-hive-commands.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const commandIds = QIANMU_HIVE_COMMANDS.map(item => item.id);
const defaultEnabled = vm.runInNewContext(source.match(/quickWheelCustomEnabled:\s*(\[[^\]]+\])/)[1]);
const plain = value => JSON.parse(JSON.stringify(value));
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function eventNode({ dataset = {}, active = false, open = false } = {}) {
    const handlers = new Map(), attrs = new Map(), classes = new Set(active ? ['active'] : []);
    return {
        dataset, open, value: '', textContent: '',
        addEventListener: (name, handler) => handlers.set(name, handler),
        setAttribute: (name, value) => attrs.set(name, String(value)),
        getAttribute: name => attrs.get(name),
        classList: {
            contains: name => classes.has(name),
            toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        },
        fire(name) { handlers.get(name)?.({ target: this, currentTarget: this }); },
        click() { this.fire('click'); },
    };
}

// Executes production renderers/bindings; only the host DOM, storage and icon painter are doubles.
function fixture(overrides = {}) {
    const calls = [], layers = new Map();
    const settings = {
        floatingButton: true, quickWheelEnabled: true, quickWheelCustomExpanded: false,
        quickWheelCustomOrder: [...commandIds], quickWheelCustomEnabled: ['dashboard', 'notes'],
        quickWheelDockedPlugins: [], proseHiveVersion: 3,
        notes: { detached: true, position: { x: 17, y: 92 }, appearance: { tone: 'light', edgeIndex: 0 }, panelSize: { width: 310, height: 420 } },
        ...overrides,
    };
    const document = {
        getElementById: id => layers.get(id),
        createElement: () => ({ id: '', className: '', innerHTML: '', remove() { layers.delete(this.id); } }),
        body: { appendChild: layer => layers.set(layer.id, layer) },
    };
    const context = vm.createContext({
        settings, document, QUICK_COMMANDS: QIANMU_HIVE_COMMANDS, QUICK_COMMAND_IDS: commandIds, QUICK_HIVE_SAFETY_LIMIT: 24,
        DEFAULT_SETTINGS: { quickWheelCustomEnabled: defaultEnabled }, upgradeProseHiveCommands,
        isPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
        htmlEscape: escape, FLOAT_SIZE_MIN: 32, FLOAT_SIZE_MAX: 80,
        closeQuickWheel: () => calls.push('close-wheel'), quickDockClearDrag: () => calls.push('clear-drag'),
        renderFloatButton: () => calls.push('render-float'), restoreQuickDockedPlugins: () => calls.push('restore-dock'),
        syncQuickDockOriginVisibility: () => calls.push('sync-origin'),
        saveSettings: () => calls.push('save'), renderModal: () => calls.push('render-modal'),
        toast: (message, level) => calls.push({ message, level }),
        getFloatSize: () => 48, uniqueClean: values => [...new Set(values.filter(Boolean))],
        LOG_LIMIT: 50, renderStorageManagementCard: () => '', feedbackOpenScope: null,
        NOTES_FLOAT_LAYER_ID: 'notes-float', NOTES_PANEL_LAYER_ID: 'notes-panel', notesPanelOpen: false,
        notesSyncPanel: { hide: () => calls.push('hide-notes-sync') },
        stopNotesPanelResizeTracking: () => calls.push('stop-notes-resize'),
        proseFloorTools: { renderHive: () => calls.push('render-notes') },
        notesFeatureSettings: () => settings.notes,
        clampDetachedNotesEntry: value => ({ ...value }), detachedNotesGeometry: () => ({ width: 42, height: 48 }),
        currentHivePalette: () => ({ edges: ['#123'], lightFill: '#fff', darkFill: '#000', lightIcon: '#111', darkIcon: '#eee' }),
        currentHiveThemeKey: () => 'light', THEME_KEYS: ['light'], QUICK_HEX_BORDER_SVG: '<svg></svg>',
        applyQianmuIcons() {}, bindFloatingNoteEvents() {}, appearanceSession: { mountNotes() {} },
    });
    const names = ['migrateWidgetSettings', 'normalizeQuickWheelSettings', 'notesFeatureEnabled', 'closeNotesPanel',
        'renderFloatingNotes', 'refreshWidgetRuntime', 'bindWidgetSettings', 'renderQuickWheelSettings', 'renderPlugTab'];
    vm.runInContext(names.map(storyboardFunctionSource).join('\n'), context);
    function mount() {
        const html = context.renderPlugTab();
        const widgets = [...html.matchAll(/<button\b[^>]*data-widget-toggle="([^"]+)"[^>]*>/g)].map(match =>
            eventNode({ dataset: { widgetToggle: match[1] }, active: /aria-pressed="true"/.test(match[0]) }));
        const commands = [...html.matchAll(/<button\b[^>]*data-command="([^"]+)"[^>]*>/g)].map(match => {
            const active = /aria-pressed="true"/.test(match[0]);
            const button = eventNode({ dataset: { command: match[1] }, active });
            button.setAttribute('aria-pressed', active);
            return button;
        });
        const details = html.includes('class="sd-wheel-custom-details"')
            ? eventNode({ open: /class="sd-wheel-custom-details" open/.test(html) }) : null;
        const count = eventNode(); count.textContent = html.match(/<b>(\d+ 项)<\/b>/)?.[1] || '';
        const range = eventNode(), size = eventNode();
        const root = {
            querySelectorAll: selector => selector === '[data-widget-toggle]' ? widgets : selector === '.sd-wheel-command-toggle' ? commands : [],
            querySelector: selector => ({ '.sd-float-size': range, '.sd-float-size-value': size,
                '.sd-wheel-custom-details': details, '.sd-wheel-custom-details > summary > b': count })[selector] ?? null,
        };
        context.bindWidgetSettings(root);
        return { html, widgets, commands, details, count, range, size,
            widget: id => widgets.find(button => button.dataset.widgetToggle === id),
            command: id => commands.find(button => button.dataset.command === id) };
    }
    return { context, settings, calls, layers, document, mount };
}

test('old wheel/dock switch combinations merge once, preserving any explicit off choice', () => {
    for (const wheel of [true, false, undefined]) for (const dock of [true, false, undefined]) {
        const f = fixture({ quickWheelEnabled: wheel, quickDockEnabled: dock });
        const originalOrder = plain(f.settings.quickWheelCustomOrder);
        f.context.migrateWidgetSettings(f.settings);
        assert.equal(f.settings.quickWheelEnabled !== false, wheel !== false && dock !== false);
        assert.equal(Object.hasOwn(f.settings, 'quickDockEnabled'), false);
        assert.deepEqual(plain(f.settings.quickWheelCustomOrder), originalOrder);
        f.settings.quickWheelEnabled = true;
        f.context.migrateWidgetSettings(f.settings);
        assert.equal(f.settings.quickWheelEnabled, true, 'the retired flag cannot undo a subsequent user choice');
    }
});

test('retired notes toggle migrates into selection without losing position, size, detach or data', () => {
    for (const enabled of [true, false, undefined]) {
        const f = fixture(); f.settings.notes.enabled = enabled;
        const original = plain(f.settings.notes); delete original.enabled;
        f.context.migrateWidgetSettings(f.settings);
        assert.equal(f.settings.quickWheelCustomEnabled.includes('notes'), enabled !== false);
        assert.deepEqual(plain(f.settings.notes), original);
        const once = plain(f.settings);
        f.context.migrateWidgetSettings(f.settings);
        assert.deepEqual(plain(f.settings), once);
        f.settings.quickWheelCustomEnabled = ['notes', 'dashboard'];
        f.context.migrateWidgetSettings(f.settings);
        assert.equal(f.context.notesFeatureEnabled(), true, 'a later note selection must not be disabled again');
    }
    const fallback = fixture({ quickWheelCustomEnabled: undefined, notes: { enabled: false, detached: true, position: { x: 2, y: 3 } } });
    fallback.context.migrateWidgetSettings(fallback.settings);
    assert.deepEqual(plain(fallback.settings.quickWheelCustomEnabled), plain(defaultEnabled).filter(id => id !== 'notes'));
});

test('production widget card renders precisely two text-only toggles', () => {
    for (const enabled of [true, false]) {
        const f = fixture({ quickWheelEnabled: enabled }), mounted = f.mount();
        const row = mounted.html.match(/<div class="sd-widget-toggle-row"[^>]*>([\s\S]*?)<\/div>/)[1];
        assert.deepEqual(mounted.widgets.map(button => button.dataset.widgetToggle), ['floating', 'wheel']);
        assert.match(row, /<span>悬浮球<\/span>/); assert.match(row, /<span>蜂巢格<\/span>/);
        assert.doesNotMatch(row, /<i\b|<svg\b|data-qm-icon|快捷盘|蜂巢收纳|便笺/);
        assert.equal(mounted.details !== null, enabled);
    }
});

test('entry renderer retains saved order, local icons, pressed states and exact selection count without sorting controls', () => {
    const order = ['tts', 'notes', 'floor', ...commandIds.filter(id => !['tts', 'notes', 'floor'].includes(id))];
    const f = fixture({ quickWheelCustomOrder: order, quickWheelCustomEnabled: ['floor', 'notes'] }), mounted = f.mount();
    assert.deepEqual(mounted.commands.map(button => button.dataset.command), order);
    assert.equal(mounted.count.textContent, '2 项');
    assert.match(mounted.html, /sd-wheel-custom-list" role="group" aria-label="蜂巢入口"/);
    const entries = [...mounted.html.matchAll(/<button\b[^>]*data-command="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
    assert.equal(entries.length, commandIds.length);
    for (const [, id, markup] of entries) {
        assert.match(markup, /<i\b[^>]*data-qm-icon="[^"]+"/);
        assert.equal(mounted.command(id).getAttribute('aria-pressed'), String(['floor', 'notes'].includes(id)));
    }
    assert.doesNotMatch(mounted.html, /sd-wheel-custom-row|type="checkbox"|data-wheel-move|data-move=|fa-chevron-up|fa-chevron-down/);
});

test('clicking labels updates count and pressed state while keeping legacy order and at least one choice', () => {
    const f = fixture({ quickWheelCustomEnabled: ['dashboard'] }), mounted = f.mount();
    const order = plain(f.settings.quickWheelCustomOrder);
    mounted.command('dashboard').click();
    assert.deepEqual(plain(f.settings.quickWheelCustomEnabled), ['dashboard']);
    assert.equal(mounted.command('dashboard').getAttribute('aria-pressed'), 'true');
    assert.equal(mounted.count.textContent, '1 项');
    assert.deepEqual(f.calls.at(-1), { message: '蜂巢格至少保留一个入口。', level: 'warning' });
    assert.equal(f.calls.includes('save'), false);
    mounted.command('tts').click(); mounted.command('notes').click();
    assert.deepEqual(plain(f.settings.quickWheelCustomEnabled), order.filter(id => ['dashboard', 'tts', 'notes'].includes(id)));
    assert.equal(mounted.count.textContent, '3 项');
    assert.equal(mounted.command('notes').classList.contains('active'), true);
    assert.equal(mounted.command('notes').getAttribute('aria-pressed'), 'true');
    mounted.command('tts').click();
    assert.equal(mounted.count.textContent, '2 项');
    assert.equal(mounted.command('tts').classList.contains('active'), false);
    assert.equal(mounted.command('tts').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(plain(f.settings.quickWheelCustomOrder), order);
    assert.equal(f.calls.filter(value => value === 'save').length, 3);
});

test('turning hive on opens its entry list, off removes it, and existing fold choice remains until the next enable', () => {
    const f = fixture({ quickWheelEnabled: false, quickWheelCustomExpanded: false });
    let mounted = f.mount(); assert.equal(mounted.details, null);
    mounted.widget('wheel').click();
    assert.equal(f.settings.quickWheelEnabled, true); assert.equal(f.settings.quickWheelCustomExpanded, true);
    mounted = f.mount(); assert.equal(mounted.details.open, true);
    mounted.details.open = false; mounted.details.fire('toggle');
    assert.equal(f.settings.quickWheelCustomExpanded, false);
    mounted = f.mount(); assert.equal(mounted.details.open, false);
    mounted.widget('wheel').click();
    assert.equal(f.context.renderQuickWheelSettings(), '');
    mounted = f.mount(); assert.equal(mounted.commands.length, 0);
    mounted.widget('wheel').click(); assert.equal(f.mount().details.open, true);
    assert.equal(f.calls.filter(value => value === 'render-modal').length, 3);
    assert.equal(f.calls.filter(value => value === 'restore-dock').length, 3);
});

test('notes label alone hides and restores the detached entry, preserving placement and never reopening its panel', () => {
    const f = fixture(), mounted = f.mount(), before = plain(f.settings.notes);
    f.context.renderFloatingNotes(); assert.equal(f.layers.has('notes-float'), true);
    const layer = f.document.createElement(); layer.id = 'notes-panel'; f.document.body.appendChild(layer);
    f.context.notesPanelOpen = true;
    mounted.command('notes').click();
    assert.equal(f.context.notesFeatureEnabled(), false);
    assert.equal(f.context.notesPanelOpen, false);
    assert.equal(f.layers.has('notes-panel'), false); assert.equal(f.layers.has('notes-float'), false);
    assert.deepEqual(plain(f.settings.notes), before);
    mounted.command('notes').click();
    assert.equal(f.context.notesFeatureEnabled(), true);
    assert.equal(f.layers.has('notes-float'), true); assert.equal(f.layers.has('notes-panel'), false);
    assert.match(f.layers.get('notes-float').innerHTML, /left:17px;top:92px/);
    assert.deepEqual(plain(f.settings.notes), before);
});

test('global widget refresh clears active gestures and resynchronizes existing controls without resetting note choice', () => {
    const f = fixture(); f.context.refreshWidgetRuntime();
    assert.deepEqual(f.calls, ['close-wheel', 'clear-drag', 'render-float', 'render-notes', 'restore-dock', 'sync-origin']);
    const before = plain(f.settings.quickWheelCustomEnabled);
    const mounted = f.mount(); mounted.widget('floating').click();
    assert.equal(f.settings.floatingButton, false);
    assert.equal(f.settings.quickWheelEnabled, true);
    assert.deepEqual(plain(f.settings.quickWheelCustomEnabled), before);
    mounted.widget('floating').click(); assert.equal(f.settings.floatingButton, true);
    const rendered = f.mount(); rendered.range.value = '100'; rendered.range.fire('input');
    assert.equal(f.settings.floatSize, 80); assert.equal(rendered.size.textContent, '80 px');
    rendered.range.value = '12'; rendered.range.fire('input'); assert.equal(f.settings.floatSize, 32);
});

test('invalid legacy entry selections cannot break widget convergence', () => {
    for (const value of [{}, 'notes', null]) {
        const f = fixture({ quickWheelCustomEnabled: value });
        assert.equal(f.context.notesFeatureEnabled(), false);
        assert.doesNotThrow(() => f.context.refreshWidgetRuntime());
        assert.ok(Array.isArray(f.settings.quickWheelCustomEnabled));
    }
});

test('applying disabled extension settings cannot recreate the detached note entry', () => {
    const f = fixture(); f.context.renderFloatingNotes();
    assert.equal(f.layers.has('notes-float'), true);
    const before = plain(f.settings.notes);
    f.context.notesPanelOpen = true; f.settings.enabled = false;
    f.context.refreshWidgetRuntime();
    assert.equal(f.context.notesPanelOpen, false);
    assert.equal(f.layers.has('notes-float'), false);
    assert.deepEqual(plain(f.settings.notes), before);
});
