import { captureCurrentChatSource } from './qianmu-current-chat-source.js';
import { inspectHistoricalStoryboardBundle } from './qianmu-historical-storyboard-bundle.js';
import { createHistoricalOriginalRestore } from './qianmu-historical-original-restore.js';
import { createHistoricalRecipeRestore } from './qianmu-historical-recipe-restore.js';
import { createHistoricalChatSaveSession } from './qianmu-historical-chat-save.js';
import { inspectHistoricalChatMutation } from './qianmu-historical-chat-journal.js';
import { createChatGalleryStateClient, createChatGalleryEvidenceClient } from './qianmu-chat-character-receipt-client.js';
import { createHistoricalRecipeArchiveClient } from './qianmu-recipe-archive-client.js';
import { createRecipeRestoreClient } from './qianmu-recipe-restore-client.js';
import { createImageRestoreClient } from './qianmu-image-restore-client.js';
import { imageRestoreReceipt } from './qianmu-image-restore-contract.js';
import { chatGalleryReceiptText } from './qianmu-chat-gallery-receipt.js';
import { projectChatGalleryState } from './qianmu-chat-gallery-state.js';
import { captureStoryboardChatEvidence, projectStoryboardChatMessages, storyboardChatProjectionMatches } from './qianmu-storyboard-chat-evidence.js';
import { vibeDigest } from './qianmu-vibe-file.js';

const scope = 'historical-originals-and-current-chat';
const fields = ['storyboardImages', 'storyboardCollections', 'characterDrafts'];
const equal = (a, b) => chatGalleryReceiptText([{ value: a }]).text === chatGalleryReceiptText([{ value: b }]).text;
const fail = message => { throw Object.assign(new Error(message), { code: 'historical_restore', submissionState: 'not_submitted' }); };

