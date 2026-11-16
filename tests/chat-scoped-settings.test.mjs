import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chatScopedTables, forgetChatSettings, renameChatSettings, chatKeyFromFileName } from '../features/chat/qianmu-chat-scoped-settings.js';

const fixture = () => ({
  selectedWorldBookNamesByChat: { a: { book: true }, b: { other: true } }, selectedWorldBookItemsByChat: { a: { book: { 1: true } } },
  selectedPresetNamesByChat: { a: {} }, selectedPresetItemsByChat: {}, enabledWorldBooksByChat: { a: ['x'] },
  focusClock: { voiceEnabledByChat: { a: true }, voiceSpeakerByChat: { a: 'N' }, voiceRelationByChat: { b: 'friend' } },
  tts: { providers: { one: { npcAssignByChat: { a: { guard: 'v1' } } }, two: { npcAssignByChat: { b: {} } }, three: {} } },
  selectedPresetNames: { a: true }, globalWorldBookNames: { a: true },
});

test('all per-chat tables are covered, and only those', () => {
  assert.equal(chatScopedTables(fixture()).length, 10);
  assert.deepEqual(chatScopedTables(null), []); assert.deepEqual(chatScopedTables({ focusClock: 1, tts: { providers: [] } }), []);
});

test('deleting a chat removes its entries everywhere and nothing else', () => {
  const settings = fixture();
  assert.equal(forgetChatSettings(settings, 'a'), true);
  for (const table of chatScopedTables(settings)) assert.equal(Object.hasOwn(table, 'a'), false);
  assert.deepEqual(settings.selectedWorldBookNamesByChat, { b: { other: true } });
  assert.deepEqual(settings.focusClock.voiceRelationByChat, { b: 'friend' }); assert.deepEqual(settings.tts.providers.two.npcAssignByChat, { b: {} });
  assert.deepEqual(settings.selectedPresetNames, { a: true }, 'global selections keyed by preset/book name are untouched');
  assert.deepEqual(settings.globalWorldBookNames, { a: true });
  assert.equal(forgetChatSettings(settings, 'a'), false, 'nothing left: no save needed');
  assert.equal(forgetChatSettings(settings, ''), false);
});

test('renaming moves entries; the .jsonl extension ST reports on rename is ignored; an existing target wins', () => {
  assert.equal(chatKeyFromFileName('c - 1.jsonl'), 'c - 1'); assert.equal(chatKeyFromFileName('c - 1'), 'c - 1');
  const settings = fixture(); settings.selectedWorldBookNamesByChat.z = { keep: true };
  assert.equal(renameChatSettings(settings, 'a.jsonl', 'z.jsonl'), true);
  assert.deepEqual(settings.selectedWorldBookNamesByChat.z, { keep: true });
  assert.deepEqual(settings.focusClock.voiceSpeakerByChat, { z: 'N' }); assert.deepEqual(settings.tts.providers.one.npcAssignByChat, { z: { guard: 'v1' } });
  for (const table of chatScopedTables(settings)) assert.equal(Object.hasOwn(table, 'a'), false);
  assert.equal(renameChatSettings(settings, 'q', 'q'), false); assert.equal(renameChatSettings(settings, 'missing', 'x'), false);
});

test('the entry listens for chat deletion (both kinds) and renames, and saves only when something changed', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  for (const pair of ["[types.CHAT_DELETED || 'chat_deleted', chatDeletedHandler]", "[types.GROUP_CHAT_DELETED || 'group_chat_deleted', chatDeletedHandler]", "[types.CHAT_RENAMED || 'chat_renamed', chatRenamedHandler]"]) assert.ok(entry.includes(pair), pair);
  assert.match(entry, /const chatDeletedHandler = name => \{ if \(forgetChatSettings\(settings, name\)\) saveSettings\(\); \};/);
  assert.match(entry, /renameChatSettings\(settings, data\?\.oldFileName, data\?\.newFileName\)\) saveSettings\(\)/);
});
