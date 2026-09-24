import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { sanitizeImageRequest } from '../qianmu-image-gateway.js';
import { describeImageServiceRequest } from '../qianmu-image-service-queue.js';
import { inspectStoryboardNovelShotInput, sealStoryboardNovelShotInput } from '../qianmu-storyboard-server-shot-input-contract.js';
import { projectStoryboardProtocolParameters } from '../qianmu-storyboard.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const account = `st-user:${'a'.repeat(64)}`;
const apiKey = 'private-key-must-not-be-in-snapshot-123456';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const attemptId = 'shotjob-abc-1-12345678';
const input = (request = {}) => ({ expectedAccount: account, batchId: randomUUID(), attemptId, request: {
  provider: 'novel', modelFamily: 'novel', protocol: 'novelai', apiKey,
  baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-4-5-full', capabilityModelId: 'nai-diffusion-4-5-full',
  allowPrivateNetwork: false, prompt: 'two people cooking in a warm kitchen', negativePrompt: 'blurry',
  referenceImages: [], vibes: [], parameters: { width: 1024, height: 1024, count: 1, providerOptions: {} }, ...request,
} });
const code = (name) => (error) => error?.code === `storyboard_shot_input_${name}` && error.submissionState === 'not_submitted';

test('NAI-only input snapshot excludes Key and round-trips the real service digest without execution', () => {
  const source = input();
  const { snapshot, assets } = sealStoryboardNovelShotInput(source);
  assert.equal(snapshot.state, 'data_only_unrunnable');
  assert.equal(snapshot.expectedAccount, account);
  assert.equal(assets.length, 0);
  assert.equal(JSON.stringify(snapshot).includes(apiKey), false);
  assert.equal(Object.hasOwn(snapshot.payload, 'apiKey'), false);
  assert.equal(snapshot.requestDigest, describeImageServiceRequest(sanitizeImageRequest(source.request)).requestDigest);
  assert.deepEqual(inspectStoryboardNovelShotInput(snapshot, assets), (({ apiKey: ignored, ...safe }) => safe)(sanitizeImageRequest(source.request)));
});

test('reference bytes are split from private payload and tampering fails readback', () => {
  const source = input({ referenceImages: [{ data: png, mime: 'image/png', name: 'portrait.png', referenceType: 'character' }] });
  const { snapshot, assets } = sealStoryboardNovelShotInput(source);
  assert.equal(assets.length, 1);
  assert.equal(snapshot.payload.references[0].data, undefined);
  assert.equal(JSON.stringify(snapshot).includes(png), false);
  assert.equal(inspectStoryboardNovelShotInput(snapshot, assets).references[0].data, png);
  const changed = { ...assets[0], data: Buffer.from(assets[0].data) };
  changed.data[0] ^= 1;
  assert.throws(() => inspectStoryboardNovelShotInput(snapshot, [changed]), code('asset'));
  assert.throws(() => inspectStoryboardNovelShotInput({ ...snapshot, payloadDigest: '0'.repeat(64) }, assets), code('record'));
  assert.throws(() => inspectStoryboardNovelShotInput({ ...snapshot, assets: [{ ...snapshot.assets[0], bytes: 1 }] }, assets), code('asset'));
  assert.throws(() => inspectStoryboardNovelShotInput({ ...snapshot, channelKey: 'invalid' }, assets), code('record'));
});

test('equivalent raw Base64 and valid data URI retain the same service request identity', () => {
  const raw = sealStoryboardNovelShotInput(input({ referenceImages: [{ data: png, mime: 'image/png' }] }));
  const uri = sealStoryboardNovelShotInput(input({ referenceImages: [{ data: `data:image/png;base64,${png}`, mime: 'image/png' }] }));
  assert.equal(uri.snapshot.requestDigest, raw.snapshot.requestDigest);
  assert.equal(uri.assets[0].sha256, raw.assets[0].sha256);
  assert.equal(inspectStoryboardNovelShotInput(uri.snapshot, uri.assets).references[0].data, png);
});

