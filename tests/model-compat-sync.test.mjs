import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FRONTEND } from '../scripts/build-yimu.mjs';

// 忆幕独立安装（third-party/yimu，平铺目录），不能 import 千幕根目录文件，
// 因此持有接口兼容层与回复解析器的逐字节副本。漏同步即失败。
const PAIRS = [['qianmu-model-compat.js', 'yimu/model-compat.mjs'], ['qianmu-model-response.js', 'yimu/model-response.mjs']];
const root = new URL('../', import.meta.url);

test('yimu copies of the shared model interface are byte-identical to the Qianmu originals', async () => {
  for (const [source, copy] of PAIRS) {
    const [a, b] = await Promise.all([readFile(new URL(source, root)), readFile(new URL(copy, root))]);
    assert.ok(a.equals(b), `${copy} 与 ${source} 不一致：改动正本后须同步复制到忆幕`);
  }
});

test('shared model interface files stay import-free and ship inside the standalone yimu package', async () => {
  for (const [source, copy] of PAIRS) {
    const text = await readFile(new URL(source, root), 'utf8');
    assert.doesNotMatch(text, /^\s*import\s|\bimport\s*\(/m, `${source} 必须保持零依赖，才能原样复制进忆幕`);
    assert.ok(FRONTEND.includes(copy.replace(/^yimu\//, '')), `${copy} 须列入 build-yimu FRONTEND`);
  }
});
