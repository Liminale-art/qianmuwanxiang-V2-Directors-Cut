import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const worldbookView = await readFile(new URL('../qianmu-storyboard-worldbook-view.js', import.meta.url), 'utf8');

const dashboard = source.slice(source.indexOf('function renderDashboardTab'), source.indexOf('function renderChainReactionsCard'));
assert.doesNotMatch(dashboard, /metricBar|本幕进度|sd-progress-metric/, '审片不应继续显示百分比进度');
assert.doesNotMatch(dashboard, /sd-status-card|sd-count-tag|data-jump="tasksnodes"|data-jump="castworld"/, '旧的审片跳转卡已移除');
assert.doesNotMatch(dashboard, /countGroupTag|p\.quests\?|p\.chain_reactions\?|p\.npc_updates\?|p\.relation_undercurrents\?|p\.world_updates\?/, '跳转标签不再附带版块计数');
assert.match(dashboard, /命运之脉[\s\S]*renderDirectorExtraCard\(p\.parallel_scene[\s\S]*renderDirectorExtraCard\(p\.interlude/, '审片呈现命运之脉及独立番外与趣味卡');
assert.doesNotMatch(dashboard, /director_comment|sd-voices-list/, '三席点评已由番外与趣味取代');

assert.match(styles, /--qm-type-card-title:\s*14px/);
assert.match(styles, /sd-storyboard-shortcut[\s\S]*scale\(\.99281\)/);
assert.match(styles, /sd-coread-shortcut[\s\S]*scale\(\.97279\)/);
assert.match(styles, /sd-theme-btn[\s\S]*scale\(\.98348\)/);
assert.match(styles, /sd-plug-shortcut[\s\S]*scale\(\.9936\)/);
assert.match(styles, /sd-director-extra-content\s*\{[^}]*font-size:\s*var\(--qm-type-body/);
assert.match(styles, /sd-director-extra-content p\s*\{[^}]*text-indent:\s*2em/);

assert.match(source, /sd-unified-source-entry/);
assert.match(worldbookView, /sd-icon-btn sd-icon-sm sd-storyboard-refresh-worldbooks[\s\S]*fa-rotate/);
assert.match(styles, /sd-storyboard-worldbook-card[\s\S]*box-sizing:\s*border-box[\s\S]*max-width:\s*100%/);
assert.match(styles, /sd-unified-source-entry[\s\S]*display:\s*block !important/);

console.log('V1.58.15 visual refinement contract OK');
