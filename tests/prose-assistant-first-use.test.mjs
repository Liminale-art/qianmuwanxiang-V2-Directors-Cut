import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createProseFloorTools} from '../qianmu-prose-floor-tools.js';
import {proseAssistantPanelDom} from './helpers/prose-assistant-panel-dom.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

// Only empty, readonly legacy lookups/cursors. The formal catalog and history
// factories and the native ST file read/write chain remain real.
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
                },openCursor(range){
                    assert.match(range.lower,/qianmu-prose-assistant-v2/);counter.scans=(counter.scans||0)+1;
                    const lookup={};setImmediate(()=>{lookup.result=null;lookup.onsuccess();setImmediate(()=>transaction.oncomplete?.());});return lookup;
                }}; }};
                return transaction;
            }};
            request.onsuccess();
        });
        return request;
    }};
}

test('formal lazy entry starts empty, saves catalog and native history, then warm reopens without any file reads or replay', async t => {
    const dom = proseAssistantPanelDom(), namespace = 'st-user:assistant-first-use-fixture';
    const transport = streamCheckpointTransport(namespace), legacy = {reads: 0}, models = [], notifications = [];
    const host = {chat: [], chatMetadata: {}, characters: [], eventSource: new EventEmitter()};
    const settings = {apiProfiles: []};
    let settingsSubmissions = 0, tools;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const originalKeyRange=Object.getOwnPropertyDescriptor(globalThis,'IDBKeyRange');
    t.after(() => {
        tools?.dispose();
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document;
        if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB); else delete globalThis.indexedDB;
        if(originalKeyRange)Object.defineProperty(globalThis,'IDBKeyRange',originalKeyRange);else delete globalThis.IDBKeyRange;
    });
    Object.defineProperty(globalThis, 'document', {configurable: true, value: dom.doc});
    Object.defineProperty(globalThis, 'indexedDB', {configurable: true, value: emptyLegacyDatabase(legacy)});
    Object.defineProperty(globalThis,'IDBKeyRange',{configurable:true,value:{bound:(lower,upper)=>({lower,upper})}});
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
    assert.equal(models.length, 0); assert.equal(settingsSubmissions, 0); assert.equal(legacy.reads, 1,dom.all().filter(node=>Object.hasOwn(node.dataset,'paHistory')||Object.hasOwn(node.dataset,'paStatus')).map(node=>node.textContent).join(';'));
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
    const postedFiles=transport.calls.filter(call=>call.options.method==='POST').map(call=>{
        const upload=JSON.parse(call.options.body);return {name:upload.name,body:JSON.parse(Buffer.from(upload.data,'base64').toString('utf8'))};
    });
    const catalogueWrites=postedFiles.filter(file=>file.body.schema==='qianmu.st-account-snapshot.v1');
    assert.equal(catalogueWrites.length,2,'one registration before sending and one metadata update after confirmed history');
    assert.ok(catalogueWrites.every(file=>file.body.slot==='assistant-conversations'));
    assert.equal(catalogueWrites[0].body.value.entries.length,1);assert.equal(catalogueWrites[1].body.value.entries.length,1);
    assert.equal(postedFiles.filter(file=>file.body.schema==='qianmu.st-account-document.v1').length,1,'the message body is uploaded once');
    assert.equal(postedFiles.filter(file=>file.body.schema==='qianmu.st-account-head.v1').length,1,'the message head is uploaded once');
    assert.equal(uploads(),4);assert.equal(transport.files.size,3);
    const saved = new Map(transport.files), writes = uploads(), priorLegacyReads = legacy.reads;
    assert.doesNotMatch([...saved.values()].join(''), /fixture-first-key/);

    const firstPanel=panel,firstRow=rows()[0],callsBeforeClose=transport.calls.length;
    let finished=false;void panel.finished.then(()=>{finished=true;});
    action('close').click();await dom.wait(()=>!panel.visible);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(tools.assistantBusy, false); assert.equal(dom.observers.size, 0);
    panel = await tools.openAssistant(); assert.ok(panel); await panel.ready;
    assert.equal(panel,firstPanel);assert.equal(rows()[0],firstRow);assert.equal(finished,false);
    assert.equal(transport.calls.length,callsBeforeClose,'normal close/reopen has no catalog or history file traffic');
    assert.equal(rows().length, 1); assert.equal(rows()[0].querySelector('.qm-pa-reply').textContent, '首次完整回答');
    assert.equal(models.length, 1); assert.equal(uploads(), writes); assert.deepEqual(transport.files, saved);
    assert.equal(legacy.reads, priorLegacyReads); assert.equal(settingsSubmissions, 1);
    action('settings').click(); assert.equal(dom.get('助手API预设').value, 'custom'); assert.equal(dom.get('助手模型').value, 'first-model');
    assert.equal(dom.get('流式传输').checked, false);
    panel.dispose();await panel.finished;await new Promise(resolve=>setImmediate(resolve));
    const beforeCold=transport.calls.length;panel=await tools.openAssistant();assert.ok(panel);await panel.ready;
    assert.notEqual(panel,firstPanel);assert.equal(rows().length,1);assert.equal(rows()[0].querySelector('.qm-pa-reply').textContent,'首次完整回答');
    const coldCalls=transport.calls.slice(beforeCold);assert.equal(coldCalls.length,3,'cold open reads the catalog plus only its selected history head/body');
    assert.ok(coldCalls.every(call=>call.options.method==='GET'));assert.equal(models.length,1);assert.equal(uploads(),writes);assert.equal(legacy.reads,priorLegacyReads);
    assert.deepEqual(notifications, []);
    const coldPanel=panel,callsBeforeCleanup=transport.calls.length;
    action('close').click();await dom.wait(()=>!coldPanel.visible);assert.equal(coldPanel.element.isConnected,true);
    const cleanup=await tools.cleanupAssistant(dom.parent,async()=>assert.fail('empty legacy cleanup needs no deletion confirmation'),()=>{},namespace,0,false);
    assert.equal(cleanup.status,'empty');await coldPanel.finished;assert.equal(coldPanel.element.isConnected,false);assert.equal(dom.observers.size,0);
    assert.equal(transport.calls.length,callsBeforeCleanup,'legacy cleanup must not read or delete native messages/catalog');assert.deepEqual(transport.files,saved);assert.equal(legacy.scans,1);
    assert.equal(tools.assistantBusy,false);assert.equal(models.length,1);
});
