import { captureCurrentChatSource } from './qianmu-current-chat-source.js';
import { createChatGalleryStateClient, createChatGalleryEvidenceClient } from './qianmu-chat-character-receipt-client.js';
import { chatCharacterReceiptTarget } from './qianmu-chat-character-receipt.js';
import { chatGalleryReceiptText } from './qianmu-chat-gallery-receipt.js';
import { projectChatGalleryState } from './qianmu-chat-gallery-state.js';
import { captureStoryboardChatEvidence, inspectStoryboardChatEvidence, projectStoryboardChatMessages, storyboardChatProjectionMatches } from './qianmu-storyboard-chat-evidence.js';
import { acquireChatSaveLock, releaseChatSaveLock } from './qianmu-chat-save-lock.js';
import { vibeDigest } from './qianmu-vibe-file.js';

const fields = ['storyboardImages', 'storyboardCollections', 'characterDrafts'];
const scope = 'historical-chat-metadata-only';
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = value => chatGalleryReceiptText([{ value }]).text;
const equal = (a, b) => text(a) === text(b);
const fail = message => { throw Object.assign(new Error(message), { code: 'historical_chat_save', submissionState: 'not_submitted' }); };
const clone = structuredClone;

function selected(store) {
  if (!object(store) || !Object.hasOwn(store, 'storyboardImages')) fail('当前聊天静帧资料尚未初始化，未凭空创建后覆盖保存');
  const value = Object.fromEntries(fields.filter(key => Object.hasOwn(store, key)).map(key => [key, store[key]]));
  text(value); return clone(value);
}

