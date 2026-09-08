import { createStoryboardBundleRestoreSession } from './qianmu-storyboard-bundle-restore.js';
import { createComfyWorkflowStore } from './qianmu-comfy-library.js';
import { createComfyPoolStore } from './qianmu-comfy-pool-store.js';
import { createCharacterArchiveStore } from './qianmu-character-archive-store.js';
import { createVibeAssetStore } from './qianmu-vibe-asset-store.js';
import { createStoryboardPackageJournal } from './qianmu-storyboard-package-journal.js';
import { createStoryboardPackageStage } from './qianmu-storyboard-package-stage.js';
import { createImageRestoreClient } from './qianmu-image-restore-client.js';
import { createSourceIdentityClient } from './qianmu-source-identity-client.js';

let id = '', operation = 0, rpc = 0, busy = false, closed = false, session = null;
const pending = new Map(), stores = [];
const failure = message => Object.assign(new Error(message), { code: 'storyboard_bundle_restore_worker', submissionState: 'not_submitted' });
function close() { closed = true; session?.close(); for (const store of stores) store.close(); for (const item of pending.values()) item.reject(failure('恢复会话已关闭，请核对可能保存的部分')); pending.clear(); self.close(); }
function ask(kind, payload) {
  if (closed) return Promise.reject(failure('恢复会话已关闭'));
  return new Promise((resolve, reject) => { const request = ++rpc; pending.set(request, { resolve, reject, operation }); self.postMessage({ id, operation, request, kind, payload }); });
}
const guard = () => ask('guard');
self.addEventListener('message', async event => {
  const message = event.data;
  if (!message || typeof message.id !== 'string' || (id && message.id !== id)) return;
  if (message.type === 'close') { close(); return; }
  if (message.type === 'rpc') {
    const item = pending.get(message.request); if (!item || item.operation !== message.operation) return;
    pending.delete(message.request); if (message.error) item.reject(Object.assign(failure(message.error.message || '页面核对未通过'), { code: message.error.code || 'storyboard_bundle_restore_worker' })); else item.resolve(message.result); return;
  }
  if (message.type !== 'command' || busy || !Number.isSafeInteger(message.operation) || message.operation <= operation) return;
  if (!id && message.action !== 'open') return;
  id = message.id; operation = message.operation; busy = true;
  try {
    let result;
    if (message.action === 'open' && !session) {
      const workflowStore = createComfyWorkflowStore(), poolStore = createComfyPoolStore(), characterStore = createCharacterArchiveStore(), vibe = createVibeAssetStore(), journal = createStoryboardPackageJournal();
      stores.push(workflowStore, poolStore, characterStore, vibe, journal);
      const namespace = message.payload.namespace, token = message.payload.csrf || '';
      session = await createStoryboardBundleRestoreSession({ namespace, chatKey: message.payload.chatKey, file: message.payload.file, workflowStore, poolStore, characterStore, journal,
        vibeStage: createStoryboardPackageStage({ store: vibe, journal }), guard, isCurrent: () => !closed,
        images: createImageRestoreClient({ namespace, headers: () => ({ 'X-CSRF-Token': token }), guard }),
        sourceIdentity: createSourceIdentityClient({ namespace, guard }),
        configuration: { preview: value => ask('configuration-preview', value), apply: value => ask('configuration-apply', value), subjects: value => ask('configuration-subjects', value), targets: value => ask('configuration-targets',value) } });
      result = { sourceDigest: session.sourceDigest };
    } else if (session && message.sourceDigest === session.sourceDigest) {
      if (message.action === 'preview') result = await session.preview(message.payload.decisions,message.payload.subjectMappings,message.payload.sourceAliasChoices);
      else if(message.action==='aliases')result=await session.aliases(message.payload);
      else if(message.action==='receipts')result=await session.receipts(message.payload);
      else if (message.action === 'choose') result = await session.choose(message.payload.decisions);
      else if (message.action === 'resources') result = await session.resources(message.payload);
      else if (message.action === 'targets') result = await session.targets(message.payload);
      else if (message.action === 'restore') result = await session.restore(message.payload.prepared, message.payload.consent);
      else throw failure('不支持的恢复操作');
    } else throw failure('恢复文件或会话不符');
    await guard(); if (!closed) self.postMessage({ id, operation, type: 'result', action: message.action, sourceDigest: session.sourceDigest, result });
  } catch (error) {
    if (!closed) self.postMessage({ id, operation, type: 'error', action: message.action, error: { code: error?.code || 'storyboard_bundle_restore_worker', message: error?.message || '恢复未确认，请核对原包' } });
    if (!session) close();
  } finally { busy = false; }
});
