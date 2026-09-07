// Lazy read-only preparation. Saved graphs are never rewritten; node/output/admission checks still run downstream.
import { createComfyWorkflowStore, normalizeComfyLibraryDocument } from './qianmu-comfy-library.js';
import { comfyWorkflowReferenceHash } from './qianmu-comfy-references.js';
import { assertComfyRouteNamespace, normalizeComfyRouteSelection, normalizeComfyRouteBinding, comfyRouteError } from './qianmu-comfy-route-contract.js';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const sameVersion = (row, namespace, selection) => row?.namespace === namespace && row.id === selection.id
  && row.revision === selection.revision && row.version === selection.version;

async function recipeHash(document) {
  if (!globalThis.crypto?.subtle) throw comfyRouteError('当前环境不能核对工作流版本，请使用 HTTPS 或本机地址');
  // The normalizer fixes the order of all recipe fields. Graph identity remains byte-order-sensitive by design.
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readVersion({ namespace, selection, guard, store }) {
  const [heads, versions, raw] = await Promise.all([
    store.list(namespace), store.versions(namespace, selection.id), store.load(namespace, selection.id, selection.revision),
  ]);
  await guard();
  if (!heads.some(row => row.namespace === namespace && row.id === selection.id && row.archived === false)) {
    throw comfyRouteError('工作流方案已归档或不存在，请重新选择分工');
  }
  const version = versions.find(row => sameVersion(row, namespace, selection));
  if (!version || !raw) throw comfyRouteError('绑定的工作流版本已不存在，请重新选择分工');
  const document = normalizeComfyLibraryDocument(raw);
  const [workflowHash, hash] = await Promise.all([comfyWorkflowReferenceHash(document.workflow), recipeHash(document)]);
  await guard();
  return { document, binding: normalizeComfyRouteBinding({ schemaVersion: 1, namespace, ...selection,
    name: version.name, workflowHash, recipeHash: hash }) };
}

async function withStore(options, work) {
  const namespace = assertComfyRouteNamespace(options.namespace);
  const selection = normalizeComfyRouteSelection(options.selection);
  const guard = options.guard || (async () => {});
  await guard();
  const store = (options.createStore || createComfyWorkflowStore)();
  try {
    const recipe = await readVersion({ namespace, selection, guard, store });
    await work(recipe);
    // Archive/purge during the asynchronous digest cannot silently authorize a new use.
    const heads = await store.list(namespace); await guard();
    if (!heads.some(row => row.namespace === namespace && row.id === selection.id && row.archived === false)) {
      throw comfyRouteError('工作流方案已变化，请重新核对分工');
    }
    return freeze(recipe);
  } finally { store.close(); }
}

export async function pinComfyRouteWorkflow(options) {
  return withStore(options, async () => {});
}

export async function readPinnedComfyRouteWorkflow({ namespace, binding, guard, createStore }) {
  const captured = normalizeComfyRouteBinding(binding);
  if (assertComfyRouteNamespace(namespace) !== captured.namespace) throw comfyRouteError('此工作流分工属于另一账户，请重新绑定');
  return withStore({ namespace, selection: captured, guard, createStore }, async recipe => {
    if (recipe.binding.workflowHash !== captured.workflowHash || recipe.binding.recipeHash !== captured.recipeHash) {
      throw comfyRouteError('工作流或配方内容与绑定版本不符，未使用当前工作台代替');
    }
    // Names are presentation metadata, not permission to upgrade the pinned recipe.
    recipe.binding = captured;
  });
}
