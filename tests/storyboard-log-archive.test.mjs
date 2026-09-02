import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const store = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

assert.match(store, /DB_VERSION = 10/);
assert.match(store, /STORE_STORYBOARD_PIPELINE_LOGS = 'storyboard_pipeline_logs'/);
assert.match(store, /STORE_STORYBOARD_PIPELINE_LOGS\]: \{ label: '分镜详细日志', category: 'logs', recoverable: true \}/);
assert.match(store, /onupgradeneeded[\s\S]*createObjectStore\(STORE_STORYBOARD_PIPELINE_LOGS\)/, 'the existing database must upgrade additively');
assert.match(store, /export async function putStoryboardPipelineLogs[\s\S]*transaction\(STORE_STORYBOARD_PIPELINE_LOGS, 'readwrite'\)[\s\S]*transaction\.oncomplete/, 'pipeline batches must commit in one IndexedDB transaction');
assert.match(store, /putStoryboardPipelineLogs[\s\S]*transaction\.abort\(\)[\s\S]*throw error/, 'synchronous clone/write failures must abort the archive transaction');
assert.match(store, /export async function getStoryboardPipelineLogs[\s\S]*new Set[\s\S]*slice\(0, 200\)/, 'archive reads must be deduplicated and bounded');
assert.match(store, /export async function clearStoryboardPipelineLogs\(\)/);

assert.match(source, /function storyboardPipelineForLog[\s\S]*state\.pipelineLogs[\s\S]*storyboardPipelineArchiveCache/, 'details must dual-read inline legacy data before the archive cache');
assert.match(source, /function storyboardArchivePipelineLog[\s\S]*await blobStore\.putStoryboardPipelineLogs[\s\S]*state\.pipelineLogs =/, 'a terminal pipeline may shrink settings only after archive persistence succeeds');
assert.match(source, /分镜详细日志暂未归档，已保留原数据/, 'archive failure must explicitly preserve the inline source');
assert.match(source, /function storyboardHydratePipelineArchive[\s\S]*storyboardArchiveCompletedPipelines[\s\S]*getStoryboardPipelineLogs/, 'opening logs must migrate old inline details and hydrate archived details');
assert.match(source, /if \(state\.view === 'logs'\) void storyboardHydratePipelineArchive\(\{ rerender: true \}\)/, 'archive hydration must wait for the logs page');
const initSource = source.slice(source.indexOf('function init()'), source.indexOf('export async function onActivate'));
assert.doesNotMatch(initSource, /storyboardHydratePipelineArchive/, 'startup must not scan detailed storyboard logs');
assert.match(source, /async function storyboardExportPackage\(\)[\s\S]*await storyboardHydratePipelineArchive\(\)[\s\S]*pipelineLogs/, 'portable storyboard packages must still include archived pipeline details');
assert.match(source, /sd-storyboard-export-logs[\s\S]*await storyboardHydratePipelineArchive\(\)[\s\S]*storyboardLogText/, 'manual log export must hydrate complete details first');
assert.match(source, /sd-storyboard-clear-logs[\s\S]*clearStoryboardPipelineLogs\(\)[\s\S]*storyboardPipelineArchiveCache\.clear\(\)[\s\S]*state\.logs = \[\]/, 'clear logs must remove archived details before summaries');
assert.match(source, /sd-storyboard-clear-logs[\s\S]*\+\+storyboardPipelineArchiveEpoch[\s\S]*clearStoryboardPipelineLogs/, 'clearing logs must invalidate writes that were already in flight');
assert.match(source, /storyboardPipelineArchiveEpoch\+\+[\s\S]*storyboardPipelineArchiveCache\.clear/, 'extension cleanup must invalidate late archive callbacks');
assert.match(source, /页面刷新后未自动续跑[\s\S]*pipeline\.status = 'cancelled'/, 'refresh reconciliation must also finish a running pipeline');
assert.match(source, /visiblePipelineIds[\s\S]*storyboardPipelineIsTerminal/, 'orphaned pipeline details must not be archived again');

console.log('Storyboard pipeline log archive contract OK');
