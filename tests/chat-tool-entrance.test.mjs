import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
import { QIANMU_HIVE_COMMANDS } from '../qianmu-hive-commands.js';

test('only the hive editor shortens chat-tool and settings labels; IDs, order and enabled actions remain intact', () => {
    const before = structuredClone(QIANMU_HIVE_COMMANDS);
    const c = vm.createContext({ settings: { quickWheelEnabled: true, quickWheelCustomOrder: QIANMU_HIVE_COMMANDS.map(item => item.id), quickWheelCustomEnabled: ['floor', 'plug'] },
        normalizeQuickWheelSettings() {}, QUICK_COMMANDS: QIANMU_HIVE_COMMANDS, htmlEscape: value => String(value) });
    vm.runInContext(storyboardFunctionSource('renderQuickWheelSettings'), c);
    const html = c.renderQuickWheelSettings();
    assert.match(html, /data-command="floor"[^>]*aria-pressed="true"[^>]*><i[^>]*data-qm-icon="floor-tools"[^>]*><\/i><span>聊天工具<\/span>/);
    assert.match(html, /data-command="plug"[^>]*aria-pressed="true"[^>]*>.*?<span>设置<\/span>/);
    assert.doesNotMatch(html, /聊天工具包|API与日志/);
    assert.deepEqual(QIANMU_HIVE_COMMANDS, before);
    assert.deepEqual([...html.matchAll(/data-command="([^"]+)"/g)].map(match => match[1]), before.map(item => item.id));
    c.settings.quickWheelEnabled = false; assert.equal(c.renderQuickWheelSettings(), '');
});

test('shared hive labels, panel titles and the ST menu logo are not globally renamed or replaced', async () => {
    assert.equal(QIANMU_HIVE_COMMANDS.find(item => item.id === 'floor').label, '聊天工具包');
    assert.equal(QIANMU_HIVE_COMMANDS.find(item => item.id === 'plug').label, 'API与日志');
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(source, /<h3>聊天工具包<\/h3>/);
    assert.match(source, /const iconMarkup = item.external \? quickDockIconMarkup\(item\) : .*?data-qm-icon=.*?item.glyph/);
    const st = await readFile(new URL('../qianmu-st-menu-entry.js', import.meta.url), 'utf8');
    assert.match(st, /glyph.innerHTML=QIANMU_HIVE_THEME_LOGO/);
    assert.match(st, /label.textContent='千幕'/);
    assert.doesNotMatch(st, /floor-tools|firstline/);
});
