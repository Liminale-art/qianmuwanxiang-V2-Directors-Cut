// Portable configuration only. No execution, connection authority, media upload or workflow rewriting.
import { validateComfyLibraryBackup, planComfyLibraryRestore, comfyLibraryBackupDigest } from './qianmu-comfy-library-backup.js';
import { validateComfyPoolBackup, planComfyPoolRestore } from './qianmu-comfy-pool-backup.js';
import { normalizeComfyLibraryDocument } from './qianmu-comfy-library.js';
import { normalizeComfyClassification } from './qianmu-comfy-classification.js';
import { comfyWorkflowReferenceHash } from './qianmu-comfy-references.js';
import { assertComfyRouteNamespace } from './qianmu-comfy-route-contract.js';
import { parseStrictStoryboardJson } from './qianmu-storyboard-package-input.js';
import { vibeDigest } from './qianmu-vibe-file.js';

export const COMFY_RESOURCE_BACKUP_SCHEMA = 'qianmu.comfy.resources.v1';
export const COMFY_RESOURCE_BACKUP_BYTES = 112 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), { code: 'comfy_resources_backup', submissionState: 'not_submitted' }); };
const fixedKey = binding => JSON.stringify([binding.id, binding.revision, binding.version]);
const digest = comfyLibraryBackupDigest;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const current = isCurrent => { if (isCurrent() !== true) fail('备份页面已变化，请重新打开核对'); };

export async function verifyComfyPoolDependencies(pools, workflows, { guard = async () => {} } = {}) {
  validateComfyPoolBackup(pools); validateComfyLibraryBackup(workflows);
  if (pools.namespace !== workflows.namespace) fail('候选方案与工作流备份的账户不一致');
  return scanDependencies(pools, workflows, guard);
}
async function scanDependencies(pools, workflows, guard) {
  await guard();
  const versions = new Map(), checked = new Map(), connections = new Set(), references = new Set(); let candidates = 0;
  for (const row of workflows.workflows) for (const version of row.versions) versions.set(fixedKey(version.meta), version.document);
  for (const row of pools.pools) for (const version of row.versions) for (const candidate of version.pool.candidates) {
    candidates++;
    // Shared old bindings are hashed once; yield periodically without resolving the ST account for every duplicate.
    if (candidates % 64 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); await guard(); }
    const target = candidate.target, binding = target.comfyWorkflowBinding, key = fixedKey(binding), document = versions.get(key);
    if (!document) fail('候选方案引用的固定工作流原版本缺失，未将缺件包标记为完整');
    if (!checked.has(key)) {
      const normalized = normalizeComfyLibraryDocument(document);
      checked.set(key, { workflowHash: await comfyWorkflowReferenceHash(normalized.workflow), recipeHash: await vibeDigest(JSON.stringify(normalized)), classification: normalizeComfyClassification(normalized.classification || { version: 1 }) });
      await guard();
    }
    const proof = checked.get(key);
    if (proof.workflowHash !== binding.workflowHash || proof.recipeHash !== binding.recipeHash) fail('候选方案与固定工作流原文摘要不符，未替换为同名工作流');
    if (JSON.stringify(candidate.classification) !== JSON.stringify(proof.classification)) fail('候选分类与固定工作流版本不符，请保留原件核对');
    if (target.connectionPresetId) connections.add(target.connectionPresetId);
    for (const item of target.comfyReferences?.items || []) references.add(JSON.stringify([item.url, item.sha256]));
  }
  await guard(); return { candidates, pinnedVersions: checked.size, connectionPresets: connections.size, referenceFiles: references.size };
}

export async function validateComfyResourcesBackup(value, options) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['schema', 'namespace', 'credentialsIncluded', 'externalFilesIncluded', 'workflows', 'pools'].includes(key))
    || value.schema !== COMFY_RESOURCE_BACKUP_SCHEMA || value.credentialsIncluded !== false || value.externalFilesIncluded !== false) fail('Comfy 方案备份格式无效或包含未支持的资源');
  assertComfyRouteNamespace(value.namespace);
  if (value.workflows?.namespace !== value.namespace || value.pools?.namespace !== value.namespace) fail('Comfy 备份资源账户不一致');
  const workflows = validateComfyLibraryBackup(value.workflows), pools = validateComfyPoolBackup(value.pools);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > COMFY_RESOURCE_BACKUP_BYTES) fail('Comfy 方案备份超过 112 MiB');
  const dependencies = await scanDependencies(value.pools, value.workflows, options?.guard || (async () => {}));
  return { workflows, pools, dependencies };
}

