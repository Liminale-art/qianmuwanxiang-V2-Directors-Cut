import test from 'node:test';
import assert from 'node:assert/strict';
import { hashText } from '../qianmu-storyboard-utils.js';
import { CREATIVE_IDENTITY, CREATIVE_LAWS, CREATIVE_BLUEPRINT, CREATIVE_GUIDES, CREATIVE_COUNTS, CREATIVE_DETAIL_COUNTS, CREATIVE_SECTION_LABELS, creativeSectionGuidance } from '../qianmu-creative-prompts.js';
import { createCreativeSchema, validateCreativePlan, projectCreativeContinuity } from '../qianmu-creative-contract.js';

const shape = options => {
  const schema = createCreativeSchema(options);
  const start = schema.indexOf('\n{') + 1;
  return JSON.parse(schema.slice(start, schema.indexOf('\n\n', start)));
};

// These are wiring and editorial-contract checks, not claims of model quality.
test('overhead composition stops at the observed change instead of explaining its meaning to the audience', () => {
  assert.match(CREATIVE_LAWS, /This overhead view guides composition, not a narrator's verdict/);
  assert.match(CREATIVE_LAWS, /do not append a summary of what this means, what a small affair has now become/);
  assert.match(CREATIVE_LAWS, /Leave interpretation and response to the reader/);
  assert.match(CREATIVE_BLUEPRINT, /俯瞰是选材与组织的视角，不是代观众下结论/);
  assert.match(CREATIVE_GUIDES.story_status, /新条件已经显现就收笔/);
  assert.match(CREATIVE_GUIDES.story_status, /不宣告主角因此必须如何安排或面对/);
  const directions = shape().story_status.directions;
  assert.match(directions[0].content, /without a narrator explaining its significance/);
  assert.match(directions[1].content, /not a summary of what the affair has now become/);
});

test('ripple breadth is causal transmission and possible feedback, not personal retellings or mandatory disasters', () => {
  assert.match(CREATIVE_LAWS, /across people, groups, resources, institutions or the natural environment/);
  assert.match(CREATIVE_LAWS, /A trajectory retold through its individual participants or split into procedural steps is not another ripple/);
  assert.match(CREATIVE_LAWS, /neither catastrophe nor escalation is required/);
  const guide = CREATIVE_GUIDES.chain_reactions;
  assert.match(guide, /当前叙事或有效世界格局/);
  assert.match(guide, /由宏观变化落到个人再反馈公共局面，由小事外溢/);
  assert.match(guide, /不规定每条都跨层、变大或升级灾难/);
  assert.match(guide, /不是把命运之脉换成个人视角重讲/);
  assert.match(guide, /至少一条体现真正的横向广度/);
  assert.match(guide, /不强制沿用上一轮或让一切相连/);
  assert.match(CREATIVE_BLUEPRINT, /不必最终回收为主角的线索/);
  assert.match(shape().chain_reactions[0].chain, /stay local, widen, transfer or feed back/);
  assert.deepEqual(CREATIVE_COUNTS.chain_reactions, { min: 3 });
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.rippleNodes, { min: 3, max: 5 });
});

test('the adopted world-transmission name changes labels only, not the chain_reactions contract', () => {
  assert.equal(CREATIVE_SECTION_LABELS.chain_reactions, '世事相牵');
  const schema = createCreativeSchema();
  assert.match(schema, /chain_reactions \(世事相牵\): at least 3 substantive entries/);
  assert.ok(Object.hasOwn(shape(), 'chain_reactions'));
  assert.doesNotMatch([CREATIVE_LAWS, CREATIVE_BLUEPRINT, ...Object.values(CREATIVE_GUIDES), schema].join('\n'), /涟漪/);
  const oldPlan = { chain_reactions: [{ spark: '旧起因', chain: '原有节点一 → 原有节点二 → 原有节点三' }] };
  assert.deepEqual(projectCreativeContinuity(oldPlan).chain_reactions, oldPlan.chain_reactions);
});

