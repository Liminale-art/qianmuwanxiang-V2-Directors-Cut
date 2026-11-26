import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATIVE_COUNTS, CREATIVE_DETAIL_COUNTS, CREATIVE_GUIDES, CREATIVE_LAWS,
  creativeSectionGuidance,
} from '../qianmu-creative-prompts.js';
import {
  createCreativeSchema, normalizeCreativeSections, validateCreativePlan,
  pruneInvalidCreativeItems, projectCreativeContinuity,
} from '../qianmu-creative-contract.js';

const selected = form => ({ interludeType: 'fourth_wall', fourthWallForm: form, personaNames: ['访客', 'Guest'], parallelSceneEnabled: false });
const diary = (lengths = [450, 250, 300, 600, 400]) => ({
  type: 'fourth_wall', form: 'diary', title: '墙外没有回信', character: '阿岚',
  entries: lengths.map((length, index) => ({ time: `第${index + 1}日`, content: String.fromCodePoint(0x4e00 + index).repeat(length) })),
});
// 人间小传（2026-11-26 起替代第四面墙的「旁观一幕」）：主角之外的已出场人物的独立短篇。
const vselected = () => ({ interludeType: 'vignette', personaNames: ['访客', 'Guest'], characterNames: ['阿岚'], parallelSceneEnabled: false });
const vignette = () => ({ type: 'vignette', title: '收摊以后', character: '老周', content: '老周把铁皮棚子的最后一根撑杆放倒，数了三遍零钱，还是差两块。他想了想，把那两块记在了自己账上。' });
const legacyScene = () => ({ type: 'fourth_wall', form: 'scene', title: '留一扇窗', character: '阿岚', content: '她把纸条留在窗沿，收回手时，窗外传来另一声轻叩。' });
const problems = (card, options = card.type === 'vignette' ? vselected() : selected(card.form)) => validateCreativePlan({ interlude: card }, options).filter(issue => issue.field === 'interlude');
const parseShape = schema => {
  const start = schema.indexOf('{\n'), end = schema.indexOf('\n\n', start);
  return JSON.parse(schema.slice(start, end));
};

test('fourth wall keeps the one-card quota with diary as its only form; 人间小传 has its own structure', () => {
  assert.equal(CREATIVE_COUNTS.interlude.min, 1);
  assert.equal(CREATIVE_COUNTS.interlude.max, 1);
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.fourthWallEntries, { min: 5 });
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.fourthWallHanChars, { min: 2000 });
  const schema = createCreativeSchema(selected('diary')), card = parseShape(schema).interlude;
  assert.equal(card.type, 'fourth_wall');assert.equal(card.form, 'diary');
  assert.deepEqual(Object.keys(card), ['type', 'form', 'title', 'character', 'entries']);
  assert.match(schema, /non-canonical/);assert.match(schema, /already encountered mainline character/);assert.match(schema, /USER and every alias/);
  assert.doesNotMatch(schema, /Forum form:|Phone form:|Phone moments form:|Vignette form/);
  assert.match(schema, /at least 5 entries across time/);
  assert.match(schema, /combined content must contain at least 2000 Chinese Han characters, not 2000 per entry/);
  assert.match(schema, /No upper limit or equal-length requirement/);
  assert.throws(() => createCreativeSchema(selected('scene')), { code: 'creative_fourth_wall_form_required' }, 'the old scene form is no longer offered');
  const vschema = createCreativeSchema(vselected()), vcard = parseShape(vschema).interlude;
  assert.deepEqual(Object.keys(vcard), ['type', 'title', 'character', 'content']);
  assert.equal(vcard.type, 'vignette');
  assert.match(vschema, /Vignette form \(人间小传\)/);
  assert.match(vschema, /excluding CHAR names \["阿岚"\] and USER with every alias \["访客","Guest"\]/);
  assert.doesNotMatch(vschema, /Fourth-wall form:|entries across time/);
});