// CURRENT exact chat only, via ST's existing saveMetadata. Never POST a copied
// whole chat or write historical disk files directly. This primitive is not a v4
// restore authorization: caller must finish original/dependency checks and later
// provide a persistent journal before wiring a user restore entry. Intent here
// survives only within this session; no cross-refresh recovery claim is made.
export function createHistoricalChatSaveSession({ getContext, epoch, namespace, account, guard, isCurrent,
  headers, fetchImpl = globalThis.fetch, timeoutMs = 30000, hostTimeoutMs = 10000 } = {}) {
  if (![getContext, epoch, account, guard, isCurrent, fetchImpl].every(fn => typeof fn === 'function')
    || typeof namespace !== 'string' || !/^st-user:.+/.test(namespace) || namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(namespace)
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(hostTimeoutMs) || hostTimeoutMs < 1) fail('缺少当前聊天的保存身份与来源保护');
  const source = captureCurrentChatSource({ getContext, epoch }), target = source.target, context = getContext();
  const store = context.chatMetadata.story_director_liminale, saveHost = context.saveMetadata;
  if (!object(store) || typeof saveHost !== 'function') { source.close(); fail('当前聊天资料或 ST 保存接口不可用'); }
  const token = {}, activeClients = new Set();
  let closed = false, busy = false, hostPending = false, intent = null, cancelOperation = null;
  const release = () => { if (!busy && !hostPending) releaseChatSaveLock(store, token); };
  const current = () => {
    if (closed || isCurrent() !== true) fail('当前保存页面已结束或来源已变化');
    source.assertCurrent();
    if (getContext().chatMetadata.story_director_liminale !== store || getContext().saveMetadata !== saveHost) fail('当前聊天资料对象或保存接口已变化');
  };
  const pending = () => intent ? clone(intent) : null;
  const unknown = reason => ({ status: 'unconfirmed', reason, pending: pending(), durableJournal: false });
  const localMatches = value => equal(selected(store), value);
  async function exclusive(work) {
    current(); if (busy || hostPending || !acquireChatSaveLock(store, token)) fail('上一项聊天资料保存尚未结束，请先核对'); busy = true;
    const controller = new AbortController(); let reject;
    const cancelled = new Promise((_, no) => reject = no);
    const abort = () => { controller.abort(); for (const client of activeClients) client.close(); reject(new Error('聊天资料保存等待已结束')); };
    cancelOperation = abort; const timer = setTimeout(() => { closed = true; source.close(); abort(); }, Math.min(120000, timeoutMs));
    const check = async () => {
      current(); if (controller.signal.aborted) fail('聊天资料保存已停止');
      if (await guard() === false) fail('当前正文来源保护未通过'); current();
      if (await account() !== namespace) fail('当前 ST 账户已变化'); current();
      if (controller.signal.aborted) fail('聊天资料保存已停止');
    };
    const clients = [createChatGalleryStateClient, createChatGalleryEvidenceClient].map(create => create({ namespace, target,
      guard: check, fetchImpl, headers: headers || (() => getContext().getRequestHeaders?.() || {}), timeoutMs: Math.min(30000, timeoutMs) }));
    clients.forEach(client => activeClients.add(client));
    try { return await Promise.race([Promise.resolve().then(() => work({ check, state: clients[0], evidence: clients[1], signal: controller.signal })), cancelled]); }
    catch (error) { if (intent) return unknown('needs_review'); throw error; }
    finally { clearTimeout(timer); cancelOperation = null; controller.abort(); for (const client of clients) { client.close(); activeClients.delete(client); } busy = false; release(); }
  }
  async function inspectLocalEvidence(expected, check) {
    await check(); const messages = projectStoryboardChatMessages(getContext().chat);
    const evidence = await captureStoryboardChatEvidence(messages, target.chatId, { guard: check }); await check();
    if (evidence.digest !== expected.digest || !storyboardChatProjectionMatches(messages, getContext().chat)) fail('当前正文或候选版本与保存提案不符');
    return messages;
  }
  async function observe(saved, chatEvidence, operation) {
    const { check, state, evidence, signal } = operation;
    await check(); const galleryHash = await vibeDigest(chatGalleryReceiptText(saved.storyboardImages).text); await check();
    const receipt = await state.read(galleryHash, { signal }); await check();
    if (!equal(receipt.saved, saved)) return false;
    const body = await evidence.read(galleryHash, { signal }); await check();
    if (body.chatEvidence.digest !== chatEvidence.digest) return false;
    // The two reads are not a lock. Read the metadata once more after the body
    // scan so an edit between those observations cannot be called confirmed.
    const final = await state.read(galleryHash, { signal }); await check();
    return equal(final.saved, saved) && final.source.sha256 === receipt.source.sha256;
  }
  async function verify(operation) {
    await operation.check(); if (!intent) return { status: 'idle' };
    if (!localMatches(intent.after)) fail('本地资料已编辑，未采用或覆盖旧保存内容');
    const messages = await inspectLocalEvidence(intent.chatEvidence, operation.check);
    if (!await observe(intent.after, intent.chatEvidence, operation)) return unknown('readback_mismatch');
    await operation.check();
    if (!localMatches(intent.after) || !storyboardChatProjectionMatches(messages, getContext().chat)) fail('保存核对期间资料或正文已变化');
    const fileHash = intent.fileHash; intent = null;
    return { status: 'saved', fileHash, metadataVerified: true, durableJournal: false };
  }
  async function invokeHost(operation) {
    current(); hostPending = true; let promise;
    try { promise = Promise.resolve(saveHost.call(context)); } catch (error) { promise = Promise.reject(error); }
    const settled = promise.then(() => { hostPending = false; release(); return true; }, () => { hostPending = false; release(); return true; });
    let timer; const deadline = new Promise(done => timer = setTimeout(() => done(false), Math.min(30000, hostTimeoutMs)));
    try { if (!await Promise.race([settled, deadline])) return unknown('host_pending'); }
    finally { clearTimeout(timer); }
    // ST may swallow errors, or throw after persistence: only readback decides.
    return verify(operation);
  }
  return Object.freeze({
    namespace, target, pending,
    close() { closed = true; source.close(); cancelOperation?.(); for (const client of activeClients) client.close(); release(); },
    save(input, { confirmed = false, scope: requestedScope } = {}) {
      // Detach caller input before guard/account awaits. Do not reinterpret a
      // generic settings backup as this restricted three-field write proposal.
      let proposal;
      try {
        if (confirmed !== true || requestedScope !== scope || !exact(input, ['namespace', 'target', 'before', 'after', 'chatEvidence', 'fileHash'])
          || input.namespace !== namespace || !equal(chatCharacterReceiptTarget(input.target), target) || !/^[a-f0-9]{64}$/.test(input.fileHash)) fail('请核对并明确确认原聊天三项资料的保存');
        for (const value of [input.before, input.after]) {
          if (!object(value) || !Object.hasOwn(value, 'storyboardImages') || Object.keys(value).some(key => !fields.includes(key))) fail('只允许保存已初始化的画面、相册与人物草稿');
          text(value);
        }
        if (Object.keys(input.before).some(key => !Object.hasOwn(input.after, key))) fail('此保存不删除原聊天资料字段');
        proposal = clone(input);
      } catch (error) { return Promise.reject(error); }
      return exclusive(async operation => {
        if (intent) fail('尚有原聊天保存待核对，不能开始新的保存');
        await operation.check();
        for (const value of [proposal.before, proposal.after]) await projectChatGalleryState(value, { namespace, chatKey: target.chatId });
        proposal.chatEvidence = await inspectStoryboardChatEvidence(proposal.chatEvidence, target.chatId); await operation.check();
        if (!localMatches(proposal.before)) fail('当前资料与提案基线不符，未覆盖用户编辑');
        const messages = await inspectLocalEvidence(proposal.chatEvidence, operation.check);
        if (!await observe(proposal.before, proposal.chatEvidence, operation)) fail('服务器资料或正文已变化，未覆盖');
        await operation.check();
        if (!localMatches(proposal.before) || !storyboardChatProjectionMatches(messages, getContext().chat)) fail('保存前资料或正文已变化');
        if (equal(proposal.before, proposal.after)) return { status: 'unchanged', metadataVerified: true, durableJournal: false };
        const changes = fields.filter(key => Object.hasOwn(proposal.after, key)
          && (!Object.hasOwn(proposal.before, key) || !equal(proposal.before[key], proposal.after[key])));
        for (const key of changes) {
          const descriptor = Object.getOwnPropertyDescriptor(store, key);
          if (descriptor && (!Object.hasOwn(descriptor, 'value') || !descriptor.writable) || !descriptor && !Object.isExtensible(store)) fail('聊天资料字段不可安全写入，未部分修改');
        }
        // Final synchronous source/body/value check -> THREE FIELDS -> native
        // host call, with no intervening await and no replacement of the store.
        current(); if (!localMatches(proposal.before) || !storyboardChatProjectionMatches(messages, getContext().chat)) fail('最终保存前资料已变化');
        intent = clone(proposal);
        for (const key of changes) store[key] = clone(proposal.after[key]);
        return invokeHost(operation);
      });
    },
    verify() { return exclusive(operation => verify(operation)); },
    retry({ confirmed = false } = {}) {
      return exclusive(async operation => {
        if (confirmed !== true) fail('请明确确认重试原聊天待核对保存');
        if (!intent) return { status: 'idle' };
        await operation.check(); if (!localMatches(intent.after)) fail('本地已编辑，不会补写旧保存');
        const messages = await inspectLocalEvidence(intent.chatEvidence, operation.check);
        // A preflight selector mismatch is NOT proof that the server is at the
        // original baseline. Only a fresh successful observation authorizes retry.
        let committed = false; try { committed = await observe(intent.after, intent.chatEvidence, operation); } catch { await operation.check(); }
        if (committed) return verify(operation);
        if (!await observe(intent.before, intent.chatEvidence, operation)) fail('服务器已变化，未重发旧资料');
        await operation.check();
        if (!localMatches(intent.after) || !storyboardChatProjectionMatches(messages, getContext().chat)) fail('重试前资料或正文已变化');
        return invokeHost(operation);
      });
    },
  });
}
