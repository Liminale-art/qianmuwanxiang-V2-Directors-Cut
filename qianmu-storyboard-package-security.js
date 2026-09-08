import { portableFieldName, isPortableCredentialField, assertPortableConnectionUrl } from './qianmu-portable-connection.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_package_credentials', submissionState: 'not_submitted' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Inspect structured credentials, including serialized API graphs; never redact or rewrite a signed original.
// Arbitrary prompt/prose strings and unknown custom-node fields are not a secret-detection guarantee.
export async function assertPortableStoryboardData(value, { workflowsOnly = false } = {}) {
  let nodes = 0;
  const path = new WeakSet(), workflows = new Map();
  function scan(item, depth = 0, headers = false, inspect = true) {
    if (++nodes > 500000 || depth > 40) fail('备份凭据检查结构过大或过深');
    if (!item || typeof item !== 'object') return;
    if (path.has(item)) fail('备份资料包含循环结构');
    path.add(item);
    for (const [name, next] of Object.entries(item)) {
      const key = portableFieldName(name), nonempty = next !== '' && next !== null && next !== undefined;
      if (['__proto__', 'prototype', 'constructor'].includes(name)) fail('备份资料字段不安全');
      if (inspect && (isPortableCredentialField(key) || headers && /(?:token|secret|auth)$/.test(key)) && nonempty) fail('备份包含结构化连接凭据或授权，请在来源设置中单独保全；原资料未改写');
      if (inspect && ['baseurl', 'apiurl', 'comfyurl'].includes(key) && next != null) assertPortableConnectionUrl(next);
      if (inspect && /(?:url|uri|href|endpoint)$/.test(key) && typeof next === 'string' && /^https?:/i.test(next)) assertPortableConnectionUrl(next);
      const header = ['headers', 'customheaders'].includes(key);
      if (inspect && header && next != null && !object(next)) fail('自定义请求头格式不透明，未写入无凭据备份');
      const workflow = ['workflow', 'comfyworkflow'].includes(key);
      if (workflow && typeof next === 'string' && /^[\s]*[\[{]/.test(next)) {
        // Per-operation deduplication only. Keep the deepest use so repeated text cannot evade the nesting limit.
        if (!workflows.has(next) || depth + 1 > workflows.get(next)) {
          // A deeper occurrence discovered after parsing another graph must be revisited by the live Map iterator.
          workflows.delete(next); workflows.set(next, depth + 1);
        }
      }
      scan(next, depth + 1, header, inspect || workflow);
    }
    path.delete(item);
  }
  // Raw state may contain valid local credential references outside graphs. The captured package is checked in full later.
  scan(value, 0, false, !workflowsOnly);
  if (workflows.size) {
    // Lazy to avoid the package-input -> assets -> security initialization cycle and duplicate parsers.
    const { parseStrictStoryboardJson } = await import('./qianmu-storyboard-package-input.js');
    for (const [text, depth] of workflows) {
      let graph;
      try { graph = parseStrictStoryboardJson(text, { maxBytes: 2 * 1048576 }); }
      catch (_) { fail('工作流原文无效、含重复字段或超限，未改写后继续备份'); }
      scan(graph, depth);
    }
  }
  return true;
}
