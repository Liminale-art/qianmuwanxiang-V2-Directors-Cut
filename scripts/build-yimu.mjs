import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { VERSION } from '../yimu/contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FRONTEND = ['manifest.json', 'index.mjs', 'host.mjs', 'budget.mjs', 'client.mjs', 'contract.mjs', 'stage-contract.mjs', 'recall-contract.mjs', 'recall.mjs', 'layers.mjs', 'core.mjs', 'runtime.mjs', 'view.mjs', 'style.css', 'logo.svg', 'LICENSE'];
export const BACKEND = ['package.json', 'server-plugin.mjs', 'server-store.mjs', 'contract.mjs', 'stage-contract.mjs', 'recall-contract.mjs', 'LICENSE'];
export async function buildYimu(destination) {
    const output = path.resolve(destination);
    const stamp = { version: VERSION, files: {} };
    // Refuse an existing destination: this command never replaces an installation or previous build.
    await fs.mkdir(output, { recursive: false });
    for (const [kind, files] of [['frontend', FRONTEND], ['server', BACKEND]]) {
        const folder = path.join(output, kind, 'yimu');
        await fs.mkdir(folder, { recursive: true });
        for (const name of files) {
            const bytes = await fs.readFile(name === 'LICENSE' ? path.join(root, name) : path.join(root, 'yimu', name));
            await fs.writeFile(path.join(folder, name), bytes, { flag: 'wx' });
            stamp.files[`${kind}/yimu/${name}`] = createHash('sha256').update(bytes).digest('hex');
        }
    }
    await fs.copyFile(path.join(root, 'yimu', 'README.md'), path.join(output, 'README.md'));
    await fs.copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
    await fs.writeFile(path.join(output, 'build.json'), JSON.stringify(stamp, null, 2) + '\n', { flag: 'wx' });
    return stamp;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2]) throw new Error('请指定一个不存在的候选包输出目录；此命令不安装到 ST');
    const result = await buildYimu(process.argv[2]);
    console.log(`忆幕 ${result.version} 候选包已生成，共 ${Object.keys(result.files).length} 个包内文件；未安装或部署。`);
}
