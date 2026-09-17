// One immutable, explicitly requested film save. Validation performs no writes.
// After the first write starts, finish its matching sidecar even if the UI moves
// on; report partial persistence honestly rather than deleting an existing film.
const pending = new WeakSet();
const pendingTimelines = new Set();
const timelineKey = editor => JSON.stringify([editor?.owner?.chatKey || '', editor?.timelineId || '']);
export const isFilmEditorSaving = editor => Boolean(editor && (pending.has(editor) || pendingTimelines.has(timelineKey(editor))));

export async function saveFilmEditorSnapshot({ editor, readSources, ensureRuntime, ensurePostproduction, workOrder, canCommit }) {
  if (!editor || isFilmEditorSaving(editor)) return { status: 'busy' };
  const key = timelineKey(editor);
  pending.add(editor);
  pendingTimelines.add(key);
  let saved = null;
  try {
    const draft = structuredClone(editor), sources = readSources();
    const motionIds = new Set(draft.selections.filter(item => item.kind === 'motion').map(item => item.assetId));
    const motion = structuredClone(sources.motionItems.filter(item => motionIds.has(item.assetId)));
    const recordIds = new Set([...draft.selections.map(item => item.recordId), ...motion.map(item => item.recordId),
      ...draft.postproduction.subtitles.map(item => item.source?.recordId), ...draft.postproduction.audio.dialogue.map(item => item.source?.recordId)]);
    const stills = structuredClone(sources.stillRecords.filter(record => recordIds.has(record.id)));
    const chatKey = String(draft.owner?.chatKey || '');
    if (!chatKey || !canCommit()) return { status: 'stale' };
    const stillById = new Map(stills.map(record => [String(record.id || ''), record]));
    const motionById = new Map(motion.map(item => [String(item.assetId || ''), item]));
    for (const selection of draft.selections) {
      const sourceRecord = selection.kind === 'motion'
        ? stillById.get(String(motionById.get(String(selection.assetId || ''))?.recordId || ''))
        : stillById.get(String(selection.recordId || ''));
      if (sourceRecord) await workOrder(sourceRecord, 'film');
      if (!canCommit()) return { status: 'stale' };
    }
    const project = draft.postproduction, validatedLayers = new Map();
    const validateLayer = async (source, consumer) => {
      if (source?.kind !== (consumer === 'voice' ? 'director_voice' : 'director')) return;
      const key = `${consumer}:${source.recordId}`;
      let order = validatedLayers.get(key);
      if (!order) {
        const record = stillById.get(String(source.recordId || ''));
        if (!record) throw Error('director_layer_source_invalid');
        order = await workOrder(record, consumer);
        validatedLayers.set(key, order);
      }
      if (!order || order.workOrderId !== source.workOrderId || order.source.decisionId !== source.decisionId) throw Error('director_layer_source_invalid');
    };
    for (const [items, consumer] of [[project.subtitles, 'subtitle'], [project.audio.dialogue, 'voice']]) {
      for (const item of items) { await validateLayer(item.source, consumer); if (!canCommit()) return { status: 'stale' }; }
    }
    const [{ timelineModule, store }, postproduction] = await Promise.all([ensureRuntime(), ensurePostproduction()]);
    if (!canCommit()) return { status: 'stale' };
    const latest = readSources();
    const built = timelineModule.buildVideoTimeline({ timelineId: draft.timelineId, title: draft.title, owner: { chatKey },
      motionItems: latest.motionItems, stillRecords: latest.stillRecords, selections: draft.selections });
    if (!built.ok) {
      const missing = built.issues.some(issue => issue.includes('not_found') || issue.includes('owner_mismatch') || issue.includes('source_invalid'));
      return { status: 'invalid', message: missing ? '部分素材已不可用或不属于当前聊天，请先移除。' : '影片顺序未通过校验，请检查片段。' };
    }
    const postproductionCandidate = { ...project, timelineId: built.timeline.timelineId, owner: { chatKey }, durationMs: Math.round(built.timeline.durationSeconds * 1000) };
    const postproductionValidation = postproduction.postproductionModule.validateVideoPostproduction(postproductionCandidate, built.timeline);
    if (!postproductionValidation.ok) {
      const subtitleIssue = postproductionValidation.issues.some(issue => issue.includes('subtitle_'));
      const transitionIssue = postproductionValidation.issues.some(issue => issue.includes('transition_'));
      return { status: 'invalid', message: subtitleIssue ? '请补全字幕正文，并检查起止时间。' : transitionIssue ? '转场与当前片段顺序不匹配，请重新选择。' : '影片后期设置未通过校验。' };
    }
    if (!canCommit()) return { status: 'stale' };
    saved = await store.save({ ...built.timeline, createdAt: draft.createdAt });
    const savedPostproduction = await postproduction.store.save({
      ...postproductionValidation.project, timelineId: saved.timelineId, owner: { chatKey }, durationMs: Math.round(saved.durationSeconds * 1000),
    }, saved);
    return { status: 'saved', saved, savedPostproduction };
  } catch (error) {
    return { status: saved ? 'partial' : 'error', saved, error };
  } finally { pending.delete(editor); pendingTimelines.delete(key); }
}
