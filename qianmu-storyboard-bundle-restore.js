import { openStoryboardBundle } from './qianmu-storyboard-bundle.js';
import { inspectStoryboardResourceBundle, collectStoryboardBundleRestoreOriginals } from './qianmu-storyboard-bundle-resources.js';
import { planComfyLibraryRestore, comfyLibraryBackupDigest as digest } from './qianmu-comfy-library-backup.js';
import { planComfyPoolRestore } from './qianmu-comfy-pool-backup.js';
import { planCharacterLibraryRestore } from './qianmu-character-library-backup.js';
import { imageRestoreReceipt } from './qianmu-image-restore-contract.js';
import { vibeDigest } from './qianmu-vibe-file.js';
import { createCharacterRestoreChoiceSnapshot } from './qianmu-character-backup-restore.js';
import { sourceIdentityLabelsMatch } from './qianmu-source-identity-contract.js';
import { validStoryboardConnectionReview } from './qianmu-storyboard-connection-identity.js';
import { storyboardResourceOriginsPage } from './qianmu-storyboard-resource-origins.js';
import { createStoryboardEnvironmentReview } from './qianmu-storyboard-environment-map.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_bundle_restore', submissionState: 'not_submitted' }); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clone = structuredClone;
const encode = bytes => { let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(value); };
function mergedLibrary(local, plan, key) {
  const rows = new Map(local[key].map(row => [row.head.id, row]));
  for (const row of plan.writes) rows.set(row.head.id, { head: row.head, versions: [...(rows.get(row.head.id)?.versions || []), ...row.versions] });
  return { ...local, [key]: [...rows.values()].sort((a, b) => a.head.id.localeCompare(b.head.id)) };
}

