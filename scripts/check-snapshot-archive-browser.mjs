// Retired, not a passing browser check. The former probe expected removed cache
// APIs, legacy mutable keys and archival success without a server source receipt.
// Keep this entry point as an explicit failure for old commands/automation.
// Do not launch a browser or substitute isolated Node evidence for native ST QA.
console.error('[千幕] 旧快照浏览器探针已退役：其缓存接口、配方版本键和来源保全条件已失效。');
console.error('当前隔离回归：node --test tests/snapshot-archive-revisions.test.mjs tests/recipe-archive-client.test.mjs tests/gallery-snapshot-migration.test.mjs');
console.error('这些测试不代表真实 ST、原生 IndexedDB、手机或跨端验收通过；真实验收仍须单独完成。');
process.exitCode=1;
