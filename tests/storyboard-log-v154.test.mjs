import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STORYBOARD_PIPELINE_LOG_LIMIT, normalizeStoryboardState } from '../qianmu-storyboard.js';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('index.js', root), 'utf8');
const css = await readFile(new URL('style.css', root), 'utf8');

assert.equal(STORYBOARD_PIPELINE_LOG_LIMIT, 20);
assert.doesNotMatch(source, /sd-storyboard-log-search/, '分镜日志不应保留搜索框或搜索监听');
assert.doesNotMatch(source, /<p>\$\{htmlEscape\(log\.prompt/, '折叠日志不应直接展示发送提示词');
assert.match(source, /分镜日志<\/h3><small>\$\{state\.logs\.length\} \/ \$\{STORYBOARD_PIPELINE_LOG_LIMIT\}/, '日志标题必须显示可见数量与固定上限');
assert.match(source, /const visiblePipelineIds = new Set\(state\.logs\.map[\s\S]*state\.pipelineLogs = state\.pipelineLogs\.filter/, '新增日志后必须同步移除不可见的管线缓存');
assert.match(source, /sd-storyboard-pipeline-stages/, '日志仍需保留阶段定位');
assert.match(source, /sd-storyboard-copy-log/, '日志仍需保留脱敏诊断复制');
assert.match(css, /\.sd-storyboard-log-tools \{ grid-template-columns: minmax\(0, 1fr\)/, '移除搜索后筛选栏必须独占一行');

const logs = Array.from({ length: 25 }, (_, index) => ({
  id: `log-${index}`, pipelineId: `pipe-${index}`, source: 'novel', status: 'success', queuedAt: index + 1,
}));
const pipelineLogs = Array.from({ length: 25 }, (_, index) => ({
  id: `pipe-${index}`, taskId: `task-${index}`, providerId: 'novel', status: 'success', finishedAt: index + 1,
}));
const normalized = normalizeStoryboardState({ logs, pipelineLogs });
assert.equal(normalized.logs.length, 20);
assert.equal(normalized.pipelineLogs.length, 20);
const visibleIds = new Set(normalized.logs.map((log) => log.pipelineId));
assert.ok(normalized.pipelineLogs.every((log) => visibleIds.has(log.id)), '持久化日志和管线日志必须一一对应');

console.log('Storyboard log v1.54.0 contract OK');
