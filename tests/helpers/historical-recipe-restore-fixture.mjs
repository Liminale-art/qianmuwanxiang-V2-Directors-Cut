import path from 'node:path';
import { historicalSourceFixture } from './historical-source-fixture.mjs';
import { recipe } from './recipe-client-fixture.mjs';
import { png } from './historical-original-restore-fixture.mjs';
import { captureHistoricalStoryboardBundle } from '../../qianmu-historical-storyboard-bundle.js';
import { createHistoricalRecipeRestore } from '../../qianmu-historical-recipe-restore.js';
import { recipeArchiveErrorPayload } from '../../qianmu-recipe-archive-contract.js';

export async function historicalRecipeRestoreFixture(t, { prepare, extraArchives = 0, recordIds } = {}) {
  const f = await historicalSourceFixture(), oldClose = f.close, sessions = [];
  f.archive = path.join(f.user, '.qianmu-recipes-v1');
  f.close = async () => { sessions.forEach(session => session.close()); await oldClose(); }; t?.after(() => f.close());
  if (prepare) await prepare(f);
  for (let i = 0; i < extraArchives; i++) {
    const row = { id: 'extra-' + i, createdAt: i + 3, url: '/user/images/extra-' + i + '.png', snapshot: recipe('extra full recipe ' + i) };
    f.rows.push(row); await f.write(); const { gallerySha256, ...base } = f.request();
    row.snapshotServerRef = (await f.recipes.preserve(f.req, { ...base, selection: { recordId: row.id, createdAt: row.createdAt, gallerySha256 } })).reference;
    delete row.snapshot;
  }
  await f.write(); const session = await f.capture(recordIds ? { recordIds } : {}); f.source = session.source;
  f.packed = await captureHistoricalStoryboardBundle({ session, guard: async () => {}, readImage: async () => new Blob([png], { type: 'image/png' }) });
  f.current = { namespace: f.account, target: structuredClone(f.target), saved: structuredClone(f.saved), evidence: f.source.chatEvidence };
  f.recipeCalls = [];
  f.restoreFetch = async (url, options) => {
    if (url !== '/api/plugins/qianmu-tts/chat-gallery/recipe/restore') throw Error('Unexpected recipe-stage endpoint');
    const body = JSON.parse(options.body); f.recipeCalls.push({ url, ...options, body });
    try { return Response.json(await f.recipes.restore(f.req, body, { signal: options.signal })); }
    catch (error) { const response = recipeArchiveErrorPayload(error); return Response.json(response.body, { status: response.status }); }
  };
  f.recipeOptions = () => ({ file: f.packed.file, namespace: f.account, target: f.target, readCurrent: async () => f.current,
    guard: async () => f.active, isCurrent: () => f.active, headers: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE' }), fetchImpl: f.restoreFetch });
  f.openRecipe = options => { const session = createHistoricalRecipeRestore({ ...f.recipeOptions(), ...options }); sessions.push(session); return session; };
  return f;
}
