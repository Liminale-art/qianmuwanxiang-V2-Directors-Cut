import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CREATIVE_GUIDES, CREATIVE_COUNTS } from '../qianmu-creative-prompts.js';
import { createCreativeSchema, normalizeCreativeSections } from '../qianmu-creative-contract.js';
import { isPlainObject, mergeDefaults } from '../qianmu-storyboard-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');

for (const field of ['quests', 'character_dynamics', 'npc_updates', 'chain_reactions', 'relation_undercurrents', 'world_chatter', 'geopolitics', 'parallel_scene', 'interlude']) {
  assert.ok(CREATIVE_GUIDES[field]?.trim(), `${field} 必须具备已审定的独立栏目引导`);
}
assert.ok(!Object.hasOwn(CREATIVE_GUIDES, 'threads'), '退役伏笔不得继续占用叙事辖区');
assert.doesNotMatch(source, /chain_reactions，挑 1-2 桩/, '系统提示词不得与因果链至少三条的质量门控互相矛盾');
assert.deepEqual(Object.fromEntries(['quests', 'character_dynamics', 'npc_updates', 'chain_reactions', 'relation_undercurrents'].map(field => [field, CREATIVE_COUNTS[field].min])), {
  quests: 5, character_dynamics: 2, npc_updates: 3, chain_reactions: 3, relation_undercurrents: 3,
}, '核心栏目供给量必须沿用定稿，不因旧协议清理降低');
const historySource = source.slice(source.indexOf('function directorHistorySelection('), source.indexOf('let directorMemoryHostModule'));
assert.match(historySource, /\[楼层['"]\s*\+\s*\(recentStartIndex \+ offset\)/, '推演近期对话必须携带可核验楼层号');
const schema = createCreativeSchema({ interludeType: 'forum' });
assert.doesNotMatch(schema, /"(?:director_comment|world_updates|threads)"\s*:/, '旧点评和旧重复栏目不再成为新输出配额');
assert.match(source, /plan\.director_comment = \(Array\.isArray[\s\S]*\.slice\(0, 3\)/, '众声回传必须兼容旧字符串并限制为三条');
assert.ok(!Object.hasOwn(CREATIVE_COUNTS, 'director_comment'), '旧点评只读兼容，不再强制生成三席');
const qualitySource = source.slice(source.indexOf('function directorDedupePlan('), source.indexOf('function makeStreamLogUpdater('));
assert.match(qualitySource, /pruneInvalidCreativeItems\(plan, options\)/, '逐条剔除只依新合同，不再强换合格条目');
assert.match(qualitySource, /validateCreativePlan\(plan, options\)/, '所有启用栏目仍经过真实数量与有效条目校验');
assert.doesNotMatch(qualitySource, /directorSimilarity|0\.96|疑似沿用上轮|机械复述/, '有效存续状态不再因相似度被强制换新');
assert.match(qualitySource, /request\.userPrompt\s*\+/, '补写必须复用同一份请求资料');
assert.match(qualitySource, /mergeCreativeRepair\(plan, patch,/, '只把被请求字段的补写合并到现有结果');

const normalizeSource = source.slice(source.indexOf('function normalizePlan('), source.indexOf('// directorItemText -'));
const sandbox = { isPlainObject, mergeDefaults, normalizeCreativeSections };
vm.createContext(sandbox); vm.runInContext(normalizeSource, sandbox);
assert.deepEqual(sandbox.normalizePlan({ director_comment: '众声：旧资料仍可读', threads: [{ id: 'retired' }] }).director_comment, ['旧资料仍可读']);
assert.deepEqual(sandbox.normalizePlan({ director_comment: ['众声：甲', { text: '乙' }, { content: '丙' }, '丁'] }).director_comment, ['甲', '乙', '丙']);
assert.ok(!Object.hasOwn(sandbox.normalizePlan({ threads: [{ id: 'retired' }] }), 'threads'), '退役字段清理必须实际发生');

assert.doesNotMatch(source, /function mergeThreads|function renderThreadsCard|sd-livestage-enabled/, '伏笔显影运行链与界面入口必须彻底移除');
assert.match(source, /delete s\.liveStageEnabled[\s\S]*delete s\.injectSections\.threads/, '旧全局配置必须惰性清理');
assert.match(source, /delete meta\[MODULE_NAME\]\.threads[\s\S]*delete meta\[MODULE_NAME\]\.threadQuality/, '旧聊天档案必须惰性清理');
assert.match(source, /delete plan\.threads/, '模型遗留的伏笔字段不得重新进入推演结果');

assert.match(source, /推演完成，下一幕已就位。/, '推演成功提示应使用当前功能语义');
assert.doesNotMatch(source, /暗线已就位/, '退役的伏笔显影文案不得残留');

console.log('Director continuity and retired-thread contract OK');
