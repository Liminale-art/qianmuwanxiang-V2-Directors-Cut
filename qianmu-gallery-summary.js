// Render-local, metadata-only projection. Never retain this across a gallery
// render: records are edited in place and can change with the current chat.
export function summarizeGalleryRecords(records, collectionIds) {
  const byId = new Map(), counts = new Map(), covers = new Map(), rawTags = new Set(), known = new Set(), words = new Set(), legacyTags = [];
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, record);
    for (const id of new Set(collectionIds(record))) { counts.set(id, (counts.get(id) || 0) + 1); if (!covers.has(id)) covers.set(id,record); }
    const value = record.tags;
    if (typeof value === 'string') legacyTags.push(value);
    const tags = Array.isArray(value) ? value : value ? [value] : [];
    for (const tag of tags) {
      rawTags.add(tag);
      const clean = String(tag || '').trim();
      if (clean) known.add(clean);
      if (typeof tag === 'string' && tag) words.add(tag);
    }
  }
  const sort = values => [...values].sort((a, b) => a.localeCompare(b));
  return {
    record: id => byId.get(id) || null,
    hasTag: tag => rawTags.has(tag) || legacyTags.some(value => value.includes(tag)),
    collectionCount: id => counts.get(id) || 0,
    collectionPreview: id => covers.get(id) || null,
    knownTags: sort(known),
    keywords: sort(words),
  };
}
