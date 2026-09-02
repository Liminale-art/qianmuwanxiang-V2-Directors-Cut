export const QIANMU_OPTIONAL_SERVICE_ENDPOINT = '/api/plugins/qianmu-tts/health';

function cleanServiceList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 24)
    : [];
}

function result(status, details = {}) {
  return {
    status,
    available: status === 'ready',
    plugin: String(details.plugin || ''),
    version: String(details.version || ''),
    services: cleanServiceList(details.services),
    message: String(details.message || ''),
    checkedAt: Date.now(),
  };
}

export async function probeQianmuOptionalService(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return result('unsupported', { message: '当前环境不支持服务检测' });
  const timeoutMs = Math.min(15000, Math.max(1000, Number(options.timeoutMs) || 5000));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(options.endpoint || QIANMU_OPTIONAL_SERVICE_ENDPOINT, {
      method: 'GET',
      headers: options.headers || {},
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (response.status === 404) return result('missing', { message: '未安装可选增强服务' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true || body?.plugin !== 'qianmu-tts') {
      return result('error', { message: body?.message || `服务响应异常（${response.status}）` });
    }
    return result('ready', body);
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return result('error', { message: timedOut ? '服务检测超时' : '增强服务暂不可达' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
