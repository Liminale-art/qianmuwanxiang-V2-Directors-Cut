// 千幕动态渠道准备状态。纯数据层，不发起请求、不读取密钥正文，也不提交付费任务。
export const QIANMU_VIDEO_READINESS_SCHEMA = 'qianmu.video-readiness.v1';

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

const STATUS_LABELS = Object.freeze({
  ready: '已就绪',
  checking: '检查中',
  attention: '需确认',
  blocked: '未就绪',
  locked: '未开放',
});

const ROUTE_REQUIREMENT_LABELS = Object.freeze({
  first_frame: '首帧',
  last_frame: '尾帧',
  reference_asset: '参考素材',
});

function item(id, label, status, detail) {
  return {
    id,
    label,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    detail: text(detail),
  };
}

function gatewayItem(serviceValue = {}) {
  const service = plain(serviceValue) ? serviceValue : {};
  const status = text(service.status, 40) || 'idle';
  const services = Array.isArray(service.services) ? service.services.map((value) => text(value, 80)).filter(Boolean) : [];
  if (status === 'checking' || status === 'idle') return item('gateway', '同源服务', 'checking', '正在检查动态网关');
  if (status === 'ready' && services.includes('minimax-h3')) return item('gateway', '同源服务', 'ready', service.version ? `动态网关 v${text(service.version, 80)}` : '动态网关已连接');
  if (status === 'ready') return item('gateway', '同源服务', 'blocked', '当前服务包未提供 MiniMax H3');
  if (status === 'missing') return item('gateway', '同源服务', 'blocked', '尚未安装千幕同源服务');
  if (status === 'unsupported') return item('gateway', '同源服务', 'blocked', '当前环境不支持服务检测');
  return item('gateway', '同源服务', 'blocked', text(service.message) || '动态网关暂不可达');
}

function credentialItem(configured) {
  return configured
    ? item('credential', '渠道凭据', 'ready', '已安全保存 MiniMax H3 凭据')
    : item('credential', '渠道凭据', 'blocked', '尚未配置 MiniMax H3 凭据');
}

function materialItem(compiledValue = {}) {
  const compiled = plain(compiledValue) ? compiledValue : {};
  const route = plain(compiled.spec?.route) ? compiled.spec.route : {};
  const missing = Array.isArray(route.missingRequirements)
    ? [...new Set(route.missingRequirements.map((value) => ROUTE_REQUIREMENT_LABELS[text(value, 80)] || text(value, 80)).filter(Boolean))]
    : [];
  if (compiled.ok === true && route.ready === true) {
    return item('materials', '镜头素材', 'ready', text(route.mode, 80) ? `已匹配 ${text(route.mode, 80).toUpperCase()}` : '镜头输入完整');
  }
  const detail = missing.length ? `还需：${missing.join('、')}` : '镜头草稿仍需修正';
  return item('materials', '镜头素材', 'blocked', detail);
}

function qualityItem(resolution, confirmed) {
  if (text(resolution, 40).toLowerCase() !== '2k') return item('quality', '生成规格', 'ready', '768P · 无需高画质确认');
  return confirmed
    ? item('quality', '生成规格', 'ready', '2K · 已完成本次确认')
    : item('quality', '生成规格', 'attention', '2K 将在报价后要求单独确认');
}

export function evaluateVideoReadiness(value = {}) {
  const raw = plain(value) ? value : {};
  const gateway = gatewayItem(raw.service);
  const credential = credentialItem(Boolean(raw.credentialConfigured));
  const materials = materialItem(raw.compiled);
  const quality = qualityItem(raw.resolution || raw.compiled?.draft?.settings?.resolution, Boolean(raw.highResolutionConfirmed));
  const prerequisitesReady = [gateway, credential, materials].every((entry) => entry.status === 'ready');
  const confirmationReady = quality.status === 'ready';
  const submissionEnabled = raw.submissionEnabled === true;
  const submission = item(
    'submission',
    '提交闸门',
    submissionEnabled ? (prerequisitesReady && confirmationReady ? 'ready' : 'blocked') : 'locked',
    submissionEnabled ? (prerequisitesReady && confirmationReady ? '允许进入最终确认' : '请先完成以上准备') : '当前版本仅保存草稿，不会提交任务',
  );
  return {
    schema: QIANMU_VIDEO_READINESS_SCHEMA,
    items: [gateway, credential, materials, quality, submission],
    prerequisitesReady,
    readyForQuote: prerequisitesReady,
    readyForSubmission: submissionEnabled && prerequisitesReady && confirmationReady,
    submissionLocked: !submissionEnabled,
  };
}