test('only the chosen guide is included; 人间小传 uses the user-approved text and never the fourth-wall premise', () => {
  const guide = creativeSectionGuidance(selected('diary'));
  assert.ok(guide.includes(CREATIVE_GUIDES.fourth_wall));assert.ok(guide.includes(CREATIVE_GUIDES.fourth_wall_diary));
  assert.ok(!guide.includes(CREATIVE_GUIDES.vignette));
  for (const key of ['forum', 'phone', 'phone_chat', 'moments', 'microblog']) assert.ok(!guide.includes(CREATIVE_GUIDES[key]), key);
  assert.equal(CREATIVE_GUIDES.fourth_wall_scene, undefined);
  const vguide = creativeSectionGuidance(vselected());
  assert.match(vguide, /### 人间小传\n\n从本轮正文与有效记忆中选取一位已出场人物，创作其专属独立叙事短篇。/);
  assert.ok(!vguide.includes(CREATIVE_GUIDES.fourth_wall), 'no wall-breaking premise');
  assert.match(CREATIVE_GUIDES.vignette, /排除\{\{char\}\}、\{\{user\}\}及其别名、身份映射/);
  assert.match(CREATIVE_GUIDES.vignette, /小人物的悲欢自有其分量/);
  assert.match(CREATIVE_GUIDES.vignette, /只输出 content ，不混入其他体裁。$/);
  assert.match(CREATIVE_GUIDES.interlude, /世界论坛、角色手机、第四面墙或人间小传形式/);
  for (const form of [undefined, '', 'chat', 'DIARY', 'scene']) {
    const options = { ...selected('diary'), fourthWallForm: form };
    assert.throws(() => creativeSectionGuidance(options), { code: 'creative_fourth_wall_form_required' });
    assert.throws(() => createCreativeSchema(options), { code: 'creative_fourth_wall_form_required' });
    assert.ok(problems(diary(), options).some(issue => /未指定/.test(issue.reason)));
  }
  assert.doesNotThrow(() => createCreativeSchema({ interludeEnabled: false, interludeType: 'fourth_wall' }));
  assert.doesNotThrow(() => creativeSectionGuidance({ interludeEnabled: false, interludeType: 'fourth_wall' }));
});

test('writing boundaries preserve personality, equal cast opportunity and private reality separation', () => {
  assert.match(CREATIVE_LAWS, /protagonist status neither earns nor removes priority/);
  assert.match(CREATIVE_LAWS, /never USER or an alias, a merely listed setting character, or a newly invented side-page person/);
  assert.match(CREATIVE_LAWS, /not a global exception to character knowledge or USER agency/);
  assert.match(CREATIVE_LAWS, /remains conjecture, not claimed knowledge of real identity, private life/);
  assert.match(CREATIVE_LAWS, /Do not write these side stories into mainline memory, continuity references, or narrative injection/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /先是这个具体的人，才是破墙机关/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /不因主角、配角地位增加或减少机会/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /不按职业分配觉醒模板/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /以自身口吻猜想墙外的你/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /不把 persona 当成真实用户的身份或隐私证据/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /氛围与结局自由/);
  assert.match(CREATIVE_GUIDES.fourth_wall_diary, /至少 5 则以上/);
  assert.match(CREATIVE_GUIDES.fourth_wall_diary, /正文合计至少 2000 个中文汉字，不是每则 2000 字/);
  assert.match(CREATIVE_GUIDES.fourth_wall_diary, /不得为满足格式强造固定习惯或篡改人格/);
  assert.match(CREATIVE_GUIDES.vignette, /不做意义总结与结局升华/);
  const hintGuide = creativeSectionGuidance({ ...selected('diary'), recentInterludeHint: '{"type":"fourth_wall","form":"diary","character":"阿岚"}' });
  assert.match(hintGuide, /第四面墙只参考形式与人物元信息，不以此证明角色在主线有过觉察/);
  assert.match(hintGuide, /不因上轮人物的主配角地位增加或减少机会，也不硬性换人/);
});

test('fourth-wall guidance starts inside the premise and carries the same relational you across forms', () => {
  assert.match(CREATIVE_LAWS, /premise already in effect, not a discovery or verification sequence/);
  assert.match(CREATIVE_LAWS, /rather than inventing a second outside observer; where the character knows USER, this is the same relational "you"/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /直接进入本篇破墙前提已经成立的叙事/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /已有的相识与关系在此延续，而不是另立一个陌生旁观者/);
  assert.match(CREATIVE_GUIDES.fourth_wall_diary, /从第一则就进入破墙后的个人记录/);
  assert.match(CREATIVE_GUIDES.fourth_wall_diary, /日记仍是写给自己的记录，未必每则都直接呼告/);
  for (const form of ['diary']) {
    const schema = createCreativeSchema(selected(form)), card = parseShape(schema).interlude;
    const prose = card.entries[0].content;
    assert.match(prose, /premise (?:is |already )?in effect/);
    assert.match(schema, /through USER with any existing relationship preserved, not as a new outside stranger/);
    assert.doesNotMatch(prose, /notice the invisible wall|Let awareness, choices/);
    assert.doesNotMatch(schema, /observe discovery, action and concrete consequences/);
  }
});

test('fourth-wall closeness is grounded without forcing acquaintance, intimacy or factual private access', () => {
  assert.match(CREATIVE_LAWS, /Preserve personality and the established relationship stage/);
  assert.match(CREATIVE_LAWS, /wishes may reach ahead, but imagined futures are not shared memories or proof of USER's intimacy, commitment or consent/);
  assert.match(CREATIVE_LAWS, /actual distance from USER, including no acquaintance/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /双方具体经历、当前关系阶段、未尽之言，以及有依据的未来可能性/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /未来可能性在本篇内展开，不倒写成已有共同记忆/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /愿望可以超前，但不把尚未获得的亲近、承诺或你的回应写成已成立/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /尚无直接交集就不强造旧交或亲密/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /不强求感动、恋爱、表白/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /猜想保留不确定/);
  assert.match(CREATIVE_GUIDES.fourth_wall, /也不替你回应或决定/);
  for (const form of ['diary']) {
    const schema = createCreativeSchema(selected(form));
    assert.match(schema, /preserves personality, relationship stage and USER agency/);
    assert.match(schema, /grants neither private knowledge nor mainline facts/);
  }
});

test('fourth-wall presence grows through character-specific opportunities without a compulsory mood or checklist', () => {
  const guide = CREATIVE_GUIDES.fourth_wall;
  assert.match(guide, /关系已亲近时/);
  assert.match(guide, /可以似有意又无意地越过故事中的 USER，落向正在读到这里的你/);
  assert.match(guide, /亲近与距离的张力从已有相处自然生长/);
  assert.match(guide, /一句特有的幽默、体贴里的笨拙、欲言又止的保留、矛盾中仍然作出的选择/);
  assert.match(guide, /合乎人物时可用的机会，而非逐项安排的清单/);
  assert.match(guide, /由人物决定说透还是保留/);
  assert.match(guide, /其他角色也保有独立生活与 USER 的实际距离/);
  assert.match(guide, /氛围与结局自由，不强求感动、恋爱、表白或任何固定情绪/);
  assert.match(guide, /不假称知道真实姓名、位置、设备、现实活动或内心，也不替你回应或决定/);
  assert.match(CREATIVE_LAWS, /Do not decide the reader's response or assign real-world obligations/);
});

test('diary admits unequal entry lengths and applies its floor to all body content combined', () => {
  const card = diary([1500, 100, 100, 100, 200]);
  assert.deepEqual(problems(card), []);
  assert.deepEqual(problems(diary([5000, 20, 30, 50, 100, 200])), []);
  const partial = diary([1500, 100, 100, 100, 199]);
  assert.ok(problems(partial).some(issue => /整组正文.*2000/.test(issue.reason)));
  assert.deepEqual(problems(vignette()), [], '人间小传 does not inherit diary length or entry counts');
});

test('diary counts only Han codepoints in entry content, including supplementary Han', () => {
  const card = diary([399, 400, 400, 400, 400]);
  card.title += '标题'.repeat(2000);
  card.character += '姓名'.repeat(2000);
  card.entries.forEach(entry => { entry.time += '日期'.repeat(2000); entry.content += 'abcdef 123 !，。🙂'.repeat(300); });
  assert.ok(problems(card).some(issue => /整组正文/.test(issue.reason)), 'metadata, punctuation, Latin letters, digits and emoji cannot bridge a one-Han shortfall');
  card.entries[0].content += '\u{20000}';
  assert.deepEqual(problems(card), [], 'one supplementary Han is exactly one character');
  const supplementary = diary([399, 400, 400, 400, 400]);
  supplementary.entries[0].content = '\u{20000}'.repeat(399);
  assert.ok(problems(supplementary).some(issue => /整组正文/.test(issue.reason)), 'UTF-16 surrogate pairs must not count twice');
  const emptyHan = diary([0, 0, 0, 0, 0]);
  emptyHan.entries.forEach((entry, index) => { entry.content = `Entry ${index}: ${'words and punctuation 123.'.repeat(2000)}`; });
  assert.ok(problems(emptyHan).some(issue => /整组正文/.test(issue.reason)));
});

test('diary rejects insufficient entries, placeholders and duplicate bodies without guessing chronology from labels', () => {
  for (const mutate of [
    card => { card.entries.pop(); },
    card => { card.entries = {}; },
    card => { card.entries[0] = null; },
    card => { card.entries[0].time = ' '; },
    card => { card.entries[0].content = '待补充'; },
    card => { card.entries[0].content = 5000; },
    card => { card.entries[1].content = ` \n${card.entries[0].content}\n `; },
  ]) {
    const card = diary(); mutate(card);
    assert.ok(problems(card).length, JSON.stringify(card).slice(0, 160));
  }
  const relative = diary(); relative.entries.forEach(entry => { entry.time = '次日'; });
  assert.deepEqual(problems(relative), [], 'repeated relative time labels do not prove the entries share one instant');
});

test('fresh fourth-wall and 人间小传 output cannot mix forms or smuggle other fields', () => {
  assert.ok(problems(diary(), vselected()).some(issue => /本轮指定形式/.test(issue.reason)));
  assert.ok(problems(vignette(), selected('diary')).some(issue => /本轮指定形式/.test(issue.reason)));
  for (const [key, value] of Object.entries({ posts: [], messages: [], owner: '阿岚', view_type: 'chat', conversation_kind: 'direct', content: '' })) {
    const card = diary(); card[key] = value;
    assert.ok(problems(card).some(issue => /混入/.test(issue.reason)), `diary: ${key}`);
  }
  for (const [key, value] of Object.entries({ posts: [], messages: [], entries: [], form: 'scene', owner: '老周' })) {
    const card = vignette(); card[key] = value;
    assert.ok(problems(card).some(issue => /混入/.test(issue.reason)), `vignette: ${key}`);
  }
  for (const [make, keys] of [[diary, ['title', 'character', 'entries']], [vignette, ['title', 'character', 'content']]]) {
    for (const key of keys) { const card = make(); delete card[key]; assert.ok(problems(card).length, `missing ${key}`); }
    assert.ok(problems(make(), { interludeType: 'forum' }).some(issue => /本轮指定形式/.test(issue.reason)));
    const card = make();
    assert.ok(problems(card, { ...(card.type === 'vignette' ? vselected() : selected('diary')), interludeEnabled: false }).some(issue => issue.disabled));
  }
  const card = diary(); card.entries[0].author = '访客';
  assert.ok(problems(card).some(issue => /混入其他字段/.test(issue.reason)));
});

test('USER and aliases are excluded as fourth-wall subjects; 人间小传 also excludes CHAR', () => {
  for (const name of ['USER', '{{user}}', '<user>', '用户', '访 客', '@Guest', 'Ｇｕｅｓｔ']) {
    for (const make of [diary, vignette]) {
      const card = make(); card.character = name;
      assert.ok(problems(card).some(issue => /USER/.test(issue.reason)), `${card.type}: ${name}`);
    }
  }
  const card = vignette(); card.character = '阿岚';
  assert.ok(problems(card).some(issue => /CHAR/.test(issue.reason)), 'CHAR is the protagonist, not a 人间小传 subject');
  const ok = vignette(); ok.content = '老周想起访客说过的话，没有替任何人作答。';
  assert.deepEqual(problems(ok), [], 'mentions do not silently change the structured subject');
  const wall = diary(); wall.character = '阿岚';
  assert.deepEqual(problems(wall, { ...selected('diary'), characterNames: ['阿岚'] }), [], 'the fourth wall may still choose CHAR');
});

test('legacy and new history remain lossless while invalid fresh cards stay in removed diagnostics', () => {
  for (const card of [diary([1, 2, 3, 4]), legacyScene(), vignette(), { type: 'theater', title: '旧趣味', content: '旧文本', custom: { kept: true } }]) {
    const snapshot = structuredClone(card), plan = { interlude: card };
    assert.deepEqual(normalizeCreativeSections(plan).interlude, snapshot);
    assert.deepEqual(card, snapshot);
  }
  const card = diary([1, 2, 3, 4, 5]), snapshot = structuredClone(card);
  const pruned = pruneInvalidCreativeItems({ interlude: card }, selected('diary'));
  assert.equal(pruned.plan.interlude, null);
  assert.deepEqual(pruned.removed.find(item => item.field === 'interlude').value, snapshot);
  assert.deepEqual(card, snapshot);
});

test('fourth-wall material cannot enter the continuity whitelist at top level or through nested extras', () => {
  const card = diary();
  card.entries[0].content = '独立番外哨兵'.repeat(500);
  const projected = projectCreativeContinuity({
    interlude: card,
    story_status: { title: '保留的标题', interlude: card },
    quests: [{ subject: '阿岚', description: '正常预演', fourth_wall: card }],
    npc_updates: [{ name: '老周', content: { interlude: card } }],
    custom: { renamed_side_page: card },
  });
  assert.doesNotMatch(JSON.stringify(projected), /独立番外哨兵|fourth_wall|entries|interlude/);
  assert.equal(projected.quests[0].description, '正常预演');
});

test('forum and phone keep their own eligibility and quotas, without fourth-wall restrictions', () => {
  const forum = { type: 'forum', title: '街坊闲聊', posts: Array.from({ length: 8 }, (_, index) => ({ author: `路人${index}`, handle: `side_${index}`, content: `今日第${index}件日常事。`, time: '今天', replies: [{ author: '新邻居', content: '明天见。' }] })) };
  const phone = { type: 'phone', title: '新邻居', owner: '本轮独立旁页人物', view_type: 'chat', conversation_kind: 'direct', messages: Array.from({ length: 12 }, (_, index) => ({ sender: index % 2 ? '新邻居' : '本轮独立旁页人物', content: `第${index}条互相回应。`, time: `午后${index}` })) };
  assert.deepEqual(problems(forum, { interludeType: 'forum' }), []);
  assert.deepEqual(problems(phone, { interludeType: 'phone', phoneConversationKind: 'direct' }), []);
  for (const type of ['forum', 'phone']) {
    const guide = creativeSectionGuidance({ interludeType: type });
    assert.ok(!guide.includes(CREATIVE_GUIDES.fourth_wall));
    assert.match(guide, /论坛和手机允许创作有自身生活的旁页人物，不套用第四面墙的已登场人物限制/);
    const schema = createCreativeSchema({ interludeType: type });
    assert.doesNotMatch(schema, /Fourth-wall form:|already encountered mainline character/);
  }
});
