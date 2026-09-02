import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');

assert.match(source, /DIRECTOR_SECTION_RULES[\s\S]*quests:[\s\S]*npc_updates:[\s\S]*world_updates:[\s\S]*chain_reactions:[\s\S]*relation_undercurrents:/, '推演各保留板块必须具备独立叙事辖区');
assert.doesNotMatch(source.slice(source.indexOf('const DIRECTOR_SECTION_RULES'), source.indexOf('const DIRECTOR_MIN_COUNTS')), /threads:/, '退役伏笔不得继续占用叙事辖区');
assert.doesNotMatch(source, /chain_reactions，挑 1-2 桩/, '系统提示词不得与因果链至少三条的质量门控互相矛盾');
assert.match(source, /五个核心数组必须达到第 10 条的数量下限/, '核心数组不得再被空数组规则放行');
assert.match(source, /function getChatHistoryText[\s\S]*\[楼层\$\{firstFloor \+ offset\}\]/, '推演近期对话必须携带可核验楼层号');
assert.match(source, /director_comment（众声）固定返回 3 条/, '众声必须固定生成三席');
assert.match(source, /plan\.director_comment = \(Array\.isArray[\s\S]*\.slice\(0, 3\)/, '众声回传必须兼容旧字符串并限制为三条');
assert.match(source, /DIRECTOR_MIN_COUNTS[^;]*director_comment:\s*3/, '众声数量不足时必须进入质量补写门');
assert.match(source, /function directorDedupePlan[\s\S]*同板块重复[\s\S]*机械复述/, '推演结果必须执行保守的板块内与跨板块重复门控');
assert.match(source, /async function repairDirectorPlanQuality[\s\S]*缺口补写器[\s\S]*疑似沿用上轮/, '模型偷懒与数量惯性必须走一次定向补写');
assert.match(source, /returned\.slice\(0, missing\)/, '定向补写只能补齐缺口，不得把整套数组重复塞入主结果');

assert.doesNotMatch(source, /function mergeThreads|function renderThreadsCard|sd-livestage-enabled/, '伏笔显影运行链与界面入口必须彻底移除');
assert.match(source, /delete s\.liveStageEnabled[\s\S]*delete s\.injectSections\.threads/, '旧全局配置必须惰性清理');
assert.match(source, /delete meta\[MODULE_NAME\]\.threads[\s\S]*delete meta\[MODULE_NAME\]\.threadQuality/, '旧聊天档案必须惰性清理');
assert.match(source, /delete plan\.threads/, '模型遗留的伏笔字段不得重新进入推演结果');

console.log('Director continuity and retired-thread contract OK');
