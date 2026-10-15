import test from 'node:test';
import assert from 'node:assert/strict';
import { CREATIVE_DETAIL_COUNTS, CREATIVE_GUIDES, CREATIVE_LAWS, creativeSectionGuidance } from '../qianmu-creative-prompts.js';
import { createCreativeSchema, normalizeCreativeSections, validateCreativePlan, projectCreativeContinuity } from '../qianmu-creative-contract.js';
import { selectCreativeOptions, recentInterludeHint } from '../qianmu-creative-runtime.js';

const options = view => ({ interludeType: 'phone', phoneViewType: view, personaNames: ['访客', 'Guest'] });
const feed = (view, count = 6) => ({ type: 'phone', view_type: view, owner: '街角新住户', title: view === 'moments' ? '朋友圈' : '短博',
  posts: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, author: `邻人${i}`, display_name: `小院${i}`, handle: `lane_${i}`, time: `午后 ${i}`, likes: i,
    content: `第${i}件属于这些人的生活小事。`, replies: i < 2 ? [{ id: `r${i}`, author: '常客', display_name: '路边茶', content: `接住第${i}件事情的话。`, reply_to: `小院${i}` }] : [],
  })),
});
const chat = () => ({ type: 'phone', owner: '老周', title: '阿岚', conversation_kind: 'direct',
  messages: Array.from({ length: 12 }, (_, i) => ({ sender: i % 2 ? '阿岚' : '老周', content: `第${i}句自然接话。`, time: `14:${i}` })),
});
const issues = (card, opts = options(card.view_type || 'chat')) => validateCreativePlan({ interlude: card }, opts).filter(issue => issue.field === 'interlude');
const shape = opts => {
  const schema = createCreativeSchema(opts), start = schema.indexOf('{\n');
  return JSON.parse(schema.slice(start, schema.indexOf('\n\n', start))).interlude;
};

test('a phone request picks one page once and samples direct/group only for chat', () => {
  for (const [draws, view, kind] of [[[.9, .1], 'moments', null], [[.9, .5], 'microblog', null], [[.9, .9, .1], 'chat', 'direct'], [[.9, .9, .9], 'chat', 'group']]) {
    let calls = 0;
    const selected = selectCreativeOptions({}, { sourceText: '这里有手机', random: () => draws[calls++] });
    assert.equal(selected.interludeType, 'phone'); assert.equal(selected.phoneViewType, view); assert.equal(selected.phoneConversationKind, kind);
    assert.equal(calls, draws.length); assert.ok(Object.isFrozen(selected));
    creativeSectionGuidance(selected); createCreativeSchema(selected);
    assert.equal(calls, draws.length, 'guidance/schema rendering cannot resample or start another request');
    assert.equal(shape(selected).view_type, view);
    assert.equal(Object.hasOwn(shape(selected), 'messages'), view === 'chat');
    assert.equal(Object.hasOwn(shape(selected), 'posts'), view !== 'chat');
  }
  for (const settings of [{ interludeEnabled: false }, {}]) {
    let calls = 0;
    const selected = selectCreativeOptions(settings, { sourceText: '旧时客栈', random: () => { calls++; return .9; } });
    assert.equal(calls, 0); assert.equal(selected.phoneViewType, null); assert.equal(selected.phoneConversationKind, null);
  }
});

test('only the selected phone page guidance and shape is supplied, retaining distinct social perspectives', () => {
  for (const view of ['chat', 'moments', 'microblog']) {
    const opts = { ...options(view), phoneConversationKind: 'direct' };
    const guide = creativeSectionGuidance(opts);
    assert.ok(guide.includes(CREATIVE_GUIDES.phone));
    for (const key of ['phone_chat', 'moments', 'microblog']) assert.equal(guide.includes(CREATIVE_GUIDES[key]), key === (view === 'chat' ? 'phone_chat' : view));
    assert.equal(guide.includes('本轮手机会话形式固定为'), view === 'chat');
    if (view !== 'chat') {
      assert.doesNotMatch(guide, /至少生成 12 条消息/);
      assert.doesNotMatch(createCreativeSchema(opts), /"conversation_kind"|12 messages/);
    }
  }
  assert.match(CREATIVE_GUIDES.moments, /朋友、家人、同好.*熟人各自的生活/);
  assert.match(CREATIVE_GUIDES.microblog, /兴趣、创作者、普通人及自身表达/);
  assert.match(CREATIVE_GUIDES.microblog, /不写成论坛换皮、主线情报墙/);
  assert.match(CREATIVE_GUIDES.phone, /不默认与 USER\/CHAR 相识/);
  assert.match(CREATIVE_GUIDES.phone, /不要求每张卡都换人或造新人/);
});

