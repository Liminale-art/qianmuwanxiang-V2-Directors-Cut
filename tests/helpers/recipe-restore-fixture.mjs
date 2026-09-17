import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRecipeArchiveService } from '../../qianmu-recipe-archive-service.js';
import { createRecipeArchiveStore } from '../../qianmu-recipe-archive-store.js';
import { recipeArchiveEnvelope, recipeArchiveErrorPayload } from '../../qianmu-recipe-archive-contract.js';
import { createRecipeRestoreClient } from '../../qianmu-recipe-restore-client.js';
import { recipe } from './recipe-client-fixture.mjs';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const account = name => 'st-user:' + sha(name);
export const target = { kind: 'character', avatar: 'Alice.png', chatId: 'chat' };
export function restoreRequest({ snapshot = recipe(' full original\n'), source = { target, recordId: 'image', createdAt: 1 }, owner = 'alice' } = {}) {
  const envelope = recipeArchiveEnvelope({ version: 1, expectedAccount: account(owner), source, snapshot });
  const hash = sha(envelope.text), bytes = Buffer.byteLength(envelope.text);
  return { ...envelope.value, confirmed: true, originalReference: { version: 1, id: hash + '-' + randomUUID(), sha256: hash, bytes } };
}
export const clientInput = ({ source, snapshot, originalReference }) => ({ source, snapshot, originalReference });
export const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
export async function recipeRestoreFixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-recipe-restore-'));
  const user = path.join(root, 'alice'), chats = path.join(user, 'chats'), folder = path.join(chats, 'Alice');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, 'chat.jsonl');
  await fs.writeFile(file, JSON.stringify({ chat_metadata: { story_director_liminale: { storyboardImages: [], unknown: 'unchanged' } } }) + '\n' + JSON.stringify({ mes: 'PRIVATE_BODY' }) + '\n');
  const service = createRecipeArchiveService({ dataRoot: root, ...options }), store = createRecipeArchiveStore({ dataRoot: root, ...options });
  const req = { user: { profile: { handle: 'alice', enabled: true }, directories: { root: user, chats, groupChats: path.join(user, 'group chats') } } };
  const clients = [], f = { root, user, file, archive: path.join(user, '.qianmu-recipes-v1'), service, store, req, calls: [], active: true,
    async fetch(url, options) {
      assert.equal(url, '/api/plugins/qianmu-tts/chat-gallery/recipe/restore');
      const body = JSON.parse(options.body); f.calls.push({ url, ...options, body });
      try { return Response.json(await service.restore(req, body, { signal: options.signal })); }
      catch (error) { const result = recipeArchiveErrorPayload(error); return Response.json(result.body, { status: result.status }); }
    },
    client(options = {}) { const client = createRecipeRestoreClient({ namespace: 'st-user:alice', guard: () => f.active, fetchImpl: f.fetch, ...options }); clients.push(client); return client; },
    async close() { f.active = false; clients.forEach(client => client.close()); await Promise.all([service.close(), store.close()]);
      const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^qianmu-recipe-restore-/); await fs.rm(resolved, { recursive: true }); },
  };
  t?.after(() => f.close()); return f;
}
