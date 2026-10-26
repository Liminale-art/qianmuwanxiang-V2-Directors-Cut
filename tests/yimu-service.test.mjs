import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../yimu/client.mjs';
import {createController} from '../yimu/runtime.mjs';
import {VERSION, SCHEMA, createDocument, createDefaults} from '../yimu/contract.mjs';

const clone = value => structuredClone(value);
const binding = {avatar: 'Service.png', file: 'Synthetic service check', integrity: 'synthetic-service'};
const deferred = () => {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return {promise, resolve};
};
function fixture(t, {selected = false, mode = 'normal'} = {}) {
    const calls = [], events = [], states = [], tasks = [];
    let healthMode = mode, chosen = selected, firstHealth = null;
    const api = createApi({headers: () => ({}), fetcher: async (url, options) => {
        const route = url.split('/').at(-1); calls.push({route, method: options.method}); events.push(route);
        if (route === 'health') {
            if (firstHealth) { const next = firstHealth; firstHealth = null; return next.promise; }
            if (healthMode === 'network') throw new TypeError('synthetic unavailable network');
            const status = healthMode === 'missing' ? 404 : 200;
            return {status, ok: status === 200, json: async () => ({version: healthMode === 'mismatch' ? '0.2.0' : VERSION, schema: SCHEMA})};
        }
        if (route === 'defaults') {
            assert.equal(options.method, 'GET', 'homepage defaults must be read-only');
            return {status: 200, ok: true, json: async () => ({defaults: createDefaults()})};
        }
        assert.equal(route, 'read', 'installation checking must never mutate account or chat data');
        return {status: 200, ok: true, json: async () => ({document: createDocument(binding), defaults: createDefaults(), sourceAvailable: true, invalidSourceIds: []})};
    }});
    const host = {async snapshot() {
        events.push('snapshot');
        if (!chosen) throw new Error('请先打开一个角色的聊天');
        return {binding: clone(typeof chosen === 'object' ? chosen : binding), name: 'Service', messages: [], maxContext: 8192};
    }, profiles: () => [], clear() {}, async generate() { throw new Error('installation checks cannot call models'); }};
    const controller = createController({api, host, onChange: state => states.push(clone(state)), defer: fn => tasks.push(fn)});
    t.after(() => controller.destroy());
    return {controller, calls, events, states, tasks, mode(value) { healthMode = value; }, selected(value) { chosen = value; }, holdHealth(value) { firstHealth = value; }};
}

test('manual homepage refresh confirms backend version without reading or writing any chat', async t => {
    const f = fixture(t); await f.controller.refresh();
    assert.deepEqual(f.calls, [{route: 'health', method: 'GET'}, {route: 'defaults', method: 'GET'}]);
    assert.deepEqual(f.events, ['health', 'snapshot', 'defaults']);
    assert.deepEqual(f.controller.state.service, {status: 'ok', version: VERSION, requiredVersion: VERSION});
    assert.equal(f.controller.state.snapshot, null); assert.equal(f.controller.state.document, null);
    assert.equal(f.controller.state.loading, false); assert.equal(f.controller.state.sourceAvailable, false);
    assert.equal(f.tasks.length, 0);
});

test('homepage missing backend returns an actionable 404 state without requiring a real chat', async t => {
    const f = fixture(t, {mode: 'missing'}); await f.controller.action('refresh');
    assert.deepEqual(f.calls, [{route: 'health', method: 'GET'}]);
    assert.equal(f.controller.state.service.status, 'error'); assert.equal(f.controller.state.service.version, '');
    assert.match(f.controller.state.error, /尚未安装忆幕服务端/); assert.equal(f.tasks.length, 0);
});

test('homepage mismatched backend reports actual and required versions instead of a network failure', async t => {
    const f = fixture(t, {mode: 'mismatch'}); await f.controller.refresh();
    assert.deepEqual(f.calls, [{route: 'health', method: 'GET'}]);
    assert.deepEqual(f.controller.state.service, {status: 'mismatch', version: '0.2.0', requiredVersion: VERSION});
    assert.match(f.controller.state.error, /当前 0\.2\.0/); assert.ok(f.controller.state.error.includes(VERSION));
});

test('homepage network failure is not reported as an absent installation and does not poll', async t => {
    const f = fixture(t, {mode: 'network'}); await f.controller.refresh();
    assert.equal(f.controller.state.service.status, 'error'); assert.match(f.controller.state.error, /无法连接/);
    assert.doesNotMatch(f.controller.state.error, /尚未安装/); assert.equal(f.calls.length, 1); assert.equal(f.tasks.length, 0);
    f.mode('normal'); await f.controller.refresh(); assert.equal(f.controller.state.service.status, 'ok');
    assert.equal(f.calls.length, 3, 'explicit refresh checks health and reads defaults without writing a chat');
});

