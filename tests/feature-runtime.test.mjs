import assert from 'node:assert/strict';
import { createFeatureRuntime } from '../qianmu-feature-runtime.js';

let calls = 0;
const runtime = createFeatureRuntime({
  gallery: {
    label: '图库',
    load: async () => {
      calls += 1;
      return { id: 'gallery-runtime' };
    },
  },
});

assert.deepEqual(runtime.snapshot(), [{
  key: 'gallery',
  label: '图库',
  status: 'idle',
  attempts: 0,
  loadedAt: 0,
  error: null,
}]);

const [first, concurrent] = await Promise.all([
  runtime.load('gallery'),
  runtime.load('gallery'),
]);
assert.equal(first, concurrent, '并发进入同一功能时必须复用同一个加载结果');
assert.equal(calls, 1, '同一功能只允许执行一次并发加载');
assert.equal(runtime.snapshot()[0].status, 'ready');
assert.equal((await runtime.load('gallery')).id, 'gallery-runtime');
assert.equal(calls, 1, '已加载功能必须复用浏览器会话缓存');

let retryCalls = 0;
const retryRuntime = createFeatureRuntime({
  image: async () => {
    retryCalls += 1;
    if (retryCalls === 1) throw new Error('temporary chunk failure');
    return 'ready';
  },
});
await assert.rejects(retryRuntime.load('image'), /temporary chunk failure/);
assert.equal(retryRuntime.snapshot()[0].status, 'error');
assert.equal(retryRuntime.snapshot()[0].error.message, 'temporary chunk failure');
assert.equal(await retryRuntime.load('image'), 'ready', '失败后的下一次用户操作必须能够重试');
assert.equal(retryRuntime.snapshot()[0].attempts, 2);

assert.throws(() => runtime.load('missing'), /Unknown feature/);

console.log('Feature runtime contract OK');
