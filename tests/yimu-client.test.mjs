import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../yimu/client.mjs';

test('story client keeps fixed operation identity and scopes every request to its explicit binding', async () => {
    const calls = [], binding = { avatar: 'Actor.png', file: 'Source', integrity: 'stable-id' };
    const api = createApi({ headers: () => ({ 'X-CSRF-Token': 'fixture' }), fetcher: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body), options }); return { ok: true, json: async () => ({ status: 'fixture' }) };
    } });
    const operation = { id: 'fixed-id', planId: 'plan', mode: 'branch', cutoff: 10, manualChoices: [], boundarySummaries: [] };
    await api.planStory(binding, { mode: 'branch', cutoff: 10 });
    await api.createStory(binding, operation);
    await api.storyResult(binding, { id: operation.id });
    assert.deepEqual(calls.map(call => [call.url, call.body]), [
        ['/api/plugins/yimu/story/plan', { binding, request: { mode: 'branch', cutoff: 10 } }],
        ['/api/plugins/yimu/story/create', { binding, request: operation }],
        ['/api/plugins/yimu/story/result', { binding, request: { id: 'fixed-id' } }],
    ]);
    assert.ok(calls.every(call => call.options.method === 'POST' && call.options.headers['X-CSRF-Token'] === 'fixture'));
});

test('backup transport sends the original File body, keeps operation identity and returns binary downloads without JSON conversion', async () => {
    const calls = [], body = new Blob(['gzip fixture']), binding = { avatar: 'a.png', file: 'one', integrity: 'one' };
    const api = createApi({ headers: () => ({ 'X-CSRF-Token': 'fixture', 'Content-Type': 'application/json' }), fetcher: async (url, options) => {
        calls.push({ url, options }); return { ok: true, json: async () => ({ archive: { id: 'saved' } }), blob: async () => body };
    } });
    await api.backupUpload(body, 'fixed-upload');
    assert.equal(calls[0].options.body, body); assert.equal(calls[0].options.headers['Content-Type'], 'application/octet-stream');
    assert.equal(calls[0].options.headers['x-yimu-operation-id'], 'fixed-upload'); assert.equal(calls[0].options.headers['X-CSRF-Token'], 'fixture');
    const result = await api.backupExport(binding, { planId: 'plan', sourceIds: [] }); assert.equal(result.blob, body);
    assert.deepEqual(JSON.parse(calls[1].options.body), { binding, request: { planId: 'plan', sourceIds: [] } });
    await api.backupUploadResult('fixed-upload'); await api.backupList(); await api.backupRead('saved');
    await api.backupRestore('saved', { id: 'restore', targetAvatar: 'a.png', sourceIds: ['source_0'] }); await api.backupResult('saved');
    assert.deepEqual(calls.map(call => call.url), ['upload', 'export', 'upload-result', 'list', 'read', 'restore', 'result'].map(name => `/api/plugins/yimu/backup/${name}`));
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { archiveId: 'saved', request: {} });
});
