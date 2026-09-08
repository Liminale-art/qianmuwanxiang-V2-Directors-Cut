import { inspectCharacterBackupFile } from './qianmu-character-backup-file.js';
import { planCharacterLibraryRestore, characterLibraryBackupDigest as digest } from './qianmu-character-library-backup.js';
import { planComfyLibraryRestore } from './qianmu-comfy-library-backup.js';
import { comfyWorkflowReferenceHash } from './qianmu-comfy-references.js';
import { imageRestoreReceipt } from './qianmu-image-restore-contract.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'character_restore', submissionState: 'not_submitted' }); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const current = check => { if (check() !== true) fail('角色恢复页面或账户已变化'); };
const bindingKey = row => JSON.stringify([row.id, row.revision, row.version]);
const receipt = row => imageRestoreReceipt(Object.fromEntries(['url', 'sha256', 'mime', 'bytes'].map(key => [key, row[key]])));

// One immutable source per session. Metadata never enters settings; original images are verified before the final IDB transaction.
export async function createCharacterRestoreSession(namespace, input, { store, workflowStore, images, journal, guard = async () => {}, isCurrent = () => true, locks = globalThis.navigator?.locks } = {}) {
  const source = structuredClone(input); if (source.namespace !== namespace) fail('角色备份属于另一 ST 账户，请在目标环境显式重新绑定');
  await inspectCharacterBackupFile(source, { guard }); await guard(); current(isCurrent);
  const sourceDigest = await digest({ ...source, images: source.images.map(({ data: _, ...row }) => row) });
  const imageData = new Map(source.images.map(row => [row.sha256, row.data]));
  let stopped = false;
  const check = async () => { if (stopped) fail('角色恢复会话已结束，请重新选择原备份'); await guard(); current(isCurrent); };
  const syncCurrent = () => !stopped && isCurrent() === true;
  async function dependencies(plan, decisions) {
    const conflicts = new Set(plan.conflicts.filter(row => row.kind === 'archive').map(row => row.key));
    const selected = source.library.archives.filter(row => !conflicts.has(`archive:${row.head.id}`) || decisions[`archive:${row.head.id}`] === 'incoming');
    const originals = new Map(), bindings = new Map();
    for (const row of selected) {
      for (const value of [row.document.imagegen.reference, row.document.imagegen.preview]) if (value) {
        const compact = receipt(value), previous = originals.get(compact.url);
        if (previous && previous.sha256 !== compact.sha256) fail('角色原图位置存在互相冲突的收据'); originals.set(compact.url, compact);
      }
      for (const implementation of row.document.comfy?.implementations || []) bindings.set(bindingKey(implementation.workflow), implementation.workflow);
    }
    const ids = new Set([...bindings.values()].map(row => row.id));
    const workflows = ids.size ? { ...source.workflows, workflows: source.workflows.workflows.filter(row => ids.has(row.head.id)) } : null;
    return { originals: [...originals.values()], bindings: [...bindings.values()], workflows };
  }
  async function inspect(decisions = {}) {
    const choices = structuredClone(decisions); await check();
    const local = await store.backup(namespace, { isCurrent: syncCurrent }); await check();
    const plan = planCharacterLibraryRestore(local, source.library, { decisions: choices });
    const record = await journal.loadResource(namespace); await check();
    if (record && record.sourceDigest !== sourceDigest && record.phase !== 'verified') fail('有另一份尚未完成的角色恢复，请先选择原备份或明确结束其核对');
    const base = { namespace, sourceDigest, libraryDigest: await digest(local), decisions: choices, conflicts: plan.conflicts, summary: plan.summary,
      bindingReview: structuredClone(plan.bindingWrites), ready: plan.ready, record, images: [], workflowSummary: null, workflowDigest: null, planDigest: '' };
    if (!plan.ready) return { view: base, plan, dependencies: null };
    const needed = await dependencies(plan, choices);
    if (needed.workflows) {
      if (!workflowStore) fail('恢复所需的工作流库未就绪');
      const localWorkflows = await workflowStore.backup(namespace, { isCurrent: syncCurrent }); await check();
      const capacity = await workflowStore.usage(namespace); await check();
      base.workflowSummary = planComfyLibraryRestore(localWorkflows, needed.workflows, { maxBytes: capacity.limit }).summary;
      base.workflowDigest = await digest(localWorkflows);
    }
    for (const row of needed.originals) {
      await check(); if (!images) fail('原图恢复服务未就绪，请先更新增强服务');
      const state = await images.inspect(row); await check();
      if (!['missing', 'present', 'conflict'].includes(state.state) || await digest(state.receipt) !== await digest(row)) fail('原图核对返回不符');
      base.images.push({ ...row, state: state.state });
    }
    base.ready = !base.images.some(row => row.state === 'conflict');
    base.planDigest = await digest({ namespace, sourceDigest, libraryDigest: base.libraryDigest, workflowDigest: base.workflowDigest, decisions: choices });
    await check(); return { view: base, plan, dependencies: needed };
  }
  async function verifyWorkflows(needed) {
    if (!needed.workflows) return;
    const actual = await workflowStore.backup(namespace, { isCurrent: syncCurrent }), byVersion = new Map(); await check();
    for (const row of actual.workflows) for (const version of row.versions) byVersion.set(bindingKey(version.meta), version.document);
    for (const binding of needed.bindings) {
      const document = byVersion.get(bindingKey(binding));
      if (!document || await comfyWorkflowReferenceHash(document.workflow) !== binding.hash) fail('固定工作流原版本尚未完整恢复，角色档案未提交'); await check();
    }
  }
  async function verifyImages(needed) {
    for (const row of needed.originals) { await check(); const actual = await images.inspect(row); await check();
      if (actual.state !== 'present' || await digest(actual.receipt) !== await digest(row)) fail('原图尚未完整确认，角色档案未提交'); }
  }
  return Object.freeze({
    sourceDigest,
    async preview(decisions = {}) { return (await inspect(decisions)).view; },
    async restore(prepared, { confirmed = false, bindingsReviewed = false } = {}) {
      if (confirmed !== true || prepared?.namespace !== namespace || prepared.sourceDigest !== sourceDigest || !hash(prepared.planDigest) || !hash(prepared.libraryDigest)) fail('请先核对并确认角色库恢复');
      if (!locks?.request) fail('浏览器不支持跨页恢复锁，尚未写入原图或档案');
      const approved = structuredClone(prepared);
      return locks.request(`qianmu:character-restore:${namespace}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) fail('另一页面正在恢复角色库，请稍后重新核对');
        const latest = await inspect(approved.decisions);
        if (!latest.view.ready) fail('请处理全部档案、绑定和原图冲突后再恢复');
        if (latest.view.planDigest !== approved.planDigest || JSON.stringify(latest.view.record) !== JSON.stringify(approved.record)) fail('确认后本机库或恢复记录已变化，请重新核对');
        if (latest.view.bindingReview.length && bindingsReviewed !== true) fail('请先核对原角色身份及聊天标识；同名不代表同一身份');
        await check();
        let checkpoint = await journal.prepareResource({ namespace, kind: 'characters', sourceDigest, planDigest: approved.planDigest }, { previous: approved.record, confirmed: true, isCurrent: syncCurrent });
        try {
          checkpoint = await journal.updateResource(checkpoint, 'originals', { isCurrent: syncCurrent });
          for (const row of latest.dependencies.originals) {
            await check(); const actual = await images.inspect(row); await check();
            if (await digest(actual.receipt) !== await digest(row)) fail('原图核对返回另一收据，未继续上传');
            if (actual.state === 'conflict') fail('原图位置出现不同内容，未覆盖');
            if (actual.state === 'missing') await images.restore(row, imageData.get(row.sha256), { confirmed: true });
            else if (actual.state !== 'present') fail('原图状态不明，未自动重传');
            await check();
          }
          await verifyImages(latest.dependencies); await check();
          checkpoint = await journal.updateResource(checkpoint, 'workflows', { isCurrent: syncCurrent });
          if (latest.dependencies.workflows) await workflowStore.restoreBackup(namespace, latest.dependencies.workflows, { expectedDigest: approved.workflowDigest, confirmed: true, isCurrent: syncCurrent });
          await verifyWorkflows(latest.dependencies); await verifyImages(latest.dependencies); await check();
          checkpoint = await journal.updateResource(checkpoint, 'metadata', { isCurrent: syncCurrent });
          const summary = await store.restoreBackup(namespace, source.library, { expectedDigest: approved.libraryDigest, decisions: approved.decisions, confirmed: true, isCurrent: syncCurrent });
          await check(); const actual = await store.backup(namespace, { isCurrent: syncCurrent });
          if (await digest(actual) !== await digest(latest.plan.value)) fail('角色档案提交结果尚未确认，请保留备份核对');
          await verifyWorkflows(latest.dependencies); await verifyImages(latest.dependencies); await check();
          checkpoint = await journal.updateResource(checkpoint, 'verified', { isCurrent: syncCurrent });
          return { summary, images: latest.dependencies.originals.length, checkpoint };
        } catch (cause) {
          const known = typeof cause?.code === 'string' && /^(?:character_|image_restore_|comfy_library_|storyboard_package_)/.test(cause.code) && typeof cause.message === 'string' && cause.message.length <= 240;
          throw Object.assign(new Error(`恢复未全部确认，已保存部分保留。${known ? cause.message + '。' : ''}请重新选择同一备份核对续接，不会自动重传或回滚删图。`), { code: 'character_restore_partial', submissionState: 'not_submitted', cause });
        }
      });
    },
    close() { stopped = true; },
  });
}
