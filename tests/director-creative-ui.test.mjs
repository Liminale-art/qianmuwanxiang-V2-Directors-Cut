import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { QIANMU_HIVE_COMMANDS } from '../qianmu-hive-commands.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function fixture(plan, settings = {}) {
  const links = [];
  const c = vm.createContext({
    settings, currentPlan: () => plan, htmlEscape: escape, snip: value => String(value),
    getContextItemId: item => item.title || item.name || 'one', injectSelection: new Set(),
    renderHistorySection: () => '<div>history</div>', renderHeroActions: () => '', renderGenerateRow: () => '',
    renderWorldChatterCard: () => '<section>尘寰群生</section>', renderRelationUndercurrentsCard: () => '<section>关系暗涌</section>',
    renderDirectorWorldEntryLink: (field, index) => { links.push({ field, index }); return '<span class="sd-world-media-entry"></span>'; },
    renderInjectPreview: () => '', renderBackstageBlueprintCard: () => '', DEFAULT_SYSTEM_PROMPT: '', JSON_SCHEMA_TEXT: '',
  });
  vm.runInContext(['renderDashboardTab', 'renderDirectorExtraCard', 'renderChainReactionsCard', 'renderTasksNodesTab',
    'renderCastWorldFront', 'renderPlanSectionFold', 'renderNoPlan', 'renderItemList', 'renderItemCard', 'renderItemChips',
    'renderInjectSections', 'renderDirectorSettingsTab'].map(section).join('\n'), c);
  return { c, links };
}

test('review shows separate read-only extras, escapes their content and respects both switches without mutating history', () => {
  const plan = { story_status: { title: '现场' }, director_comment: ['retired commentary'],
    parallel_scene: { title: '<另一幕>', content: '第一段\n第二段<script>' },
    interlude: { type: 'phone', owner: '<同事>', title: '未读消息', content: '发来一句问候。' } };
  const before = JSON.stringify(plan), { c } = fixture(plan);
  const html = c.renderDashboardTab();
  assert.match(html, /未映之幕/); assert.match(html, /幕间拾趣/); assert.match(html, /平行番外/);
  assert.match(html, /&lt;同事&gt;的手机/); assert.match(html, /第一段\n第二段&lt;script&gt;/);
  assert.doesNotMatch(html, /众声|retired commentary|<script>|sd-inject|sd-world-media-entry/);
  c.settings.interludeEnabled = false;
  assert.doesNotMatch(c.renderDashboardTab(), /幕间拾趣|发来一句问候/);
  c.settings.parallelSceneEnabled = false;
  assert.doesNotMatch(c.renderDashboardTab(), /未映之幕|第一段/);
  assert.equal(JSON.stringify(plan), before);
  assert.doesNotMatch(c.renderDirectorExtraCard({ type: 'wrong', content: 'invalid' }, 'interlude'), /invalid/);
});

test('encounters preserve concrete scene and user-initiated draft action without task rewards or priority labels', () => {
  const { c } = fixture({ quests: [{ title: '门前的来客', description: '邮差带来一封无人领取的信。', trigger: '愿意停下来听他说明。',
    objective: 'old objective', reward: 'old reward', priority: 'high', type: 'main', status: 'active', deadline: '明早', inject_prompt: '门边有人询问信件的主人。' }] });
  const html = c.renderTasksNodesTab();
  assert.match(html, /际遇/); assert.match(html, /邮差带来/); assert.match(html, /可回应之处/); assert.match(html, /写入输入框/);
  assert.doesNotMatch(html, /任务|奖励|收获|优先级|期限|old objective|old reward|>main<|>active</);
  assert.match(html, /时机/);
  assert.equal(QIANMU_HIVE_COMMANDS.find(item => item.id === 'tasksnodes').label, '际遇');
});

test('character life and other people are independent sections, with distinct selection ids and legacy world reading retained', () => {
  const plan = { character_dynamics: [{ title: '交接', content: '他把两份记录放在同事面前。' }],
    npc_updates: [{ title: '交接', name: '邻居', content: '她收起暂未寄出的信。' }], world_updates: [] };
  const { c, links } = fixture(plan);
  const html = c.renderCastWorldFront();
  assert.match(html, /此间一人/); assert.match(html, /其他人物动向/); assert.match(html, /他把两份记录/); assert.match(html, /暂未寄出/);
  assert.match(html, /data-id="character-0-/); assert.match(html, /data-id="npc-0-/);
  assert.doesNotMatch(html, /世界回声/); assert.ok(links.every(item => item.field !== undefined));
  plan.world_updates = [{ title: '旧记录', content: '仍可阅读的历史世界记录' }];
  assert.match(c.renderCastWorldFront(), /仍可阅读的历史世界记录/);
  assert.equal(plan.character_dynamics.length, 1);
});

test('ripples keep full consequences and do not manufacture extra nodes by splitting natural connective words', () => {
  const chain = '邮路改道，进而让原本错开的两班车在桥头相遇。'.repeat(5), { c } = fixture(null);
  const html = c.renderChainReactionsCard({ chain_reactions: [{ spark: '一座桥暂停通行', chain }] });
  assert.match(html, /<b>涟漪<\/b>/); assert.ok(html.includes(chain));
  assert.equal((html.match(/sd-chain-node(?: |")/g) || []).length, 2);
  assert.doesNotMatch(html, /因果链|世界自行流转的连锁/);
});

test('derivative switches are checked by default and each immediately saves only its own preference', () => {
  const { c } = fixture(null);
  const html = c.renderDirectorSettingsTab();
  assert.match(html, /class="sd-parallel-scene-enabled" checked/);
  assert.match(html, /class="sd-interlude-enabled" checked/);
  c.settings.interludeEnabled = false;
  assert.doesNotMatch(c.renderDirectorSettingsTab(), /class="sd-interlude-enabled" checked/);
  const handlers = new Map(), messages = []; let saves = 0;
  c.root = { querySelector: selector => ({ addEventListener: (type, run) => handlers.set(selector, run) }) };
  c.saveSettings = () => saves++;
  c.toast = message => messages.push(message);
  const start = source.indexOf("  root.querySelector('.sd-parallel-scene-enabled')?.addEventListener");
  const end = source.indexOf("  root.querySelector('.sd-geopolitics-enabled')?.addEventListener", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), c);
  handlers.get('.sd-parallel-scene-enabled')({ target: { checked: false } });
  assert.equal(c.settings.parallelSceneEnabled, false); assert.equal(c.settings.interludeEnabled, false);
  handlers.get('.sd-interlude-enabled')({ target: { checked: true } });
  assert.equal(c.settings.interludeEnabled, true); assert.equal(c.settings.parallelSceneEnabled, false);
  assert.equal(saves, 2); assert.deepEqual(messages, ['未映之幕已关闭。', '幕间拾趣已开启。']);
});

test('creative card typography and overflow remain scoped to the Qianmu modal and inherit theme tokens', () => {
  assert.match(styles, /#story-director-modal \.sd-director-extra-content,[\s\S]*var\(--sd-text\)[\s\S]*white-space:\s*pre-wrap;[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /#story-director-modal \.sd-chain-node\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /#story-director-modal \.sd-derivative-options\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
});
