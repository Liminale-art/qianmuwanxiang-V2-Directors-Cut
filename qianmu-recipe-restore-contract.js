import { recipeArchiveEnvelope, recipeArchiveReference, recipeArchiveError, RECIPE_ARCHIVE_LIMITS } from './qianmu-recipe-archive-contract.js';
import { assertPortableStoryboardData } from './qianmu-storyboard-package-security.js';
import { vibeDigest } from './qianmu-vibe-file.js';

const fail = message => { throw recipeArchiveError('restore_contract', message, 400); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameReferenceContent = (left, right) => left.sha256 === right.sha256 && left.bytes === right.bytes;

// A separate EXPLICIT import contract. Ordinary preserve/read routes still accept
// only saved-chat selectors and never upload caller recipes or choose disk names.
export function recipeRestoreRequest(value) {
  if (!exact(value, ['version', 'expectedAccount', 'confirmed', 'source', 'snapshot', 'originalReference'])
    || value.version !== 1 || value.confirmed !== true) fail('请明确确认恢复原配方文件，不接受普通保存请求或额外路径');
  const envelope = recipeArchiveEnvelope({ version: 1, expectedAccount: value.expectedAccount, source: value.source, snapshot: value.snapshot });
  const originalReference = recipeArchiveReference(value.originalReference);
  const result = { ...envelope.value, confirmed: true, originalReference };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > RECIPE_ARCHIVE_LIMITS.fileBytes) fail('配方恢复请求超过安全上限，未截断');
  return result;
}

export async function inspectRecipeRestoreRequest(value) {
  // Snapshot/canonicalize before any await so callers cannot change identity or
  // recipe while serialized-workflow security checks or digest work is pending.
  const request = recipeRestoreRequest(value);
  const envelope = recipeArchiveEnvelope({ version: 1, expectedAccount: request.expectedAccount, source: request.source, snapshot: request.snapshot });
  await assertPortableStoryboardData(request.snapshot);
  const bytes = new TextEncoder().encode(envelope.text).byteLength, sha256 = await vibeDigest(envelope.text);
  if (!sameReferenceContent(request.originalReference, { bytes, sha256 })) fail('原配方完整内容、来源或长度与包内引用指纹不符，未写入');
  return { request, envelope: envelope.value };
}

export function recipeRestoreResponse(value) {
  if (!exact(value, ['ok', 'version', 'expectedAccount', 'source', 'originalReference', 'reference', 'proof'])
    || value.ok !== true || value.version !== 1 || value.proof !== 'durable-restored-recipe') fail('配方恢复回执不完整或版本不符');
  // Validate the source using the same bounded record/target contract, without
  // introducing a second loose interpretation of names or record timestamps.
  const checked = recipeArchiveEnvelope({ version: value.version, expectedAccount: value.expectedAccount, source: value.source,
    snapshot: { source: 'receipt-only', prompt: '', negative: '', profile: {}, payload: {} } });
  const originalReference = recipeArchiveReference(value.originalReference), reference = recipeArchiveReference(value.reference);
  if (!sameReferenceContent(originalReference, reference)) fail('配方恢复回执改变了原始内容指纹');
  return { ok: true, version: 1, expectedAccount: checked.value.expectedAccount, source: checked.value.source, originalReference, reference, proof: value.proof };
}

// Read only an exact, already-restored private file. No caller recipe, path,
// arbitrary account or implicit repair; usable before the chat points at it.
export function recipeVerificationRequest(value){
  if(!exact(value,['version','expectedAccount','source','reference'])||value.version!==1)fail('配方文件核对只接受准确来源与原引用');
  const checked=recipeArchiveEnvelope({version:1,expectedAccount:value.expectedAccount,source:value.source,
    snapshot:{source:'receipt-only',prompt:'',negative:'',profile:{},payload:{}}});
  return {version:1,expectedAccount:checked.value.expectedAccount,source:checked.value.source,reference:recipeArchiveReference(value.reference)};
}
export function recipeVerificationResponse(value){
  if(!exact(value,['ok','version','expectedAccount','source','reference','proof'])||value.ok!==true||value.proof!=='read-only-recipe-file')fail('配方文件核对回执不完整');
  return {ok:true,...recipeVerificationRequest({version:value.version,expectedAccount:value.expectedAccount,source:value.source,reference:value.reference}),proof:value.proof};
}
