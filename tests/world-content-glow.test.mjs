import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

test('world border glow requires actual faction or event content, not merely enabling the module', () => {
    const context = vm.createContext({ settings: { geopoliticsEnabled: true }, worldPage: 'front', store: {} });
    vm.runInContext('function getChatStore(){return store;}\n' + storyboardFunctionSource('renderWorldPageEdges'), context);
    for (const store of [{}, { factions: [], worldEvents: [] }, { factions: [null, {}, { name: '  ' }], worldEvents: [{ title: '' }] }]) {
        context.store = store;
        const markup = context.renderWorldPageEdges();
        assert.equal((markup.match(/<button/g) || []).length, 2, 'empty module remains reachable');
        assert.doesNotMatch(markup, /has-content/);
    }
    for (const store of [{ factions: [{ name: '港口商会' }] }, { worldEvents: [{ title: '港口变迁' }] }, { worldEvents: [{ essence: '已有事件正文' }] }]) {
        context.store = store;
        assert.equal((context.renderWorldPageEdges().match(/has-content/g) || []).length, 2);
    }
    context.settings.geopoliticsEnabled = false;
    assert.equal(context.renderWorldPageEdges(), '');
    context.worldPage = 'geopolitics';
    assert.match(context.renderWorldPageEdges(), /返回世界正面/, 'disabling the module never traps its open view');
    context.store = { factions: [], worldEvents: [] };
    assert.doesNotMatch(context.renderWorldPageEdges(), /has-content/, 'clearing generated content removes both glows');
});
