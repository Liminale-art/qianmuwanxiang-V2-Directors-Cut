import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { hashText } from '../qianmu-storyboard-utils.js';
import { selectCreativeOptions, recentInterludeHint } from '../qianmu-creative-runtime.js';
import { CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT, creativeSectionGuidance } from '../qianmu-creative-prompts.js';
import { createCreativeSchema, projectCreativeContinuity } from '../qianmu-creative-contract.js';

const input = { sourceText: '这个世界使用手机。', narrativeText: '店主陈青收起当晚未寄出的信。', characterName: '陈青', personaNames: ['访客'] };
const key = value => [value.interludeType, value.phoneViewType, value.phoneConversationKind, value.fourthWallForm].filter(Boolean).join('/');
const leaves = ['forum', 'phone/chat/direct', 'phone/chat/group', 'phone/moments', 'phone/microblog', 'fourth_wall/diary', 'fourth_wall/scene'];

test('all seven applicable leaves have equal nonzero intervals and one frozen draw per request', () => {
  const counts = new Map();
  for (let i = 0; i < 700; i++) {
    let calls = 0;
    const value = selectCreativeOptions({}, { ...input, random: () => { calls++; return (i + .5) / 700; } });
    const selected = key(value); counts.set(selected, (counts.get(selected) || 0) + 1);
    assert.ok(Object.isFrozen(value));
    creativeSectionGuidance(value); createCreativeSchema(value);
    assert.equal(calls, 1, 'schema and guide reads cannot resample');
  }
  assert.deepEqual([...counts], leaves.map(leaf => [leaf, 100]));
});

test('the selected guide and schema require exactly that leaf, not a model-selected easier alternative', () => {
  for (let i = 0; i < leaves.length; i++) {
    const value = selectCreativeOptions({}, { ...input, random: () => (i + .5) / leaves.length });
    const schema = createCreativeSchema(value), start = schema.indexOf('{\n');
    const card = JSON.parse(schema.slice(start, schema.indexOf('\n\n', start))).interlude;
    assert.equal(card.type, value.interludeType);
    if (value.interludeType === 'fourth_wall') {
      assert.equal(card.form, value.fourthWallForm);
      assert.equal(Object.hasOwn(card, 'entries'), value.fourthWallForm === 'diary');
      assert.equal(Object.hasOwn(card, 'content'), value.fourthWallForm === 'scene');
      assert.ok(!Object.hasOwn(card, 'posts') && !Object.hasOwn(card, 'messages'));
    } else if (value.interludeType === 'phone') {
      assert.equal(card.view_type, value.phoneViewType);
      if (value.phoneViewType === 'chat') assert.equal(card.conversation_kind, value.phoneConversationKind);
    }
  }
});

test('era and selected narrative govern eligibility without treating settings or raw speaker labels as appeared cast', () => {
  for (let i = 0; i < 3; i++) assert.equal(key(selectCreativeOptions({}, {
    ...input, sourceText: '旧时客栈', random: () => (i + .5) / 3,
  })), ['forum', 'fourth_wall/diary', 'fourth_wall/scene'][i]);
  for (let i = 0; i < 5; i++) assert.equal(key(selectCreativeOptions({}, {
    ...input, narrativeText: '', chat: [{ name: '陈青', mes: '未选入的正文不可作为第四墙来源。' }], random: () => (i + .5) / 5,
  })), leaves[i]);
  let calls = 0;
  assert.equal(key(selectCreativeOptions({}, { sourceText: '人物设定：陈青。', random: () => { calls++; return .9; } })), 'forum');
  assert.equal(key(selectCreativeOptions({}, { sourceText: '角色/群聊：古代客栈。group chat', random: () => { calls++; return .9; } })), 'forum', 'host group labels alone are not evidence of mobile devices');
  const off = selectCreativeOptions({ interludeEnabled: false }, { ...input, random: () => { calls++; return .9; } });
  assert.equal(key(off), ''); assert.equal(calls, 0);
});

test('history does not impose a fixed rotation or alter selection probabilities on repeated requests', () => {
  const previous = [null, { type: 'forum', title: '旧论坛' }, { type: 'phone', owner: '旧人物', title: '旧页面' },
    { type: 'fourth_wall', form: 'diary', character: '陈青', title: '旧标题', entries: [{ time: '昨日', content: '旧破墙经历。' }] }];
  for (const previousInterlude of previous) {
    for (let i = 0; i < leaves.length; i++) {
      const value = selectCreativeOptions({}, { ...input, previousInterlude, random: () => (i + .5) / 7 });
      assert.equal(key(value), leaves[i]);
    }
  }
});

