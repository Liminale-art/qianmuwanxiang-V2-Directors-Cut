import test from 'node:test';
import assert from 'node:assert/strict';
import { CREATIVE_DETAIL_COUNTS, CREATIVE_GUIDES, CREATIVE_SYSTEM_PROMPT, creativeSectionGuidance } from '../qianmu-creative-prompts.js';
import { createCreativeSchema, normalizeCreativeSections, validateCreativePlan } from '../qianmu-creative-contract.js';
import { renderCreativeSocialCard } from '../qianmu-creative-social.js';

const options = type => ({ interludeType: type, parallelSceneEnabled: false, eligiblePhoneOwners: ['小林'] });
const forum = count => ({ type: 'forum', title: '桥头闲话', posts: Array.from({ length: count }, (_, i) => ({
  author: `街坊${i}`, handle: `lane_${i}`, time: `午后 ${i}`, content: `今天第${i}家店门口的日常小事。`,
  replies: Array.from({ length: 1 + i % 3 }, (_, j) => ({ author: j ? `邻居${j}` : `街坊${i}`, content: `第${i}帖的第${j}次接话。` })),
})) });
const phone = count => ({ type: 'phone', title: '午后闲聊', owner: '小林', conversation_kind: 'direct',
  messages: Array.from({ length: count }, (_, i) => ({ sender: i % 3 ? '小林' : '老周', time: `14:${String(i).padStart(2, '0')}`, content: `第${i}次接话带来不同回应。` })),
});
const interludeIssues = (card, type) => validateCreativePlan({ interlude: card }, options(type)).filter(issue => issue.field === 'interlude');

test('interlude quotas agree across constants, instructions and generated schema', () => {
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.forumPosts, { min: 8 });
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.phoneMessages, { min: 12 });
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.forumReplies, { min: 1, max: 3 });
  assert.match(CREATIVE_SYSTEM_PROMPT, /at least 8 posts/);
  assert.match(CREATIVE_SYSTEM_PROMPT, /at least 12 messages/);
  assert.match(CREATIVE_GUIDES.forum, /至少生成 8 帖/);
  assert.match(CREATIVE_GUIDES.phone, /至少生成 12 条消息/);
  assert.match(createCreativeSchema(options('forum')), /Forum form: at least 8 posts, each with 1–3 replies/);
  assert.match(createCreativeSchema(options('phone')), /Phone form: at least 12 messages/);
  assert.match(creativeSectionGuidance(options('forum')), /至少生成 8 帖/);
  assert.match(creativeSectionGuidance(options('phone')), /至少生成 12 条消息/);
});

for (const [type, make, min, longCount, unit] of [['forum', forum, 8, 13, '帖'], ['phone', phone, 12, 21, '条']]) {
  test(`${type} accepts its minimum and longer output with no generation ceiling, rejecting shortfalls without mutation`, () => {
    for (const count of [min, longCount, longCount + 10]) assert.deepEqual(interludeIssues(make(count), type), [], `${count} is valid`);
    for (const count of [0, min - 1]) {
      const card = make(count), before = structuredClone(card);
      const issues = interludeIssues(card, type);
      assert.equal(issues.length, 1);
      assert.match(issues[0].reason, new RegExp(`至少有 ${min} ${unit}`));
      assert.deepEqual(card, before, 'validation reports a mismatch, never creates or cuts generated content');
    }
  });

  test(`${type} renderer exposes longer output beyond the previous quota ceiling without inventing controls`, () => {
    const card = make(longCount), before = structuredClone(card), html = renderCreativeSocialCard(card);
    const selector = type === 'forum' ? /class="sd-social-post"/g : /class="sd-social-message(?: sd-social-message-own)?"/g;
    assert.equal((html.match(selector) || []).length, longCount);
    const last = type === 'forum' ? card.posts.at(-1).content : card.messages.at(-1).content;
    assert.ok(html.includes(last));
    assert.doesNotMatch(html, /<form|<input|<textarea|contenteditable|data-social-message-extra/);
    assert.deepEqual(card, before);
  });

  test(`${type} smaller historical cards remain readable and unmodified, not silently backfilled`, () => {
    const card = make(type === 'forum' ? 3 : 6), before = structuredClone(card);
    assert.deepEqual(normalizeCreativeSections({ interlude: card }).interlude, before);
    const html = renderCreativeSocialCard(card);
    assert.doesNotMatch(html, /尚未生成/);
    assert.deepEqual(card, before);
    assert.equal(interludeIssues(card, type).length, 1, 'old output remains readable but is not valid as new requested output');
  });
}

test('expanded social guidance preserves varied replies, speaker identity and natural conversational pacing', () => {
  assert.match(CREATIVE_GUIDES.forum, /回复数从允许范围内自然变化/);
  assert.match(CREATIVE_GUIDES.forum, /至少一处让楼主二次回应/);
  assert.match(CREATIVE_GUIDES.forum, /不靠拆分一句话、换账号复述/);
  assert.match(CREATIVE_GUIDES.phone, /私聊恰好两位说话者，群聊至少两位/);
  assert.match(CREATIVE_GUIDES.phone, /不把完整一句机械拆成数条凑数/);
  assert.match(CREATIVE_GUIDES.phone, /不要求每位说话者平均发言/);
  const repeat = forum(8); repeat.posts[7].content = repeat.posts[0].content;
  assert.match(interludeIssues(repeat, 'forum')[0].reason, /重复帖子/);
  const solo = phone(12); solo.messages.forEach(message => { message.sender = '小林'; });
  assert.match(interludeIssues(solo, 'phone')[0].reason, /两位/);
});
