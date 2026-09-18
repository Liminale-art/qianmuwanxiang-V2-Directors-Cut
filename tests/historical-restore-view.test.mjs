import assert from 'node:assert/strict';
import test from 'node:test';
import { openHistoricalRestoreReview, renderHistoricalRestoreReview } from '../qianmu-historical-restore-view.js';
import { importHistoricalStoryboardBundle } from '../qianmu-historical-import-runtime.js';

const preview = {
  scope: 'historical-originals-and-current-chat',
  fingerprint: 'a'.repeat(64),
  target: { kind: 'character', chatId: 'chat-1' },
  mode: 'fresh',
  recipes: 2,
  ready: true,
  excluded: ['chat-body', 'videos'],
  images: [{ state: 'present', receipt: { url: 'https://example.invalid/a.png' } }, { state: 'missing', receipt: { url: '<unsafe>' } }],
};

test('historical restore view keeps scope and explicit dependency consent', () => {
  const html = renderHistoricalRestoreReview({ fileName: 'history.qmb', preview, busy: false, result: null, dependenciesAccepted: false });
  assert.match(html, /恢复历史聊天分镜/);
  assert.match(html, /不会恢复正文、视频、全局设置/);
  assert.match(html, /data-historical-dependencies/);
  assert.match(html, /data-historical-action="restore" disabled/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<unsafe>/);
});

test('historical restore view enables restore only after exact consent', () => {
  const html = renderHistoricalRestoreReview({ fileName: 'history.qmb', preview, busy: false, result: null, dependenciesAccepted: true, hostWriteReady: true });
  assert.doesNotMatch(html, /data-historical-action="restore" disabled/);
});

test('historical restore remains readable but never offers a write when the host save contract is absent', () => {
  const html = renderHistoricalRestoreReview({ fileName: 'history.qmb', preview, busy: false, result: null, dependenciesAccepted: true, hostWriteReady: false });
  assert.match(html, /仍可只读核对原件/);
  assert.match(html, /data-historical-action="restore" disabled/);
});

test('historical restore view reports a completed result without another write action', () => {
  const html = renderHistoricalRestoreReview({ fileName: 'history.qmb', preview, busy: false, result: { status: 'restored' }, dependenciesAccepted: true });
  assert.match(html, /data-historical-action="close"/);
  assert.doesNotMatch(html, /data-historical-action="restore"/);
});

test('historical import runtime does not claim the transfer slot when another transfer is active', async () => {
  const transfer = { busy: true };
  const exportTransfer = { busy: false };
  const result = await importHistoricalStoryboardBundle(new Blob(), [null, null, transfer, exportTransfer]);
  assert.equal(result, undefined);
  assert.equal(transfer.busy, true);
});

test('historical restore dialog carries the host save capability into its live view', async () => {
  const previousDocument = globalThis.document;
  const dialog = {
    open: false, isConnected: true, innerHTML: '', listeners: new Map(),
    className: '', setAttribute() {}, addEventListener(type, handler) { this.listeners.set(type, handler); },
    querySelector(selector) { return selector === '[data-historical-scroll]' ? { scrollTop: 0 } : null; },
    appendChild() {}, showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.isConnected = false; },
  };
  globalThis.document = { createElement() { return dialog; } };
  try {
    const session = { preview: async () => preview, close() {} };
    const review = openHistoricalRestoreReview({ parent: { appendChild() {} }, fileName: 'history.qmb', hostWriteReady: false,
      connect: async () => session });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(dialog.innerHTML, /当前 ST 宿主未提供可确认的聊天保存接口/);
    assert.match(dialog.innerHTML, /data-historical-action="restore" disabled/);
    review.close();
  } finally { globalThis.document = previousDocument; }
});

test('historical restore rechecks a host that becomes unavailable before confirmation', async () => {
  const previousDocument = globalThis.document;
  const dialog = {
    open: false, isConnected: true, innerHTML: '', listeners: new Map(),
    className: '', setAttribute() {}, addEventListener(type, handler) { this.listeners.set(type, handler); },
    querySelector(selector) { return selector === '[data-historical-scroll]' ? { scrollTop: 0 } : null; },
    appendChild() {}, showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.isConnected = false; },
  };
  globalThis.document = { createElement() { return dialog; } };
  let canSave = true, restores = 0;
  try {
    const session = { preview: async () => preview, restore: async () => { restores++; }, close() {} };
    const review = openHistoricalRestoreReview({ parent: { appendChild() {} }, fileName: 'history.qmb', hostWriteReady: true,
      readHostWriteReady: () => canSave, connect: async () => session });
    await new Promise(resolve => setTimeout(resolve, 0));
    canSave = false;
    dialog.listeners.get('click')({ target: { closest: () => ({ dataset: { historicalAction: 'restore' } }) } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(restores, 0);
    assert.match(dialog.innerHTML, /当前 ST 宿主保存接口已不可用/);
    assert.match(dialog.innerHTML, /data-historical-action="restore" disabled/);
    review.close();
  } finally { globalThis.document = previousDocument; }
});
