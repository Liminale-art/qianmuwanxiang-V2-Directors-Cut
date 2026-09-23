import { validateCharacterLibraryBackup } from './qianmu-character-library-backup.js';
import { validateComfyLibraryBackup } from './qianmu-comfy-library-backup.js';
import { readStaticReferenceImages, comfyWorkflowReferenceHash } from './qianmu-comfy-references.js';
import { comfyReferenceStillMime } from './qianmu-comfy-results.js';
import { parseStrictStoryboardJson } from './qianmu-storyboard-package-input.js';
import { vibeDigest } from './qianmu-vibe-file.js';
import {validateCharacterSources,inspectCharacterSources} from './qianmu-character-source-backup.js';

export const CHARACTER_BACKUP_FILE_SCHEMA = 'qianmu.character.resources.v1';
export const CHARACTER_BACKUP_SOURCES_SCHEMA = 'qianmu.character.resources.v2';
export const CHARACTER_BACKUP_FILE_BYTES = 128 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), { code: 'character_archive_backup_file', submissionState: 'not_submitted' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const size = value => new TextEncoder().encode(value).byteLength;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = row => JSON.stringify([row.id, row.revision, row.version]);

export function collectCharacterBackupDependencies(library, sources=null) {
  validateCharacterLibraryBackup(library);
  if(sources!==null)validateCharacterSources(sources,library.namespace);
  const images = new Map(), paths = new Map(), workflows = new Map(); let imageUses = 0;
  for (const document of [library,...(sources?.sources||[]).map(row=>row.library)]) for (const row of document.archives) {
    for (const name of ['reference', 'preview']) {
      const image = row.document.imagegen[name]; if (!image) continue; imageUses++;
      const previous = images.get(image.sha256), path = paths.get(image.url);
      if (previous && (previous.bytes !== image.bytes || previous.mime !== image.mime) || path && path !== image.sha256) fail('角色参考图收据互相冲突，请先保留原数据核对');
      images.set(image.sha256, previous || image); paths.set(image.url, image.sha256);
      if(images.size>1024)fail('角色与旧来源参考图超过1024份，未输出缺件包');
    }
    for (const implementation of row.document.comfy?.implementations || []) {
      const previous = workflows.get(key(implementation.workflow));
      if (previous && previous.hash !== implementation.workflow.hash) fail('角色实现绑定同一版本却有不同工作流摘要');
      workflows.set(key(implementation.workflow), implementation.workflow);
    }
  }
  return { images: [...images.values()], workflows: [...workflows.values()], imageUses };
}

export function selectCharacterBackupWorkflows(library, source, sources=null) {
  const census = collectCharacterBackupDependencies(library,sources);
  if (!census.workflows.length) return null;
  validateComfyLibraryBackup(source); if (source.namespace !== library.namespace) fail('角色实现的工作流库属于另一 ST 账户');
  const ids = new Set(census.workflows.map(row => row.id));
  return { ...source, workflows: source.workflows.filter(row => ids.has(row.head.id)) };
}

async function verifyWorkflows(library, source, census, guard) {
  if (!census.workflows.length) { if (source !== null) fail('角色备份含多余工作流库'); return; }
  validateComfyLibraryBackup(source); if (source.namespace !== library.namespace) fail('角色与工作流资源账户不一致');
  const ids = new Set(census.workflows.map(row => row.id)), versions = new Map();
  for (const row of source.workflows) {
    if (!ids.has(row.head.id)) fail('角色备份含未使用的工作流');
    for (const version of row.versions) versions.set(key(version.meta), version.document);
  }
  for (const binding of census.workflows) {
    await guard(); const document = versions.get(key(binding));
    if (!document) fail('角色实现缺少固定工作流原版本，未输出缺件备份');
    if (await comfyWorkflowReferenceHash(document.workflow) !== binding.hash) fail('角色实现与固定工作流原文不符');
  }
  await guard();
}

// Unified bundles share the full workflow library once. The character proof still checks only its exact pinned originals.
export async function verifyCharacterBackupWorkflowDependencies(library, workflows, {guard = async () => {},sources=null} = {}) {
  const census = collectCharacterBackupDependencies(library,sources), selected = selectCharacterBackupWorkflows(library, workflows,sources);
  await verifyWorkflows(library, selected, census, guard); return census;
}

async function verifyImage(value, expected) {
  if (!object(value) || Object.keys(value).some(key => !['sha256', 'mime', 'bytes', 'data'].includes(key)) || !hash(value.sha256) || !expected
    || value.sha256 !== expected.sha256 || value.bytes !== expected.bytes || value.mime !== expected.mime || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 16 * 1024 * 1024
    || typeof value.data !== 'string' || value.data.length !== 4 * Math.ceil(value.bytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) fail('角色原图文件、大小或收据不符');
  let binary; try { binary = atob(value.data); } catch (_) { fail('角色原图不是有效 Base64'); }
  if (binary.length !== value.bytes || btoa(binary) !== value.data) fail('角色原图编码不完整或非规范编码');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  let mime; try { mime = comfyReferenceStillMime(bytes); } catch (_) { fail('角色原图须为完整静态 PNG、JPEG 或 WebP'); }
  if (mime !== value.mime || await vibeDigest(bytes) !== value.sha256) fail('角色原图格式或内容摘要不符');
}

export async function buildCharacterBackupFile(library, { workflows = null, sources=null, readImages = readStaticReferenceImages, guard = async () => {} } = {}) {
  if(sources!==null)await inspectCharacterSources(sources,library.namespace,{guard});
  const census = collectCharacterBackupDependencies(library,sources); await verifyWorkflows(library, workflows, census, guard);
  const included=Boolean(sources?.sources.length);
  const header = JSON.stringify({ schema: included?CHARACTER_BACKUP_SOURCES_SCHEMA:CHARACTER_BACKUP_FILE_SCHEMA, namespace: library.namespace, credentialsIncluded: false, originalsIncluded: true, library, workflows,...(included?{sources}:{}) });
  // Confirm the complete expected encoded size before downloading any original. Never silently omit oversized/missing files.
  if (size(header) + census.images.reduce((sum, image) => sum + 4 * Math.ceil(image.bytes / 3) + 256, 0) + 64 > CHARACTER_BACKUP_FILE_BYTES) fail('角色库连同原图超过 128 MiB，未输出缺件包；请保留原环境');
  const parts = [header.slice(0, -1), ',"images":[']; let total = size(header) + 16, first = true;
  for (const receipt of census.images) {
    await guard(); const result = await readImages([receipt], { guard }); await guard();
    if (!Array.isArray(result) || result.length !== 1 || result[0]?.mime !== receipt.mime) fail('角色原图读取结果不符');
    const image = { sha256: receipt.sha256, bytes: receipt.bytes, mime: receipt.mime, data: result[0].data };
    await verifyImage(image, receipt); await guard();
    const text = JSON.stringify(image); total += size(text) + 1; if (total > CHARACTER_BACKUP_FILE_BYTES) fail('角色备份超过 128 MiB');
    if (!first) parts.push(','); parts.push(text); first = false;
  }
  parts.push(']}'); const file = new Blob(parts, { type: 'application/json' });
  if (file.size > CHARACTER_BACKUP_FILE_BYTES) fail('角色备份超过 128 MiB'); await guard();
  return { file, summary: { ...library.usage, images: census.images.length, imageUses: census.imageUses, workflowVersions: census.workflows.length, fileBytes: file.size,...(included?{sources:sources.sources.length}:{}) } };
}

export async function inspectCharacterBackupFile(value, { guard = async () => {} } = {}) {
  const included=value?.schema===CHARACTER_BACKUP_SOURCES_SCHEMA;
  if (!object(value) || Object.keys(value).some(key => !['schema', 'namespace', 'credentialsIncluded', 'originalsIncluded', 'library', 'workflows', 'images',...(included?['sources']:[])].includes(key))
    || ![CHARACTER_BACKUP_FILE_SCHEMA,CHARACTER_BACKUP_SOURCES_SCHEMA].includes(value.schema) || value.credentialsIncluded !== false || value.originalsIncluded !== true || !Array.isArray(value.images) || value.images.length > 1024
    || value.namespace !== value.library?.namespace) fail('角色资源备份格式或归属无效');
  if(included){await inspectCharacterSources(value.sources,value.namespace,{guard});if(!value.sources.sources.length)fail('新版角色资源包缺少旧源');}
  const census = collectCharacterBackupDependencies(value.library,value.sources||null); await verifyWorkflows(value.library, value.workflows, census, guard);
  if (size(JSON.stringify(value)) > CHARACTER_BACKUP_FILE_BYTES) fail('角色备份超过 128 MiB');
  const expected = new Map(census.images.map(image => [image.sha256, image]));
  for (const image of value.images) { await guard(); await verifyImage(image, expected.get(image?.sha256)); expected.delete(image.sha256); }
  if (expected.size) fail('角色备份缺少参考图或缩略图原件'); await guard();
  return { ...value.library.usage, images: value.images.length, imageUses: census.imageUses, workflowVersions: census.workflows.length,...(included?{sources:value.sources.sources.length}:{}) };
}

export async function readCharacterBackupFile(file, options) {
  if (!(file instanceof Blob) || file.size < 1 || file.size > CHARACTER_BACKUP_FILE_BYTES) fail('请选择 128 MiB 以内的角色资源备份');
  const bytes = await file.arrayBuffer(); if (bytes.byteLength !== file.size) fail('角色备份读取大小不符'); let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { fail('角色备份不是完整 UTF-8'); }
  const value = parseStrictStoryboardJson(text, { maxBytes: CHARACTER_BACKUP_FILE_BYTES }); await inspectCharacterBackupFile(value, options); return value;
}
