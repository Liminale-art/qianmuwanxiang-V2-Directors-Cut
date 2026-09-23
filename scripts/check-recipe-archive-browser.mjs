// Retired: the old probe depends on removed eager hydration/cache APIs and
// bypasses the current migration scheduler, capability routes and host lifecycle.
// An obsolete script is not passing browser evidence. Do not launch a browser.
console.error('[千幕] 旧配方浏览器探针已退役：原缓存预热、初始化及自动迁移夹具已不再匹配实际入口。');
console.error('当前隔离回归：node --test tests/recipe-client-opening.test.mjs tests/recipe-archive-client.test.mjs tests/gallery-snapshot-migration.test.mjs');
console.error('这些测试不代表真实 ST、原生 IndexedDB、手机或跨端验收通过；真实验收仍须单独完成。');
process.exitCode=1;
