import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const checker = String.raw`
  import fs from 'node:fs';
  import path from 'node:path';
  import vm from 'node:vm';
  import { pathToFileURL } from 'node:url';

  const modules = new Map();
  const getModule = (url) => {
    if (modules.has(url.href)) return modules.get(url.href);
    const module = new vm.SourceTextModule(fs.readFileSync(url, 'utf8'), {
      identifier: url.href,
    });
    modules.set(url.href, module);
    return module;
  };

  const linker = (specifier, referencingModule) => (
    getModule(new URL(specifier, referencingModule.identifier))
  );
  const roots = fs.readdirSync('.')
    .filter((file) => file === 'index.js' || /^qianmu-storyboard-.*\.js$/.test(file));
  for (const file of roots) {
    const module = getModule(pathToFileURL(path.resolve(file)));
    if (module.status === 'unlinked') await module.link(linker);
  }
  console.log(roots.length + ':' + modules.size);
`;

const result = spawnSync(process.execPath, [
  '--experimental-vm-modules',
  '--no-warnings',
  '--input-type=module',
  '-e',
  checker,
], {
  cwd: root,
  encoding: 'utf8',
});

assert.equal(result.status, 0, result.stderr || result.stdout || '模块链接检查失败');
const [rootCount, moduleCount] = result.stdout.trim().split(':').map(Number);
assert.ok(rootCount > 1, '模块链接检查必须覆盖全部分镜模块');
assert.ok(moduleCount >= rootCount, '模块链接检查必须覆盖各模块依赖图');

console.log('Static module linkage contract OK');