test('phone feed quotas share one source without changing the original forum or chat quotas', () => {
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.phoneFeedPosts, { min: 6 });
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.phoneFeedReplies, { min: 0, max: 3 });
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.phoneCommentedPosts, { min: 2 });
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.forumPosts, { min: 8 });
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.phoneMessages, { min: 12 });
  assert.match(CREATIVE_LAWS, /at least 6 posts with 0–3 replies each; at least 2 posts have replies/);
  for (const view of ['moments', 'microblog']) {
    assert.match(CREATIVE_GUIDES[view], /至少 6 条/);
    assert.match(CREATIVE_GUIDES[view], /0–3 条回复，至少 2 条动态有评论互动/);
    assert.match(createCreativeSchema(options(view)), /at least 6 posts, each with 0–3 replies; at least 2 posts have replies/);
  }
});

for (const view of ['moments', 'microblog']) {
  test(`${view} accepts 6 and more posts, but reports missing substance without truncation or invented filler`, () => {
    for (const count of [6, 12, 21]) assert.deepEqual(issues(feed(view, count)), []);
    const short = feed(view, 5), before = structuredClone(short);
    assert.match(issues(short)[0].reason, /至少有 6 条/); assert.equal(issues(short)[0].missing, 1); assert.deepEqual(short, before);
    const quiet = feed(view); quiet.posts[1].replies = [];
    assert.match(issues(quiet)[0].reason, /至少有 2 条带评论互动/);
    const many = feed(view); many.posts[0].replies = Array.from({ length: 4 }, (_, i) => ({ author: `客${i}`, content: `接话${i}` }));
    assert.match(issues(many)[0].reason, /0–3 条完整回复/);
    for (const key of ['author', 'content', 'time', 'replies']) {
      const bad = feed(view); delete bad.posts[0][key]; assert.equal(issues(bad).length, 1, key);
    }
    const duplicate = feed(view); duplicate.posts[1].content = duplicate.posts[0].content;
    assert.match(issues(duplicate)[0].reason, /重复正文/);
    const optional = feed(view); for (const post of optional.posts) for (const key of ['id', 'display_name', 'handle', 'likes']) delete post[key];
    assert.deepEqual(issues(optional), []);
    for (const value of [-1, 1.2, '5', Infinity]) { const bad = feed(view); bad.posts[0].likes = value; assert.match(issues(bad)[0].reason, /非负整数/); }
  });

  test(`${view} excludes USER aliases as owner or author identities, not ordinary references in content`, () => {
    for (const alias of ['{{user}}', 'USER', '用户', '访客', ' Guest ', '@Guest']) {
      const badOwner = feed(view); badOwner.owner = alias; assert.match(issues(badOwner)[0].reason, /USER/);
      for (const key of ['author', 'display_name', 'handle']) {
        const post = feed(view); post.posts[0][key] = alias; assert.match(issues(post)[0].reason, /USER/);
        const reply = feed(view); reply.posts[0].replies[0][key] = alias; assert.match(issues(reply)[0].reason, /USER/);
      }
    }
    const mentions = feed(view); mentions.posts[0].content = '今天公开活动上见到访客，也有人称呼他 Guest。';
    assert.deepEqual(issues(mentions), []);
  });
}

test('one phone page cannot be substituted or mixed, while old view-less chats remain unchanged and readable', () => {
  const old = chat(), before = structuredClone(old);
  assert.deepEqual(issues(old), []); assert.deepEqual(normalizeCreativeSections({ interlude: old }).interlude, before);
  assert.ok(!Object.hasOwn(old, 'view_type'));
  for (const requested of ['chat', 'moments', 'microblog']) for (const emitted of ['chat', 'moments', 'microblog']) {
    const card = emitted === 'chat' ? { ...chat(), view_type: 'chat' } : feed(emitted);
    assert.equal(issues(card, options(requested)).length, Number(requested !== emitted));
  }
  for (const invalid of ['', null, 'timeline']) assert.equal(issues({ ...chat(), view_type: invalid }).length, 1);
  const mixedChat = { ...chat(), posts: [] }; assert.match(issues(mixedChat)[0].reason, /不能混入/);
  for (const key of ['messages', 'conversation_kind']) {
    const mixed = { ...feed('moments'), [key]: key === 'messages' ? [] : 'direct' }; assert.match(issues(mixed)[0].reason, /不能混入/);
  }
});

test('phone feeds remain side material; only a bounded non-factual variety hint can cross a normal request boundary', () => {
  for (const view of ['moments', 'microblog']) {
    const card = feed(view); card.posts[0].content = '私有旁页内容'.repeat(100); card.posts[1].content = 'SECOND_POST_NOT_IN_HINT';
    const plan = { interlude: card, quests: [] }, copy = structuredClone(plan);
    assert.ok(!Object.hasOwn(projectCreativeContinuity(plan), 'interlude'));
    const hint = JSON.parse(recentInterludeHint(card));
    assert.equal(hint.owner, card.owner); assert.equal(hint.first_excerpt.length, 180);
    assert.ok(!JSON.stringify(hint).includes('SECOND_POST_NOT_IN_HINT'));
    assert.deepEqual(plan, copy);
  }
});
