import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createProseFloorTools} from '../qianmu-prose-floor-tools.js';
import {proseAssistantPanelDom} from './helpers/prose-assistant-panel-dom.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

// Only the empty, readonly legacy lookup needed before a first remote save.
// The actual history factory and native ST file read/write chain remain real.
function emptyLegacyDatabase(counter) {
    return {open(name, version) {
        assert.equal(name, 'qianmu-prose-assistant-history'); assert.equal(version, 1);
        const request = {};
        setImmediate(() => {
            request.result = {close() {}, transaction(store, mode) {
                assert.equal(store, 'accounts'); assert.equal(mode, 'readonly');
                const transaction = {objectStore() { return {get() {
                    counter.reads++;
                    const lookup = {};
                    setImmediate(() => {
                        lookup.result = undefined; lookup.onsuccess();
                        setImmediate(() => transaction.oncomplete?.());
                    });
                    return lookup;
                }}; }};
                return transaction;
            }};
            request.onsuccess();
        });
        return request;
    }};
}

test('formal lazy entry starts with no history, flushes first connection before send and reopens native history without replay', async t => {
    const dom = proseAssistantPanelDom(), namespace = 'st-user:assistant-first-use-fixture';
    const transport = streamCheckpointTransport(namespace), legacy = {reads: 0}, models = [], notifications = [];
    const host = {chat: [], chatMetadata: {}, characters: [], eventSource: new EventEmitter()};
    const settings = {apiProfiles: []};
    let settingsSubmissions = 0, tools;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    t.after(() => {
        tools?.dispose();
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document;
        if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB); else delete globalThis.indexedDB;
    });
    Object.defineProperty(globalThis, 'document', {configurable: true, value: dom.doc});
    Object.defineProperty(globalThis, 'indexedDB', {configurable: true, value: emptyLegacyDatabase(legacy)});
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/generate', 'only the exact synthetic ST model route is accepted');
        assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin');
        assert.equal(options.headers['X-CSRF-Token'], 'fixture-csrf');
        models.push(JSON.parse(options.body));
        return Response.json({choices: [{message: {content: '首次完整回答'}, finish_reason: 'stop'}]});
    });
    tools = createProseFloorTools({
        getContext: () => host, resolveNamespace: async () => namespace, headers: () => ({'X-CSRF-Token': 'fixture-csrf'}),
        isCurrent: () => true, confirm: async () => true, notify: message => notifications.push(message),
        assistantConfig: () => ({...settings.proseAssistant, profiles: settings.apiProfiles}),
        assistantSettings: () => settings, saveAssistantSettings: () => { settingsSubmissions++; },
    });
    // Inject only the transport boundary. Do not override assistantHistoryFactory:
    // the public entry must lazy-load and supply its production native factory.
    transport.configure();
    let panel = await tools.openAssistant(); assert.ok(panel, notifications.join('\n')); await panel.ready;
    const action = name => dom.all().find(node => node.dataset.paAction === name);
    const question = () => dom.get('向场外特助提问');
    const rows = () => dom.all().filter(node => Object.hasOwn(node.dataset, 'paTurn'));
    const uploads = () => transport.calls.filter(call => call.options.method === 'POST').length;
    assert.equal(rows().length, 0); assert.equal(uploads(), 0); assert.equal(transport.files.size, 0);
    assert.equal(models.length, 0); assert.equal(settingsSubmissions, 0); assert.equal(legacy.reads, 1);
    assert.equal(dom.get('参考楼层数').value, '0'); assert.equal(dom.get('参考楼层数').disabled, true);
    assert.equal(dom.all().find(node => Object.hasOwn(node.dataset, 'paReferenceHint')).hidden, false);

    action('settings').click();
    const selector = dom.get('助手API预设'); selector.value = 'custom'; selector.emit('change');
    for (const [label, value] of [['助手API地址', 'https://model.fixture.invalid/v1'], ['助手模型', 'first-model'], ['助手API Key', 'fixture-first-key']]) {
        const field = dom.get(label); field.value = value; field.emit('input');
    }
    dom.get('流式传输').checked = false; dom.get('流式传输').emit('change');
    action('back').click(); question().value = '首次问题'; question().emit('input');
    assert.equal(settingsSubmissions, 0, 'send is clicked before the settings debounce is flushed');
    assert.equal(action('send').disabled, false); action('send').click();
    await dom.wait(() => models.length === 1 && panel.element.getAttribute('aria-busy') === 'false');
    assert.equal(settingsSubmissions, 1); assert.equal(models.length, 1); assert.equal(question().value, '');
    assert.equal(settings.proseAssistant.selection.mode, 'custom'); assert.equal(models[0].custom_url, 'https://model.fixture.invalid/v1');
    assert.equal(settings.proseAssistant.referenceFloors, 3, 'offstage display zero must not overwrite the preferred in-chat range');
    assert.equal(models[0].stream, false); assert.equal(settings.proseAssistant.selection.connection.stream, false);
    assert.equal(models[0].custom_include_headers, 'Authorization: Bearer fixture-first-key'); assert.equal(models[0].model, 'first-model');
    assert.equal(uploads(), 2); assert.equal(transport.files.size, 2);
    const saved = new Map(transport.files), writes = uploads(), priorLegacyReads = legacy.reads;
    assert.doesNotMatch([...saved.values()].join(''), /fixture-first-key/);

    action('close').click(); await panel.finished; await new Promise(resolve => setImmediate(resolve));
    assert.equal(tools.assistantBusy, false); assert.equal(dom.observers.size, 0);
    panel = await tools.openAssistant(); assert.ok(panel); await panel.ready;
    assert.equal(rows().length, 1); assert.equal(rows()[0].querySelector('.qm-pa-reply').textContent, '首次完整回答');
    assert.equal(models.length, 1); assert.equal(uploads(), writes); assert.deepEqual(transport.files, saved);
    assert.equal(legacy.reads, priorLegacyReads); assert.equal(settingsSubmissions, 1);
    action('settings').click(); assert.equal(dom.get('助手API预设').value, 'custom'); assert.equal(dom.get('助手模型').value, 'first-model');
    assert.equal(dom.get('流式传输').checked, false);
    assert.deepEqual(notifications, []);
});
