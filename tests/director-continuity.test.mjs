import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');

assert.match(source, /DIRECTOR_SECTION_RULES[\s\S]*quests:[\s\S]*npc_updates:[\s\S]*world_updates:[\s\S]*chain_reactions:[\s\S]*relation_undercurrents:[\s\S]*threads:/, '推演各板块必须具备独立叙事辖区');
assert.doesNotMatch(source, /chain_reactions，挑 1-2 桩/, '系统提示词不得与因果链至少三条的质量门控互相矛盾');
assert.match(source, /五个核心数组必须达到第 10 条的数量下限/, '核心数组不得再被空数组规则放行');
assert.match(source, /function getChatHistoryText[\s\S]*\[楼层\$\{firstFloor \+ offset\}\]/, '推演近期对话必须携带可核验楼层号');
assert.match(source, /evidence_floor[\s\S]*evidence_quote[\s\S]*resolution/, '伏笔状态回传必须包含证据与收束字段');
assert.match(source, /function validateThreadEvidence[\s\S]*原句不在近期对话中/, '伏笔证据必须由程序核对近期正文');
assert.match(source, /t\.stage = advanceStage\(previousStage\)/, '伏笔推进必须相对旧阶段最多升一档，不能基于模型新档位重复升档');
assert.match(source, /模型漏回传只记录漏审[\s\S]*t\.unreviewedRounds[\s\S]*状态保持/, '模型漏审不得冒充正文 idle 改变生命周期');
assert.match(source, /t\.status === 'closed'[\s\S]*已落幕档案不可由模型复活/, '已落幕伏笔不得被后续模型回传重新开启');
assert.match(source, /先审阅既有档案、再接纳新线/, '伏笔合并必须与模型数组顺序解耦');
assert.match(source, /回传了不存在的伏笔 id[\s\S]*本轮重复的新伏笔候选/, '伏笔合并必须拦截未知 id 与重复新候选');
assert.match(source, /同一伏笔 id 在本轮重复回传/, '同一既有伏笔每轮只能被审阅一次');
assert.match(source, /t\.stage === '落幕'[\s\S]*t\.status = 'closed'/, '伏笔推进至落幕必须自动归档');
assert.match(source, /THREAD_RECALL_LIMIT = 2[\s\S]*THREAD_RECALL_COOLDOWN = 2[\s\S]*function selectThreadsForRecall/, '伏笔档案储备、召回预算与冷却必须分离');
assert.match(source, /function buildThreadsDigest[\s\S]*threadRecallIds[\s\S]*最多两条/, '正文注入只能使用本轮语境命中的少量伏笔');
assert.match(source, /function directorDedupePlan[\s\S]*同板块重复[\s\S]*机械复述/, '推演结果必须执行保守的板块内与跨板块重复门控');
assert.match(source, /async function repairDirectorPlanQuality[\s\S]*缺口补写器[\s\S]*疑似沿用上轮[\s\S]*漏审伏笔 id/, '模型偷懒、数量惯性和伏笔漏审必须走一次定向补写');
assert.match(source, /projectedExits[\s\S]*projectedActiveCount/, '伏笔储备补足判断必须计入本轮预计落幕与沉睡的条目');
assert.match(source, /returned\.slice\(0, missing\)/, '定向补写只能补齐缺口，不得把整套数组重复塞入主结果');
assert.match(source, /sd-thread-edit[\s\S]*sd-thread-evidence[\s\S]*sd-thread-decision[\s\S]*sd-thread-quality/, '伏笔档案必须支持修改并解释证据、判定与质检状态');

console.log('Director continuity and lifecycle contract OK');
