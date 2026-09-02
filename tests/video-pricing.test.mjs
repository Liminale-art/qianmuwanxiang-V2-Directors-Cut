import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { estimateMiniMaxH3Cost } from '../qianmu-video-pricing.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));

function inputs({ durationSeconds = 6, resolution = '768p', assets = [] } = {}) {
  return {
    spec: {
      durationSeconds,
      resolution,
      route: { ready: true, inputs: { referenceAssetIds: assets.map((asset) => asset.assetId) } },
    },
    manifest: { assets },
  };
}

test('global H3 preview follows the dated public per-second snapshot', () => {
  const { spec, manifest } = inputs();
  const estimate = estimateMiniMaxH3Cost(spec, manifest, { region: 'global' });
  assert.equal(estimate.total, 0.48);
  assert.equal(estimate.displayLabel, '$0.48');
  assert.equal(estimate.authoritative, false);
  assert.equal(estimate.readyForReservation, false);
  assert.equal(estimate.verifiedAt, '2026-09-03');
});

test('2K, extra images and referenced video are itemized without double-counting ids', () => {
  const assets = [
    ...Array.from({ length: 7 }, (_, index) => ({ assetId: `image-${index}`, kind: 'image' })),
    { assetId: 'video-1', kind: 'video', technical: { durationSeconds: 3 } },
  ];
  const { spec, manifest } = inputs({ durationSeconds: 10, resolution: '2k', assets });
  spec.route.inputs.firstFrameAssetId = 'image-0';
  const estimate = estimateMiniMaxH3Cost(spec, manifest, { region: 'global' });
  assert.equal(estimate.total, 1.77);
  assert.equal(estimate.breakdown.length, 3);
  assert.equal(estimate.imageCount, 7);
  assert.equal(estimate.inputVideoSeconds, 3);
});

test('unverified regional prices and incomplete routes fail closed', () => {
  const { spec, manifest } = inputs();
  assert.equal(estimateMiniMaxH3Cost(spec, manifest, { region: 'china' }).reason, 'regional_pricing_unverified');
  spec.route.ready = false;
  assert.equal(estimateMiniMaxH3Cost(spec, manifest, { region: 'global' }).reason, 'video_route_not_ready');
});

test('pricing stays lazy, visible-only and cannot authorize the draft editor', () => {
  assert.match(source, /videoPricing:[\s\S]*qianmu-video-pricing\.js/);
  assert.match(source, /sd-storyboard-video-estimate/);
  assert.match(source, /最终以 MiniMax 实际结算为准/);
  assert.ok(release.files.includes('qianmu-video-pricing.js'));
  const init = source.slice(source.indexOf('function init()'), source.indexOf('export async function onActivate'));
  assert.doesNotMatch(init, /videoPricing|qianmu-video-pricing/);
});