test('NAI encoded Vibe is a separate binary asset with exact request identity', () => {
  const source = input({ novelVibeVersion: 1, vibes: [{ kind: 'novelai-vibe-encoding', data: Buffer.from('encoded-vibe').toString('base64'),
    encodingModel: 'v4-5full', variant: 'source_variant-1', strength: 0.6, information: null }] });
  const { snapshot, assets } = sealStoryboardNovelShotInput(source);
  assert.equal(snapshot.assets[0].kind, 'vibe');
  assert.equal(snapshot.payload.vibes[0].data, undefined);
  assert.equal(snapshot.payload.vibes[0].variant, undefined);
  assert.equal(inspectStoryboardNovelShotInput(snapshot, assets).vibes[0].data, source.request.vibes[0].data);
  assert.equal(snapshot.requestDigest, describeImageServiceRequest(sanitizeImageRequest(source.request)).requestDigest);
});

test('NAI V3 original-image Vibe preserves its bytes and checks declared length', () => {
  const source = input({ model: 'nai-diffusion-3', capabilityModelId: 'nai-diffusion-3',
    vibes: [{ kind: 'image', data: png, mime: 'image/png', strength: 0.6,
      information: 0.8, byteLength: Buffer.from(png, 'base64').length }] });
  const { snapshot, assets } = sealStoryboardNovelShotInput(source);
  assert.equal(snapshot.assets[0].kind, 'vibe');
  assert.equal(inspectStoryboardNovelShotInput(snapshot, assets).vibes[0].data, png);
  assert.throws(() => sealStoryboardNovelShotInput(input({ ...source.request,
    vibes: [{ ...source.request.vibes[0], byteLength: 1 }] })), code('lossy'));
});

test('sixteen complete references stay sixteen distinct shot inputs', () => {
  const source = input({ referenceImages: Array.from({ length: 16 }, (_, index) => ({
    data: png, mime: 'image/png', name: `reference-${index + 1}.png`,
  })) });
  const { snapshot, assets } = sealStoryboardNovelShotInput(source);
  assert.equal(assets.length, 16);
  assert.equal(snapshot.payload.references.length, 16);
  assert.equal(inspectStoryboardNovelShotInput(snapshot, assets).references.length, 16);
});

test('readback refuses oversized private payload or aggregate assets before digest work', () => {
  const { snapshot } = sealStoryboardNovelShotInput(input());
  assert.throws(() => inspectStoryboardNovelShotInput({ ...snapshot,
    payload: { ...snapshot.payload, prompt: 'x'.repeat(257 * 1024) } }, []), code('record'));
  const bytes = Buffer.alloc(16 * 1024 * 1024);
  const assets = Array.from({ length: 4 }, (_, index) => ({ kind: 'reference', index, data: bytes }));
  const references = assets.map(({ kind, index }) => ({ asset: { kind, index, sha256: '0'.repeat(64), bytes: bytes.length } }));
  const payload = { ...snapshot.payload, references };
  const payloadDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  assert.throws(() => inspectStoryboardNovelShotInput({ ...snapshot, payload, payloadDigest,
    assets: references.map(row => row.asset) }, assets), code('asset'));
});

test('front-end numeric text matches the actual NAI request without accepting a clamp', () => {
  const source = input({ parameters: { width: '1024', height: '1024', steps: '28', scale: '7.5',
    seed: '-1', count: 1, sampler: 'k_euler', providerOptions: { cfg_rescale: 0.1 } } });
  const { snapshot, assets } = sealStoryboardNovelShotInput(source);
  assert.equal(snapshot.payload.parameters.width, 1024);
  assert.equal(snapshot.payload.parameters.scale, 7.5);
  assert.equal(inspectStoryboardNovelShotInput(snapshot, assets).parameters.steps, 28);
  assert.throws(() => sealStoryboardNovelShotInput(input({ parameters: { width: '32', count: 1 } })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ parameters: { steps: '', count: 1 } })), code('lossy'));
});

