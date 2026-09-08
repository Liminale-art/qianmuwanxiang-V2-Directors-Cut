import { captureStoryboardResourceBundle, inspectStoryboardResourceBundle } from './qianmu-storyboard-bundle-resources.js';
import { createComfyWorkflowStore } from './qianmu-comfy-library.js';
import { createComfyPoolStore } from './qianmu-comfy-pool-store.js';
import { createCharacterArchiveStore } from './qianmu-character-archive-store.js';

let started = false, counter = 0;
const pending = new Map();
const guard = () => new Promise(resolve => { const id = ++counter; pending.set(id, resolve); self.postMessage({ guard: id }); });
self.addEventListener('message', async event => {
  if (Number.isSafeInteger(event.data?.guard)) { const resolve = pending.get(event.data.guard); if (resolve) { pending.delete(event.data.guard); resolve(); } return; }
  if (started) return; started = true; const stores = [];
  try {
    const input = event.data;
    let result;
    if (input?.action === 'capture') {
      const workflowStore = createComfyWorkflowStore(), poolStore = createComfyPoolStore(), characterStore = createCharacterArchiveStore(); stores.push(workflowStore, poolStore, characterStore);
      result = await captureStoryboardResourceBundle({ namespace: input.namespace, chatKey: input.chatKey, storyboard: input.file, workflowStore, poolStore, characterStore, guard });
    } else if (input?.action === 'inspect') result = await inspectStoryboardResourceBundle(input.file, { guard });
    else throw Error('不支持的资源包操作');
    await guard(); self.postMessage({ result });
  } catch (error) { self.postMessage({ error: { code: error?.code || 'storyboard_bundle_worker', message: error?.message || '资源包处理失败' } }); }
  finally { for (const store of stores) store.close(); pending.clear(); self.close(); }
});
