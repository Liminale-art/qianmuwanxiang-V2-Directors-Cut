// 数据管理卡里「资料库」各行的整库导出／恢复。
// 每个库都调用它自己现成的备份与恢复函数，这里只负责：取账户、开关仓、分批、确认与提示。
// 所有依赖在用到时才加载，不拖慢启动。

const VIBE_BATCH = 16, VIBE_BATCH_BYTES = 56 * 1024 * 1024;

// 把 Vibe 原件按「每批至多 16 份、合计不超过约 56 MB」切开（单次导出的上限是 16 份／64 MB）。
export function planVibeBatches(items = []) {
  const batches = [];
  let current = [], bytes = 0;
  for (const item of items) {
    const size = Math.max(0, Number(item.bytes) || 0);
    if (current.length && (current.length >= VIBE_BATCH || bytes + size > VIBE_BATCH_BYTES)) { batches.push(current); current = []; bytes = 0; }
    current.push(item.id); bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

// 专注语音按备份文件的 32 MiB 上限分批；单条就超限的放进 skipped。
export function planFocusBatches(rows = [], { limit, clips }) {
  const cost = row => Math.ceil((Number(row.audioBytes) || 0) / 3) * 4 + 8192;
  const batches = [], skipped = [];
  let current = [], bytes = 256;
  for (const row of rows) {
    const size = cost(row);
    if (256 + size > limit) { skipped.push(row); continue; }
    if (current.length && (current.length >= clips || bytes + size > limit)) { batches.push(current); current = []; bytes = 256; }
    current.push(row); bytes += size;
  }
  if (current.length) batches.push(current);
  return { batches, skipped };
}

const part = (index, total) => total > 1 ? `-${index + 1}of${total}` : '';

// deps:
//   resolveNamespace()            当前 ST 账户的命名空间
//   confirm(title, text)          确认框，返回 true 才继续
//   download(blob, name)          保存文件
//   notify(text, kind)            提示
//   headers()                     请求头（角色原图恢复用）
//   fonts                         字体库控制器（action('export'|'import')）
//   vibe()                        => { call, storage, items }：Vibe 文件通道、文件空间模块、当前库条目
//   focusFree()                   专注语音库此刻能否操作
//   open(key)                     打开对应库的管理页
export function createStorageLibraryTransfer({ resolveNamespace, confirm, download, notify, headers = () => ({}), fonts, vibe, focusFree = () => true, open = () => {}, stamp = () => Date.now() }) {
  let busy = false;
  // 统一的外壳：同一时间只跑一项；全程核对账户没变；失败只提示，不抛到界面外。
  const run = (label, work) => async (...args) => {
    if (busy) return notify('上一项备份或恢复还在进行，请稍候。', 'info');
    busy = true;
    try {
      const namespace = await resolveNamespace();
      let alive = true;
      const isCurrent = () => alive;
      const guard = async () => { if (!alive || namespace !== await resolveNamespace()) { alive = false; throw new Error('账户已变化，请重新操作'); } };
      await work({ namespace, guard, isCurrent }, ...args);
    } catch (error) {
      notify(`${label}未完成：${error?.userMessage || error?.message || error}`, 'warning');
    } finally { busy = false; }
  };
  const save = (value, name) => download(value instanceof Blob ? value : new Blob([JSON.stringify(value)], { type: 'application/json' }), name);

  // ── 角色库 ──
  const charactersExport = run('角色库备份', async ({ namespace, guard, isCurrent }) => {
    const [codec, sourceCodec, { characterLibraryBackupDigest: digest }, { createCharacterArchiveStore }] = await Promise.all([
      import('./features/character/qianmu-character-backup-file.js'), import('./features/character/qianmu-character-source-backup.js'),
      import('./features/character/qianmu-character-library-backup.js'), import('./features/character/qianmu-character-archive-store.js')]);
    await guard();
    const store = createCharacterArchiveStore();
    try {
      const capture = async () => ({ library: await store.backup(namespace, { isCurrent }), sources: await sourceCodec.captureCharacterSources(store, namespace, { isCurrent, guard }) });
      const { library, sources } = await capture(), census = codec.collectCharacterBackupDependencies(library, sources), baseline = await digest({ library, sources });
      await guard();
      if (!library.usage.count && !sources.sources.length) return notify('角色库里还没有档案。', 'info');
      if (await confirm('备份角色库', `备份 ${library.usage.count} 份角色档案、${library.usage.bindings} 处绑定及 ${census.images.length} 份参考图／封面原件？仅保存到本机文件。不含模型／LoRA 文件、API 连接与授权。`) !== true) return;
      await guard();
      let workflows = null;
      if (census.workflows.length) {
        const workflowStore = (await import('./qianmu-comfy-library.js')).createComfyWorkflowStore();
        try { workflows = codec.selectCharacterBackupWorkflows(library, await workflowStore.backup(namespace, { isCurrent }), sources); } finally { workflowStore.close(); }
      }
      const result = await codec.buildCharacterBackupFile(library, { workflows, sources, guard });
      await guard();
      if (await digest(await capture()) !== baseline) throw new Error('备份期间角色库有改动，请重新备份');
      await guard(); await download(result.file, 'qianmu-character-resources.json');
      notify(`已备份 ${library.usage.count} 份角色档案。`, 'success');
    } finally { store.close(); }
  });
  // 恢复只走「没有任何需要逐项确认的差异」这一条直路；其余交给角色库自己的核对页。
  const charactersImport = run('角色库恢复', async ({ namespace, guard, isCurrent }, file) => {
    const [files, module, imageModule, journalModule, { createCharacterArchiveStore }] = await Promise.all([
      import('./features/character/qianmu-character-backup-file.js'), import('./features/character/qianmu-character-backup-restore.js'),
      import('./features/gallery/qianmu-image-restore-client.js'), import('./qianmu-storyboard-package-journal.js?v=1.59.414'),
      import('./features/character/qianmu-character-archive-store.js')]);
    await guard();
    const store = createCharacterArchiveStore(), journal = journalModule.createStoryboardPackageJournal();
    let workflowStore = null, session = null;
    const handOver = text => { notify(text, 'info'); open('characters'); };
    try {
      const pending = await journal.loadResource(namespace); await guard();
      if (pending && pending.phase !== 'verified') return handOver('角色库有一次尚未完成的恢复，请在角色库的「恢复角色库与原图」里续接或结束它。');
      const packet = await files.readCharacterBackupFile(file, { guard }); await guard();
      if (packet.workflows) workflowStore = (await import('./qianmu-comfy-library.js')).createComfyWorkflowStore();
      session = await module.createCharacterRestoreSession(namespace, packet, { store, workflowStore, journal,
        images: imageModule.createImageRestoreClient({ namespace, headers, guard }), guard, isCurrent });
      const preview = await session.preview(); await guard();
      if (!preview.ready || preview.conflicts?.length || preview.bindingReview?.length)
        return handOver('这份备份与本机档案有需要逐项确认的差异（同名档案或聊天绑定），请在角色库的「恢复角色库与原图」里选择同一文件核对。');
      if (await confirm('恢复角色库', '把备份里的角色档案与原图补进当前账户？本机已有的档案不会被覆盖。恢复分步保存，中断后请用同一份备份重新核对。不启动生成，也不改变镜头台开关。') !== true) return;
      await guard(); await session.restore(preview, { confirmed: true, bindingsReviewed: false }); await guard();
      notify('角色库与原图已恢复。', 'success');
    } finally { session?.close(); workflowStore?.close(); journal.close(); store.close(); }
  });

  // ── Vibe 原件 ──
  const vibeActions = async ({ namespace, guard }) => { const { call, storage, items } = await vibe(); await guard(); return storage.createVibeStorageActions({ namespace, call, guard, items }); };
  const vibesExport = run('Vibe 备份', async scope => {
    const actions = await vibeActions(scope), snapshot = await actions.list(), batches = planVibeBatches(snapshot.items || []);
    if (!batches.length) return notify('当前账户还没有 Vibe 原件。', 'info');
    const count = batches.reduce((sum, ids) => sum + ids.length, 0);
    if (await confirm('备份 Vibe 原件', `导出 ${count} 份 Vibe 原件${batches.length > 1 ? `，分成 ${batches.length} 个文件（单个文件至多 16 份）` : ''}？库里的条目、分组与默认值随「配置」一起备份。`) !== true) return;
    for (const [index, ids] of batches.entries()) {
      await save(await actions.export(snapshot, ids), `qianmu-vibe-backup${part(index, batches.length)}.${ids.length === 1 ? 'naiv4vibe' : 'naiv4vibeBundle'}`);
      if (index < batches.length - 1) await new Promise(resolve => setTimeout(resolve, 400));
    }
    notify(`已导出 ${count} 份 Vibe 原件。`, 'success');
  });
  const vibesImport = run('Vibe 恢复', async (scope, file) => {
    const actions = await vibeActions(scope), plan = await actions.inspectRestore(file);
    if (!plan?.missingCount) return notify('这份备份里的原件本机都已存在，无需恢复。', 'info');
    if (!plan.fits) throw new Error('当前账户的 Vibe 空间放不下这份备份，请先整理');
    const result = await actions.restore(plan, file, confirm);
    if (result) notify(`已恢复 ${result.restored ?? plan.missingCount} 份 Vibe 原件。`, 'success');
  });

  // ── Comfy 工作流与候选方案（同一份资源包）──
  const withComfy = async ({ namespace, guard, isCurrent }, work) => {
    const [codec, { createComfyWorkflowStore }, { createComfyPoolStore }] = await Promise.all([
      import('./qianmu-comfy-resource-backup.js'), import('./qianmu-comfy-library.js'), import('./qianmu-comfy-pool-store.js')]);
    await guard();
    const workflowStore = createComfyWorkflowStore(), poolStore = createComfyPoolStore();
    try { return await work(codec, { workflowStore, poolStore, guard, isCurrent }, namespace); } finally { workflowStore.close(); poolStore.close(); }
  };
  const comfyScope = '仅供同一 ST 账户换设备或重装时恢复。不含模型／LoRA 文件、参考图原件、API 连接与服务授权。';
  const comfyExport = run('Comfy 备份', scope => withComfy(scope, async (codec, options, namespace) => {
    const packet = await codec.captureComfyResourcesBackup(namespace, options), summary = await codec.validateComfyResourcesBackup(packet, options);
    await scope.guard();
    if (!summary.workflows.count && !summary.pools.count) return notify('还没有 Comfy 工作流或候选方案。', 'info');
    if (await confirm('备份 Comfy 资源', `备份 ${summary.workflows.count} 个工作流（${summary.workflows.versions} 个历史版本）及 ${summary.pools.count} 个候选方案（${summary.pools.versions} 个历史版本）？${comfyScope}`) !== true) return;
    await scope.guard(); await save(packet, 'qianmu-comfy-resources.json');
    notify('Comfy 工作流与候选方案已备份。', 'success');
  }));
  // 旧版「仅工作流库」备份（工作流页以前单独导出的那种）走工作流库自己的恢复。
  const restoreWorkflowsOnly = async (scope, codec, packet, { workflowStore, isCurrent }, namespace) => {
    const local = await workflowStore.backup(namespace, { isCurrent }), usage = await workflowStore.usage(namespace);
    const { summary } = codec.planComfyLibraryRestore(local, packet, { maxBytes: usage?.limit }), expectedDigest = await codec.comfyLibraryBackupDigest(local); await scope.guard();
    if (await confirm('恢复工作流库', `新增 ${summary.added} 个工作流，补齐 ${summary.extended} 个的后续版本，保留 ${summary.kept} 个本机方案。不会切换当前工作流，也不启用自动选择。`) !== true) return;
    await scope.guard(); await workflowStore.restoreBackup(namespace, packet, { expectedDigest, confirmed: true, isCurrent });
    notify('工作流库已恢复；候选方案、连接与模型文件未变。', 'success');
  };
  const comfyImport = run('Comfy 恢复', (scope, file) => withComfy(scope, async (codec, options, namespace) => {
    let packet;
    try { packet = await codec.readComfyResourcesBackup(file, options); }
    catch (error) {
      const legacy = await import('./qianmu-comfy-library-backup.js'), old = await legacy.readComfyLibraryBackup(file).catch(() => null);
      if (!old) throw error;
      await scope.guard(); return restoreWorkflowsOnly(scope, legacy, old, options, namespace);
    }
    await scope.guard();
    const prepared = await codec.previewComfyResourcesRestore(namespace, packet, options); await scope.guard();
    const pool = prepared.pools, workflow = prepared.workflows;
    if (await confirm('恢复 Comfy 资源', `工作流：新增 ${workflow.added}、补齐 ${workflow.extended}、保留本机 ${workflow.kept}；候选方案：新增 ${pool.added}、补齐 ${pool.extended}、保留本机 ${pool.kept}。${comfyScope}不会启动任务，也不改变镜头台的选择与开关。`) !== true) return;
    await scope.guard(); await codec.restoreComfyResourcesBackup(namespace, packet, { ...options, prepared, confirmed: true });
    notify('Comfy 工作流与候选方案已恢复；连接、参考图与模型文件请另行核对。', 'success');
  }));

  // ── 字体库（库自己会提示结果）──
  const fontsExport = run('字体库备份', () => fonts.action('export'));
  const fontsImport = run('字体库导入', (_scope, file) => fonts.action('import', { file }));

  // ── 专注语音库 ──
  const withFocus = async ({ guard }, work) => {
    if (!focusFree()) return notify('请先结束当前任务或关闭其他数据管理窗口。', 'info');
    const [{ createFocusLibraryStore }, codec, { FOCUS_LIBRARY_LIMITS }] = await Promise.all([
      import('./qianmu-focus-library-store.js'), import('./qianmu-focus-library-backup.js'), import('./qianmu-focus-library.js')]);
    await guard();
    const store = createFocusLibraryStore();
    try { return await work(store, codec, FOCUS_LIBRARY_LIMITS); } finally { store.close(); }
  };
  const focusExport = run('专注语音备份', scope => withFocus(scope, async (store, codec, limits) => {
    const rows = await store.list(scope.namespace, { isCurrent: scope.isCurrent }); await scope.guard();
    const { batches, skipped } = planFocusBatches(rows, { limit: codec.FOCUS_BACKUP_LIMIT, clips: limits.clips });
    if (!batches.length) return notify(skipped.length ? '语音单条超过备份上限，无法导出。' : '专注语音库里还没有语音。', 'info');
    const count = batches.reduce((sum, batch) => sum + batch.length, 0);
    if (await confirm('备份专注语音', `导出 ${count} 条语音${batches.length > 1 ? `，分成 ${batches.length} 个文件（单个文件上限 32 MiB）` : ''}？`) !== true) return;
    const time = stamp();
    for (const [index, batch] of batches.entries()) {
      await save(await codec.exportFocusLibrary(batch, { readAudio: store.readAudio, guard: scope.guard }), `qianmu-focus-voices-${time}${part(index, batches.length)}.json`);
      if (index < batches.length - 1) await new Promise(resolve => setTimeout(resolve, 400));
    }
    notify(`已导出 ${count} 条专注语音${skipped.length ? `；另有 ${skipped.length} 条单条超限未导出` : ''}。`, skipped.length ? 'warning' : 'success');
  }));
  const focusImport = run('专注语音导入', (scope, file) => withFocus(scope, async (store, codec) => {
    const items = await codec.inspectFocusLibraryBackup(file, { guard: scope.guard });
    if (await confirm('导入专注语音', `将导入 ${items.length} 条语音，不覆盖已有语音。`) !== true) return;
    await scope.guard();
    const result = await store.batch(scope.namespace, { add: items.map(({ clip, blob }) => ({ clip: { ...clip, namespace: scope.namespace, id: crypto.randomUUID() }, blob })) }, { isCurrent: scope.isCurrent });
    notify(`已导入 ${result?.added?.length ?? items.length} 条专注语音。`, 'success');
  }));

  const file = handler => (picked) => handler(picked);
  return {
    exports: { characters: () => charactersExport(), vibes: () => vibesExport(), comfy: () => comfyExport(), fonts: () => fontsExport(), focus: () => focusExport() },
    imports: { characters: file(charactersImport), vibes: file(vibesImport), comfy: file(comfyImport), fonts: file(fontsImport), focus: file(focusImport) },
  };
}
