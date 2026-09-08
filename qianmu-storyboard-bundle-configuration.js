import { STORYBOARD_SOURCES, sanitizeStoryboardSnapshot, createStoryboardMessageReference, resolveStoryboardMessageReference } from './qianmu-storyboard.js';
import { hashText } from './qianmu-storyboard-utils.js';
import { prepareStoryboardPackageDraft } from './qianmu-storyboard-package-draft.js';
import { createStoryboardMutation, inspectStoryboardMutation, applyStoryboardMutation } from './qianmu-storyboard-package-mutation.js';
import { comfyLibraryBackupDigest as digest } from './qianmu-comfy-library-backup.js';
import { captureStoryboardChatEvidence, inspectStoryboardChatEvidence, createStoryboardEvidenceLinkResolver, projectStoryboardChatMessages, storyboardChatProjectionMatches } from './qianmu-storyboard-chat-evidence.js';
import { inspectStoryboardSubjectEvidence, compareStoryboardSubjectEvidence } from './qianmu-storyboard-subject-evidence.js';
import { mappedStoryboardSubjectTargets, compareMappedStoryboardSubjects } from './qianmu-storyboard-subject-map.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_bundle_configuration', submissionState: 'not_submitted' }); };
const clone = structuredClone;

// Live ST state is injected by the entry point. Resource code never gets a reference to these objects.
// Persistence may be debounced by ST: an applied journal is NOT proof of durable settings after reload.
export function createStoryboardBundleConfiguration({ namespace, chatKey, settings, chat, messages, journal, persist, guard, isCurrent, captureChatEvidence = captureStoryboardChatEvidence, captureSubjects, listSubjects }) {
  if (![messages, persist, guard, isCurrent].every(value => typeof value === 'function')) fail('缺少配置恢复环境或持久保存接口');
  const stamp = () => JSON.stringify(messages().map((message, floor) => createStoryboardMessageReference({ message, floor, chatKey, now: 1 })));
  const check = async () => { if (isCurrent() !== true) fail('配置恢复页面已变化'); await guard(); if (isCurrent() !== true) fail('配置恢复页面已变化'); };
  async function prepare(input) {
    const source = clone(input); await check();
    const sourceEvidence = source.chatEvidence ? await inspectStoryboardChatEvidence(source.chatEvidence, chatKey) : null;
    const originalStamp = sourceEvidence ? '' : stamp(), list = sourceEvidence ? messages().slice() : clone(messages());
    const projection = sourceEvidence ? projectStoryboardChatMessages(list) : null;
    const currentEvidence = sourceEvidence ? await captureChatEvidence(projection, chatKey, { guard: check }) : null;
    if (currentEvidence) await inspectStoryboardChatEvidence(currentEvidence, chatKey);
    await check();
    const resolveEvidence = sourceEvidence ? createStoryboardEvidenceLinkResolver(sourceEvidence, currentEvidence) : null;
    const references = new Map();
    const referenceFor = floor => {
      if (!references.has(floor)) references.set(floor, createStoryboardMessageReference({ message: list[floor], floor, chatKey, now: 1 }));
      return clone(references.get(floor));
    };
    const images = (source.chat?.images || []).map(raw => {
      if (!raw?.id || !Object.hasOwn(STORYBOARD_SOURCES, raw.source)) fail('成片包含不支持的渠道，未部分导入');
      if (raw.snapshotRef && !raw.snapshot && !raw.recipeUnavailable) fail('成片缺少原始配置，请保留原包');
      const url = source.imageUrls?.[raw.id];
      if (typeof url !== 'string' || !/^\/user\/images\/Qianmu-Storyboards\/import-[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(url)) fail('成片缺少已核对的原件收据地址');
      const record = { ...raw, url, chatKey }; delete record.snapshotRef; delete record.snapshotVersion;
      record.snapshot = sanitizeStoryboardSnapshot(record.snapshot || {}, { source: record.source, prompt: record.prompt, negative: record.negative });
      const floor = Number.isInteger(record.floor) ? record.floor : null, message = list[floor];
      const sourceFloor = floor ?? (Number.isInteger(raw.lastKnownFloor) ? raw.lastKnownFloor : Number.isInteger(raw.messageRef?.lastKnownFloor) ? raw.messageRef.lastKnownFloor : null);
      const reference = record.messageRef ? { ...record.messageRef, chatKey } : null;
      const resolved = !resolveEvidence && !raw.restoreLinkReview && reference?.messageKey ? resolveStoryboardMessageReference(reference, list, { chatKey }) : null;
      const valid = resolved ? resolved.state === 'active' : message && Boolean(record.messageHash) && record.messageHash === hashText(String(message.mes || '')) && Number(record.swipeId || 0) === Number(message.swipe_id || 0);
      const evidenceFloor = resolveEvidence ? resolveEvidence(raw) : null;
      if (resolveEvidence) {
        if (evidenceFloor !== null) {
          record.floor = evidenceFloor; record.lastKnownFloor = evidenceFloor; record.linkState = 'active'; record.messageRef = referenceFor(evidenceFloor);
          if (record.paragraphAnchor) record.paragraphAnchor = { ...record.paragraphAnchor, floor: evidenceFloor };
        }
        else { record.lastKnownFloor = sourceFloor; record.floor = null; record.linkState = 'orphaned'; }
      }
      else if (resolved?.state === 'active') { record.floor = resolved.floor; record.linkState = 'active'; record.messageRef = reference; }
      else if (!valid || raw.restoreLinkReview) { record.lastKnownFloor = sourceFloor; record.floor = null; record.linkState = resolved?.state || 'orphaned'; }
      if (record.floor === null && record.linkState === 'orphaned') {
        record.restoreLinkReview ||= { version: 1, sourceChatKey: chatKey, sourceFloor, sourceFingerprint: source.fingerprint, reason: 'unverified-message' };
        record.requestedInline = record.requestedInline ?? record.inline; record.inline = false;
      }
      return record;
    });
    const draft = prepareStoryboardPackageDraft({ settings, chat, incoming: source.settings, images, collections: source.chat?.collections || [], chatKey, now: 0 });
    const mutation = await createStoryboardMutation({ namespace, chatKey, fileHash: source.fingerprint, settings, chat, draft, now: () => 0 });
    const proof = await digest({ mutation, connections: draft.connectionReview, messages: currentEvidence?.digest || originalStamp }); await check();
    if ((projection ? !storyboardChatProjectionMatches(projection, messages()) : stamp() !== originalStamp) || inspectStoryboardMutation(mutation, { settings, chat }).conflicts.length) fail('核对期间正文或配置已变化');
    return { mutation, stamp: originalStamp, projection, digest: proof, summary: { images: images.length, orphaned: images.filter(row => row.linkState !== 'active' && row.floor == null).length,
      fields: mutation.patch.length, connections: draft.connectionReview, chatEvidence: Boolean(sourceEvidence), chatChanged: sourceEvidence ? sourceEvidence.digest !== currentEvidence.digest : null } };
  }
  return Object.freeze({
    async targets(input) {
      await check();if(typeof listSubjects!=='function')fail('缺少ST角色目标目录接口');
      const result=await listSubjects({category:input.category,query:input.query,offset:input.offset});await check();return result;
    },
    async subjects(input) {
      await check();
      if (typeof captureSubjects !== 'function') fail('缺少角色来源读取接口，请更新前端后核对');
      const source = await inspectStoryboardSubjectEvidence(input.subjectEvidence), bindings = clone(input.subjectBindings);
      if (!Array.isArray(bindings) || bindings.length > 2048) fail('角色来源绑定核对范围无效');
      const mappings = input.subjectMappings || [];
      const target = await captureSubjects(mappedStoryboardSubjectTargets(source.subjects,mappings)); await check();
      return mappings.length ? compareMappedStoryboardSubjects(source,target,bindings,mappings) : compareStoryboardSubjectEvidence(source, target, bindings);
    },
    async preview(input) { const prepared = await prepare(input); return { digest: prepared.digest, summary: prepared.summary }; },
    async apply(input) {
      const source = clone(input), prepared = await prepare(source);
      if (source.expectedDigest !== prepared.digest) fail('配置或正文已变化，未覆盖，请重新核对');
      await check(); const pending = await journal.prepareMutation(prepared.mutation, { isCurrent }); await check();
      const report = inspectStoryboardMutation(pending, { settings, chat });
      if ((prepared.projection ? !storyboardChatProjectionMatches(prepared.projection, messages()) : stamp() !== prepared.stamp) || report.conflicts.length || report.after) fail('写入恢复记录期间正文或配置已变化，请先核对导入');
      applyStoryboardMutation(pending, { settings, chat });
      try {
        await persist(); await check(); await journal.updateMutation(pending, 'applied', { isCurrent }); await check();
        return { settingsApplied: true, settingsVerified: false };
      } catch (cause) {
        if (isCurrent() === true) try { await journal.updateMutation(pending, 'uncertain', { isCurrent }); } catch (_) {}
        throw Object.assign(new Error('配置保存尚未确认，请刷新后通过“核对导入”处理；原配置恢复记录和原件已保留'), { code: 'storyboard_bundle_configuration_pending', cause, submissionState: 'not_submitted' });
      }
    },
  });
}
