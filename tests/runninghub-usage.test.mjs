import test from 'node:test';
import assert from 'node:assert/strict';
import {readRunningHubUsage as read,normalizeRunningHubUsage as normalize,describeRunningHubUsage as describe,normalizeRunningHubObservation as observation} from '../qianmu-runninghub-usage.js';
test('task usage keeps exact decimals, differentiates zero from missing and does not invent units or totals',()=>{
  const raw={consumeCoins:'1.230000',consumeMoney:'0',taskCostTime:'35.5'},usage=read(raw);
  assert.equal(usage.consumeCoins,'1.230000');assert.equal(usage.thirdPartyConsumeMoney,null);
  assert.match(describe(usage),/RH币 1\.230000.*平台金额 0.*第三方金额 未提供.*耗时原值 35\.5/);
  assert.equal(describe(null),'平台用量未提供');assert.doesNotMatch(describe(usage),/￥|USD|秒|合计/);
  assert.deepEqual(normalize(usage),usage);assert.ok(Object.isFrozen(usage));
});
test('untrusted metrics cannot run accessors, inject markup or smuggle metadata into persistent usage',()=>{
  assert.equal(read({get consumeCoins(){assert.fail('getter must not run');}}),null);
  for(const value of ['<img src=x>','1e3','-1',Infinity,10,'1'.repeat(17)])assert.equal(read({consumeCoins:value}),null);
  const valid=read({consumeCoins:'0'});
  for(const value of [null,{}, {...valid,url:'secret'}, {...valid,consumeMoney:'bad'},Object.create(valid)])assert.throws(()=>normalize(value),{code:'comfy_runninghub_usage'});
});
test('a usage observation requires a terminal report and a bounded timestamp, not a guessed completion or arbitrary data',()=>{
  const valid={status:'failed',usage:read({consumeCoins:'0.5'}),observedAt:100};assert.deepEqual(observation(valid),valid);
  for(const change of [{status:'running'},{status:'archived'},{observedAt:0},{observedAt:Infinity},{apiKey:'secret'}])assert.throws(()=>observation({...valid,...change}));
  assert.throws(()=>observation({get status(){assert.fail('getter');},usage:valid.usage,observedAt:100}),{code:'comfy_runninghub_observation'});
});