test('public account names and IDs have separate roles without forcing real names or occupational templates', () => {
  const forum = shape({ interludeType: 'forum' }).interlude;
  assert.match(forum.posts[0].author, /fictional public nickname/);
  assert.match(forum.posts[0].handle, /different fictional account ID, not author with @ added/);
  assert.match(forum.posts[0].replies[0].author, /reuse the same nickname/);
  assert.match(CREATIVE_GUIDES.interlude, /同一账号在帖子与回复里保持标识稳定/);
  assert.match(CREATIVE_GUIDES.interlude, /彼此可以有反差/);
  assert.match(CREATIVE_GUIDES.interlude, /熟人页的联系人备注无需强行网名化/);
  const microblog = shape({ interludeType: 'phone', phoneViewType: 'microblog' }).interlude;
  assert.match(microblog.posts[0].display_name, /distinct from handle/);
  assert.match(microblog.posts[0].handle, /not the same name with @ added/);
  assert.match(createCreativeSchema({ interludeType: 'phone', phoneViewType: 'microblog' }), /fictional display_name and a distinct handle, stable for each account/);
});

test('private feeds follow the owner social circle while public visibility does not imply acquaintance', () => {
  assert.match(CREATIVE_GUIDES.phone, /认识 CHAR 不等于认识 CHAR 的家人、同事与朋友/);
  assert.match(CREATIVE_GUIDES.phone, /不能只因同在设定名单就拼在一起/);
  assert.match(CREATIVE_GUIDES.phone, /不倒造主要人物间的旧交/);
  assert.match(CREATIVE_GUIDES.phone, /每位参与者都有脱离主角仍成立的关系、需求与生活/);
  assert.match(CREATIVE_GUIDES.moments, /朋友的同事、亲属或其他朋友并不因此成为主人的好友/);
  assert.match(CREATIVE_GUIDES.moments, /评论者的熟悉程度、可见范围和话题知识各有依据/);
  assert.match(CREATIVE_GUIDES.microblog, /关注或推荐不代表私下相识/);
  const moments = shape({ interludeType: 'phone', phoneViewType: 'moments' }).interlude;
  assert.match(moments.posts[0].content, /plausible direct contact of this phone owner/);
  assert.match(moments.posts[0].content, /Friendship is not transitive/);
  assert.match(moments.posts[0].replies[0].content, /sharing a feed does not make everyone acquainted/);
});

test('selected guidance carries only the chosen social surface and keeps the approved preview and identity unchanged', () => {
  assert.equal(hashText(CREATIVE_IDENTITY), '6bb891a0');
  assert.equal(hashText(CREATIVE_GUIDES.quests), '35ad1955');
  const moments = creativeSectionGuidance({ interludeType: 'phone', phoneViewType: 'moments' });
  assert.ok(moments.includes(CREATIVE_GUIDES.phone));
  assert.ok(moments.includes(CREATIVE_GUIDES.moments));
  assert.ok(moments.includes(CREATIVE_GUIDES.interlude));
  assert.ok(!moments.includes(CREATIVE_GUIDES.microblog));
  assert.ok(!moments.includes(CREATIVE_GUIDES.forum));
  const forum = creativeSectionGuidance({ interludeType: 'forum' });
  assert.ok(forum.includes(CREATIVE_GUIDES.interlude));
  assert.ok(!forum.includes(CREATIVE_GUIDES.phone));
});

test('editorial account guidance does not reject or rewrite legacy duplicated handles or promote a social page to continuity', () => {
  const card = { type: 'forum', title: '旧社区', posts: Array.from({ length: 8 }, (_, i) => ({ author: `旧昵称${i}`, handle: `旧昵称${i}`, content: `这是第${i}条完整日常动态。`, time: '午后', replies: [{ author: '老朋友', content: '这件事我也碰到过。' }] })) };
  const before = structuredClone(card);
  assert.equal(validateCreativePlan({ interlude: card }, { interludeType: 'forum' }).filter(issue => issue.field === 'interlude').length, 0);
  assert.deepEqual(card, before);
  assert.ok(!Object.hasOwn(projectCreativeContinuity({ interlude: card }), 'interlude'));
});
