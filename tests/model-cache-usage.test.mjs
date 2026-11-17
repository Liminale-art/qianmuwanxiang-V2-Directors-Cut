import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modelCacheUsage, modelCacheText, createModelResponseAccumulator } from '../qianmu-model-response.js';
import * as yimu from '../yimu/model-response.mjs';

test('cache usage is read from each protocol and absent fields are not reported as zero', () => {
  assert.deepEqual(modelCacheUsage({ prompt_tokens: 10000, prompt_tokens_details: { cached_tokens: 7300 } }), { input: 10000, cached: 7300, written: 0, ratio: 0.73 });
  // Claude 原生：input_tokens 不含缓存部分。
  assert.deepEqual(modelCacheUsage({ input_tokens: 200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 800 }), { input: 10000, cached: 9000, written: 800, ratio: 0.9 });
  assert.deepEqual(modelCacheUsage({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 500 }), { input: 500, cached: 0, written: 0, ratio: 0 });
  assert.deepEqual(modelCacheUsage({ promptTokenCount: 4000, cachedContentTokenCount: 1000 }), { input: 4000, cached: 1000, written: 0, ratio: 0.25 });
  assert.equal(modelCacheUsage({ prompt_tokens: 100, completion_tokens: 3 }), null, 'a channel that reports no cache field is unknown, not 0%');
  for (const value of [null, undefined, 'x', 3]) assert.equal(modelCacheUsage(value), null);
  assert.equal(modelCacheUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: -1 } }), null);
});

test('readout text is short, and empty when there is nothing to report', () => {
  assert.equal(modelCacheText({ prompt_tokens: 10000, prompt_tokens_details: { cached_tokens: 7300 } }), '缓存命中 73%（7.3k / 10k）');
  assert.equal(modelCacheText({ input_tokens: 200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 800 }), '缓存命中 90%（9.0k / 10k） · 新写入 800');
  assert.equal(modelCacheText({ cached_tokens: 120 }), '缓存命中 120 token');
  assert.equal(modelCacheText({ prompt_tokens: 100 }), '');
});

test('usage arriving in several stream events is merged, later parts do not erase earlier ones', () => {
  const stream = createModelResponseAccumulator();
  stream.consume({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } } });
  stream.consume({ type: 'content_block_delta', delta: { text: 'hi' } });
  stream.consume({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
  stream.consume({ type: 'message_stop' });
  const done = stream.finish();
  assert.deepEqual(done.usage, { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 4 });
  assert.equal(modelCacheText(done.usage), '缓存命中 90%（90 / 100）');
});

test('Yimu carries the same reader, and both surfaces show the readout', async () => {
  const usage = { prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 500 } };
  assert.equal(yimu.modelCacheText(usage), modelCacheText(usage));
  const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const [entry, settings, view] = await Promise.all([read('index.js'), read('yimu/api-settings.mjs'), read('yimu/api-view.mjs')]);
  assert.match(entry, /modelCacheText\(log\.completion\?\.usage\) \? infoTag\(modelCacheText\(log\.completion\.usage\)\)/);
  assert.match(settings, /lastCache = modelCacheText\(reply\.usage\);/);
  assert.match(view, /api\.lastCache\?\.\(\) \|\| ''/);
});
