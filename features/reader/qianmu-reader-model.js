// 伴读的坐标底座：一本书的「纯文字投影」与全局字符位。
//
// 投影就是 chapters[].content 依次排开；全局位 = 前面各章 content 长度之和 + 章内偏移。这把尺子与旧的
// computeVisibleWindow（qianmu-storyboard-utils.js）一字不差，记忆切片 coveredFrom/To、provenance.readTo、
// 阅读记录、忆幕 confirmedReadTo 都用它，所以旧书的坐标不变。区别只在于：这里打开书时算一次前缀和，
// 之后按需切片，不再每存一次读位就把全书拼成一个字符串。
// 纯函数，不碰 DOM、不读设置。

const textOf = chapter => String(chapter?.content || '');   // 与 computeVisibleWindow 同一取法（0、null 都当空）

/** 旧书（只有 chapters）的单元：一章一单元，start 是前缀和。 */
export function legacyUnits(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  let start = 0;
  return list.map(chapter => {
    const length = textOf(chapter).length, unit = { title: String(chapter?.title || ''), kind: 'toc', start, length };
    start += length;
    return unit;
  });
}

/**
 * 打开书时建一次：{ chapters, starts, total, slice(from, to), unitAt(pos) }。
 * slice 只拼与区间相交的单元，结果与「全书拼接后 slice」相同；unitAt 与 chapterIndexAtOffset 同一规则
 * （落在空章上时取后面第一个有字的章，越过末尾取最后一章，没有章时为 null）。
 */
export function createProjection(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  const bodies = list.map(textOf), count = bodies.length;
  const starts = new Int32Array(count), ends = new Int32Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) { starts[i] = total; total += bodies[i].length; ends[i] = total; }
  // 第一个 end > pos 的章（ends 单调不减）
  const firstEndAfter = pos => {
    let lo = 0, hi = count - 1, found = count - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ends[mid] > pos) { found = mid; hi = mid - 1; } else lo = mid + 1; }
    return found;
  };
  const clamp = value => Math.max(0, Math.min(total, Math.floor(Number(value) || 0)));
  return Object.freeze({
    chapters: list, starts, total,
    lengthOf: index => (index >= 0 && index < count ? bodies[index].length : 0),
    unitAt(pos) {
      if (!count) return null;
      return firstEndAfter(Math.max(0, Number(pos) || 0));
    },
    slice(from, to) {
      const a = clamp(from), b = clamp(to);
      if (b <= a) return '';
      let out = '';
      for (let i = firstEndAfter(a); i < count && starts[i] < b; i++) {
        out += bodies[i].slice(Math.max(0, a - starts[i]), Math.min(bodies[i].length, b - starts[i]));
      }
      return out;
    },
  });
}

/** 章内偏移由滚动比例折算（旧口径：round(本章长度 × 比例)）。 */
export function offsetFromRatio(length, ratio) {
  return Math.round(Math.max(0, Number(length) || 0) * Math.max(0, Math.min(1, Number(ratio) || 0)));
}

/** 第 chapterIndex 章、章内 offset 处的全局位；章号与偏移都夹到有效范围。 */
export function positionAt(projection, chapterIndex, offset) {
  const count = projection?.starts?.length || 0;
  if (!count) return 0;
  const ci = Math.max(0, Math.min(Math.floor(Number(chapterIndex) || 0), count - 1));
  const off = Math.max(0, Math.min(projection.lengthOf(ci), Math.round(Number(offset) || 0)));
  return projection.starts[ci] + off;
}

/**
 * 读到 readTo 为止、往前 percent%（占全书，最多 cap 字）的可见正文；起点往后对齐到最近的句界。
 * 与 computeVisibleWindow 的输出逐字段相同（readTo 取它算出的 readPos 时），只是不拼全书。
 */
export function visibleWindowAt(projection, readTo, percent, cap) {
  const total = projection?.total || 0;
  const readPos = Math.max(0, Math.min(total, Number(readTo) || 0));
  const pct = Math.max(1, Math.min(100, Number(percent) || 15));
  const limit = Math.max(200, Number(cap) || 6000);
  const windowChars = Math.min(Math.ceil((pct / 100) * (total || 1)), limit);
  let start = Math.max(0, readPos - windowChars);
  if (start > 0) {
    const m = projection.slice(start, Math.min(readPos, start + 200)).search(/[。！？…\n」』】）\)]/);
    if (m >= 0) start = Math.min(readPos, start + m + 1);
  }
  return { visibleText: projection ? projection.slice(start, readPos) : '', readPos, totalLen: total, windowChars, start };
}
