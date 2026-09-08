import { buildStoryboardBundle, openStoryboardBundle, STORYBOARD_BUNDLE_LIMITS } from './qianmu-storyboard-bundle.js';
import { sourceIdentityForNamespace } from './qianmu-source-identity-contract.js';
import { inspectStoryboardChatEvidence } from './qianmu-storyboard-chat-evidence.js';
import { inspectStoryboardSubjectEvidence, storyboardSubjectTargets } from './qianmu-storyboard-subject-evidence.js';
import { assertPortableConnection, assertPortableConnectionUrl } from './qianmu-storyboard-connection-identity.js';
import { projectStoryboardOriginPayload, buildStoryboardResourceOrigins, inspectStoryboardResourceOrigins, storyboardResourceOriginsSummary } from './qianmu-storyboard-resource-origins.js';
import { inspectStoryboardPackageFile, validateStoryboardPackagePayload, validateStoryboardPackageMedia } from './qianmu-storyboard-package-input.js';
import { collectStoryboardVibeDependencies, inspectStoryboardVibePackage } from './qianmu-storyboard-package-assets.js';
import { validateComfyLibraryBackup, comfyLibraryBackupDigest as digest } from './qianmu-comfy-library-backup.js';
import { normalizeComfyLibraryDocument } from './qianmu-comfy-library.js';
import { validateComfyPoolBackup } from './qianmu-comfy-pool-backup.js';
import { verifyComfyPoolDependencies } from './qianmu-comfy-resource-backup.js';
import { validateCharacterLibraryBackup } from './qianmu-character-library-backup.js';
import { verifyCharacterBackupWorkflowDependencies } from './qianmu-character-backup-file.js';
import { normalizeComfyRouteBinding } from './qianmu-comfy-route-contract.js';
import { normalizeComfyReferenceSelection } from './qianmu-comfy-reference-contract.js';
import { readStaticReferenceBlobs, comfyWorkflowReferenceHash } from './qianmu-comfy-references.js';
import { comfyReferenceStillMime } from './qianmu-comfy-results.js';
import { imageRestoreReceipt } from './qianmu-image-restore-contract.js';
import { vibeDigest } from './qianmu-vibe-file.js';
import { captureLegacyVibeOriginals, inspectLegacyVibeOriginals } from './qianmu-storyboard-legacy-vibes.js';
import { captureBundleMappings, inspectBundleMappings } from './qianmu-bundle-mappings.js';
import {captureBundleCarriers,inspectBundleCarriers} from './qianmu-bundle-carriers.js';
import {inspectStoryboardPortableSelections} from './qianmu-storyboard-package-fields.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_bundle_resources', submissionState: 'not_submitted' }); };
const object = value => value !== null && typeof value === 'object';
const key = value => JSON.stringify([value.id, value.revision, value.version]);
const jsonFile = value => new Blob([JSON.stringify(value)], { type: 'application/json' });
const sensitive = new Set(['apikey', 'authorization', 'accesstoken', 'refreshtoken', 'clientsecret', 'password', 'credentialid', 'grantid', 'sharedsecret']);
function checkSubjectCoverage(evidence, characters) {
  const ids = new Set(evidence.subjects.map(row => JSON.stringify([row.category,row.subjectKey])));
  if (storyboardSubjectTargets(characters.bindings).some(row => !ids.has(JSON.stringify([row.category,row.subjectKey])))) fail('角色来源摘要缺少原绑定，请重新导出');
}

