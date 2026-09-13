// Task-level reported usage, never a price estimate or per-image sum.
const keys = ['consumeCoins','consumeMoney','thirdPartyConsumeMoney','taskCostTime'];
const decimal = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,15})(?:\.\d{1,12})?$/.test(value);
export function readRunningHubUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = keys.map(key => {
    const property = Object.getOwnPropertyDescriptor(value,key), item = property && !property.get && !property.set ? property.value : null;
    return [key,decimal(item) ? item : null];
  });
  return entries.some(([,item]) => item !== null) ? Object.freeze(Object.fromEntries(entries)) : null;
}
export function normalizeRunningHubUsage(value) {
  const valid = readRunningHubUsage(value);
  if (!valid || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value,key) || Object.getOwnPropertyDescriptor(value,key).get || Object.getOwnPropertyDescriptor(value,key).set || value[key] !== valid[key]))
    throw Object.assign(new Error('原任务用量记录无效'),{code:'comfy_runninghub_usage',retryable:false});
  return valid;
}
export function describeRunningHubUsage(value) {
  const usage = readRunningHubUsage(value);
  if (!usage) return '平台用量未提供';
  // API documents numeric strings but no currency or time unit. Do not invent them.
  return [['consumeCoins','RH币'],['consumeMoney','平台金额'],['thirdPartyConsumeMoney','第三方金额'],['taskCostTime','耗时原值']]
    .map(([key,label]) => `${label} ${usage[key] ?? '未提供'}`).join(' · ');
}
