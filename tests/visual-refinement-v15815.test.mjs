import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const dashboard = source.slice(source.indexOf('function renderDashboardTab'), source.indexOf('function renderChainReactionsCard'));
assert.doesNotMatch(dashboard, /metricBar|本幕进度|sd-progress-metric/, '审片不应继续显示百分比进度');
assert.match(dashboard, /sd-status-card[\s\S]*data-jump="tasksnodes"[\s\S]*data-jump="castworld"/, '任务与世界跳转必须保留为同排标签');
assert.doesNotMatch(dashboard, /countGroupTag|p\.quests\?|p\.chain_reactions\?|p\.npc_updates\?|p\.relation_undercurrents\?|p\.world_updates\?/, '跳转标签不再附带版块计数');
assert.match(dashboard, /sd-scene-current[\s\S]*当前幕：[\s\S]*sd-voices-list/, '当前幕须改为信息行，众声须使用独立列表');
assert.match(source, /director_comment（众声）固定返回 3 条/);

assert.match(styles, /--qm-type-card-title:\s*14px/);
assert.match(styles, /sd-storyboard-shortcut[\s\S]*scale\(\.99281\)/);
assert.match(styles, /sd-coread-shortcut[\s\S]*scale\(\.97279\)/);
assert.match(styles, /sd-theme-btn[\s\S]*scale\(\.98348\)/);
assert.match(styles, /sd-plug-shortcut[\s\S]*scale\(\.9936\)/);
assert.match(styles, /sd-voices-list > p[\s\S]*font-size:\s*11\.5px/);
assert.match(styles, /sd-status-card \.sd-count-tags\s*\{[^}]*grid-template-columns:\s*repeat\(2/);

assert.match(source, /sd-unified-source-entry/);
assert.match(source, /sd-icon-btn sd-icon-sm sd-storyboard-refresh-worldbooks[\s\S]*fa-rotate/);
assert.match(styles, /sd-storyboard-worldbook-card[\s\S]*box-sizing:\s*border-box[\s\S]*max-width:\s*100%/);
assert.match(styles, /sd-unified-source-entry[\s\S]*display:\s*block !important/);

console.log('V1.58.15 visual refinement contract OK');
