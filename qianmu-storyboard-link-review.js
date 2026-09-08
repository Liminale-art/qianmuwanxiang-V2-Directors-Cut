import { projectStoryboardChatMessages, storyboardChatProjectionMatches } from './qianmu-storyboard-chat-evidence.js';
import { createStoryboardMessageReference, createStoryboardParagraphAnchor } from './qianmu-storyboard.js';
import { hashText } from './qianmu-storyboard-utils.js';
import { vibeDigest } from './qianmu-vibe-file.js';

const fail = message => { throw new Error(message); };
const PAGE = 24;
const linkFields = ['chatKey','floor','lastKnownFloor','messageHash','swipeId','messageRef','paragraphAnchor','paragraphAnchorFallback','linkState','inline','requestedInline'];
const assistant = message => message && !message.is_user && !message.is_system && typeof message.mes === 'string' && message.mes.trim();

// Explicit display-link editing only. Original recipes, snapshots, source labels and image bytes are never rewritten.
export function createStoryboardLinkReview({ recordId, records, messages, chatKey, paragraphs, now = Date.now }) {
  const original = records().filter(row => row.id === recordId);
  if (original.length !== 1 || !original[0].restoreLinkReview) fail('此图片已不需要核对，或编号不唯一');
  const frozenRecord = JSON.stringify(original[0]);
  let selected = null, paragraphIndex = null;
  function checkRecord() {
    const rows = records().filter(row => row.id === recordId);
    if (rows.length !== 1 || JSON.stringify(rows[0]) !== frozenRecord) fail('图片资料已变化，请关闭后重新核对');
    return rows[0];
  }
  function checkSelection(checkImage = true) {
    if (checkImage) checkRecord();
    const message = messages()[selected?.floor];
    if (!selected || !assistant(message) || !storyboardChatProjectionMatches(selected.projection, [message])
      || JSON.stringify(createStoryboardMessageReference({ message, chatKey, floor: selected.floor, now: 1 })) !== selected.referenceText) fail('所选正文或候选回复已变化，请重新选层');
    return message;
  }
  return Object.freeze({
    floors(page = 0) {
      checkRecord();
      const chat = messages();
      if (!Array.isArray(chat) || chat.length > 100000) fail('聊天范围不支持，请保留原聊天');
      const floors = []; for (let floor = 0; floor < chat.length; floor++) if (assistant(chat[floor])) floors.push(floor);
      const pages = Math.max(1, Math.ceil(floors.length / PAGE)), current = Math.max(0, Math.min(pages - 1, Math.trunc(page) || 0));
      return { page: current, pages, count: floors.length, rows: floors.slice(current * PAGE, (current + 1) * PAGE).map(floor => ({ floor, name: String(chat[floor].name || '').slice(0, 120), preview: chat[floor].mes.slice(0, 100) })) };
    },
    selectFloor(floor) {
      checkRecord(); selected = null; paragraphIndex = null;
      const message = messages()[floor];
      if (!Number.isSafeInteger(floor) || floor < 0 || !assistant(message)) fail('请选择有效的助手正文楼层');
      // Match the existing inline renderer's paragraph contract; do not silently offer positions it cannot address.
      if (message.mes.length > 2 * 1048576) fail('此层正文超过 2 Mi 字符，请先单独保全并整理后定位');
      const rows = paragraphs(message.mes);
      if (!Array.isArray(rows) || !rows.length || rows.length > 240 || rows.some(row => typeof row !== 'string' || !row.trim())) fail('此层没有可定位段落，或超过 240 段支持范围');
      selected = { floor, rows: [...rows], projection: projectStoryboardChatMessages([message]), referenceText: JSON.stringify(createStoryboardMessageReference({ message, chatKey, floor, now: 1 })) };
      return this.paragraphs();
    },
    paragraphs(page = 0) {
      checkSelection(); const pages = Math.ceil(selected.rows.length / PAGE), current = Math.max(0, Math.min(pages - 1, Math.trunc(page) || 0));
      return { floor: selected.floor, page: current, pages, count: selected.rows.length, rows: selected.rows.slice(current * PAGE, (current + 1) * PAGE).map((text, offset) => ({ index: current * PAGE + offset, text })) };
    },
    selectParagraph(index) {
      checkSelection();
      if (!Number.isSafeInteger(index) || index < 0 || index >= selected.rows.length) fail('请选择明确的段落');
      paragraphIndex = index; return { floor: selected.floor, index, text: selected.rows[index] };
    },
    validate() { checkSelection(); if (paragraphIndex === null) fail('尚未选择插图段落'); },
    validateTarget() { checkSelection(false); },
    async prepare({ confirmed = false } = {}) {
      if (confirmed !== true) fail('尚未确认正文落点'); this.validate();
      const choice = selected, index = paragraphIndex;
      const sha256 = await vibeDigest(JSON.stringify(choice.projection[0]));
      this.validate(); if (selected !== choice || paragraphIndex !== index) fail('落点选择已变化，请重新确认');
      const current = checkRecord(), next = structuredClone(current), stamp = now();
      if (current.restoreLinkHistory != null && !Array.isArray(current.restoreLinkHistory)) fail('原定位记录格式不支持，未覆盖');
      if ((current.restoreLinkHistory?.length || 0) >= 100) fail('已有 100 条定位记录，请先保全，未裁剪历史');
      const previous = {};
      for (const key of linkFields) if (Object.hasOwn(current, key)) previous[key] = structuredClone(current[key]);
      const target = { chatKey, floor: choice.floor, paragraphIndex: index, sha256, swipeId: choice.projection[0].swipe_id };
      next.restoreLinkHistory = [...(next.restoreLinkHistory || []), { version: 1, confirmedAt: stamp, review: structuredClone(current.restoreLinkReview), previous, target }];
      const message = messages()[choice.floor];
      Object.assign(next, { chatKey, floor: choice.floor, lastKnownFloor: choice.floor, messageHash: hashText(message.mes), swipeId: target.swipeId,
        messageRef: createStoryboardMessageReference({ message, chatKey, floor: choice.floor, now: stamp }),
        paragraphAnchor: createStoryboardParagraphAnchor({ chatKey, floor: choice.floor, swipeId: target.swipeId, messageText: message.mes,
          paragraphIndex: index, paragraphText: choice.rows[index], previousText: choice.rows[index - 1] || '', nextText: choice.rows[index + 1] || '', createdAt: stamp }),
        paragraphAnchorFallback: false, linkState: 'active', inline: true, requestedInline: true });
      delete next.restoreLinkReview;
      const fileHash = await vibeDigest(JSON.stringify({ operation: 'manual-display-link.v1', recordId, target, previous, review: current.restoreLinkReview, stamp }));
      this.validate(); if (selected !== choice || paragraphIndex !== index) fail('落点选择已变化，请重新确认');
      const before = JSON.stringify(records());
      return { fileHash, validateDraft: () => { this.validate(); if (JSON.stringify(records()) !== before) fail('阅片室已变化，请重新确认，未覆盖其他图片'); },
        draft: { settings: {}, chat: { storyboardImages: records().map(row => structuredClone(row.id === recordId ? next : row)) } } };
    },
  });
}