// Visit typed bindings in settings, histories and all pool revisions. Do not interpret arbitrary strings as executable JSON.
function scan(value, namespace, census, depth = 0) {
  if (++census.nodes > 500000 || depth > 40) fail('资源引用层级或数量过大');
  if (!object(value)) return;
  for (const [name, item] of Object.entries(value)) {
    if (sensitive.has(name.replace(/[-_]/g, '').toLowerCase()) && item !== '' && item !== null && item !== undefined) fail('资源包含结构化连接凭据或授权，未复制到备份');
    if (item != null && ['baseUrl','apiUrl','comfyUrl'].includes(name)) assertPortableConnectionUrl(item);
    if (item != null && ['connection','headers','customHeaders'].includes(name)) assertPortableConnection(name === 'connection' ? item : { [name]: item });
    if (name === 'connections' && item != null) {
      if (!object(item) || Array.isArray(item)) fail('连接目录无效');
      for (const group of Object.values(item)) {
        if (!object(group) || Array.isArray(group) || group.presets != null && !Array.isArray(group.presets)) fail('连接预设目录无效');
        if (group.draft != null) assertPortableConnection(group.draft);
        for (const row of group.presets || []) assertPortableConnection(row);
      }
    }
    if (name === 'comfyWorkflowBinding' && item != null) {
      const binding = normalizeComfyRouteBinding(item); if (binding.namespace !== namespace) fail('固定工作流引用属于另一账户，请先在来源环境核对');
      const previous = census.bindings.get(key(binding));
      if (previous && (previous.workflowHash !== binding.workflowHash || previous.recipeHash !== binding.recipeHash)) fail('相同固定版本的引用摘要互相冲突');
      census.bindings.set(key(binding), binding);
    }
    if (name === 'comfyReferences' && item != null) {
      const selection = normalizeComfyReferenceSelection(item);
      if (selection.namespace !== namespace) fail('参考原件属于另一账户，请先在来源环境核对');
      for (const row of selection.items) addOriginal(census, row);
    }
    scan(item, namespace, census, depth + 1);
  }
}
function addOriginal(census, value) {
  const row = imageRestoreReceipt(Object.fromEntries(['url', 'sha256', 'mime', 'bytes'].map(name => [name, value[name]])));
  const previous = census.originals.get(row.url), sameFile = census.files.get(row.sha256);
  if (previous && (previous.sha256 !== row.sha256 || previous.bytes !== row.bytes || previous.mime !== row.mime)
    || sameFile && (sameFile.bytes !== row.bytes || sameFile.mime !== row.mime)) fail('原件路径、格式或摘要收据互相冲突');
  census.originals.set(row.url, row); census.files.set(row.sha256, row);
  if (census.files.size > 1024 || census.originals.size > 30000) fail('资源原件或使用位置超过支持范围');
}
async function inspectConfig(payload, namespace, { checked = false, withOrigins = false, guard = async()=>{} } = {}) {
  validateStoryboardPackagePayload(payload);
  if (payload.vibeAccount !== namespace) fail('配置和独立库的来源账户不一致');
  if (!checked) { validateStoryboardPackageMedia(payload); await inspectStoryboardVibePackage(payload); }
  const media = new Set((payload.media || []).map(row => row.id));
  if ((payload.chat.images || []).some(row => !media.has(row.id))) fail('配置分段缺少成片原图，未把地址清单当作完整资源');
  const vibes = collectStoryboardVibeDependencies(payload, { namespace });
  const census = { originals: new Map(), files: new Map(), bindings: new Map(), nodes: 0, selections:inspectStoryboardPortableSelections(payload.settings,namespace) };
  scan(payload.settings, namespace, census); scan(payload.chat, namespace, census);
  return { census, legacyUrls: vibes.legacyUrls, ...(withOrigins?{originsPayload:await projectStoryboardOriginPayload(payload,{guard})}:{}), summary: { images: media.size, vibeFiles: vibes.refs.length, legacyVibeUrls: vibes.legacyUrls.length, legacyVibeOriginals: 0 } };
}
function includeLegacyOriginals(config, document) {
  const result = inspectLegacyVibeOriginals(document, config.legacyUrls);
  for (const row of result.receipts) addOriginal(config.census, row);
  config.summary.legacyVibeOriginals = result.rows.length;
}
async function inspectLibraries(namespace, config, { workflows, pools, characters }, guard) {
  if ([workflows, pools, characters].some(value => value?.namespace !== namespace)) fail('资源库账户不一致');
  const summary = { workflows: validateComfyLibraryBackup(workflows), pools: validateComfyPoolBackup(pools), characters: validateCharacterLibraryBackup(characters) };
  await verifyComfyPoolDependencies(pools, workflows, { guard });
  const characterCensus = await verifyCharacterBackupWorkflowDependencies(characters, workflows, { guard });
  const census = config.census;
  scan(pools, namespace, census);
  // Keep every reference/cover URL use even if its bytes are the same as a pool reference.
  for (const archive of characters.archives) for (const row of [archive.document.imagegen.reference, archive.document.imagegen.preview]) if (row) addOriginal(census, row);
  const versions = new Map(), verified = new Map();
  for (const row of workflows.workflows) for (const version of row.versions) versions.set(key(version.meta), version.document);
  if(census.selections.workflow&&!versions.has(key(census.selections.workflow)))fail('镜头台当前工作流选择的原版本缺失，未导出缺件包');
  if(census.selections.pool){
    const selected=census.selections.pool,version=pools.pools.find(row=>row.head.id===selected.id)?.versions.find(row=>key(row.meta)===key(selected));
    if(!version||await vibeDigest(JSON.stringify(version.pool))!==selected.poolHash)fail('镜头台当前候选方案原版本缺失或摘要不符，未猜配同名方案');
  }
  for (const [id, binding] of census.bindings) {
    const document = versions.get(id); if (!document) fail('配置或历史记录引用的固定工作流原版本缺失');
    if (!verified.has(id)) { const normalized = normalizeComfyLibraryDocument(document); verified.set(id, { workflowHash: await comfyWorkflowReferenceHash(normalized.workflow), recipeHash: await vibeDigest(JSON.stringify(normalized)) }); }
    const proof = verified.get(id); if (proof.workflowHash !== binding.workflowHash || proof.recipeHash !== binding.recipeHash) fail('配置引用与固定工作流原文不符'); await guard();
  }
  await guard(); return { census, summary: { ...config.summary, ...summary, characterPinnedVersions: characterCensus.workflows.length,
    originalFiles: census.files.size, originalPaths: census.originals.size, pinnedVersions: verified.size,
    scope: 'current-chat-and-libraries', identityVerified: false, restoreAuthorized: false } };
}

