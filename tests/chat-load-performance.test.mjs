import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const blob = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

const observer = source.slice(source.indexOf('function ttsStartChat'), source.indexOf('function ttsStopChat'));
assert.match(observer, /MutationObserver\(\(records\) => ttsQueueMutationRecords\(records\)\)/, '聊天观察器必须把新增节点交给增量队列');
assert.doesNotMatch(observer, /MutationObserver\(\(\) => ttsScanDebounced/, '聊天新增楼层不得触发全聊天回扫');
assert.match(source, /ttsMessageEditedHandler = \(messageRef\)[\s\S]*ttsScheduleEditedMessage\(messageRef/, '正文编辑必须只重查对应楼层');
const refresh = source.slice(source.indexOf('const refreshHandler = async'), source.indexOf('const rerenderHandler = async'));
assert.match(refresh, /if \(metadataChanged\) await saveMetadata\(\)/, '新消息未改变推演状态时不得重写整份聊天 metadata');

const queue = source.slice(source.indexOf('function ttsScheduleInitialScan'), source.indexOf('// 委托点击'));
assert.match(queue, /requestIdleCallback[\s\S]*cursor < 8/, '长聊天历史恢复必须先处理最新楼层并在空闲片继续');
assert.match(queue, /record\.addedNodes[\s\S]*ttsPendingMessageRoots/, 'MutationObserver 必须仅收集本轮新增消息');

assert.match(source, /TTS_LOCAL_LINE_LIMIT = 100[\s\S]*TTS_PORTABLE_LINE_LIMIT = 12/, '完整本机缓存与聊天轻量快照必须分层限额');
assert.ok(source.includes('blobStore.getTtsLineCache') && source.includes('blobStore.putTtsLineCache'), '台词列表必须按聊天分桶存入 IndexedDB');
assert.match(blob, /DB_VERSION = 8[\s\S]*STORE_TTS_LINES = 'tts_lines'[\s\S]*STORE_NOTES = 'notes'/, 'IndexedDB 必须包含台词缓存与固定便笺仓');

assert.match(source, /worldSyncMode: 'none'/, '新用户必须默认使用千幕档案主存储且不占用世界书');
assert.match(source, /if \(m\.worldSyncMode === 'none'\) return ''/, '关闭世界书同步时不得创建镜像目标');
assert.match(source, /coreadSetWorldSyncMode[\s\S]*coreadRemoveSliceMirrors/, '切换世界书镜像目标时必须处理旧镜像，避免过期副本继续注入');

console.log('Chat load performance contract OK');
