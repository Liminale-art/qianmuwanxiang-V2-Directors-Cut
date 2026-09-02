import assert from 'node:assert/strict';

import {
  filterOpenAIProviderOptions,
  normalizeOpenAICompatibleHeaders,
  normalizeOpenAIImageCompatibility,
  parseOpenAICompatibleHeaders,
} from '../qianmu-openai-image-compat.js';
import { checkDirectImageConnection, generateDirectImage } from '../qianmu-image-direct.js';
import { checkImageConnection, generateImage } from '../qianmu-image-gateway.js';
import { STORYBOARD_SCHEMA_VERSION, normalizeStoryboardConnectionProfile } from '../qianmu-storyboard.js';

const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const imageBase64 = Buffer.from(imageBytes).toString('base64');

assert.equal(STORYBOARD_SCHEMA_VERSION, 21);

const compatibility = normalizeOpenAIImageCompatibility({
  modelDiscovery: 'off',
  endpoints: { models: '/catalog/models', generation: '/paint/create', edit: '/paint/edit' },
  referenceField: 'image',
  responseKinds: ['base64', 'url'],
  allowedParameters: ['size'],
  providerOptionKeys: ['input_fidelity', 'vendor_mode', 'api_key'],
  customHeaderNames: ['X-Workspace', 'Authorization', 'X-Api-Key', 'X-Custom-Token'],
});

assert.equal(compatibility.endpoints.generation, 'paint/create');
assert.equal(compatibility.referenceField, 'image');
assert.deepEqual(compatibility.allowedParameters, ['size']);
assert.deepEqual(compatibility.providerOptionKeys, ['input_fidelity', 'vendor_mode']);
assert.deepEqual(compatibility.customHeaderNames, ['X-Workspace']);

const parsedHeaders = parseOpenAICompatibleHeaders('X-Workspace: qianmu\nAuthorization: stolen\nX-Api-Key: stolen\nBad Header: no');
assert.deepEqual(parsedHeaders.names, ['X-Workspace']);
assert.deepEqual(parsedHeaders.headers, { 'X-Workspace': 'qianmu' });
assert.deepEqual(normalizeOpenAICompatibleHeaders({ 'X-Workspace': 'director', 'X-Other': 'drop' }, compatibility), { 'X-Workspace': 'director' });
assert.deepEqual(filterOpenAIProviderOptions({ input_fidelity: 'high', vendor_mode: 2, moderation: 'low' }, compatibility), { input_fidelity: 'high', vendor_mode: 2 });

const storedConnection = normalizeStoryboardConnectionProfile({
  id: 'relay', baseUrl: 'https://relay.example/v1', model: 'custom-image', compatibility,
  headers: { 'X-Workspace': 'director', Authorization: 'stolen' }, credentialId: 'credential-ref',
}, 'openai');
assert.equal(storedConnection.customModel, true);
assert.equal(storedConnection.credentialId, 'credential-ref');
assert.deepEqual(storedConnection.headers, { 'X-Workspace': 'director' });
assert.equal(storedConnection.compatibility.endpoints.edit, 'paint/edit');

let fetchCount = 0;
const noDiscovery = await checkDirectImageConnection({
  provider: 'openai', apiKey: 'key', baseUrl: 'https://relay.example/v1', model: 'custom-image', compatibility,
}, { fetchImpl: async () => { fetchCount++; throw new Error('must not fetch'); } });
assert.equal(fetchCount, 0);
assert.equal(noDiscovery.verified, false);

let captured = null;
await generateDirectImage({
  provider: 'openai', apiKey: 'key', baseUrl: 'https://relay.example/v1', model: 'custom-image',
  prompt: 'portrait', compatibility, customHeaders: { 'X-Workspace': 'director', Authorization: 'stolen' },
  parameters: { count: 4, size: '1024x1024', quality: 'high', providerOptions: { vendor_mode: 2, moderation: 'low' } },
}, {
  fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ images: [{ base64: imageBase64 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(captured.url, 'https://relay.example/v1/paint/create');
assert.equal(captured.init.headers['X-Workspace'], 'director');
assert.equal(captured.init.headers.Authorization, 'Bearer key');
assert.deepEqual(JSON.parse(captured.init.body), { vendor_mode: 2, model: 'custom-image', prompt: 'portrait', size: '1024x1024' });

await generateImage({
  provider: 'openai', apiKey: 'key', baseUrl: 'https://relay.example/v1', model: 'custom-image', prompt: 'edit',
  compatibility, customHeaders: { 'X-Workspace': 'director' },
  referenceImages: [
    { mime: 'image/png', data: imageBase64, name: 'first.png' },
    { mime: 'image/png', data: imageBase64, name: 'second.png' },
  ],
  parameters: { size: '1024x1024', count: 3, quality: 'high' },
}, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    assert.equal(init.headers['X-Workspace'], 'director');
    assert.equal(init.body.getAll('image').length, 1, '单图兼容档不得误发 image[] 或多张参考图');
    assert.equal(init.body.get('image[]'), null);
    assert.equal(init.body.get('n'), null);
    assert.equal(init.body.get('quality'), null);
    return new Response(JSON.stringify({ data: [{ base64: imageBase64 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(captured.url, 'https://relay.example/v1/paint/edit');

const optional404 = await checkImageConnection({
  provider: 'openai', apiKey: 'key', baseUrl: 'https://relay.example/v1', model: 'custom-image',
  compatibility: { ...compatibility, modelDiscovery: 'optional' },
}, {
  resolveHost: publicDns,
  fetchImpl: async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } }),
});
assert.equal(optional404.ok, true);
assert.equal(optional404.verified, false);

await assert.rejects(() => checkImageConnection({
  provider: 'openai', apiKey: 'key', baseUrl: 'https://relay.example/v1', model: 'custom-image',
  compatibility: { ...compatibility, modelDiscovery: 'required' },
}, {
  resolveHost: publicDns,
  fetchImpl: async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } }),
}), (error) => error?.upstreamStatus === 404);

console.log('OpenAI-compatible image capability profile contract OK');
