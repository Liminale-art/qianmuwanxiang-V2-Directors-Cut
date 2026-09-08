import assert from 'node:assert/strict';
import { captureStoryboardResourceBundle } from '../../qianmu-storyboard-bundle-resources.js';
import { normalizeComfyLibraryDocument, inspectComfyLibraryDocument } from '../../qianmu-comfy-library.js';
import { COMFY_LIBRARY_BACKUP_SCHEMA } from '../../qianmu-comfy-library-backup.js';
import { COMFY_POOL_BACKUP_SCHEMA } from '../../qianmu-comfy-pool-backup.js';
import { normalizeComfyAutoPool, COMFY_SELECTION_SCHEMA } from '../../qianmu-comfy-selection.js';
import { normalizeCharacterArchive, newCharacterArchive } from '../../qianmu-character-archive.js';
import { CHARACTER_LIBRARY_BACKUP_SCHEMA } from '../../qianmu-character-library-backup.js';
import { comfyWorkflowReferenceHash } from '../../qianmu-comfy-references.js';
import { vibeDigest } from '../../qianmu-vibe-file.js';

const namespace = 'st-user:bundle', chatKey = 'chat-one', clone = structuredClone;
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const png = Buffer.from(data, 'base64'), sha256 = await vibeDigest(png), blob = new Blob([png], { type: 'image/png' });
const file = value => new Blob([JSON.stringify(value)], { type: 'application/json' });
const receipt = { name: 'original', url: '/user/images/reference.png', mime: 'image/png', bytes: png.length, sha256 };
export async function fixture({ externalFiles = 0 } = {}) {
  let totalBytes = 0;
  const versions = [0, 77].map((seed, index) => {
    const extra = Object.fromEntries(Array.from({length:externalFiles},(_,i)=>[`model-${i}`,{class_type:i%2?'LoraLoader':'CheckpointLoaderSimple',inputs:{[i%2?'lora_name':'ckpt_name']:`models/test-${i}-v${index+1}.safetensors`}}]));
    const document = normalizeComfyLibraryDocument({ workflow: { text: { class_type: 'CLIPTextEncode', inputs: { text: '%qianmu_prompt%' } }, load: { class_type: 'LoadImage', inputs: { image: '%qianmu_reference_1%' } }, ...extra }, parameters: { seed }, classification: { version: 1 } });
    const inspected = inspectComfyLibraryDocument(document); totalBytes += inspected.bytes;
    const meta = { id: 'workflow', revision: `wrev${index+1}`, version: index+1, name: `Recipe${index+1}`, createdAt: 1, updatedAt: index+1, archived: false, bytes: inspected.bytes, totalBytes,
      nodes: inspected.nodes, slots: inspected.slots, issue: inspected.issue, classification: document.classification, parentRevision: index ? 'wrev1' : '' };
    return { meta, document };
  });
  const { parentRevision: _, ...head } = versions.at(-1).meta, workflows = { schema: COMFY_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, workflows: [{ head, versions }] };
  const binding = { schemaVersion: 1, namespace, id: 'workflow', revision: 'wrev1', version: 1, name: 'First recipe', workflowHash: await comfyWorkflowReferenceHash(versions[0].document.workflow), recipeHash: await vibeDigest(JSON.stringify(versions[0].document)) };
  const references = { version: 1, enabled: false, namespace, workflowHash: binding.workflowHash, items: [{ ...receipt, url: '/user/images/pool.png' }] };
  const pool = normalizeComfyAutoPool({ schema: COMFY_SELECTION_SCHEMA, namespace, id: 'pool', revision: 'prev1', enabled: true, styleLock: true, candidates: [{ id: 'candidate', enabled: true, priority: 0, classification: versions[0].document.classification,
    target: { providerId: 'comfy', modelId: 'comfy-workflow', connectionPresetId: 'connection', comfyCharacterEnabled: false, comfyWorkflowBinding: binding, comfyReferences: references } }] });
  const poolBytes = file(pool).size, poolHead = { id: 'pool', revision: 'prev1', version: 1, name: 'Pool', createdAt: 1, updatedAt: 1, archived: true, bytes: poolBytes, totalBytes: poolBytes, candidateCount: 1, enabled: true, styleLock: true };
  const pools = { schema: COMFY_POOL_BACKUP_SCHEMA, namespace, credentialsIncluded: false, pools: [{ head: poolHead, versions: [{ meta: { ...poolHead, archived: false }, pool }] }] };
  const document = normalizeCharacterArchive({ ...newCharacterArchive('char'), name: 'Alice', ageStatus: 'adult', imagegen: { appearance: 'dark hair', sensitiveAppearance: 'private annotation', reference: receipt,
    preview: { ...receipt, url: '/user/images/cover.png', sourceSha256: sha256 }, novelReference: { strength: 0, fidelity: 1 } },
    comfy: { version: 1, implementations: [{ version: 1, name: 'Reference', workflow: { id: 'workflow', revision: 'wrev1', version: 1, hash: binding.workflowHash }, referenceSlot: 1, loras: [], conditioning: [] }] } });
  const roleHead = { id: 'alice', revision: 'arev1', version: 1, category: 'char', name: 'Alice', aliases: [], cover: document.imagegen.preview.url, bytes: file(document).size, createdAt: 1, updatedAt: 1 };
  const characters = { schema: CHARACTER_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, archives: [{ head: roleHead, document }], bindings: [{ category: 'char', subjectKey: 'char:alice.png', scope: 'chat', chatKey, archiveId: '', revision: 'bind1', updatedAt: 1 }], usage: { count: 1, bytes: roleHead.bytes, bindings: 1 } };
  const config = { type: 'qianmu-storyboard', version: 7, credentialsIncluded: false, settings: { profiles: { comfy: { comfyWorkflowBinding: binding, comfyReferences: { ...references, items: [{ ...receipt, url: '/user/images/config.png' }] } } }, connections: { comfy: { presets: [{ id: 'connection', credentialId: '' }] } } },
    chat: { images: [{ id: 'frame', url: '/user/images/frame.png' }], collections: [] }, media: [{ id: 'frame', mime: 'image/png', b64: data }], vibeAccount: namespace, vibeAssets: [] };
  const sources = { workflows, pools, characters }, reads = { workflows: 0, pools: 0, characters: 0, images: 0 };
  const store = key => ({ backup: async () => { reads[key]++; return clone(sources[key]); } });
  const options = { namespace, chatKey, storyboard: file(config), workflowStore: store('workflows'), poolStore: store('pools'), characterStore: store('characters'),
    readImages: async rows => { reads.images++; assert.equal(rows.length, 1); return [blob]; }, now: () => 123 };
  return { sources, config, options, reads, build: () => captureStoryboardResourceBundle(options) };
}

export { namespace, chatKey, data, png, sha256, blob, file, receipt };