test('fourth-wall words never become future continuity or variety excerpts; read-only metadata stays bounded', () => {
  for (const form of ['diary', 'scene']) {
    const card = { type: 'fourth_wall', form, character: '陈青'.repeat(100), title: 'META_SECRET_TITLE', content: 'META_SECRET_SCENE',
      entries: [{ time: 'META_SECRET_TIME', content: 'META_SECRET_DIARY' }] };
    const original = structuredClone(card), hint = recentInterludeHint(card);
    assert.deepEqual(Object.keys(JSON.parse(hint)), ['type', 'form', 'character']);
    assert.equal(JSON.parse(hint).character.length, 60); assert.doesNotMatch(hint, /META_SECRET/);
    assert.ok(!Object.hasOwn(projectCreativeContinuity({ interlude: card }), 'interlude'));
    assert.deepEqual(card, original);
  }
});

test('exact v456-v458 built-in defaults upgrade while DIY, backups, old cards and world checkpoints survive', () => {
  const fingerprints = { 'v457-system': '24243610', 'v457-schema': '2705ca8b', 'v457-blueprint': 'e8c57aa2',
    'v458-system': '04b8c901', 'v458-schema': '8c9d7978', 'v458-blueprint': 'e8c57aa2' };
  const sandbox = vm.createContext({ hashText: value => fingerprints[value] || hashText(value) });
  const runtime = fs.readFileSync(new URL('../qianmu-creative-runtime.js', import.meta.url), 'utf8');
  vm.runInContext(runtime.replace(/^import .+;\r?$/gm, '').replace(/^export /gm, ''), sandbox);
  const next = { systemPrompt: CREATIVE_SYSTEM_PROMPT, outputSchemaText: createCreativeSchema(), blueprint: CREATIVE_BLUEPRINT };
  for (const prior of ['v457', 'v458']) for (const marker of [undefined, '__legacy__']) {
    const system = `${prior}-system`, schema = `${prior}-schema`, blueprint = `${prior}-blueprint`;
    const settings = { systemPrompt: system, outputSchemaText: schema, appliedPromptDefaultHash: marker, appliedSchemaDefaultHash: marker,
      systemPromptBackup: system, outputSchemaBackup: 'manual', templates: [{ id: 'default-free-blueprint', content: blueprint }, { id: 'mine', content: blueprint }] };
    sandbox.upgradeCreativeDefaults(settings, next);
    assert.equal(settings.systemPrompt, next.systemPrompt); assert.equal(settings.outputSchemaText, next.outputSchemaText);
    assert.equal(settings.systemPromptBackup, system); assert.equal(settings.outputSchemaBackup, 'manual');
    assert.equal(settings.templates[0].content, next.blueprint); assert.equal(settings.templates[1].content, blueprint);
    const stable = structuredClone(settings); sandbox.upgradeCreativeDefaults(settings, next); assert.deepEqual(settings, stable);
    const store = { blueprint, appliedBlueprintDefaultHash: marker, history: [{ interlude: { type: 'phone', content: '旧原文' } }],
      factions: [{ name: '旧组织' }], geoNodeCheckpoint: { version: 1, base: { geoSeq: 8 } } };
    const before = structuredClone(store); sandbox.upgradeCreativeBlueprint(store, next.blueprint, 7);
    assert.equal(store.blueprint, next.blueprint);
    for (const field of ['history', 'factions', 'geoNodeCheckpoint']) assert.deepEqual(store[field], before[field]);
    const custom = { systemPrompt: system + '。', outputSchemaText: schema + '。', appliedPromptDefaultHash: marker, appliedSchemaDefaultHash: marker,
      templates: [{ id: 'default-free-blueprint', content: blueprint + '。' }, { id: 'default-free-blueprint', content: blueprint, edited: true }] };
    const copy = structuredClone(custom); sandbox.upgradeCreativeDefaults(custom, next); assert.deepEqual(custom.templates, copy.templates);
    assert.equal(custom.systemPrompt, copy.systemPrompt); assert.equal(custom.outputSchemaText, copy.outputSchemaText);
  }
});