// One coordinator, no new endpoint/UI or alternative host writer. A successful
// result covers THIS exact chat's originals and three raw fields, not libraries,
// video, the narrative itself or the external dependencies needed to regenerate.
export function createHistoricalRestore({ file, namespace, getContext, epoch, account, guard, isCurrent, journal,
  headers = () => getContext().getRequestHeaders?.() || {}, fetchImpl = globalThis.fetch, timeoutMs = 600000 } = {}) {
  if (!(file instanceof Blob) || ![getContext, epoch, account, guard, isCurrent, headers, fetchImpl].every(fn => typeof fn === 'function')
    || typeof namespace !== 'string' || !/^st-user:.+/.test(namespace) || namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(namespace) || !Number.isFinite(timeoutMs) || timeoutMs < 1
    || !['loadHistoricalChatMutation', 'prepareHistoricalChatMutation', 'updateHistoricalChatMutation'].every(key => typeof journal?.[key] === 'function')) fail('历史恢复缺少原件、当前聊天或持久核对记录');
  const source = captureCurrentChatSource({ getContext, epoch }), target = source.target;
  let closed = false, busy = false, preview = null, abortActive = null;
  const current = () => { if (closed || isCurrent() !== true) fail('历史恢复页面已结束'); source.assertCurrent(); };
  async function operation(work) {
    current(); if (busy) fail('已有原件恢复正在进行'); busy = true;
    const controller = new AbortController(), owned = []; let reject, attempted = false, stage = 'preview';
    const cancelled = new Promise((_, no) => reject = no);
    const abort = () => { controller.abort(); owned.forEach(client => client.close?.()); reject(new Error('历史恢复已取消或超时')); };
    abortActive = abort; const timer = setTimeout(abort, Math.min(600000, timeoutMs));
    let body = null, evidence = null;
    const check = async () => {
      current(); if (controller.signal.aborted) fail('历史恢复已停止');
      if (await guard() === false) fail('当前来源保护未通过'); current();
      if (await account() !== namespace) fail('ST 账户已变化'); current();
      if (controller.signal.aborted || body && !storyboardChatProjectionMatches(body, getContext().chat)) fail('正文或恢复来源已变化');
    };
    const fetchLinked = async (url, options = {}) => {
      await check(); const linked = new AbortController(), stop = () => { linked.abort(); controller.signal.removeEventListener('abort', stop); options.signal?.removeEventListener('abort', stop); };
      controller.signal.addEventListener('abort', stop, { once: true }); options.signal?.addEventListener('abort', stop, { once: true });
      if (controller.signal.aborted || options.signal?.aborted) stop();
      try { return await fetchImpl(url, { ...options, signal: linked.signal }); } catch (error) { stop(); throw error; }
    };
    const own = client => { owned.push(client); return client; };
    const shared = { namespace, target, headers, fetchImpl: fetchLinked, guard: check, isCurrent: () => !closed && !controller.signal.aborted && isCurrent() === true };
    async function snapshot() {
      await check();
      if (!body) { body = projectStoryboardChatMessages(getContext().chat); evidence = await captureStoryboardChatEvidence(body, target.chatId, { guard: check }); }
      const store = getContext().chatMetadata.story_director_liminale;
      if (!store || !Object.hasOwn(store, 'storyboardImages')) fail('原聊天静帧资料未初始化，未创建空槽覆盖');
      const saved = Object.fromEntries(fields.filter(key => Object.hasOwn(store, key)).map(key => [key, store[key]]));
      chatGalleryReceiptText([{ value: saved }]); const detached = structuredClone(saved);
      await projectChatGalleryState(detached, { namespace, chatKey: target.chatId }); await check();
      return { namespace, target, saved: detached, evidence: structuredClone(evidence) };
    }
    const state = own(createChatGalleryStateClient(shared)), bodyClient = own(createChatGalleryEvidenceClient(shared));
    async function serverMatches(saved) {
      const hash = await vibeDigest(chatGalleryReceiptText(saved.storyboardImages).text); await check();
      const first = await state.read(hash), text = await bodyClient.read(hash), last = await state.read(hash); await check();
      if (!equal(first.saved, saved) || !equal(last.saved, saved) || first.source.sha256 !== last.source.sha256 || text.chatEvidence.digest !== evidence.digest) fail('本机与服务器原聊天不一致，请重新载入核对');
    }
    const images = createImageRestoreClient(shared);
    async function imageStates(bundle) {
      const receipts = new Map();
      for (let i = 0; i < bundle.media.images.length; i++) {
        const row = bundle.media.images[i], receipt = imageRestoreReceipt({ url: bundle.source.saved.storyboardImages[i].url, sha256: row.sha256, bytes: row.bytes, mime: row.mime });
        const key = decodeURIComponent(receipt.url), prior = receipts.get(key);
        if (prior && ['sha256', 'bytes', 'mime'].some(key => prior[key] !== receipt[key])) fail('同一原图路径对应不同内容'); receipts.set(key, receipt);
      }
      const result = [];
      for (const receipt of receipts.values()) { await check(); const value = await images.inspect(receipt); await check(); result.push({ receipt, state: value.state }); }
      return result;
    }
    async function prepare() {
      const bundle = await inspectHistoricalStoryboardBundle(file, { guard: check }), baseline = await snapshot();
      if (bundle.source.namespace !== namespace || !equal(bundle.source.target, target) || bundle.source.selection.ids.length !== bundle.source.selection.total
        || bundle.source.chatEvidence.digest !== baseline.evidence.digest) fail('只接受原账户、准确聊天和未变化正文的完整原件包');
      await serverMatches(baseline.saved);
      const pending = await journal.loadHistoricalChatMutation(namespace, { isCurrent: shared.isCurrent }); await check();
      let record = null, originals, recipes, imageRows;
      if (pending) {
        record = await inspectHistoricalChatMutation(pending); await check();
        if (record.proposal.fileHash !== bundle.fingerprint || !equal(record.proposal.target, target) || record.proposal.chatEvidence.digest !== baseline.evidence.digest
          || !equal(baseline.saved, record.proposal.before) && !equal(baseline.saved, record.proposal.after)) fail('待核对记录与原包或当前资料不符，未覆盖');
        imageRows = await imageStates(bundle);
        if (imageRows.some(row => row.state !== 'present')) fail('原保存已开始，但原图缺失或变化，请保留待核对记录和原包');
      } else {
        const options = { ...shared, file, readCurrent: snapshot, signal: controller.signal };
        originals = own(createHistoricalOriginalRestore(options)); recipes = own(createHistoricalRecipeRestore(options));
        imageRows = (await originals.preview()).originals; await recipes.preview();
      }
      const baselineDigest = await vibeDigest(JSON.stringify(baseline));
      if (await vibeDigest(JSON.stringify(await snapshot())) !== baselineDigest) fail('核对期间本机资料已变化');
      const core = { scope, fingerprint: bundle.fingerprint, namespace, target, baselineDigest, mode: record ? 'recovery' : 'fresh',
        journal: record ? { revision: record.revision, phase: record.phase, proposalDigest: record.proposalDigest } : null,
        images: imageRows, recipes: bundle.source.recipes.length, ready: imageRows.every(row => row.state !== 'conflict'),
        excluded: ['chat-body', 'videos', 'global-settings', 'shared-libraries', 'external-models-nodes-assets'], dependenciesRestored: false };
      const digest = await vibeDigest(JSON.stringify(core)); await check();
      return { view: { ...core, digest }, bundle, baseline, record, originals, recipes };
    }
    async function verifyFinal(bundle, saved) {
      const local = await snapshot(); if (!equal(local.saved, saved)) fail('恢复资料在最终核对时已编辑'); await serverMatches(saved);
      if ((await imageStates(bundle)).some(row => row.state !== 'present')) fail('保存后原图未完整读回，请保留记录核对');
      const reader = own(createHistoricalRecipeArchiveClient({ ...shared, records: saved.storyboardImages }));
      for (const recipe of bundle.source.recipes) {
        const row = saved.storyboardImages.find(row => row.id === recipe.recordId && row.createdAt === recipe.createdAt);
        if (!row) fail('恢复画面与原配方失去对应');
        const read = await reader.read(row, { signal: controller.signal }); await check();
        if (!equal(read.snapshot, recipe.snapshot)) fail('保存后配方与原件不一致，未确认完成');
      }
      await serverMatches(saved); if (!equal((await snapshot()).saved, saved)) fail('最终核对期间本机资料已变化');
    }
    try { return await Promise.race([Promise.resolve().then(() => work({ check, shared, own, prepare, snapshot, verifyFinal, signal: controller.signal,
      imageStates, mark: value => { attempted = true; stage = value; } })), cancelled]); }
    catch (cause) { preview = null; if (attempted) closed = true; throw Object.assign(new Error(attempted ? '原件恢复尚未完整确认；已保存资料和待核对记录保留，不自动重传或回滚' : cause.message), { code: 'historical_restore', cause, stage, state: attempted ? 'needs_review' : 'not_started', restoreSupported: false }); }
    finally { clearTimeout(timer); controller.abort(); owned.forEach(client => client.close?.()); busy = false; abortActive = null; if (closed) source.close(); }
  }
  return Object.freeze({
    close() { closed = true; preview = null; source.close(); abortActive?.(); },
    preview() { return operation(async ({ prepare }) => { preview = null; const result = await prepare(); preview = structuredClone(result.view); return structuredClone(preview); }); },
    restore({ confirmed = false, expectedDigest, dependenciesAccepted = false } = {}) {
      if (confirmed !== true || dependenciesAccepted !== true || !preview?.ready || expectedDigest !== preview.digest) return Promise.reject(new Error('请重新核对并确认原件范围及外部依赖不在恢复范围'));
      const digest = expectedDigest;
      return operation(async op => {
        preview = null; const prepared = await op.prepare(); if (prepared.view.digest !== digest) fail('原件、资料或恢复记录已变化，请重新核对确认');
        // The saver loads independently. Bind that load to the exact record the
        // user confirmed, so a dismissed/replaced operation cannot be adopted
        // between this coordinator's preview and the saver's recovery step.
        const saveJournal = prepared.record ? {
          async loadHistoricalChatMutation(...args) {
            const row = await journal.loadHistoricalChatMutation(...args);
            if (!equal(row, prepared.record)) fail('待核对记录已更新，请重新确认此次原包');
            return row;
          },
          prepareHistoricalChatMutation: (...args) => journal.prepareHistoricalChatMutation(...args),
          updateHistoricalChatMutation: (...args) => journal.updateHistoricalChatMutation(...args),
        } : journal;
        const save = op.own(createHistoricalChatSaveSession({ ...op.shared, getContext, epoch, account, journal: saveJournal }));
        let result, saved;
        if (prepared.record) {
          op.mark('recovery'); result = await save.recover();
          saved = prepared.record.proposal.after;
          if (result.status !== 'saved') {
            if (prepared.record.phase === 'verified') fail('已核对记录与当前服务器状态不符，未重复保存');
            // Assets were already completed before this durable intent existed.
            // Revalidate each archived envelope; a different replacement pointer
            // requires a new plan, never silently rewrite the pending proposal.
            const recipes = op.own(createRecipeRestoreClient(op.shared));
            for (const recipe of prepared.bundle.source.recipes.filter(row => row.origin === 'server-archive')) {
              const row = saved.storyboardImages.find(row => row.id === recipe.recordId && row.createdAt === recipe.createdAt);
              const receipt = await recipes.restore({ source: { target, recordId: recipe.recordId, createdAt: recipe.createdAt }, snapshot: recipe.snapshot, originalReference: recipe.reference }, { confirmed: true, signal: op.signal }); await op.check();
              if (!row || !equal(receipt.reference, row.snapshotServerRef)) fail('待核对配方引用已变化，需要重新核对方案');
            }
            result = await save.retry({ confirmed: true });
          }
        } else {
          op.mark('originals'); let view = await prepared.originals.preview(); await prepared.originals.restore({ confirmed: true, scope: view.scope, expectedDigest: view.digest });
          op.mark('recipes'); view = await prepared.recipes.preview(); const recipes = await prepared.recipes.restore({ confirmed: true, scope: view.scope, expectedDigest: view.digest });
          if (!equal(recipes.before, prepared.baseline.saved)) fail('配方阶段与原确认基线不一致'); saved = recipes.proposedSaved;
          if ((await op.imageStates(prepared.bundle)).some(row => row.state !== 'present')) fail('保存前原图未完整核实，未提交聊天资料');
          op.mark('metadata'); result = await save.save({ namespace, target, before: recipes.before, after: saved, chatEvidence: prepared.baseline.evidence, fileHash: prepared.bundle.fingerprint }, { confirmed: true, scope: 'historical-chat-metadata-only' });
        }
        if (!['saved', 'unchanged'].includes(result.status)) fail('宿主保存尚未确认，请保留记录核对');
        op.mark('final-readback'); await op.verifyFinal(prepared.bundle, saved); await op.check();
        return { status: 'restored', scope, fingerprint: prepared.bundle.fingerprint, namespace, target, metadataVerified: true,
          originalsVerified: prepared.bundle.media.images.length, recipesVerified: prepared.bundle.source.recipes.length,
          durableJournal: result.durableJournal, dependenciesRestored: false, excluded: prepared.view.excluded, restoreSupported: false };
      });
    },
  });
}