// This unit captures and verifies one portable file. Applying it requires the explicit staged restore coordinator.
export async function captureStoryboardResourceBundle({ namespace, chatKey, storyboard, workflowStore, poolStore, characterStore, journal = null, carrierStore = null, source = null, chatEvidence = null, subjectEvidence = null,
  guard = async () => {}, isCurrent = () => true, readImages = readStaticReferenceBlobs, legacyFetch = globalThis.fetch, now = Date.now }) {
  const check = async () => { if (isCurrent() !== true) fail('资源包页面已变化'); await guard(); if (isCurrent() !== true) fail('资源包页面已变化'); };
  source = source === null ? null : await sourceIdentityForNamespace(source, namespace);
  chatEvidence = chatEvidence === null ? null : await inspectStoryboardChatEvidence(chatEvidence, chatKey);
  subjectEvidence = subjectEvidence === null ? null : await inspectStoryboardSubjectEvidence(subjectEvidence);
  await check();
  const config = await (async () => { const parsed = await inspectStoryboardPackageFile(storyboard); await check(); return inspectConfig(parsed.payload, namespace, { checked: true, withOrigins: true, guard: check }); })();
  const pools = await poolStore.backup(namespace, { isCurrent }); await check();
  const characters = await characterStore.backup(namespace, { isCurrent }); await check();
  const workflows = await workflowStore.backup(namespace, { isCurrent }); await check();
  const { census, summary } = await inspectLibraries(namespace, config, { workflows, pools, characters }, check);
  if (subjectEvidence) checkSubjectCoverage(subjectEvidence, characters);
  const baselines = await Promise.all([digest(workflows), digest(pools), digest(characters)]); await check();
  const entries = [{ id: 'storyboard', file: storyboard }, { id: 'workflows', file: jsonFile(workflows) }, { id: 'pools', file: jsonFile(pools) }, { id: 'characters', file: jsonFile(characters) }];
  const mappings=journal===null?null:await captureBundleMappings({namespace,journal,guard:check,isCurrent});
  if(mappings){entries.push(...mappings.entries);summary.mappingReceipts=mappings.summary;}
  const carriers=carrierStore===null?null:await captureBundleCarriers({namespace,store:carrierStore,mappings,guard:check,isCurrent});
  if(carriers){entries.push(...carriers.entries);summary.carriers=carriers.summary;}
  if (chatEvidence) entries.push({ id: 'chat-evidence', file: jsonFile(chatEvidence) });
  if (chatEvidence) summary.chatEvidenceMessages = chatEvidence.messages.length;
  if (subjectEvidence) { entries.push({ id: 'subject-evidence', file: jsonFile(subjectEvidence) }); summary.subjectEvidenceCount = subjectEvidence.subjects.length; }
  // Conservative header reserve avoids fetching originals only to discover that the combined file cannot fit.
  if (entries.reduce((sum, row) => sum + row.file.size, STORYBOARD_BUNDLE_LIMITS.manifest) + [...census.files.values()].reduce((sum, row) => sum + row.bytes, 0) > STORYBOARD_BUNDLE_LIMITS.total) fail('资源联包超过 512 MiB，请保留原环境，未读取原图或输出缺件包');
  const remaining = STORYBOARD_BUNDLE_LIMITS.total - entries.reduce((sum, row) => sum + row.file.size, STORYBOARD_BUNDLE_LIMITS.manifest + STORYBOARD_BUNDLE_LIMITS['legacy-vibes']) - [...census.files.values()].reduce((sum, row) => sum + row.bytes, 0);
  if (remaining < 0) fail('联包没有足够容量容纳旧 Vibe 原图清单');
  const legacy = await captureLegacyVibeOriginals(config.legacyUrls, { guard: check, fetch: legacyFetch, maxBytes: remaining });
  includeLegacyOriginals(config, legacy.document);
  Object.assign(summary, { legacyVibeOriginals: config.summary.legacyVibeOriginals, originalFiles: census.files.size, originalPaths: census.originals.size });
  entries.push({ id: 'legacy-vibes', file: jsonFile(legacy.document) });
  const origins = await buildStoryboardResourceOrigins({payload:config.originsPayload,workflows,pools,characters,originals:[...census.originals.values()],legacy:legacy.document},{guard:check});
  delete config.originsPayload;
  entries.push({id:'resource-origins',file:jsonFile(origins)});summary.resourceOrigins=storyboardResourceOriginsSummary(origins,true);
  if(entries.reduce((sum,row)=>sum+row.file.size,STORYBOARD_BUNDLE_LIMITS.manifest)+[...census.files.values()].reduce((sum,row)=>sum+row.bytes,0)>STORYBOARD_BUNDLE_LIMITS.total)fail('加上文件用途清单后联包超过 512 MiB，未输出缺件包');
  for (const row of census.files.values()) {
    await check(); const files = legacy.files.has(row.sha256) ? [legacy.files.get(row.sha256)] : await readImages([{ ...row, name: '备份原件' }], { guard: check }); await check();
    if (!Array.isArray(files) || files.length !== 1 || !(files[0] instanceof Blob) || files[0].size !== row.bytes) fail('资源原图读取结果不符');
    const bytes = new Uint8Array(await files[0].arrayBuffer());
    if (comfyReferenceStillMime(bytes) !== row.mime || await vibeDigest(bytes) !== row.sha256) fail('资源原图内容已变化，未生成缺件包');
    entries.push({ id: `image:${row.sha256}`, mime: row.mime, file: files[0] }); await check();
  }
  // A concurrent library edit is not silently folded into a different snapshot halfway through an export.
  for (const [index, store] of [workflowStore, poolStore, characterStore].entries()) {
    if (await digest(await store.backup(namespace, { isCurrent })) !== baselines[index]) fail('打包期间资源库已变化，请重新导出'); await check();
  }
  const result = await buildStoryboardBundle({ namespace, chatKey, entries, source, createdAt: now() }, { guard: check });
  await mappings?.verify();
  await carriers?.verify();
  await check(); return { ...result, summary };
}

