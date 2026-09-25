function normalizeDefinition(key, definition) {
  if (typeof definition === 'function') {
    return { key, label: key, load: definition };
  }
  if (!definition || typeof definition.load !== 'function') {
    throw new TypeError(`Feature "${key}" must provide a load function.`);
  }
  return {
    key,
    label: String(definition.label || key),
    load: definition.load,
    intent: definition.intent || '',
  };
}

function serializeError(error) {
  if (!error) return null;
  if (error.code === 'qianmu_chunk_exhausted') return { name: 'Error', message: '组件未能载入，请刷新 ST 页面。', exhausted: true };
  return {
    name: String(error.name || 'Error'),
    message: String(error.message || error),
  };
}

/**
 * Small session-only boundary for feature chunks. A rejected import is never
 * cached as a permanent failure: the next explicit user action may retry it.
 */
export function createFeatureRuntime(definitions = {}) {
  const entries = new Map(Object.entries(definitions).map(([key, definition]) => {
    const normalized = normalizeDefinition(key, definition);
    return [key, {
      ...normalized,
      status: 'idle',
      attempts: 0,
      loadedAt: 0,
      value: undefined,
      promise: null,
      error: null,
    }];
  }));

  function entryFor(key) {
    const entry = entries.get(key);
    if (!entry) throw new RangeError(`Unknown feature "${key}".`);
    return entry;
  }

  function load(key) {
    const entry = entryFor(key);
    if (entry.status === 'ready') return Promise.resolve(entry.value);
    if (entry.status === 'loading' && entry.promise) return entry.promise;

    entry.status = 'loading';
    entry.attempts += 1;
    entry.error = null;
    entry.promise = Promise.resolve()
      .then(() => entry.load())
      .then((value) => {
        entry.status = 'ready';
        entry.loadedAt = Date.now();
        entry.value = value;
        entry.promise = null;
        return value;
      })
      .catch((error) => {
        entry.status = 'error';
        entry.error = serializeError(error);
        entry.promise = null;
        throw error;
      });
    return entry.promise;
  }

  function snapshot() {
    return [...entries.values()].map((entry) => ({
      key: entry.key,
      label: entry.label,
      status: entry.status,
      attempts: entry.attempts,
      loadedAt: entry.loadedAt,
      error: entry.error ? { ...entry.error } : null,
    }));
  }

  const roots=new WeakSet();
  function bindIntent(root){
    if(roots.has(root))return;roots.add(root);
    const warm=event=>{for(const entry of entries.values())if(entry.intent&&entry.status==='idle'&&event.target.closest?.(entry.intent))void load(entry.key).catch(()=>{});};
    root.addEventListener('pointerover',warm);root.addEventListener('focusin',warm);
  }
  return Object.freeze({ load, snapshot, bindIntent });
}

// Explicit local allowlist only. No rewriting dependency graphs or executing URLs from errors.
const localChunkNames=new Set(['qianmu-reader.js','builtin-theaters.js','qianmu-theaters.js','qianmu-focus-dialogue.js','qianmu-focus-dialogue-ui.js','qianmu-focus-library-ui.js',
  'qianmu-character-archive-view.js','qianmu-vibe-library-view.js','qianmu-ensemble-ui.js','qianmu-comfy-workbench.js','qianmu-comfy-library-view.js','qianmu-comfy-pool-view.js','qianmu-comfy-route.js','qianmu-image-admission.js',
  'qianmu-prose-assistant-panel.js','qianmu-prose-assistant-native.js','qianmu-text-collection-library.js','qianmu-text-collection-capture.js','qianmu-gallery-catalog-management-view.js',
  'qianmu-storage-gallery-check.js','qianmu-gallery-recipe-review-view.js','qianmu-gallery-local-recipe-current.js','qianmu-storyboard-export-scope-view.js',
  'qianmu-gallery-archive-view.js','qianmu-gallery-location-view.js','qianmu-gallery-directory-view.js','qianmu-historical-gallery-consumer.js']);
export function createLocalChunkLoader({importer=url=>import(url),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const entries=new Map();
  const exhausted=cause=>Object.assign(new Error('组件仍未载入，请刷新 ST 页面后重试',{cause}),{code:'qianmu_chunk_exhausted'});
  return function load(relative){
    const url=new URL(relative,import.meta.url),name=url.pathname.split('/').at(-1);
    if(!localChunkNames.has(name)||url.href.split('?')[0]!==new URL('./'+name,import.meta.url).href||url.hash)return Promise.reject(Error('无效的本地组件地址'));
    const key=url.href;let entry=entries.get(key);if(!entry){entry={attempt:0,promise:null,value:null};entries.set(key,entry);}
    if(entry.value)return Promise.resolve(entry.value);if(entry.promise)return entry.promise;
    entry.promise=(async()=>{
      for(let retry=0;retry<2;retry++){
        if(entry.attempt>=8)throw exhausted();
        const attempt=entry.attempt++,target=new URL(key);if(attempt)target.searchParams.set('qm_retry',String(attempt));
        try{return entry.value=await importer(target.href);}
        catch(error){
          if(entry.attempt>=8)throw exhausted(error);
          const network=error?.name==='TypeError'&&/(fetch.*dynamically imported|importing a module script failed|error loading dynamically imported)/i.test(error.message);
          if(!network)throw error;
          if(retry)throw Object.assign(new Error('组件未能载入，请重试；若仍失败，请刷新页面',{cause:error}),{code:'qianmu_chunk_load'});
          await pause(180);
        }
      }
    })().finally(()=>{entry.promise=null;});return entry.promise;
  };
}
export const loadLocalChunk=createLocalChunkLoader();

// A local import may be retried by an explicit click only while its bounded
// session budget remains. Never render a retry control for an exhausted URL.
export function localChunkFailure(error,label){
  const exhausted=error?.code==='qianmu_chunk_exhausted';
  return Object.freeze({exhausted,message:exhausted?`${label}未能载入，请刷新 ST 页面后重试。`
    :error?.code==='qianmu_chunk_load'?`${label}未能载入，请重试；若仍失败，请刷新 ST 页面。`
    :`${label}未能载入，请稍后重试。`});
}
export function mountLocalChunkFailure(host,error,label,onRetry){
  if(!host)return;
  const failure=localChunkFailure(error,label),safe=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  host.innerHTML=`<div role="alert">${safe(failure.message)}${failure.exhausted?'':' <button type="button" class="sd-btn sd-local-chunk-retry">重试</button>'}</div>`;
  if(!failure.exhausted)host.querySelector('.sd-local-chunk-retry')?.addEventListener('click',onRetry);
  return failure;
}
