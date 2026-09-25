// Receive only the selected ST account's pending pictures into its current chat.
// The host can only save current-chat metadata, so every awaited boundary must
// recheck both the ST account and that exact chat/metadata owner.
export async function drainStoryboardDeliveries(expectedChatKey, env) {
  const {
    resolveImageAccountNamespace, storyboardState, ctx, getChatKey, blobStore, storyboardVolatileDeliveries,
    storyboardGalleryRecords, storyboardFloorTakeReceipts, storyboardUtilsModule, storyboardBlobToBase64,
    storyboardSafeUrl, storyboardImageExtension, getCharacterName, clone, resolveStoryboardMessageReference,
    storyboardFloorTakeInitialInline, hashText, transitionStoryboardTaskState, saveStoryboardFloorTakes,
    saveMetadata, storyboardValidatedAnchor, saveSettings, storyboardScheduleInlineRender, rerenderIfOpen,
    toast, warn = () => {},
  } = env;
  const namespace = await resolveImageAccountNamespace(), ownerState = storyboardState(), metadata = ctx().chatMetadata;
  const current = () => String(getChatKey() || '') === expectedChatKey
    && ownerState === storyboardState() && metadata === ctx().chatMetadata;
  const owns = async () => {
    try { return current() && await resolveImageAccountNamespace() === namespace && current(); }
    catch (_) { return false; }
  };
  const assertOwner = async () => {
    if (!await owns()) throw new Error('收片账户或聊天已变化，原图仍在待收箱');
  };
  let durable = [];
  try { durable = await blobStore.listStoryboardDeliveries(namespace, expectedChatKey); }
  catch (error) { warn('分镜待收箱暂时无法读取', error); }
  await assertOwner();
  const deliveries = new Map();
  for (const item of durable) if (item?.namespace === namespace && item.taskId && item.chatKey === expectedChatKey)
    deliveries.set(String(item.taskId), item);
  for (const item of storyboardVolatileDeliveries.values())
    if (item?.namespace === namespace && item.chatKey === expectedChatKey && item.taskId)
      deliveries.set(String(item.taskId), item);
  if (!deliveries.size) return 0;
  const chat = Array.isArray(ctx().chat) ? ctx().chat : [];
  const gallery = storyboardGalleryRecords(), takeReceipts = storyboardFloorTakeReceipts();
  const galleryById = new Map(), duplicateGalleryIds = new Set();
  for (const item of gallery) {
    const id = String(item?.id || '');
    if (galleryById.has(id)) duplicateGalleryIds.add(id);
    else galleryById.set(id, item);
  }
  const knownIds = new Set(galleryById.keys());
  const originalId = (delivery, index) => `pending-${delivery.taskId}-${index}`;
  const sameOriginal = (record, delivery, index) => record?.imageAccountNamespace === namespace
    && record.chatKey === expectedChatKey && record.taskId === delivery.taskId
    && record.imageIndex === index && record.origin === 'service_recovered'
    && record.recipeUnavailable === true && typeof record.url === 'string' && Boolean(record.url);
  const sameRecipe = (existing, raw, delivery) => existing?.taskId === delivery.taskId
    && existing.chatKey === expectedChatKey && existing.planId === delivery.planId
    && existing.planShotId === delivery.shotId && existing.imageIndex === raw.imageIndex
    && existing.url === raw.url
    && (!existing.imageAccountNamespace || existing.imageAccountNamespace === namespace)
    && (!existing.imageAdmission?.namespace || existing.imageAdmission.namespace === namespace);
  // Check the whole batch before any ST file save or inbox deletion. A matching
  // ID alone is never proof that this account/chat owns an archived picture.
  const incomingRecipeIds = new Set(), incomingOriginalIds = new Set();
  for (const delivery of deliveries.values()) {
    if (delivery.originalOnly) {
      if (!Number.isInteger(delivery.imageCount) || delivery.imageCount < 1 || delivery.imageCount > 8)
        throw new Error('待领取原图数量无效');
      for (let index = 0; index < delivery.imageCount; index++) {
        const id = originalId(delivery, index), existing = galleryById.get(id);
        incomingOriginalIds.add(id);
        if (duplicateGalleryIds.has(id) || (existing && !sameOriginal(existing, delivery, index)))
          throw new Error('待领取原图与图库记录来源冲突，领取记录仍保留');
      }
      continue;
    }
    const rows = delivery.records;
    if (!Array.isArray(rows) || !rows.length || rows.length > 8) throw new Error('待领取分镜记录缺失，领取记录仍保留');
    const deliveryIds = new Set(), deliveryIndices = new Set();
    for (const raw of rows) {
      if (typeof raw?.id !== 'string' || !raw.id.trim()
        || raw.taskId !== delivery.taskId || raw.chatKey !== expectedChatKey
        || String(raw.planId || '') !== String(delivery.planId || '')
        || String(raw.planShotId || '') !== String(delivery.shotId || '')
        || !Number.isInteger(raw.imageIndex) || raw.imageIndex < 0 || raw.imageIndex > 7
        || typeof raw.url !== 'string' || !raw.url
        || (raw.imageAccountNamespace && raw.imageAccountNamespace !== namespace)
        || (raw.imageAdmission?.namespace && raw.imageAdmission.namespace !== namespace)
        || deliveryIds.has(raw.id) || deliveryIndices.has(raw.imageIndex) || incomingRecipeIds.has(raw.id))
        throw new Error('待领取分镜记录不完整或重复，领取记录仍保留');
      deliveryIds.add(raw.id);
      deliveryIndices.add(raw.imageIndex);
      incomingRecipeIds.add(raw.id);
      const existing = galleryById.get(raw.id);
      if (duplicateGalleryIds.has(raw.id) || (existing && !sameRecipe(existing, raw, delivery)))
        throw new Error('待领取分镜与图库记录来源冲突，领取记录仍保留');
    }
    if (Array.from({ length: rows.length }, (_, index) => index).some(index => !deliveryIndices.has(index)))
      throw new Error('待领取分镜序号不完整，领取记录仍保留');
    const pendingTask = (ownerState.taskStates || []).find(item => item.id === delivery.taskId
      && item.chatKey === expectedChatKey && item.planId === delivery.planId && item.shotId === delivery.shotId
      && item.status === 'completed' && ['pending_chat', 'volatile_pending'].includes(item.deliveryState));
    if (pendingTask) {
      const ids = rows.map(row => row.id), frozen = pendingTask.resultIds;
      if (!Array.isArray(frozen) || frozen.length !== ids.length || new Set(frozen).size !== frozen.length
        || frozen.some(id => typeof id !== 'string' || !id.trim()) || ids.some(id => !frozen.includes(id)))
        throw new Error('待领取分镜与原任务图片清单不一致，领取记录仍保留');
    }
  }
  if ([...incomingOriginalIds].some(id => incomingRecipeIds.has(id)))
    throw new Error('待领取分镜与原图记录编号冲突，领取记录仍保留');
  const changedTasks = new Map(), touchedFloors = new Set(), receivedRecords = [];
  let received = 0;
  const rollbackRecords = () => {
    for (const record of receivedRecords) {
      const index = gallery.indexOf(record);
      if (index >= 0) gallery.splice(index, 1);
    }
  };
  try {
  for (const delivery of deliveries.values()) {
    await assertOwner();
    let deliveryLinkState = '';
    const deliveryFloors = new Set(), resultIds = [];
    let rows = Array.isArray(delivery.records) ? delivery.records : [];
    if (delivery.originalOnly) {
      rows = [];
      const originals = [];
      for (let index = 0; index < delivery.imageCount; index++) {
        if (galleryById.has(originalId(delivery, index))) continue;
        const blob = delivery.originals?.[index] || await blobStore.getStoryboardPendingImage(namespace, delivery.taskId, index);
        await assertOwner();
        if (!(blob instanceof Blob)) throw new Error('本机暂存原图缺失，未清除领取记录');
        originals.push({ blob, index });
      }
      for (const { blob, index } of originals) {
        const utils = await storyboardUtilsModule(); await assertOwner();
        if (typeof utils.saveBase64AsFile !== 'function') throw new Error('当前 ST 无法保存暂存原图，领取记录仍保留');
        const encoded = await storyboardBlobToBase64(blob); await assertOwner();
        const url = storyboardSafeUrl(await utils.saveBase64AsFile(encoded, getCharacterName() || 'Qianmu',
          `qianmu_pending_${delivery.taskId}_${index}`, storyboardImageExtension(blob.type)));
        await assertOwner();
        if (!url) throw new Error('暂存原图未确认保存，领取记录仍保留');
        rows.push({ id: originalId(delivery, index), taskId: delivery.taskId, groupId: delivery.taskId,
          imageIndex: index, url, chatKey: expectedChatKey, source: delivery.source || '', model: '',
          imageAccountNamespace: namespace,
          origin: 'service_recovered', recipeUnavailable: true, sourceLabel: '原图找回 · 配置未保留',
          floor: null, inline: false, tags: [], createdAt: Date.now() });
      }
    }
    for (const raw of rows) {
      if (!raw?.id) continue;
      if (knownIds.has(String(raw.id))) {
        const existing = galleryById.get(String(raw.id));
        if (delivery.originalOnly ? !sameOriginal(existing, delivery, raw.imageIndex)
          : !sameRecipe(existing, raw, delivery))
          throw new Error('待领取分镜与图库记录来源冲突，领取记录仍保留');
        resultIds.push(String(raw.id));
        if (Number.isInteger(existing?.floor)) deliveryFloors.add(existing.floor);
        deliveryLinkState ||= existing?.linkState || '';
        continue;
      }
      const record = clone(raw);
      const resolved = record.messageRef?.messageKey
        ? resolveStoryboardMessageReference(record.messageRef, chat, { chatKey: expectedChatKey, metadata: ctx().chatMetadata })
        : null;
      if (resolved?.state === 'active') {
        record.floor = resolved.floor;
        record.inline = record.requestedInline !== false && storyboardFloorTakeInitialInline(record, gallery, takeReceipts);
        if (record.floorTake) record.floorTakeEligible = true;
        record.messageHash = hashText(String(resolved.message?.mes || ''));
        record.swipeId = Number(resolved.message?.swipe_id || 0);
        record.linkState = 'active';
        touchedFloors.add(resolved.floor);
        deliveryFloors.add(resolved.floor);
        deliveryLinkState = 'active';
      } else {
        record.lastKnownFloor = Number.isInteger(record.lastKnownFloor) ? record.lastKnownFloor
          : (Number.isInteger(record.floor) ? record.floor : null);
        record.floor = null;
        record.inline = false;
        record.linkState = resolved?.state || (delivery.target === 'gallery' ? '' : 'orphaned');
        deliveryLinkState ||= record.linkState;
      }
      gallery.push(record);
      receivedRecords.push(record);
      knownIds.add(String(record.id));
      galleryById.set(String(record.id), record);
      resultIds.push(String(record.id));
      received++;
    }
    // A task id alone is not a generation proof. Only the pending task that
    // already carries these exact frozen result ids may be marked delivered.
    const task = !delivery.originalOnly && resultIds.length && (ownerState.taskStates || []).find(item =>
      item.id === delivery.taskId && item.chatKey === expectedChatKey
      && item.planId === delivery.planId && item.shotId === delivery.shotId
      && item.status === 'completed'
      && ['pending_chat', 'volatile_pending'].includes(item.deliveryState)
      && Array.isArray(item.resultIds) && item.resultIds.length === resultIds.length
      && item.resultIds.every(id => typeof id === 'string' && Boolean(id.trim()))
      && new Set(item.resultIds).size === item.resultIds.length
      && resultIds.every(id => item.resultIds.includes(id)));
    if (task) changedTasks.set(task.id, transitionStoryboardTaskState(task, 'completed', {
      stage: 'complete', progress: 1, resultIds: resultIds.length ? resultIds : task.resultIds,
      floor: deliveryFloors.size ? [...deliveryFloors].at(-1) : null,
      deliveryState: deliveryFloors.size || delivery.target === 'gallery' ? 'delivered' : 'gallery_fallback',
      linkState: deliveryLinkState,
    }));
  }
  } catch (error) { rollbackRecords(); throw error; }
  try {
    await assertOwner();
    await saveStoryboardFloorTakes(gallery, async () => {
      await assertOwner(); await saveMetadata(); await assertOwner();
    }, record => storyboardValidatedAnchor(record).valid,
    () => current() && gallery === storyboardGalleryRecords(), takeReceipts);
    await assertOwner();
  } catch (error) {
    if (await owns()) throw error;
    rollbackRecords();
    throw error;
  }
  if (changedTasks.size) ownerState.taskStates = ownerState.taskStates.map(task => changedTasks.get(task.id) || task);
  if (changedTasks.size) saveSettings();
  for (const delivery of deliveries.values()) {
    await assertOwner();
    storyboardVolatileDeliveries.delete(`${namespace}\u241f${delivery.taskId}`);
    try { await blobStore.deleteStoryboardDelivery(delivery.taskId, namespace); }
    catch (error) { warn('分镜待收箱清理失败', error); }
  }
  await assertOwner();
  if (touchedFloors.size) touchedFloors.forEach(floor => storyboardScheduleInlineRender(40, floor));
  else storyboardScheduleInlineRender(40);
  rerenderIfOpen();
  if (received) toast([...deliveries.values()].some(item => item.originalOnly)
    ? `已找回 ${received} 张原图，原配置未保留。` : `已接收 ${received} 张跨聊天完成的分镜。`, 'success');
  return received;
}