export async function inspectStoryboardResourceBundle(file, { guard = async () => {}, includeOrigins = false } = {}) {
  const opened = await openStoryboardBundle(file, { guard }), namespace = opened.manifest.namespace;
  const mappings=await inspectBundleMappings(opened,{guard});
  const carriers=await inspectBundleCarriers(opened,{mappings,guard});
  const config = await (async () => inspectConfig(await opened.readJson('storyboard'), namespace, {withOrigins:true,guard}))(); await guard();
  const legacy = opened.manifest.entries.some(row => row.id === 'legacy-vibes') ? await opened.readJson('legacy-vibes') : null;
  if (legacy) includeLegacyOriginals(config, legacy);
  const workflows = await opened.readJson('workflows'), pools = await opened.readJson('pools'), characters = await opened.readJson('characters'); await guard();
  const { census, summary } = await inspectLibraries(namespace, config, { workflows, pools, characters }, guard);
  if(mappings)summary.mappingReceipts=mappings.summary;
  if(carriers)summary.carriers=carriers.summary;
  if (opened.manifest.entries.some(row => row.id === 'chat-evidence')) {
    const evidence = await inspectStoryboardChatEvidence(await opened.readJson('chat-evidence'), opened.manifest.chatKey); summary.chatEvidenceMessages = evidence.messages.length; await guard();
  }
  if (opened.manifest.entries.some(row => row.id === 'subject-evidence')) {
    const evidence = await inspectStoryboardSubjectEvidence(await opened.readJson('subject-evidence')); checkSubjectCoverage(evidence, characters); summary.subjectEvidenceCount = evidence.subjects.length; await guard();
  }
  const imageEntries = opened.manifest.entries.filter(row => row.id.startsWith('image:'));
  if (imageEntries.length !== census.files.size) fail('资源原件数量不符，存在缺件或多余文件');
  for (const row of imageEntries) {
    const expected = census.files.get(row.sha256); if (!expected || expected.bytes !== row.bytes || expected.mime !== row.mime) fail('资源原件收据不符');
    const part = await opened.read(row.id); if (comfyReferenceStillMime(part.bytes) !== row.mime) fail('资源原件不是完整静态图片'); await guard();
  }
  const origins=await buildStoryboardResourceOrigins({payload:config.originsPayload,workflows,pools,characters,originals:[...census.originals.values()],legacy},{guard});
  delete config.originsPayload;
  const recorded=opened.manifest.entries.some(row=>row.id==='resource-origins');
  if(recorded)await inspectStoryboardResourceOrigins(await opened.readJson('resource-origins'),origins);
  summary.resourceOrigins=storyboardResourceOriginsSummary(origins,recorded);await guard();
  return { manifest: opened.manifest, fileBytes: opened.fileBytes, fingerprint: opened.fingerprint, summary,
    originals: [...census.originals.values()], ...(includeOrigins?{origins}:{}) };
}

// Restore only the selected incoming role originals. Shared config/pool references still remain required.
// Called after the immutable bundle has passed full validation; this does not authorize any write.
export async function collectStoryboardBundleRestoreOriginals(payload, pools, characters, excludedCharacterIds = [], legacyDocument = null) {
  const namespace = characters.namespace, config = await inspectConfig(payload, namespace, { checked: true }), { census } = config;
  if (legacyDocument !== null) includeLegacyOriginals(config, legacyDocument);
  scan(pools, namespace, census);
  const excluded = new Set(excludedCharacterIds);
  for (const row of characters.archives) if (!excluded.has(row.head.id)) {
    for (const original of [row.document.imagegen.reference, row.document.imagegen.preview]) if (original) addOriginal(census, original);
  }
  return [...census.originals.values()];
}