export async function captureComfyResourcesBackup(namespace, { workflowStore, poolStore, guard = async () => {}, isCurrent = () => true }) {
  await guard(); current(isCurrent);
  // Capture pools first: immutable workflow originals can then be resolved without guessing the latest version.
  const pools = await poolStore.backup(namespace, { isCurrent }); await guard();
  const workflows = await workflowStore.backup(namespace, { isCurrent }); await guard();
  const value = { schema: COMFY_RESOURCE_BACKUP_SCHEMA, namespace, credentialsIncluded: false, externalFilesIncluded: false, workflows, pools };
  await validateComfyResourcesBackup(value, { guard }); current(isCurrent); return value;
}

export async function readComfyResourcesBackup(file, options) {
  if (!(file instanceof Blob) || file.size < 1 || file.size > COMFY_RESOURCE_BACKUP_BYTES) fail('请选择 112 MiB 以内的 Comfy 方案备份');
  const bytes = await file.arrayBuffer(); if (bytes.byteLength !== file.size) fail('备份文件读取大小不符'); let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { fail('备份文件不是完整 UTF-8'); }
  const value = parseStrictStoryboardJson(text, { maxBytes: COMFY_RESOURCE_BACKUP_BYTES });
  await validateComfyResourcesBackup(value, options); return value;
}

export async function previewComfyResourcesRestore(namespace, input, { workflowStore, poolStore, guard = async () => {}, isCurrent = () => true }) {
  const value = structuredClone(input); assertComfyRouteNamespace(namespace);
  // References and API preset IDs require an explicit cross-account rebind design, never a namespace string replace.
  if (value.namespace !== namespace) fail('此方案备份仅可恢复至同一 ST 账户；跨账户须重新绑定连接与参考图');
  const source = await validateComfyResourcesBackup(value, { guard }); await guard(); current(isCurrent);
  const pools = await poolStore.backup(namespace, { isCurrent }), workflows = await workflowStore.backup(namespace, { isCurrent }); await guard();
  const [poolUsage, workflowUsage] = await Promise.all([poolStore.usage(namespace), workflowStore.usage(namespace)]); await guard();
  const poolPlan = planComfyPoolRestore(pools, value.pools, { maxBytes: poolUsage.limit }), workflowPlan = planComfyLibraryRestore(workflows, value.workflows, { maxBytes: workflowUsage.limit });
  const prepared = { namespace, sourceDigest: await digest(value), poolDigest: await digest(pools), workflowDigest: await digest(workflows),
    pools: poolPlan.summary, workflows: workflowPlan.summary, dependencies: source.dependencies };
  await guard(); current(isCurrent); return prepared;
}

export async function restoreComfyResourcesBackup(namespace, input, { prepared, confirmed = false, workflowStore, poolStore, guard = async () => {}, isCurrent = () => true }) {
  if (confirmed !== true || prepared?.namespace !== namespace || !hash(prepared?.sourceDigest) || !hash(prepared?.poolDigest) || !hash(prepared?.workflowDigest)) fail('请先核对并确认 Comfy 方案恢复');
  const value = structuredClone(input), approved = structuredClone(prepared);
  const latest = await previewComfyResourcesRestore(namespace, value, { workflowStore, poolStore, guard, isCurrent });
  if (['sourceDigest', 'poolDigest', 'workflowDigest'].some(key => latest[key] !== approved[key])) fail('备份或本机方案在确认后已变化，未开始恢复，请重新核对');
  await guard(); current(isCurrent);
  // Two databases cannot share one IDB transaction. Each append is atomic and retrying this same file is idempotent.
  // Never delete a restored original to imitate cross-database rollback; it could already have other users.
  try {
    const workflows = await workflowStore.restoreBackup(namespace, value.workflows, { expectedDigest: approved.workflowDigest, confirmed: true, isCurrent });
    await guard();
    const actualWorkflows = await workflowStore.backup(namespace, { isCurrent });
    await verifyComfyPoolDependencies(value.pools, actualWorkflows, { guard }); current(isCurrent);
    const pools = await poolStore.restoreBackup(namespace, value.pools, { expectedDigest: approved.poolDigest, confirmed: true, isCurrent });
    await guard();
    const actualPools = await poolStore.backup(namespace, { isCurrent });
    if (planComfyPoolRestore(actualPools, value.pools).writes.length) fail('候选方案保存结果尚未确认');
    await verifyComfyPoolDependencies(value.pools, await workflowStore.backup(namespace, { isCurrent }), { guard });
    current(isCurrent); return { workflows, pools };
  } catch (cause) {
    const error = Object.assign(new Error('恢复未全部确认；工作流阶段可能已保存。请保留并重新选择同一备份核对续接，不会重复新增版本。'), { code: 'comfy_resources_partial', submissionState: 'not_submitted', cause });
    throw error;
  }
}
