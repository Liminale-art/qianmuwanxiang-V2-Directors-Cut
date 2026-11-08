import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { sanitizeImageRequest } from '../qianmu-image-gateway.js';
import { projectStoryboardProtocolParameters } from '../qianmu-storyboard.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const apiKey = 'private-key-must-not-be-in-snapshot-123456';

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
  const sanitized = sanitizeImageRequest(JSON.parse(JSON.stringify(request)));
  for (const key of ['steps', 'scale', 'seed', 'guidanceScale']) assert.equal(sanitized.parameters[key], undefined);
  assert.equal(sanitized.parameters.width, 1024); assert.equal(sanitized.prompt, 'kitchen');
  const explicit = projectStoryboardProtocolParameters('novel', { seed: '0', scale: 0, count: 1 });
  assert.equal(explicit.seed, '0'); assert.equal(explicit.scale, 0);
  const nested = { providerOptions: { v4_negative_prompt: { caption: { base_caption: '' } } } };
  assert.equal(projectStoryboardProtocolParameters('novel', nested).providerOptions.v4_negative_prompt.caption.base_caption, '');
  const comfy = { seed: '', steps: '', workflow: {} };
  assert.equal(projectStoryboardProtocolParameters('comfy', comfy), comfy);
  const otherNative = { seed: '', count: 1, providerOptions: { caption: '' } };
  assert.equal(projectStoryboardProtocolParameters('banana', otherNative), otherNative);
});
