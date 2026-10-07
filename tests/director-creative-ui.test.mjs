import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { QIANMU_HIVE_COMMANDS } from '../qianmu-hive-commands.js';
import { directorPreviewPlan } from '../qianmu-director-live.js';
import { renderCreativeSocialCard } from '../qianmu-creative-social.js';

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
    settings, directorLiveLog: null, directorPreviewPlan, renderCreativeSocialCard, currentPlan: () => plan, htmlEscape: escape, snip: value => String(value),
    getContextItemId: item => item.title || item.name || 'one', injectSelection: new Map(),
    renderHistorySection: () => '<div>history</div>', renderHeroActions: () => '', renderGenerateRow: () => '',
    renderWorldChatterCard: () => '<section>尘寰群生</section>', renderRelationUndercurrentsCard: () => '<section>关系暗涌</section>',
    renderDirectorWorldEntryLink: (field, index) => { links.push({ field, index }); return '<span class="sd-world-media-entry"></span>'; },
    renderInjectPreview: () => '', renderBackstageBlueprintCard: () => '', DEFAULT_SYSTEM_PROMPT: '', JSON_SCHEMA_TEXT: '',
  });
  vm.runInContext(['directorDisplayPlan', 'renderDashboardTab', 'renderDirectorExtraCard', 'renderChainReactionsCard', 'renderTasksNodesTab',
    'renderCastWorldFront', 'renderPlanSectionFold', 'renderNoPlan', 'renderItemList', 'directorItemParagraphs', 'renderDirectorParagraph', 'renderItemCard', 'renderItemChips', 'collectDirectorSelectedText',
    'renderInjectSections', 'renderDirectorSettingsTab'].map(section).join('\n'), c);
  return { c, links };
}

test('review shows separate read-only extras, escapes their content and respects both switches without mutating history', () => {
  const plan = { story_status: { title: '现场' }, director_comment: ['retired commentary'],
    parallel_scene: { title: '<另一幕>', content: '第一段\n第二段<script>' },
    interlude: { type: 'phone', owner: '<同事>', title: '未读消息', content: '发来一句问候。' } };
  const before = JSON.stringify(plan), { c } = fixture(plan);
  const html = c.renderDashboardTab();
  assert.match(html, /未映之幕/); assert.match(html, /世界论坛/); assert.match(html, /平行番外/);
  assert.match(html, /&lt;同事&gt;的手机/); assert.match(html, /第一段\n第二段&lt;script&gt;/);
  assert.doesNotMatch(html, /&lt;另一幕&gt;|data-director-memory-review|临时查阅/);
  assert.match(html, /<h4>未读消息<\/h4>/, 'only parallel story subtitles are removed');
  assert.doesNotMatch(html, /众声|retired commentary|<script>|sd-inject|sd-world-media-entry/);
  c.settings.interludeEnabled = false;
  assert.doesNotMatch(c.renderDashboardTab(), /世界论坛|发来一句问候/);
  c.settings.parallelSceneEnabled = false;
  assert.doesNotMatch(c.renderDashboardTab(), /未映之幕|第一段/);
  assert.equal(JSON.stringify(plan), before);
  assert.doesNotMatch(c.renderDirectorExtraCard({ type: 'wrong', content: 'invalid' }, 'interlude'), /invalid/);
});

test('rehearsals expose three independently selectable paragraphs with an explicit subject and no whole-card checkbox', () => {
  const { c } = fixture({ quests: [{ title: '门前的来客', subject: '邮差', description: '邮差带来一封无人领取的信。', trigger: '愿意停下来听他说明。',
    objective: 'old objective', reward: 'old reward', priority: 'high', type: 'main', status: 'active', deadline: '明早', inject_prompt: '门边有人询问信件的主人。' }] });
  const html = c.renderTasksNodesTab();
  assert.match(html, /预演/); assert.match(html, /邮差带来/); assert.match(html, /发生条件/);
  assert.equal((html.match(/data-director-paragraph /g) || []).length, 3);
  assert.match(html, /data-subject="邮差"/); assert.match(html, /role="button" tabindex="0" aria-pressed="false"/);
  assert.doesNotMatch(html, /写入输入框|sd-select-inject|class="sd-btn sd-inject"/);
  assert.doesNotMatch(section('bindActiveTabEvents'), /querySelectorAll\('\.sd-inject'\)/);
  assert.doesNotMatch(html, /任务|奖励|收获|优先级|期限|old objective|old reward|>main<|>active</);
  assert.match(html, /时机/);
  assert.equal(QIANMU_HIVE_COMMANDS.find(item => item.id === 'tasksnodes').label, '预演');
});