test('quiet homepage startup preserves the previous no-health/no-chat-read behavior', async t => {
    const f = fixture(t); await f.controller.refresh({quiet: true, auto: true});
    assert.deepEqual(f.calls, []); assert.equal(f.controller.state.service.status, 'unknown'); assert.equal(f.tasks.length, 0);
});

for (const quiet of [false, true]) test(`${quiet ? 'quiet' : 'manual'} selected-chat refresh checks health once and still loads its normal document`, async t => {
    const f = fixture(t, {selected: true}); await f.controller.refresh({quiet, auto: false});
    assert.deepEqual(f.calls.map(call => call.route), ['health', 'read']);
    assert.equal(f.controller.state.service.status, 'ok'); assert.equal(f.controller.state.service.version, VERSION);
    assert.deepEqual(f.controller.state.snapshot.binding, binding); assert.equal(f.controller.state.document.enabled, false);
    assert.equal(f.controller.state.sourceAvailable, true); assert.equal(f.tasks.length, 0);
});

test('a failed manual service recheck retains an already loaded document and marks it unavailable', async t => {
    const f = fixture(t, {selected: true}); await f.controller.refresh(); const before = clone(f.controller.state.document);
    f.mode('network'); await f.controller.refresh();
    assert.deepEqual(f.controller.state.document, before); assert.equal(f.controller.state.sourceAvailable, false);
    assert.equal(f.calls.filter(call => call.route === 'read').length, 1, 'health failure cannot start a second data read');
    await assert.rejects(() => f.controller.action('manual', {text: 'preserved draft'}), /服务尚不可用/);
    assert.ok(f.calls.every(call => ['health', 'read'].includes(call.route)));
});

test('a known service failure still permits immediate local stopping without a write or false saved state', async t => {
    const f = fixture(t, {selected: true}); await f.controller.refresh();
    f.controller.state.document.enabled = true;
    f.mode('network'); await f.controller.refresh(); const before = f.calls.length;
    await assert.rejects(() => f.controller.action('enable', {enabled: false}), /服务尚不可用/);
    assert.equal(f.states.at(-1).paused, true, 'local stop must not depend on a backend response');
    assert.equal(f.controller.state.document.enabled, true, 'the server document is not falsely marked saved');
    assert.equal(f.calls.length, before, 'an already failed service check does not start another network mutation');
});

for (const destination of ['homepage', 'other chat']) test(`a failed service check after switching to ${destination} cannot expose or write the previous chat`, async t => {
    const f = fixture(t, {selected: true}); await f.controller.refresh();
    const other = {...binding, file: 'Other synthetic service chat', integrity: 'other-service-identity'};
    f.selected(destination === 'homepage' ? false : other); f.mode('missing');
    const callsBefore = f.calls.length; await f.controller.refresh();
    assert.equal(f.controller.state.service.status, 'error'); assert.match(f.controller.state.error, /尚未安装/);
    assert.equal(f.controller.state.document, null); assert.equal(f.controller.state.defaults, null);
    assert.equal(f.controller.state.lastUsed, null); assert.equal(f.controller.state.sourceAvailable, false);
    if (destination === 'homepage') assert.equal(f.controller.state.snapshot, null);
    else assert.deepEqual(f.controller.state.snapshot.binding, other);
    assert.deepEqual(f.calls.slice(callsBefore), [{route: 'health', method: 'GET'}]);
    await assert.rejects(() => f.controller.action('manual', {text: 'must not write old chat'}), /请先打开单人聊天/);
    await assert.rejects(() => f.controller.action('settings', {values: {recent: 7}}), /请先打开单人聊天/);
    assert.deepEqual(f.calls.slice(callsBefore), [{route: 'health', method: 'GET'}]);
});

test('a late older health response cannot replace a newer failed check or start a data read', async t => {
    const f = fixture(t), first = deferred(); f.holdHealth(first);
    const old = f.controller.refresh(); f.mode('missing'); await f.controller.refresh();
    first.resolve({status: 200, ok: true, json: async () => ({version: VERSION, schema: SCHEMA})}); await old;
    assert.equal(f.controller.state.service.status, 'error'); assert.match(f.controller.state.error, /尚未安装/);
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.route === 'health'));
});