test('current NAI form projection omits unset values before the real gateway request and keeps explicit zero', () => {
  const parameters = projectStoryboardProtocolParameters('novel', {
    width: '1024', height: '1024', steps: '', scale: '', seed: '', guidanceScale: '',
    count: 1, watermark: false, providerOptions: {},
  });
  assert.equal(Object.hasOwn(parameters, 'steps'), false);
  assert.equal(Object.hasOwn(parameters, 'scale'), false);
  assert.equal(Object.hasOwn(parameters, 'seed'), false);
  assert.equal(Object.hasOwn(parameters, 'guidanceScale'), false);
  const context = vm.createContext({
    clone: structuredClone,
    resolveStoryboardJobModelIdentity: () => ({ modelFamily: 'novel', protocol: 'novelai',
      remoteModelId: 'nai-diffusion-4-5-full', capabilityModelId: 'nai-diffusion-4-5-full' }),
    resolveStoryboardConnectionBinding: () => ({ modelFamily: 'novel', protocol: 'novelai' }),
  });
  vm.runInContext(storyboardFunctionSource('storyboardGatewayRequest'), context);
  const request = context.storyboardGatewayRequest({ source: 'novel', connection: { baseUrl: 'https://image.novelai.net' },
    payload: { prompt: 'kitchen', negative: '', parameters } }, apiKey, { references: [], vibes: [] });
  assert.equal(sealStoryboardNovelShotInput({ ...input(), request: JSON.parse(JSON.stringify(request)) }).snapshot.state, 'data_only_unrunnable');
  const explicit = projectStoryboardProtocolParameters('novel', { seed: '0', scale: 0, count: 1 });
  assert.equal(explicit.seed, '0'); assert.equal(explicit.scale, 0);
  const nested = { providerOptions: { v4_negative_prompt: { caption: { base_caption: '' } } } };
  assert.equal(projectStoryboardProtocolParameters('novel', nested).providerOptions.v4_negative_prompt.caption.base_caption, '');
  const comfy = { seed: '', steps: '', workflow: {} };
  assert.equal(projectStoryboardProtocolParameters('comfy', comfy), comfy);
  const otherNative = { seed: '', count: 1, providerOptions: { caption: '' } };
  assert.equal(projectStoryboardProtocolParameters('banana', otherNative), otherNative);
});

test('input snapshot rejects silent truncation, unsupported routes, and lossy options', () => {
  assert.throws(() => sealStoryboardNovelShotInput(input({ prompt: 'a'.repeat(32001) })), code('size'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ referenceImages: Array.from({ length: 17 }, () => ({ data: png })) })), code('size'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ parameters: { count: 2 } })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ negativePrompt: 'blurry ' })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ parameters: { width: 9000, count: 1 } })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ referenceImages: [{ data: png, strength: 3 }] })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ referenceImages: [{ data: png, name: 'n'.repeat(161) }] })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ referenceImages: [{ data: png, base64: png }] })), code('size'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ referenceImages: [{ data: png, mime: 'image/jpeg' }] })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ referenceImages: [{ data: `data:image/jpeg;base64,${png}`, mime: 'image/png' }] })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ referenceImages: [{ data: png, hidden: 'discarded' }] })), code('shape'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ vibes: [{ kind: 'image', data: png, hidden: 'discarded' }] })), code('shape'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ parameters: { count: 1, scale: 7, cfg: 7 } })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ baseUrl: 'https://user:pass@example.com/path?token=1' })), code('endpoint'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ referenceImages: [{ data: 'not-base64' }] })), code('request'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ parameters: { providerOptions: { apiKey: 'forbidden' } } })), code('lossy'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ parameters: { providerOptions: { nested: { unset: undefined } } } })), code('shape'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ parameters: { providerOptions: { score: NaN } } })), code('shape'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ novelVibeVersion: 1 })), code('lossy'));
  const dynamic = [1];
  Object.defineProperty(dynamic, '0', { get: () => 1 });
  assert.throws(() => sealStoryboardNovelShotInput(input({ parameters: { providerOptions: { dynamic } } })), code('shape'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ provider: 'comfy' })), code('provider'));
  assert.throws(() => sealStoryboardNovelShotInput(input({ prompt: apiKey })), code('secret'));
  assert.throws(() => sealStoryboardNovelShotInput({ ...input(), expectedAccount: 'st-user:other' }), /账户|编号/);
});
