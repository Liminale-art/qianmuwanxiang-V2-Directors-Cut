// Worldbook targets and IO belong to the caller. Never discover or create targets mid-cleanup.
export async function cleanupReaderWorldMirrors(bookId, { names, readEntries, disableEntry, logicalId, isCurrent }) {
  const result = { status: 'complete', entries: 0, checkedBooks: [], failedBooks: [] };
  const prefix = `coread::${bookId}::`;
  for (const name of [...new Set(names)]) {
    if (!isCurrent()) return { ...result, status: 'stale' };
    try {
      const entries = await readEntries(name);
      if (!Array.isArray(entries)) throw new Error('Invalid worldbook response');
      for (const entry of entries) {
        if (!isCurrent()) return { ...result, status: 'stale' };
        if (!logicalId(entry).startsWith(prefix) || (!String(entry.content || '').trim() && entry.disable === true)) continue;
        // No broad whole-file replacement: touch only the original namespaced entry.
        await disableEntry(name, entry.uid);
        result.entries++;
      }
      if (!isCurrent()) return { ...result, status: 'stale' };
      const verified = await readEntries(name);
      if (!Array.isArray(verified) || verified.some(entry => logicalId(entry).startsWith(prefix) && (String(entry.content || '').trim() || entry.disable !== true))) {
        throw new Error('Worldbook cleanup not confirmed');
      }
      result.checkedBooks.push(name);
    } catch (_) {
      result.failedBooks.push(name);
      return { ...result, status: 'failed' };
    }
  }
  return isCurrent() ? result : { ...result, status: 'stale' };
}
