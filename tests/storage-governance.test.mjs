import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { estimateStoredValueBytes } from '../qianmu-blobstore.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const storeSource = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

assert.equal(estimateStoredValueBytes('千幕'), 6, 'UTF-8 中文大小应按真实字节估算');
assert.equal(estimateStoredValueBytes(new Blob(['12345'])), 5, 'Blob 必须使用真实 size，不得 stringify');
assert.equal(estimateStoredValueBytes(new Uint8Array(9)), 9, 'TypedArray 必须使用真实 byteLength');
const cyclic = { label: 'ok' };
cyclic.self = cyclic;
assert.doesNotThrow(() => estimateStoredValueBytes(cyclic), '存储盘点不得被循环引用拖垮');

assert.match(storeSource, /STORE_AUDIO.*recoverable: true/s, '语音缓存应允许安全清理');
assert.match(storeSource, /STORE_TTS_LINES.*recoverable: true/s, '台词提取缓存应允许安全清理');
assert.match(storeSource, /STORE_RETLOG.*recoverable: true/s, '检索诊断日志应允许安全清理');
assert.match(storeSource, /STORE_FAVORITES.*recoverable: false/s, '语音收藏必须受保护');
assert.match(storeSource, /STORE_BOOKS.*recoverable: false/s, '伴读书籍必须受保护');
assert.match(storeSource, /export async function clearRecoverableStorage\(\)/, '安全清理接口不得接收任意 store 名');
assert.match(storeSource, /Object\.entries\(STORAGE_STORE_INFO\)[\s\S]*filter\(\(\[, info\]\) => info\.recoverable\)/, '清理范围必须来自内部白名单');

assert.match(source, /function renderStorageManagementCard\(\)/, '任务页必须具备容量卡');
assert.match(source, /浏览器 \/ ST 来源[\s\S]*千幕已盘点[\s\S]*可安全清理/, '来源总量、千幕归因量和安全清理量必须分开展示');
assert.match(source, /ST 总空间包含同一站点及其他扩展/, '不得把整个来源用量误称为千幕占用');
assert.match(source, /if \(!p\) return `\$\{storageCard\}\$\{renderNoPlan/, '未生成审片任务时容量管理仍应可见');
assert.match(source, /blobStore\.clearRecoverableStorage\(\)[\s\S]*storyboard\.logs = \[\][\s\S]*storyboard\.pipelineLogs = \[\]/, '安全清理应清理诊断日志且不触碰成片');

console.log('Storage governance contract OK');
