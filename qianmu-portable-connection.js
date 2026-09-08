const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_connection_identity', submissionState: 'not_submitted' }); };
export const portableFieldName = value => String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
export const isPortableCredentialField = name => /(?:apikey|apitoken|accesskey|authorization|cookie|accesstoken|refreshtoken|sessiontoken|clientsecret|password|credentialid|grantid|sharedsecret|bearertoken|privatekey)/.test(portableFieldName(name)) || /^(?:token|auth|secret|secretkey)$/.test(portableFieldName(name));

export function assertPortableConnectionUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) fail('连接地址格式不支持安全备份');
  if (!value) return;
  let parsed; try { parsed = new URL(value); } catch (_) { fail('连接地址须为完整 HTTP(S) 地址，请先核对'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) fail('连接地址含内嵌身份或片段，未写入无凭据备份，请使用独立 Key 输入框');
  for (const key of parsed.searchParams.keys()) if (isPortableCredentialField(key) || /^(?:key|token|auth|signature|sig|code|secret)$/.test(portableFieldName(key)) || /(?:signature|credential)$/.test(portableFieldName(key))) fail('连接地址含授权查询参数，未写入无凭据备份，请使用独立 Key 输入框');
}

export function assertPortableConnection(value) {
  if (!object(value)) fail('连接资料格式无效'); let nodes = 0;
  function scan(item, depth = 0, headers = false) {
    if (++nodes > 20000 || depth > 20) fail('连接资料结构过大');
    if (!item || typeof item !== 'object') return;
    for (const [key, next] of Object.entries(item)) {
      if ((isPortableCredentialField(key) || headers && /(?:token|secret|auth)$/.test(portableFieldName(key))) && next !== '' && next !== null && next !== undefined) fail('连接包含结构化连接凭据或授权，未写入备份；请先在原设置中单独保全授权');
      if (['baseurl', 'apiurl', 'comfyurl'].includes(portableFieldName(key)) && next != null) assertPortableConnectionUrl(next);
      if (['headers', 'customheaders'].includes(portableFieldName(key)) && next != null && !object(next)) fail('自定义请求头格式不透明，未写入无凭据备份');
      scan(next, depth + 1, ['headers', 'customheaders'].includes(portableFieldName(key)));
    }
  }
  scan(value); return true;
}
