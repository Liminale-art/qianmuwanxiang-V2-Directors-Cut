// MiniMax H3 创建前费用预估。公开价可能变化，本模块只供界面提示，不能直接授权预算或提交。
export const QIANMU_VIDEO_COST_ESTIMATE_SCHEMA = 'qianmu.video-cost-estimate.v1';
export const MINIMAX_H3_GLOBAL_PRICE_SNAPSHOT = Object.freeze({
  provider: 'minimax-h3',
  region: 'global',
  currency: 'USD',
  verifiedAt: '2026-09-03',
  sourceUrl: 'https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise',
  outputPerSecond: Object.freeze({ '768p': 0.08, '2k': 0.13 }),
  includedImages: 5,
  additionalImage: 0.04,
  inputVideoPerSecond: Object.freeze({ '768p': 0.08, '2k': 0.13 }),
  audioInput: 0,
});

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const money = (value) => Math.round(Math.max(0, finite(value)) * 10000) / 10000;

function selectedAssetIds(spec = {}) {
  const inputs = plain(spec.route?.inputs) ? spec.route.inputs : {};
  return [...new Set([
    inputs.firstFrameAssetId,
    inputs.lastFrameAssetId,
    ...(Array.isArray(inputs.referenceAssetIds) ? inputs.referenceAssetIds : []),
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function unavailable(reason, region) {
  return {
    schema: QIANMU_VIDEO_COST_ESTIMATE_SCHEMA,
    available: false,
    authoritative: false,
    readyForReservation: false,
    reason,
    region,
    currency: '',
    total: 0,
    displayLabel: '暂无可靠预估',
    breakdown: [],
    verifiedAt: '',
    sourceUrl: '',
  };
}

export function estimateMiniMaxH3Cost(specValue = {}, manifestValue = {}, options = {}) {
  const spec = plain(specValue) ? specValue : {};
  const manifest = plain(manifestValue) ? manifestValue : {};
  const region = options.region === 'china' || options.region === 'cn' ? 'china' : 'global';
  if (region !== 'global') return unavailable('regional_pricing_unverified', region);
  if (spec.route?.ready !== true) return unavailable('video_route_not_ready', region);
  const seconds = Math.min(15, Math.max(4, Math.round(finite(spec.durationSeconds, 6))));
  const resolution = String(spec.resolution || '').toLowerCase() === '2k' ? '2k' : '768p';
  const selected = new Set(selectedAssetIds(spec));
  const assets = (Array.isArray(manifest.assets) ? manifest.assets : []).filter((asset) => selected.has(String(asset?.assetId || '')));
  const imageCount = assets.filter((asset) => asset?.kind === 'image').length;
  const inputVideoSeconds = assets.filter((asset) => asset?.kind === 'video')
    .reduce((sum, asset) => sum + Math.max(0, finite(asset?.technical?.durationSeconds)), 0);
  const output = money(seconds * MINIMAX_H3_GLOBAL_PRICE_SNAPSHOT.outputPerSecond[resolution]);
  const extraImages = Math.max(0, imageCount - MINIMAX_H3_GLOBAL_PRICE_SNAPSHOT.includedImages);
  const images = money(extraImages * MINIMAX_H3_GLOBAL_PRICE_SNAPSHOT.additionalImage);
  const inputVideo = money(inputVideoSeconds * MINIMAX_H3_GLOBAL_PRICE_SNAPSHOT.inputVideoPerSecond[resolution]);
  const total = money(output + images + inputVideo);
  const breakdown = [
    { id: 'output', label: `${resolution === '2k' ? '2K' : '768P'} 输出 ${seconds} 秒`, amount: output },
    ...(extraImages ? [{ id: 'images', label: `额外参考图 ${extraImages} 张`, amount: images }] : []),
    ...(inputVideoSeconds ? [{ id: 'input_video', label: `参考视频 ${money(inputVideoSeconds)} 秒`, amount: inputVideo }] : []),
  ];
  return {
    schema: QIANMU_VIDEO_COST_ESTIMATE_SCHEMA,
    available: true,
    authoritative: false,
    readyForReservation: false,
    reason: 'public_price_snapshot_only',
    region,
    currency: MINIMAX_H3_GLOBAL_PRICE_SNAPSHOT.currency,
    total,
    displayLabel: `$${total.toFixed(2)}`,
    breakdown,
    imageCount,
    inputVideoSeconds: money(inputVideoSeconds),
    verifiedAt: MINIMAX_H3_GLOBAL_PRICE_SNAPSHOT.verifiedAt,
    sourceUrl: MINIMAX_H3_GLOBAL_PRICE_SNAPSHOT.sourceUrl,
  };
}
