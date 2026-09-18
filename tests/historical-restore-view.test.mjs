import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHistoricalRestoreReview } from '../qianmu-historical-restore-view.js';
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
