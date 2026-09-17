import * as fs from 'node:fs/promises';
import path from 'node:path';
import { historicalSourceFixture } from './historical-source-fixture.mjs';
import { captureHistoricalStoryboardBundle } from '../../qianmu-historical-storyboard-bundle.js';
import { createImageRestoreService } from '../../qianmu-image-restore-service.js';
import { imageRestoreErrorPayload } from '../../qianmu-image-restore-contract.js';
import { createHistoricalOriginalRestore } from '../../qianmu-historical-original-restore.js';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=', 'base64');
export async function historicalOriginalRestoreFixture(t, { prepare, readImage } = {}) {
  const f = await historicalSourceFixture(), oldClose = f.close, sessions = [];
  f.images = path.join(f.user, 'user', 'images'); await fs.mkdir(f.images, { recursive: true });
  f.req.user.directories.userImages = f.images;
  f.imageService = createImageRestoreService({ dataRoot: f.root });
  f.close = async () => { for (const session of sessions) session.close(); await f.imageService.close(); await oldClose(); };
  t?.after(() => f.close());
  if (prepare) { prepare(f); await f.write(); }
  const sourceSession = await f.capture(); f.source = sourceSession.source;
  f.packed = await captureHistoricalStoryboardBundle({ session: sourceSession, guard: async () => {}, readImage: readImage || (async () => new Blob([png], { type: 'image/png' })) });
  f.current = { namespace: f.account, target: f.target, saved: structuredClone(f.saved), evidence: f.source.chatEvidence };
  f.imageCalls = [];
  f.restoreFetch = async (url, options) => {
    const action = url.split('/').at(-1), body = options.body ? JSON.parse(options.body) : null;
    if (!['capabilities', 'inspect', 'restore'].includes(action)) throw Error('Unexpected restore route');
    f.imageCalls.push({ url, action, body, headers: options.headers, signal: options.signal });
    try { return Response.json(await f.imageService[action](f.req, ...(body ? [body, { signal: options.signal }] : []))); }
    catch (error) { const result = imageRestoreErrorPayload(error); return Response.json(result.body, { status: result.status }); }
  };
  f.options = () => ({ file: f.packed.file, namespace: f.account, target: f.target, readCurrent: async () => f.current,
    guard: async () => { if (!f.active) throw Error('closed'); }, isCurrent: () => f.active,
    headers: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE' }), fetchImpl: f.restoreFetch });
  f.open = extra => { const session = createHistoricalOriginalRestore({ ...f.options(), ...extra }); sessions.push(session); return session; };
  return f;
}
