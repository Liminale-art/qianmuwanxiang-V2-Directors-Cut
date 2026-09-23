import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
for(const [file,message] of [['check-snapshot-archive-browser.mjs','旧快照浏览器探针已退役'],['check-recipe-archive-browser.mjs','旧配方浏览器探针已退役']]){
const script=new URL('../scripts/'+file,import.meta.url);
test(`retired ${file} fails explicitly without loading or launching a browser`,()=>{
  const source=readFileSync(script,'utf8');assert.doesNotMatch(source,/\bimport\s|\brequire\s*\(|\.launch\s*\(|\bfetch\s*\(/);
  const result=spawnSync(process.execPath,[fileURLToPath(script)],{encoding:'utf8',timeout:5000,env:{...process.env,QIANMU_PLAYWRIGHT_MODULE:'qianmu-deliberately-unavailable-probe'}});
  assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.ok(result.stderr.includes(message));assert.match(result.stderr,/node --test/);assert.match(result.stderr,/不代表真实 ST/);
  assert.doesNotMatch(result.stderr,/nativeIndexedDB.*true|MODULE_NOT_FOUND/);
});
}