test('review presents independent distant directions, omits stage and mood, and reads old summaries without rewriting them', () => {
  const plan = { story_status: { title: '街角的分岔', summary: 'OLD_SUMMARY', current_stage: 'OLD_STAGE', mood: 'OLD_MOOD',
    directions: [{ title: '账本换了主人', content: '学徒将旧账交还家人，积年的生意开始转向。' }, { title: '共同修缮', content: '几家店铺各让出一天人手，旧街开始重新接纳夜客。' }] } };
  const { c } = fixture(plan), original = JSON.stringify(plan);
  const html = c.renderDashboardTab();
  assert.equal((html.match(/class="sd-director-direction"/g) || []).length, 2);
  assert.match(html, /共同修缮/); assert.doesNotMatch(html, /OLD_SUMMARY|OLD_STAGE|OLD_MOOD|阶段：|氛围：/);
  assert.equal(JSON.stringify(plan), original);
  delete plan.story_status.directions;
  assert.match(c.renderDashboardTab(), /OLD_SUMMARY/);
  assert.equal(plan.story_status.current_stage, 'OLD_STAGE');
});

test('paragraph drafts retain display order, one explicit subject prefix, and safe named-affair fallback', () => {
  const { c } = fixture(null);
  const fields = c.directorItemParagraphs({ description: '正文已有称呼不可用来猜姓名', trigger: '完成取证后', inject_prompt: '递交报告。' }, 'quest');
  for (const order of [2, 0, 1]) c.injectSelection.set(`part-${order}`, { cardId: 'quest-one', subject: '邵宁', order, ...fields[order] });
  c.injectSelection.set('old-whole-card', '旧世界原文');
  const text = c.collectDirectorSelectedText();
  assert.equal(text[0], '【邵宁】\n情境：正文已有称呼不可用来猜姓名\n\n发生条件：完成取证后\n\n落笔：递交报告。');
  assert.equal(text[1], '旧世界原文');
  assert.equal((text[0].match(/【邵宁】/g) || []).length, 1);
  assert.match(c.renderItemCard({ title: '门口的旧信', description: '甲和乙在说话。' }, 'quest', 0), /data-subject="事项：门口的旧信"/);
  assert.match(c.renderItemCard({ name: '邵宁', next_action: '递交报告。' }, 'npc', 0), /data-subject="邵宁"/);
  assert.doesNotMatch(c.renderItemCard({ subject: '邵宁', description: '递交报告。' }, 'quest', 0, true), /data-director-paragraph|role="button"|tabindex|sd-select-inject/);
  const duplicate = c.directorItemParagraphs({ description: '同一段', inject_prompt: '同一段' }, 'quest');
  assert.equal(duplicate.length, 1);
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
  assert.equal(saves, 2); assert.deepEqual(messages, ['未映之幕已关闭。', '世界论坛已开启。']);
});

test('creative card typography and overflow remain scoped to the Qianmu modal and inherit theme tokens', () => {
  assert.match(styles, /#story-director-modal \.sd-director-extra-content,[\s\S]*var\(--sd-text\)[\s\S]*white-space:\s*pre-wrap;[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /#story-director-modal \.sd-chain-node\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /#story-director-modal \.sd-derivative-options\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
});

test('failed or stopped streams restore the saved plan and cannot obscure loaded history', () => {
  const plan = { story_status: { title: '已保存方案' } }, { c } = fixture(plan);
  c.directorLiveLog = { status: 'loading', response: '{"story_status":{"title":"未采纳片段"}}' };
  assert.match(c.renderDashboardTab(), /未采纳片段/); assert.doesNotMatch(c.renderDashboardTab(), /已保存方案/);
  for (const status of ['error', 'cancelled']) {
    c.directorLiveLog.status = status;
    assert.match(c.renderDashboardTab(), /已保存方案/); assert.doesNotMatch(c.renderDashboardTab(), /未采纳片段/);
  }
  plan.story_status.title = '载入的历史';
  assert.match(c.renderDashboardTab(), /载入的历史/);
});

test('stream refresh binds only reading actions and preserves the world shell instead of rerunning global tab teardown', () => {
  const refresh = section('refreshDirectorLiveUI'), actions = section('bindDirectorReadingEvents');
  assert.match(refresh, /bindDirectorReadingEvents\(host\)/);
  assert.doesNotMatch(refresh, /bindActiveTabEvents\(host\)|bindCoreadTabEvents|bindTheaterTabEvents/);
  assert.match(refresh, /worldBody\.innerHTML/);
  assert.doesNotMatch(actions, /unmountReaderPortal|document\.addEventListener|window\.addEventListener|bindCoreadTabEvents/);
  assert.match(section('bindActiveTabEvents'), /bindDirectorReadingEvents\(root\)/);
  assert.equal((source.match(/root\.querySelectorAll\('\.sd-generate-main'\)/g) || []).length, 1);
});