// Heavy source bodies stay inside this session (intended for a worker). Views contain summaries/receipts only.
// Resources use independent atomic stores, NOT a fictitious cross-IDB transaction or destructive rollback.
// configuration must preflight a detached draft, then persist its before/after mutation through the shared journal.
export async function createStoryboardBundleRestoreSession({ namespace, chatKey, file, workflowStore, poolStore, characterStore,
  vibeStage, images, journal, configuration, sourceIdentity, guard, isCurrent, locks = globalThis.navigator?.locks }) {
  if (typeof guard !== 'function' || typeof isCurrent !== 'function' || !configuration?.preview || !configuration?.apply) fail('缺少整包恢复的环境及配置核对');
  let closed = false, busy = false, choose = null;
  const syncCurrent = () => !closed && isCurrent() === true;
  const check = async () => { if (!syncCurrent()) fail('整包恢复页面已变化'); await guard(); if (!syncCurrent()) fail('整包恢复页面已变化'); };
  await check();
  const inspected = await inspectStoryboardResourceBundle(file, { guard: check, includeOrigins: true }), opened = await openStoryboardBundle(file, { guard: check });
  if (inspected.fingerprint !== opened.fingerprint) fail('核验后资源联包发生变化，请重新选择原文件');
  if (inspected.manifest.namespace !== namespace || inspected.manifest.chatKey !== chatKey) fail('请在原 ST 账户及原聊天核对；跨环境身份重绑定尚未确认');
  const sourceDigest = inspected.fingerprint, chatHash = await vibeDigest(chatKey);
  let environmentReview = null;
  const checkSource = async () => {
    await check(); if (!opened.manifest.source) return;
    if (typeof sourceIdentity?.inspect !== 'function') fail('此包含来源标识，请更新增强服务后核对，不能降级绕过');
    const target = await sourceIdentity.inspect(); await check();
    if (!environmentReview) environmentReview = await createStoryboardEnvironmentReview({ namespace, chatHash, sourceDigest, source: opened.manifest.source, target });
    else if (!sourceIdentityLabelsMatch(environmentReview.target, target)) fail('ST 来源标识不同于本次核对目标，已停止；请重新核对环境映射');
  };
  await checkSource();
  const environmentDigest = environmentReview?.state === 'mapping-required' ? environmentReview.digest : undefined;
  async function inspectEnvironmentMap(required = false) {
    if (!environmentDigest) return null;
    if (!journal.inspectEnvironmentMap || !journal.prepareEnvironmentMap) fail('请更新前端以保存环境映射凭据');
    const result = await journal.inspectEnvironmentMap(environmentReview); await check();
    if (!result?.fits) fail('环境映射凭据空间不足，未恢复；不会自动清理历史');
    if ((result.receipt && await digest(result.receipt.review) !== await digest(environmentReview)) || (required && !result.receipt)) fail('环境映射凭据写入尚未确认，未继续恢复');
    return result.receipt;
  }
  const configFile = (await opened.read('storyboard')).file;
  const payload = await opened.readJson('storyboard'), workflows = await opened.readJson('workflows'), pools = await opened.readJson('pools'), characters = await opened.readJson('characters');
  const legacyDocument = opened.manifest.entries.some(row => row.id === 'legacy-vibes') ? await opened.readJson('legacy-vibes') : null;
  const chatEvidence = opened.manifest.entries.some(row => row.id === 'chat-evidence') ? await opened.readJson('chat-evidence') : null;
  const subjectEvidence = opened.manifest.entries.some(row => row.id === 'subject-evidence') ? await opened.readJson('subject-evidence') : null;
  const gallery = new Map(), imageUrls = Object.create(null);
  for (const row of payload.media || []) {
    await check(); const bytes = Uint8Array.from(atob(row.b64), c => c.charCodeAt(0)), sha256 = await vibeDigest(bytes);
    const extension = row.mime === 'image/jpeg' ? 'jpg' : row.mime.split('/')[1];
    const receipt = imageRestoreReceipt({ url: `/user/images/Qianmu-Storyboards/import-${sha256}.${extension}`, sha256, mime: row.mime, bytes: bytes.length });
    gallery.set(receipt.url, { receipt, data: row.b64 }); imageUrls[row.id] = receipt.url;
  }
  const stageOptions = { namespace, chatKey, guard: check, isCurrent: syncCurrent };
  // Never send Base64 media or Vibe bodies to the live configuration adapter.
  const configOptions = () => ({ settings: clone(payload.settings), chat: clone(payload.chat), imageUrls: clone(imageUrls), fingerprint: sourceDigest, ...(chatEvidence ? { chatEvidence: clone(chatEvidence) } : {}) });
  async function inspectSubjects(bindings) {
    if (!subjectEvidence) return null;
    if (typeof configuration.subjects !== 'function') fail('请更新前端以核对角色来源；不能绕过新包证据');
    const result = await configuration.subjects({ fingerprint: sourceDigest, subjectEvidence: clone(subjectEvidence), subjectBindings: clone(bindings) }); await check();
    const required = new Set(bindings.filter(row => row.archiveId).map(row => JSON.stringify([row.category,row.subjectKey])));
    if (!hash(result?.digest) || typeof result.ready !== 'boolean' || !Array.isArray(result.rows) || result.rows.length !== subjectEvidence.subjects.length
      || result.rows.some((row,index) => row.category !== subjectEvidence.subjects[index].category || row.subjectKey !== subjectEvidence.subjects[index].subjectKey
        || row.required !== required.has(JSON.stringify([row.category,row.subjectKey])) || !['matched','changed','missing','unverified'].includes(row.state))
      || result.ready !== !result.rows.some(row => row.required && row.state === 'missing')) fail('角色来源核对返回不完整');
    return result;
  }
  async function verifySubjects(latest) {
    if (!subjectEvidence) return;
    const current = await inspectSubjects(latest.view.bindingReview);
    if (!current.ready || current.digest !== latest.subjects.digest) fail('角色或人设来源已变化，未继续套用绑定；请重新核对');
  }
  async function inspectImage(receipt) {
    await check(); const actual = await images.inspect(receipt); await check();
    if (!['present', 'missing', 'conflict'].includes(actual?.state) || await digest(actual.receipt) !== await digest(receipt)) fail('原图恢复返回不符，未继续写入');
    return { ...receipt, state: actual.state };
  }
  async function pendingRecords() {
    const record = await journal.loadResource(namespace, 'bundle'); await check();
    if (record && record.phase !== 'verified' && (record.sourceDigest !== sourceDigest || record.chatHash !== chatHash)) fail('另一份资源联包尚未恢复完成，请先选择原文件核对');
    if (record && record.phase !== 'verified' && record.environmentDigest !== environmentDigest) fail('未完成恢复的目标环境已变化，请先核对原记录');
    const roles = await journal.loadResource(namespace, 'characters'); await check();
    if (roles && roles.phase !== 'verified') fail('独立角色恢复尚未完成，请先核对原角色备份');
    if (await journal.loadMutation(namespace)) fail('配置有待核对导入，请先通过“核对导入”处理，不会自动重放');
    await check(); return record;
  }
  async function inspect(decisions = {}) {
    choose = null; const choices = clone(decisions); await checkSource(); const record = await pendingRecords(); await inspectEnvironmentMap();
    const localCharacters = await characterStore.backup(namespace, { isCurrent: syncCurrent }); await check();
    const characterPlan = planCharacterLibraryRestore(localCharacters, characters, { decisions: choices });
    const subjects = await inspectSubjects(characterPlan.bindingWrites);
    const view = { namespace, chatHash, sourceDigest, record, decisions: choices, conflicts: characterPlan.conflicts, subjectReview: subjects?.rows || [],
      summary: clone(inspected.summary), characterSummary: characterPlan.summary, bindingReview: clone(characterPlan.bindingWrites), images: [],
      ready: false, planDigest: '', settingsVerified: false, identityVerified: false, environmentReview: clone(environmentReview), sourceLabelsMatched: environmentReview?.state === 'matched' };
    const captureChoices = () => {
      const snapshot = createCharacterRestoreChoiceSnapshot(localCharacters, characters, characterPlan, { ...view, summary: view.characterSummary });
      choose = decisions => { const next = snapshot(decisions); return { ...next, characterSummary: next.summary, summary: clone(inspected.summary), environmentReview: clone(environmentReview), sourceLabelsMatched: environmentReview?.state === 'matched', poolSummary: null, vibe: null, configuration: null }; };
    };
    if (!characterPlan.ready) { captureChoices(); return { view }; }
    const localWorkflows = await workflowStore.backup(namespace, { isCurrent: syncCurrent }); await check();
    const workflowCapacity = await workflowStore.usage(namespace); await check();
    const workflowPlan = planComfyLibraryRestore(localWorkflows, workflows, { maxBytes: workflowCapacity.limit });
    const localPools = await poolStore.backup(namespace, { isCurrent: syncCurrent }); await check();
    const poolCapacity = await poolStore.usage(namespace); await check();
    const poolPlan = planComfyPoolRestore(localPools, pools, { maxBytes: poolCapacity.limit });
    const baseline = { workflows: await digest(localWorkflows), pools: await digest(localPools), characters: await digest(localCharacters) };
    const expected = { workflows: await digest(mergedLibrary(localWorkflows, workflowPlan, 'workflows')),
      pools: await digest(mergedLibrary(localPools, poolPlan, 'pools')), characters: await digest(characterPlan.value) };
    // All capacities and the ENTIRE configuration merge are checked before inspecting or writing originals.
    const vibe = await vibeStage.inspect(configFile, stageOptions); await check();
    if (!vibe.fits) fail('Vibe 原文件空间或名额不足，未开始恢复，不会自动清理');
    const config = await configuration.preview(configOptions()); await check();
    if (!hash(config?.digest) || !validStoryboardConnectionReview(config.summary?.connections)) fail('整包配置核对未返回完整连接清单，请更新前端');
    const excluded = characterPlan.conflicts.filter(row => row.kind === 'archive' && choices[row.key] === 'local').map(row => row.key.slice('archive:'.length));
    const originals = new Map((await collectStoryboardBundleRestoreOriginals(payload, pools, characters, excluded, legacyDocument)).map(row => [row.url, row]));
    for (const { receipt } of gallery.values()) {
      if (originals.has(receipt.url) && await digest(originals.get(receipt.url)) !== await digest(receipt)) fail('成片与参考原件存在不同内容的同路径');
      originals.set(receipt.url, receipt);
    }
    for (const receipt of originals.values()) view.images.push(await inspectImage(receipt));
    // Do not show a mixture of revisions if a local edit happened during a long preflight.
    for (const [key, store] of [['workflows', workflowStore], ['pools', poolStore], ['characters', characterStore]]) {
      await check(); if (await digest(await store.backup(namespace, { isCurrent: syncCurrent })) !== baseline[key]) fail('核对期间本机资源库已变化，请重新核对');
    }
    if (await digest(await pendingRecords()) !== await digest(record)) fail('核对期间恢复记录已变化');
    view.workflowSummary = workflowPlan.summary; view.poolSummary = poolPlan.summary;
    view.vibe = vibe; view.configuration = clone(config.summary || {});
    view.planDigest = await digest({ namespace, chatHash, sourceDigest, record, baseline, choices, expected, vibe, configuration: config.digest, images: view.images, ...(subjects ? { subjects: subjects.digest } : {}), ...(environmentReview ? { environment: environmentReview.digest } : {}) });
    view.ready = !view.images.some(row => row.state === 'conflict') && subjects?.ready !== false; await check(); captureChoices();
    return { view, baseline, expected, config, subjects, originals: [...originals.values()] };
  }
  async function verifyResources(latest) {
    for (const [key, store] of [['workflows', workflowStore], ['pools', poolStore], ['characters', characterStore]]) {
      await check(); const actual = await store.backup(namespace, { isCurrent: syncCurrent }); await check();
      if (await digest(actual) !== latest.expected[key]) fail('资源库写入后复核不符，请保留原文件核对');
    }
    for (const receipt of latest.originals) if ((await inspectImage(receipt)).state !== 'present') fail('原件写入后尚未完整确认，配置未应用');
    const vibe = await vibeStage.inspect(configFile, stageOptions); await check();
    if (vibe.fileHash !== latest.view.vibe.fileHash || vibe.missing !== 0 || !vibe.fits) fail('Vibe 原文件写入后尚未完整确认，配置未应用');
  }
  async function locked(name, action) {
    return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) fail('另一页面正在恢复资源，请稍后重新核对'); await check(); return action();
    });
  }
  return Object.freeze({
    sourceDigest,
    async resources(options = {}) { if(busy)fail('恢复正在执行，请勿重复操作');await check();return {...storyboardResourceOriginsPage(inspected.origins,options),sourceDigest}; },
    async preview(decisions = {}) { if (busy) fail('恢复正在执行，请勿重复操作'); return clone((await inspect(decisions)).view); },
    async choose(decisions = {}) {
      if (busy) fail('恢复正在执行，请勿重复操作'); const snapshot = choose, choices = clone(decisions); await check();
      if (!snapshot || snapshot !== choose) fail('冲突选择已过期，请重新核对');
      const view = snapshot(choices); await check(); if (snapshot !== choose) fail('冲突选择已过期，请重新核对'); return view;
    },
    async restore(prepared, { confirmed = false, environmentReviewed = false, environmentMapped = false, bindingsReviewed = false, subjectsReviewed = false, connectionsReviewed = false, resourcesReviewed = false } = {}) {
      if (busy) fail('恢复正在执行，请勿重复操作');
      if (confirmed !== true || environmentReviewed !== true || prepared?.namespace !== namespace || prepared.sourceDigest !== sourceDigest || !hash(prepared.planDigest)) fail('请先核对整包内容、原环境及原聊天，并明确确认恢复');
      if (!locks?.request) fail('浏览器不支持跨页恢复锁，尚未写入任何原件');
      const approved = clone(prepared); busy = true;
      try { return await locked(`qianmu:package-import:${namespace}`, () => locked(`qianmu:character-restore:${namespace}`, async () => {
        const latest = await inspect(approved.decisions);
        if (!latest.view.ready) fail('请处理全部角色、绑定和原图冲突');
        if (latest.view.planDigest !== approved.planDigest) fail('确认后资源、配置或恢复记录已变化，请重新核对');
        if (latest.view.bindingReview.length && bindingsReviewed !== true) fail('请逐项核对角色及聊天绑定；同名不是身份验证');
        if (latest.view.subjectReview.length && subjectsReviewed !== true) fail('请明确核对角色卡及人设内容差异，不能只确认同名绑定');
        if (latest.view.configuration.connections.length && connectionsReviewed !== true) fail('请核对连接差异及需要重新填写的授权；当前连接草稿不会切换');
        if (latest.view.summary.resourceOrigins.total && resourcesReviewed !== true) fail('请核对包内原件与外部依赖；模型文件、节点插件和授权不会自动恢复');
        if (environmentDigest && environmentMapped !== true) fail('请单独确认从备份来源到当前 ST 的环境映射；不会自动信任上次确认');
        await checkSource();
        let checkpoint = await journal.prepareResource({ namespace, kind: 'bundle', chatHash, sourceDigest, planDigest: approved.planDigest, ...(environmentDigest ? { environmentDigest } : {}) }, { previous: latest.view.record, confirmed: true, isCurrent: syncCurrent });
        const advance = async phase => { await checkSource(); await inspectEnvironmentMap(true); await verifySubjects(latest); checkpoint = await journal.updateResource(checkpoint, phase, { isCurrent: syncCurrent }); await check(); };
        try {
          if (environmentDigest) { await journal.prepareEnvironmentMap(environmentReview, { confirmed: true, isCurrent: syncCurrent }); await checkSource(); await inspectEnvironmentMap(true); }
          await advance('originals');
          for (const receipt of latest.originals) {
            const state = await inspectImage(receipt); if (state.state === 'conflict') fail('原图位置出现不同内容，未覆盖');
            if (state.state === 'missing') {
              const data = gallery.get(receipt.url)?.data || encode((await opened.read(`image:${receipt.sha256}`)).bytes);
              await check(); const result = await images.restore(receipt, data, { confirmed: true }); await check();
              if (!['created', 'reused'].includes(result?.state) || await digest(result.receipt) !== await digest(receipt)) fail('原图上传结果未确认，不会自动重传');
            }
          }
          for (const receipt of latest.originals) if ((await inspectImage(receipt)).state !== 'present') fail('原图尚未完整恢复');
          await advance('workflows'); await workflowStore.restoreBackup(namespace, workflows, { expectedDigest: latest.baseline.workflows, confirmed: true, isCurrent: syncCurrent });
          await check(); if (await digest(await workflowStore.backup(namespace, { isCurrent: syncCurrent })) !== latest.expected.workflows) fail('固定工作流版本尚未完整恢复');
          await advance('pools'); await poolStore.restoreBackup(namespace, pools, { expectedDigest: latest.baseline.pools, confirmed: true, isCurrent: syncCurrent });
          await check(); if (await digest(await poolStore.backup(namespace, { isCurrent: syncCurrent })) !== latest.expected.pools) fail('候选方案版本尚未完整恢复');
          await advance('metadata'); await characterStore.restoreBackup(namespace, characters, { expectedDigest: latest.baseline.characters, decisions: approved.decisions, confirmed: true, isCurrent: syncCurrent });
          await advance('vibes'); await vibeStage.stage(configFile, latest.view.vibe, true, stageOptions);
          await verifyResources(latest); await check();
          // 'verified' belongs to the RESOURCE checkpoint only. Debounced ST settings are tracked separately.
          await advance('verified');
          const config = await configuration.preview(configOptions()); await check();
          if (config?.digest !== latest.config.digest) fail('资源恢复期间配置或正文已变化，未覆盖；已恢复原件保留');
          await checkSource(); await inspectEnvironmentMap(true); await verifySubjects(latest); await configuration.apply({ ...configOptions(), expectedDigest: latest.config.digest }); await checkSource(); await inspectEnvironmentMap(true); await verifySubjects(latest);
          const mutation = await journal.loadMutation(namespace); await check();
          if (!mutation || mutation.fileHash !== sourceDigest || mutation.chatHash !== chatHash || mutation.phase !== 'applied') fail('配置保存结果未确认，请通过“核对导入”处理');
          return { checkpoint, resourcesVerified: true, settingsApplied: true, settingsVerified: false, verificationRequired: true };
        } catch (cause) {
          const known = /^(?:storyboard_|character_|comfy_|image_restore_)/.test(cause?.code || '') && typeof cause.message === 'string' && cause.message.length <= 240;
          throw Object.assign(new Error(`整包恢复未全部确认，已写入部分保留。${known ? cause.message + '。' : ''}请先核对配置记录，或重选原包重新确认续接；不会自动重传或回滚删图。`), { code: 'storyboard_bundle_restore_partial', submissionState: 'not_submitted', cause });
        }
      })); } finally { busy = false; }
    },
    close() { closed = true; choose = null; },
  });
}
