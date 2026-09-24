// Per-floor narrative shots are independent of provider variants and concurrency.
// Expanding the supported range never changes an existing user's chosen budget.
export const STORYBOARD_LEGACY_MAX_SHOTS = 4;
export const STORYBOARD_LEGACY_V2_MAX_SHOTS = 6;
export const STORYBOARD_MAX_CONCURRENCY = 4;

// Resource budgets apply to complete structures, not an example shot count.
// Call before cloning/mapping an untrusted batch; never trim a batch to fit.
export function assertStoryboardStructureBytes(value, maxBytes=256*1024, label='分镜数据') {
  const fail=()=>{throw Object.assign(new Error(`${label}超过安全容量或结构无效，未截断、未提交`),{
    code:'storyboard_structure_capacity',submissionState:'not_submitted',
  });};
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)fail();
  let serialized;
  try{serialized=JSON.stringify(value);}catch{fail();}
  if(typeof serialized!=='string'||new TextEncoder().encode(serialized).byteLength>maxBytes)fail();
  return value;
}

// Shot counts come from an explicit user budget, not the 3/6-shot examples.
// Byte, queue, attempt-ledger and output-token capacities remain separate guards.
export function storyboardShotCount(value, fallback = 1) {
  const count = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw Object.assign(new Error('镜头数量请输入正整数'), { code: 'storyboard_shot_count' });
  }
  return count;
}
