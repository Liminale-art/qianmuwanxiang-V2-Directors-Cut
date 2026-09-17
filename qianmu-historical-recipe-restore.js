import { inspectHistoricalStoryboardBundle } from './qianmu-historical-storyboard-bundle.js';
import { planHistoricalStoryboardMerge } from './qianmu-historical-storyboard-merge.js';
import { createRecipeRestoreClient } from './qianmu-recipe-restore-client.js';
import { chatCharacterReceiptTarget } from './qianmu-chat-character-receipt.js';
import { chatGalleryReceiptText } from './qianmu-chat-gallery-receipt.js';
import { projectChatGalleryState } from './qianmu-chat-gallery-state.js';
import { vibeDigest } from './qianmu-vibe-file.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'historical_recipe_restore', submissionState: 'not_submitted' }); };
const clone = structuredClone;
const equal = (left, right) => chatGalleryReceiptText([{ value: left }]).text === chatGalleryReceiptText([{ value: right }]).text;
const fields = ['storyboardImages', 'storyboardCollections', 'characterDrafts'];
const scope = 'historical-recipe-files-only';

// The RECIPE FILE stage and a detached reference-resolution proposal. Does not
// assign live metadata, restore images/libraries, save ST or enable v4 restore UI.
// The host coordinator must guard actual account/page/source and later perform a
// fresh baseline check, original-file checks and a durable metadata transaction.
export function createHistoricalRecipeRestore({ file, namespace, target, readCurrent, guard, isCurrent,
  headers = () => ({}), fetchImpl = globalThis.fetch, timeoutMs = 600000, signal } = {}) {
  if (!(file instanceof Blob) || typeof namespace !== 'string' || ![readCurrent, guard, isCurrent, headers, fetchImpl].every(fn => typeof fn === 'function')
    || !Number.isFinite(timeoutMs) || timeoutMs < 1) fail('缺少历史配方原件、准确来源或页面保护');
  const selectedTarget = chatCharacterReceiptTarget(target);
  let closed = false, busy = false, preview = null, pendingAbort = null;
  const close = () => { closed = true; preview = null; pendingAbort?.(); };
  signal?.addEventListener('abort', close, { once: true }); if (signal?.aborted) close();
  const current = () => { if (closed || signal?.aborted || isCurrent() !== true) fail('历史配方恢复页面或账户已变化，请保留原包核对'); };
  async function operation(work) {
    current(); if (busy) fail('已有历史配方核对或恢复正在进行'); busy = true;
    const controller = new AbortController(), completed = []; let attempted = false, reject, client;
    const cancelled = new Promise((_, no) => reject = no);
    const abort = () => { controller.abort(); client?.close(); reject(new Error('历史配方恢复已取消或超时')); };
    pendingAbort = abort; const timer = setTimeout(abort, Math.min(600000, timeoutMs));
    const check = async () => {
      current(); if (controller.signal.aborted) fail('历史配方恢复已停止');
      if (await guard() === false) fail('历史配方恢复来源保护未通过');
      current(); if (controller.signal.aborted) fail('历史配方恢复已停止');
    };
    try {
      return await Promise.race([Promise.resolve().then(() => work({ check, completed, signal: controller.signal,
        createClient: recipeGuard => (client = createRecipeRestoreClient({ namespace, headers, fetchImpl, guard: recipeGuard })),
        markWrite: () => { attempted = true; },
      })), cancelled]);
    } catch (cause) {
      preview = null; if (attempted) closed = true;
      throw Object.assign(new Error(attempted ? '历史配方文件尚未完整确认；已保存原件保留，请重新核对，未改聊天引用或自动重传' : cause.message), {
        code: 'historical_recipe_restore', cause, recipesState: attempted ? 'needs_review' : 'not_started',
        completed: clone(completed), proposedSaved: null, metadataRestored: false, submissionState: 'not_submitted',
      });
    } finally {
      clearTimeout(timer); controller.abort(); client?.close(); pendingAbort = null; busy = false;
      if (closed) signal?.removeEventListener('abort', close);
    }
  }
  async function snapshot(check) {
    await check(); const value = clone(await readCurrent()); await check();
    if (!value || value.namespace !== namespace || !equal(chatCharacterReceiptTarget(value.target), selectedTarget)) fail('当前聊天不是原账户和准确角色／群组的同一聊天');
    return { namespace, target: selectedTarget, saved: value.saved, evidence: value.evidence };
  }
  async function prepare(check) {
    const inspected = await inspectHistoricalStoryboardBundle(file, { guard: check }); await check();
    if (inspected.source.namespace !== namespace || !equal(inspected.source.target, selectedTarget)) fail('历史原件包不属于所选账户和准确聊天');
    const baseline = await snapshot(check);
    const plan = await planHistoricalStoryboardMerge({ source: inspected.source, namespace, target: selectedTarget,
      currentSaved: baseline.saved, currentEvidence: baseline.evidence, guard: check });
    if (!plan.compatible) fail('当前资料与历史原件存在冲突，未开始写入配方');
    const baselineDigest = await vibeDigest(JSON.stringify(baseline));
    if (await vibeDigest(JSON.stringify(await snapshot(check))) !== baselineDigest) fail('核对期间正文或聊天资料已变化');
    const core = { scope, fingerprint: inspected.fingerprint, namespace, target: selectedTarget, metadataDigest: plan.digest,
      archiveRecipes: inspected.source.recipes.filter(row => row.origin === 'server-archive').length,
      inlineRecipes: inspected.source.recipes.filter(row => row.origin === 'saved-inline').length,
      ready: true, metadataRestored: false, originalsVerified: false, dependenciesRestored: false };
    const digest = await vibeDigest(JSON.stringify(core)); await check();
    return { view: { ...core, digest }, source: inspected.source, plan, baselineDigest };
  }
  return Object.freeze({
    close() { signal?.removeEventListener('abort', close); close(); },
    preview() { return operation(async ({ check }) => { preview = null; const result = await prepare(check); preview = clone(result.view); return clone(result.view); }); },
    restore({ confirmed = false, expectedDigest, scope: requestedScope } = {}) {
      if (confirmed !== true || requestedScope !== scope || !preview?.ready || expectedDigest !== preview.digest)
        return Promise.reject(Object.assign(new Error('请重新核对并明确确认仅保全历史配方文件'), { code: 'historical_recipe_restore', recipesState: 'not_started', proposedSaved: null }));
      const selectedDigest = expectedDigest;
      return operation(async context => {
        preview = null; const { check, completed, markWrite } = context, prepared = await prepare(check);
        if (prepared.view.digest !== selectedDigest) fail('原件或聊天资料已变化，请重新核对并确认');
        const verifyBaseline = async () => {
          if (await vibeDigest(JSON.stringify(await snapshot(check))) !== prepared.baselineDigest) fail('配方恢复期间正文或资料已变化，未继续处理');
          await check();
        };
        const proposed = clone(prepared.plan.proposedSaved), client = context.createClient(verifyBaseline);
        for (const recipe of prepared.source.recipes) {
          await verifyBaseline();
          if (recipe.origin === 'saved-inline') continue; // Keep full inline originals and every extension field exactly as saved.
          const record = proposed.storyboardImages.find(row => row.id === recipe.recordId && row.createdAt === recipe.createdAt);
          if (!record || record.snapshot != null || !equal(record.snapshotServerRef, recipe.reference)) fail('待保存画面与原配方引用不一致，未猜测重新关联');
          markWrite();
          const receipt = await client.restore({ source: { target: selectedTarget, recordId: recipe.recordId, createdAt: recipe.createdAt },
            snapshot: recipe.snapshot, originalReference: recipe.reference }, { confirmed: true, signal: context.signal });
          await verifyBaseline();
          // Replace ONLY the verified server reference. Keep legacy local refs,
          // unknown record fields, original order, drafts and albums untouched.
          record.snapshotServerRef = clone(receipt.reference); completed.push(clone(receipt));
        }
        await verifyBaseline();
        await projectChatGalleryState({ storyboardImages: [], ...proposed }, { namespace, chatKey: selectedTarget.chatId }); await check();
        const before = prepared.plan.before, changedFields = fields.filter(field => Object.hasOwn(before, field) !== Object.hasOwn(proposed, field)
          || Object.hasOwn(before, field) && !equal(before[field], proposed[field]));
        const result = { scope, fingerprint: prepared.view.fingerprint, namespace, target: selectedTarget,
          sourceDigest: prepared.plan.sourceDigest, metadataDigest: prepared.plan.digest, baselineDigest: prepared.baselineDigest,
          before: clone(before), proposedSaved: proposed, changedFields, archiveReceipts: clone(completed),
          archiveRecipesVerified: completed.length, inlineRecipesPreserved: prepared.view.inlineRecipes,
          metadataRestored: false, originalsVerified: false, dependenciesRestored: false, restoreSupported: false,
          requiredStages: ['verified-originals', 'dependency-review', 'durable-host-save'] };
        const digest = await vibeDigest(JSON.stringify(result)); await verifyBaseline();
        return { ...result, digest };
      });
    },
  });
}
