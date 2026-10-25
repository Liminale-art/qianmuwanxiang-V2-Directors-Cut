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
