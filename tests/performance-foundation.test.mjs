import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const focusRuntime = await readFile(new URL('../qianmu-focus-runtime.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /const performanceRuntime = \{[\s\S]*modalRenderCount:[\s\S]*slowModalRenderCount:[\s\S]*rendersByTab:/, 'runtime measurements must stay in an in-memory envelope');
assert.match(source, /function renderModal\([\s\S]*renderStartedAt[\s\S]*modalRenderTotalMs \+= renderMs[\s\S]*lastNodeCount/, 'modal rendering must record time and node count');
assert.match(source, /function runtimeHealthSnapshot\([\s\S]*settingsBytes[\s\S]*chatBytes[\s\S]*observers[\s\S]*timers/, 'health snapshot must cover data size and active background work');
assert.match(source, /数据只保留在本次页面，不写入日志或用户设置/, 'diagnostics must explicitly remain session-only');
assert.match(focusRuntime, /if \(state.status !== 'running'\) return;[\s\S]*setInterval\(tick, 500\)/, 'the focus clock must not poll while idle or paused');
assert.match(source, /\['专注时钟', focusClockRuntime\?\.active\]/, 'health diagnostics must read the runtime owner rather than a duplicate timer');
assert.doesNotMatch(source, /^import[^\n]*qianmu-image-direct/m, 'image provider transports must stay outside the startup module graph');
assert.match(source, /createFeatureRuntime\(\{[\s\S]*imageDirect:[\s\S]*import\('\.\/qianmu-image-direct\.js\?v=1\.59\.181'\)[\s\S]*featureRuntime\.load\('imageDirect'\)/, 'the direct image runtime must enter the shared on-demand feature boundary');
assert.match(source, /optionalService:[\s\S]*import\('\.\/qianmu-service-capabilities\.js\?v=1\.59\.181'\)/, 'optional backend capability checks must stay outside the startup graph');
assert.doesNotMatch(source, /^import .*\.\/builtin-theaters\.js/m, 'large built-in theater catalogs must stay outside the startup graph');
assert.doesNotMatch(source, /^import .*\.\/qianmu-theaters\.js/m, 'large Qianmu theater catalogs must stay outside the startup graph');
assert.match(source, /theaterCatalog:[\s\S]*Promise\.all\([\s\S]*loadLocalChunk\('\.\/builtin-theaters\.js\?v=1\.59\.181'\)[\s\S]*loadLocalChunk\('\.\/qianmu-theaters\.js\?v=1\.59\.181'\)/, 'both managed theater catalogs must share one recoverable on-demand feature boundary');
assert.match(source, /function renderTheaterTab\(\)[\s\S]*ensureTheaterCatalog\(\)[\s\S]*sd-theater-catalog-retry/, 'the theater page must load its catalog on first entry and expose retry after a failed chunk');
const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
assert.doesNotMatch(initSource, /seedBuiltinTheaters\(\)/, 'startup must not parse or seed theater catalogs before the feature is opened');
assert.doesNotMatch(initSource, /hydrateNotesRuntime\(/, 'startup must not scan account notes before the notes workspace is opened');
assert.match(source, /function openNotesPanel\(\)[\s\S]*renderNotesPanelPortal\(\)[\s\S]*hydrateNotesRuntime\(true\)/, 'each independent notes opening must refresh its local account records before synchronization');
assert.match(source, /function runtimeHealthSnapshot\(\)[\s\S]*featureRuntime\.snapshot\(\)[\s\S]*lazyFeatures/, 'session diagnostics must expose feature chunk state without persisting it');
assert.match(source, /function inputMenuObservationRoot\(\)[\s\S]*return sendForm \|\| menu\?\.parentElement \|\| document\.body/, 'the input entry observer must prefer the narrow input-shell boundary');
assert.match(source, /inputMenuObserverTarget = target;[\s\S]*inputMenuObserver\.observe\(target, \{ childList: true, subtree: true \}\)/, 'the input entry observer must not remain hard-wired to the entire document body');
assert.match(source, /storyboardCheckConnection[\s\S]*await directImageRuntime\(\)[\s\S]*directImage\.checkDirectImageConnection/, 'connection tests must enter the lazy image boundary');
assert.match(source, /storyboardRunJob[\s\S]*await directImageRuntime\(\)[\s\S]*directImage\.generateDirectImage/, 'generation jobs must enter the lazy image boundary');
assert.doesNotMatch(source, /function renderRuntimeHealthCard|sd-runtime-health-refresh|<b>运行与性能<\/b>/, 'internal measurements must not retain the removed diagnostics card or its whole-modal refresh');
assert.match(styles, /\.sd-storage-service[\s\S]*flex-wrap: wrap/, 'compact backend status must fit narrow storage cards');

console.log('Performance foundation contract OK');
