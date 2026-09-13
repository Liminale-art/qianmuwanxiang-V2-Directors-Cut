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
export function normalizeRunningHubObservation(value) {
  const fail=()=>{throw Object.assign(new Error('原任务用量核查记录无效'),{code:'comfy_runninghub_observation',retryable:false});};
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
  const names=['status','usage','observedAt'];
  if(Reflect.ownKeys(value).length!==names.length||names.some(key=>!Object.hasOwn(value,key)||Object.getOwnPropertyDescriptor(value,key).get||Object.getOwnPropertyDescriptor(value,key).set))fail();
  if(!['succeeded','failed'].includes(value.status)||!Number.isSafeInteger(value.observedAt)||value.observedAt<1)fail();
  return Object.freeze({status:value.status,usage:normalizeRunningHubUsage(value.usage),observedAt:value.observedAt});
}

// Small immutable task receipt shared by variants, never an image price.
export function readRunningHubTaskUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const own = key => { const p=Object.getOwnPropertyDescriptor(value,key); return p && !p.get && !p.set ? p.value : undefined; };
  const taskId=own('taskId'), usage=readRunningHubUsage(own('usage'));
  if (own('provider')!=='runninghub' || typeof taskId!=='string' || !/^\d{1,64}$/.test(taskId) || !usage) return null;
  return Object.freeze({provider:'runninghub',taskId,usage});
}
export function runningHubUsageFields(data) {
  const cloudUsage=readRunningHubTaskUsage({provider:data?.provider,taskId:data?.upstreamId,usage:data?.delivery?.usage});
  return cloudUsage ? {cloudUsage} : {};
}
export function renderRunningHubTaskUsage(owner) {
  const value=readRunningHubTaskUsage(owner?.cloudUsage);
  if (!value) return '';
  // All dynamic values are validated numeric strings; no URLs, credentials or HTML.
  return `<p class="sd-storyboard-task-usage">整次任务用量（非单张）<br>原任务 ${value.taskId}<br>${describeRunningHubUsage(value.usage)}</p>`;
}
