import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { historicalRecipeRestoreFixture } from './historical-recipe-restore-fixture.mjs';
import { createImageRestoreService } from '../../qianmu-image-restore-service.js';
import { imageRestoreErrorPayload } from '../../qianmu-image-restore-contract.js';
import { createHistoricalRestore } from '../../qianmu-historical-restore.js';
import { inspectHistoricalChatMutation, historicalChatMutationNext } from '../../qianmu-historical-chat-journal.js';

// Real services and isolated JSONL/files; only ST's native writer and IDB are
// substituted here. Browser coverage supplies real IDB and the same services.
export async function historicalRestoreFixture(t, options) {
  const f = await historicalRecipeRestoreFixture(null, options), end = f.close, sessions = [];
  f.images = path.join(f.user, 'user', 'images'); await fs.mkdir(f.images, { recursive: true });
  f.req.user.directories.userImages = f.images;
  f.imageService = createImageRestoreService({ dataRoot: f.root });
  f.namespace = f.account; f.epoch = 0; f.saves = 0; f.traffic = [];
  const header = f.header();
  f.context = { chatId: f.target.chatId, characterId: 0, groupId: null, characters: [{ avatar: f.target.avatar, chat: f.target.chatId }],
    chat: structuredClone(f.messages), chatMetadata: structuredClone(header.chat_metadata),
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE' }), saveMetadata() { f.saves++; return f.host(); } };
  f.persist = async () => fs.writeFile(f.file, [JSON.stringify({ ...header, chat_metadata: f.context.chatMetadata }), ...f.context.chat.map(row => JSON.stringify(row))].join('\n') + '\n');
  f.host = f.persist;
  f.reload = async () => {
    const [head, ...chat] = (await fs.readFile(f.file, 'utf8')).trimEnd().split('\n').map(JSON.parse);
    f.context.chatMetadata = head.chat_metadata; f.context.chat = chat; f.epoch++;
  };
  f.hideArchive = async () => { const ref = f.rows[1].snapshotServerRef; await fs.rename(path.join(f.archive, ref.id + '.json'), path.join(f.archive, ref.id + '.retained')); };
  let record = null;
  f.journal = {
    calls: [], get record() { return structuredClone(record); },
    async loadHistoricalChatMutation(namespace, { isCurrent = () => true } = {}) { assert.ok(isCurrent()); return record?.namespace === namespace ? structuredClone(record) : null; },
    async prepareHistoricalChatMutation(input, { confirmed, isCurrent } = {}) { assert.equal(confirmed, true); assert.ok(isCurrent()); assert.equal(record, null); this.calls.push('prepared'); record = await inspectHistoricalChatMutation(input); return structuredClone(record); },
    async updateHistoricalChatMutation(input, phase, { isCurrent } = {}) { assert.ok(isCurrent()); assert.deepEqual(record, input); this.calls.push(phase); record = historicalChatMutationNext(input, phase, Date.now()); return structuredClone(record); },
  };
  f.fullFetch = async (url, options = {}) => {
    f.traffic.push({ url, options });
    if (url.includes('/image/restore/')) {
      const method = url.split('/').at(-1);
      try { return Response.json(await f.imageService[method](f.req, options.body ? JSON.parse(options.body) : undefined, { signal: options.signal })); }
      catch (error) { const result = imageRestoreErrorPayload(error); return Response.json(result.body, { status: result.status }); }
    }
    return url.endsWith('/recipe/restore') ? f.restoreFetch(url, options) : f.fetch(url, options);
  };
  f.open = overrides => { const session = createHistoricalRestore({ file: f.packed.file, namespace: f.account,
    getContext: () => f.context, epoch: () => f.epoch, account: async () => f.namespace, guard: async () => f.active, isCurrent: () => f.active,
    journal: f.journal, fetchImpl: f.fullFetch, ...overrides }); sessions.push(session); return session; };
  f.apply = async session => { const view = await session.preview(); return session.restore({ confirmed: true, dependenciesAccepted: true, expectedDigest: view.digest }); };
  f.close = async () => { sessions.forEach(session => session.close()); await f.imageService.close(); await end(); }; t?.after(() => f.close());
  return f;
}
