import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /const performanceRuntime = \{[\s\S]*modalRenderCount:[\s\S]*slowModalRenderCount:[\s\S]*rendersByTab:/, 'runtime measurements must stay in an in-memory envelope');
assert.match(source, /function renderModal\([\s\S]*renderStartedAt[\s\S]*modalRenderTotalMs \+= renderMs[\s\S]*lastNodeCount/, 'modal rendering must record time and node count');
assert.match(source, /function runtimeHealthSnapshot\([\s\S]*settingsBytes[\s\S]*chatBytes[\s\S]*observers[\s\S]*timers/, 'health snapshot must cover data size and active background work');
assert.match(source, /数据只保留在本次页面，不写入日志或用户设置/, 'diagnostics must explicitly remain session-only');
assert.match(source, /if \(f\.status !== 'running'\) return;[\s\S]*setInterval\(focusClockRuntimeTick, 500\)/, 'the focus clock must not poll while idle or paused');
assert.doesNotMatch(source, /^import[^\n]*qianmu-image-direct/m, 'image provider transports must stay outside the startup module graph');
assert.match(source, /createFeatureRuntime\(\{[\s\S]*imageDirect:[\s\S]*import\('\.\/qianmu-image-direct\.js\?v=1\.58\.28'\)[\s\S]*featureRuntime\.load\('imageDirect'\)/, 'the direct image runtime must enter the shared on-demand feature boundary');
assert.match(source, /optionalService:[\s\S]*import\('\.\/qianmu-service-capabilities\.js\?v=1\.58\.28'\)/, 'optional backend capability checks must stay outside the startup graph');
assert.match(source, /function runtimeHealthSnapshot\(\)[\s\S]*featureRuntime\.snapshot\(\)[\s\S]*lazyFeatures/, 'session diagnostics must expose feature chunk state without persisting it');
assert.match(source, /function inputMenuObservationRoot\(\)[\s\S]*return sendForm \|\| menu\?\.parentElement \|\| document\.body/, 'the input entry observer must prefer the narrow input-shell boundary');
assert.match(source, /inputMenuObserverTarget = target;[\s\S]*inputMenuObserver\.observe\(target, \{ childList: true, subtree: true \}\)/, 'the input entry observer must not remain hard-wired to the entire document body');
assert.match(source, /storyboardCheckConnection[\s\S]*await directImageRuntime\(\)[\s\S]*directImage\.checkDirectImageConnection/, 'connection tests must enter the lazy image boundary');
assert.match(source, /storyboardRunJob[\s\S]*await directImageRuntime\(\)[\s\S]*directImage\.generateDirectImage/, 'generation jobs must enter the lazy image boundary');
assert.match(styles, /\.sd-runtime-health-grid[\s\S]*grid-template-columns: repeat\(2/, 'desktop diagnostics need a compact two-column layout');
assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.sd-runtime-health-grid \{ grid-template-columns: minmax\(0, 1fr\)/, 'mobile diagnostics must collapse to one column');

console.log('Performance foundation contract OK');
