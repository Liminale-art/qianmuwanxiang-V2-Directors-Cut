import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
import { htmlEscape, groupByFolder } from '../qianmu-storyboard-utils.js';

function fixture() {
    const theater = { scripts: [{ id: 'one', title: '旅途', folder: '' }] }, calls = [];
    const context = vm.createContext({
        htmlEscape, groupByFolder, getTheater: () => theater,
        theaterExportMode: true, theaterExportSelection: new Set(['one']),
        theaterCatalogReady: true, theaterView: null, bindTheaterPresetPicker() {}, importTheaterScripts() {},
        renderModal: () => calls.push('render'), bindLibraryEvents: (_root, _cfg, handlers) => { context.handlers = handlers; },
    });
    vm.runInContext(['renderLibraryRow', 'renderLibraryListBody', 'renderLibrarySection', 'theaterScriptLibraryCfg', 'bindTheaterTabEvents'].map(storyboardFunctionSource).join('\n'), context);
    return { context, theater, calls };
}

test('theater selection has three accessible shared-icon actions and no duplicate cancel', () => {
    const { context } = fixture(), cfg = context.theaterScriptLibraryCfg(), html = context.renderLibrarySection(cfg);
    assert.equal(cfg.compactSelectionActions, true);
    const bar = html.match(/<div class="sd-export-bar sd-lib-icon-selection">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(bar);
    const buttons = [...bar.matchAll(/<button\b([^>]+)>([\s\S]*?)<\/button>/g)];
    assert.equal(buttons.length, 3);
    for (const [index, name] of ['fa-check-double', 'fa-trash-can', 'fa-file-export'].entries()) {
        assert.match(buttons[index][1], /sd-icon-btn sd-icon-sm/);
        assert.match(buttons[index][1], /title="[^"]+" aria-label="[^"]+"/);
        assert.ok(buttons[index][2].includes(name));
        assert.doesNotMatch(buttons[index][2], /全选|删除|导出/);
    }
    assert.doesNotMatch(html, /sd-lib-cancel-export/);
    assert.match(html, /sd-lib-export-toggle active/);
    assert.match(bar, /sd-lib-sel-count">1<\/span>/);
});

test('other shared libraries retain their existing text actions and cancel', () => {
    const { context } = fixture(), cfg = context.theaterScriptLibraryCfg();
    delete cfg.compactSelectionActions;
    const html = context.renderLibrarySection({ ...cfg, ns: 'template' });
    assert.doesNotMatch(html, /sd-lib-icon-selection/);
    assert.match(html, /sd-lib-select-all">全选/);
    assert.match(html, /sd-lib-cancel-export">取消/);
});

test('the existing theater multiselect switch exits and clears only selection, then reopens', () => {
    const { context, theater, calls } = fixture(), before = structuredClone(theater);
    context.bindTheaterTabEvents({ querySelector: () => null, querySelectorAll: () => [] });
    context.handlers.onToggleExport();
    assert.equal(context.theaterExportMode, false);
    assert.equal(context.theaterExportSelection.size, 0);
    assert.deepEqual(theater, before);
    context.handlers.onToggleExport();
    assert.equal(context.theaterExportMode, true);
    assert.deepEqual(calls, ['render', 'render']);
});
