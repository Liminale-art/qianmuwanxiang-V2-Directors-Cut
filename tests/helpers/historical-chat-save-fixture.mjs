import * as fs from 'node:fs/promises';
import { chatStateFixture } from './chat-state-fixture.mjs';
import { createHistoricalChatSaveSession } from '../../qianmu-historical-chat-save.js';
import { captureStoryboardChatEvidence } from '../../qianmu-storyboard-chat-evidence.js';
import { chatCharacterReceiptErrorPayload } from '../../qianmu-chat-character-receipt.js';
export const consent = { confirmed: true, scope: 'historical-chat-metadata-only' };
export const gate = () => { let release; const promise = new Promise(done => release = done); return { promise, release }; };
export async function historicalChatSaveFixture(t) {
  const f = await chatStateFixture(), close = f.close, sessions = [];
  const header = f.header(), metadata = structuredClone(header.chat_metadata);
  f.store = metadata.story_director_liminale; f.namespace = 'st-user:alice'; f.epoch = 0; f.active = true; f.saves = 0; f.calls = [];
  f.context = { chatId: f.target.chatId, characterId: 0, groupId: null, characters: [{ avatar: f.target.avatar, chat: f.target.chatId }],
    chat: structuredClone(f.messages), chatMetadata: metadata, getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE' }),
    saveMetadata() { f.saves++; return f.host(); } };
  // Test-only ST-shaped writer; production delegates to ST and never writes JSONL.
  f.persist = async () => fs.writeFile(f.file, [JSON.stringify({ ...header, chat_metadata: f.context.chatMetadata }), ...f.context.chat.map(row => JSON.stringify(row))].join('\n') + '\n');
  f.host = f.persist;
  f.fetch = async (url, options) => {
    const method = url.endsWith('/state') ? 'readGalleryState' : url.endsWith('/evidence') ? 'readGalleryEvidence' : url.endsWith('/chat-characters/receipt') ? 'inspect' : null;
    if (!method) throw Error('Unexpected save-stage endpoint'); const body = JSON.parse(options.body); f.calls.push({ url, ...options, body });
    try { return Response.json(await f.service[method](f.req, body, { signal: options.signal })); }
    catch (error) { const response = chatCharacterReceiptErrorPayload(error); return Response.json(response.body, { status: response.status }); }
  };
  f.options = () => ({ getContext: () => f.context, epoch: () => f.epoch, namespace: 'st-user:alice', account: async () => f.namespace,
    guard: async () => f.active, isCurrent: () => f.active, fetchImpl: f.fetch, timeoutMs: 3000, hostTimeoutMs: 100 });
  f.open = options => { const session = createHistoricalChatSaveSession({ ...f.options(), ...options }); sessions.push(session); return session; };
  const before = structuredClone(f.saved), after = structuredClone(f.saved);
  after.storyboardImages.push({ id: 'restored', createdAt: 99, future: { keep: '  exact  ', zero: 0 } });
  after.storyboardCollections.push({ id: 'new-album', name: '原册', future: false });
  after.characterDrafts.items[0].future.note = '  original extension restored  ';
  f.proposal = { namespace: f.namespace, target: f.target, before, after, chatEvidence: await captureStoryboardChatEvidence(f.messages, f.target.chatId), fileHash: 'a'.repeat(64) };
  f.close = async () => { f.active = false; sessions.forEach(session => session.close()); await close(); }; t?.after(() => f.close());
  return f;
}
