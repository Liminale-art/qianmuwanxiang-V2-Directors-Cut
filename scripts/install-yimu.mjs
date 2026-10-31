import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { buildYimu } from './build-yimu.mjs';
import { VERSION } from '../yimu/contract.mjs';

export const INSTALLER_ID = 'yimu-paired-installer-v1';
export const RECEIPT = '.yimu-install.json';
export const MAX_INSTALL_BACKUPS = 5;
const sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, target) => target !== root && !path.relative(root, target).startsWith('..') && !path.isAbsolute(path.relative(root, target));
const fail = message => { throw new Error(message); };
const exists = async target => { try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

async function command(file, args, options = {}) {
    if (process.platform === 'win32' && file === 'pm2') {
        // npm installs a .cmd shim on Windows. Only these fixed subcommands and
        // validated numeric IDs cross cmd; no user path or service name is interpolated.
        if (!(args.length === 1 && args[0] === 'jlist')
            && !(args.length === 2 && ['stop', 'start'].includes(args[0]) && /^\d+$/.test(args[1]))) fail('PM2 操作参数无效。');
        return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pm2 ' + args.join(' ')],
            { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
    }
    return exec(file, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
}

async function plain(target, directory) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || directory !== stat.isDirectory() || !directory && !stat.isFile()) fail('目标含链接或非预期文件，未继续：' + target);
    return stat;
}

async function checkedRoot(input) {
    const absolute = path.resolve(input);
    if (absolute === path.parse(absolute).root) fail('请指定真正的 SillyTavern 根目录。');
    await plain(absolute, true);
    const root = await fs.realpath(absolute);
    if (!samePath(absolute, root)) fail('请使用真实 ST 目录，而不是符号链接或重定向路径。');
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name?.toLowerCase() !== 'sillytavern') fail('所选目录不是 SillyTavern 根目录。');
    for (const file of ['server.js', 'src/server-startup.js', 'public/scripts/extensions.js']) await plain(path.join(root, file), false);
    return root;
}

async function descendants(root, target, create = false, mode = 0o755) {
    if (!inside(root, target)) fail('安装路径超出已确认的 ST 目录。');
    let current = root;
    for (const component of path.relative(root, target).split(path.sep)) {
        current = path.join(current, component);
        if (!await exists(current)) {
            if (!create) return false;
            await fs.mkdir(current, { mode });
            await fs.chmod(current, mode);
        }
        await plain(current, true);
    }
    return true;
}

async function fileMap(folder, { omitReceipt = false } = {}) {
    await plain(folder, true);
    const result = Object.create(null);
    async function walk(dir, prefix = '') {
        for (const name of (await fs.readdir(dir)).sort()) {
            const target = path.join(dir, name), relative = prefix + name, stat = await fs.lstat(target);
            if (stat.isSymbolicLink()) fail('安装目录包含链接，未覆盖：' + relative);
            if (stat.isDirectory()) fail('独立忆幕安装目录存在额外子目录，未覆盖：' + relative);
            else if (stat.isFile()) {
                if (!(omitReceipt && relative === RECEIPT)) result[relative] = sha(await fs.readFile(target));
            } else fail('安装目录存在不明文件类型。');
        }
    }
    await walk(folder);
    return result;
}

const sameMap = (a, b) => Object.keys(a).length === Object.keys(b).length
    && Object.entries(a).every(([name, hash]) => b[name] === hash);

async function copyFlat(source, target, expected, publicCode = false) {
    if (!sameMap(await fileMap(source), expected)) fail('跨挂载副本来源校验失败，未清理原件。');
    if (!await exists(target)) {
        await fs.mkdir(target, { mode: publicCode ? 0o755 : 0o700 });
        await fs.chmod(target, publicCode ? 0o755 : 0o700);
        for (const name of Object.keys(expected)) {
            await fs.copyFile(path.join(source, name), path.join(target, name), 1);
            await fs.chmod(path.join(target, name), name === RECEIPT ? 0o600 : 0o644);
        }
    }
    if (!sameMap(await fileMap(target), expected)) fail('跨挂载备份校验失败，未清理原件。');
}

async function removeKnownFlat(folder, expected) {
    if (!await exists(folder)) return;
    const files = await fileMap(folder);
    // A previous interrupted cleanup may have removed some known files. Its
    // complete backup must already be verified by the caller before coming here.
    if (!Object.entries(files).every(([name, hash]) => expected[name] === hash)) fail('暂存目录有不明改动，保留现场，未重启。');
    for (const name of Object.keys(files)) await fs.unlink(path.join(folder, name));
    await fs.rmdir(folder);
}

async function installed(folder, kind, root) {
    if (!await exists(folder)) return null;
    await plain(folder, true);
    const receiptPath = path.join(folder, RECEIPT);
    if (!await exists(receiptPath)) fail('现有忆幕不是由此安装器管理，未覆盖：' + folder);
    await plain(receiptPath, false);
    const receiptBytes = await fs.readFile(receiptPath), receipt = JSON.parse(receiptBytes);
    if (receipt.installer !== INSTALLER_ID || receipt.kind !== kind || !samePath(receipt.root || '', root)
        || !receipt.files || !/^[a-f0-9]{40,64}$/.test(receipt.commit)) fail('现有忆幕安装记录不能核实，未覆盖。');
    const files = await fileMap(folder, { omitReceipt: true });
    if (!sameMap(files, receipt.files)) fail('现有忆幕含本地修改或多余文件，请先保留并核对，未覆盖：' + folder);
    const descriptorName = kind === 'frontend' ? 'manifest.json' : 'package.json';
    if (!files[descriptorName] || !files['contract.mjs']) fail('现有忆幕缺少版本入口，未覆盖。');
    const descriptor = JSON.parse(await fs.readFile(path.join(folder, descriptorName), 'utf8'));
    if (descriptor.version !== receipt.version) fail('现有忆幕实际版本与安装记录不符，未覆盖。');
    return { receipt, receiptHash: sha(receiptBytes), files };
}

export async function pruneInstallBackups(root, keep = MAX_INSTALL_BACKUPS) {
    if (!await exists(root)) return;
    const rows = [];
    for (const item of await fs.readdir(root, { withFileTypes: true })) {
        if (!item.isDirectory() || item.isSymbolicLink() || !/^\d{4}-\d{2}-\d{2}T/.test(item.name)) continue;
        const folder = path.join(root, item.name);
        await plain(folder, true);
        const stat = await fs.stat(folder);
        rows.push({ folder, mtime: stat.mtimeMs });
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    for (const row of rows.slice(Math.max(0, keep))) await fs.rm(row.folder, { recursive: true, force: false });
}

export function enableServerPlugins(bytes) {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '', body = content.slice(bom.length);
    const firstSetting = body.split(/\r?\n/).find(line => line.trim() && !line.trim().startsWith('#') && line.trim() !== '---');
    if (firstSetting && /^[ \t]+/.test(firstSetting)
        || /^[ \t]+(?:enableServerPlugins|"enableServerPlugins"|'enableServerPlugins')[ \t]*:/m.test(body)) {
        fail('ST 根配置存在非常规缩进，请先核对，未追加或修改开关。');
    }
    if ((body.match(/^---\s*$/gm) || []).length > 1 || /^\.\.\.\s*$/m.test(body)
        || /^[ \t]*[\[{]/m.test(body) || /^<<[ \t]*:/m.test(body)) fail('ST 配置格式需要人工核对，未自动修改。');
    const key = /^(?:enableServerPlugins|"enableServerPlugins"|'enableServerPlugins')[ \t]*:/gm;
    const matches = [...body.matchAll(key)];
    if (matches.length > 1) fail('ST 配置中的 enableServerPlugins 重复，未修改。');
    let next;
    if (matches.length) {
        const line = /^(?:enableServerPlugins|"enableServerPlugins"|'enableServerPlugins')([ \t]*:[ \t]*)(true|false)([ \t]*(?:#[^\r\n]*)?)(\r?)$/m;
        if (!line.test(body)) fail('enableServerPlugins 不是普通 true/false 值，未修改。');
        next = body.replace(line, 'enableServerPlugins$1true$3$4');
    } else {
        const eol = body.includes('\r\n') ? '\r\n' : '\n';
        next = body + (body.endsWith('\n') ? '' : eol) + 'enableServerPlugins: true' + eol;
    }
    return Buffer.from(bom + next, 'utf8');
}

async function protectCopy(source, destination) {
    const stat = await fs.stat(source);
    if (process.platform !== 'win32') {
        const target = await fs.stat(destination);
        if (target.uid !== stat.uid || target.gid !== stat.gid) await fs.chown(destination, stat.uid, stat.gid);
    }
    await fs.chmod(destination, stat.mode & 0o777);
    if (process.platform === 'win32') {
        // Preserve explicit ACLs when replacing a configuration containing private values.
        const quoted = value => "'" + value.replaceAll("'", "''") + "'";
        const code = '$ErrorActionPreference="Stop"; $acl=[IO.File]::GetAccessControl(' + quoted(source)
            + '); [IO.File]::SetAccessControl(' + quoted(destination) + ', $acl)';
        const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
        await command(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]);
    }
}

async function sourceCommit(sourceRoot, run) {
    const git = async args => (await run('git', ['-c', 'core.fsmonitor=false', '-C', sourceRoot, ...args])).stdout.trim();
    const top = await fs.realpath(await git(['rev-parse', '--show-toplevel']));
    if (!samePath(top, await fs.realpath(sourceRoot))) fail('安装源码不是独立仓库根目录。');
    if (await git(['status', '--porcelain', '--untracked-files=all'])) fail('安装源码存在未提交改动；请使用一键命令获取完整交付版本。');
    const commit = await git(['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) fail('无法确认安装源码提交。');
    return commit;
}

async function verifyBuild(folder, stamp, sourceRoot, commit, run) {
    if (stamp?.version !== VERSION || !stamp.files || typeof stamp.files !== 'object') fail('构建版本与忆幕版本不一致。');
    const maps = {};
    for (const kind of ['frontend', 'server']) {
        const files = await fileMap(path.join(folder, kind, 'yimu'));
        for (const [name, hash] of Object.entries(files)) {
            if (name === RECEIPT || name.includes('/')) fail('构建文件布局不符合独立忆幕安装约定。');
            if (stamp.files[kind + '/yimu/' + name] !== hash) fail('构建文件校验失败：' + name);
            const tracked = name === 'LICENSE' ? 'LICENSE' : 'yimu/' + name;
            const bytes = (await run('git', ['-C', sourceRoot, 'show', commit + ':' + tracked], { encoding: 'buffer' })).stdout;
            if (sha(bytes) !== hash) fail('前后端文件不是同一源码提交：' + name);
        }
        maps[kind] = files;
    }
    if (Object.keys(stamp.files).length !== Object.keys(maps.frontend).length + Object.keys(maps.server).length) fail('构建清单有未核实文件。');
    const manifest = JSON.parse(await fs.readFile(path.join(folder, 'frontend/yimu/manifest.json'), 'utf8'));
    const pkg = JSON.parse(await fs.readFile(path.join(folder, 'server/yimu/package.json'), 'utf8'));
    if (manifest.version !== VERSION || pkg.version !== VERSION || pkg.name !== 'yimu' || pkg.main !== 'server-plugin.mjs'
        || manifest.js !== 'index.mjs' || manifest.generate_interceptor !== 'yimuGenerationInterceptor') fail('忆幕前后端入口或实际版本不匹配。');
    for (const [kind, name] of [['frontend', 'index.mjs'], ['server', 'server-plugin.mjs']]) {
        if (!maps[kind][name] || !maps[kind]['contract.mjs']) fail('忆幕安装包缺少必要入口。');
    }
    if (maps.frontend['contract.mjs'] !== maps.server['contract.mjs']) fail('前后端契约文件不一致。');
    if (await sourceCommit(sourceRoot, run) !== commit) fail('安装期间源码提交发生变化。');
    return maps;
}

async function pm2Target(name, root, run) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-') || name.includes('\0')) fail('请明确指定 PM2 服务名。');
    const output = await run('pm2', ['jlist']);
    let records;
    try { records = JSON.parse(output.stdout); } catch { fail('无法读取 PM2 服务清单，未操作进程。'); }
    const matches = records.filter(item => item.name === name);
    if (matches.length !== 1) fail('PM2 服务名不唯一或不存在，未操作进程。');
    const item = matches[0], env = item.pm2_env;
    if (!Number.isSafeInteger(item.pm_id) || !env?.pm_cwd || !samePath(await fs.realpath(env.pm_cwd), root)
        || !env.pm_exec_path || !inside(root, await fs.realpath(env.pm_exec_path))) fail('所选 PM2 服务的运行目录或入口与 ST 不符，未操作进程。');
    const executable = await fs.realpath(env.pm_exec_path);
    if (samePath(executable, path.join(root, 'start.sh'))) {
        const lines = (await fs.readFile(executable, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
        const known = new Set([
            'cd "$(dirname "$0")"', 'if ! command -v npm &> /dev/null', 'then', 'fi',
            String.raw`echo -e "\033[0;31mnpm could not be found in PATH. If the startup fails, please install Node.js from https://nodejs.org/\033[0m"`,
            'echo "Installing Node Modules..."', 'export NODE_ENV=production',
            'npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts',
            'echo "Entering SillyTavern..."', 'node "server.js" "$@"',
        ]);
        if (!lines.includes('node "server.js" "$@"') || lines.some(line => !known.has(line))) {
            fail('PM2 启动脚本的配置来源不能确认；请手动停止 ST 后用 --stopped --config 安装。');
        }
    } else if (!samePath(executable, path.join(root, 'server.js'))) {
        fail('PM2 使用自定义启动入口，无法确认实际配置；请手动停止后指定 --config。');
    }
    const args = env.args === undefined || env.args === '' ? [] : env.args;
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) fail('PM2 启动参数格式不能可靠确认，请手动停止后指定 --config。');
    let configPath = path.join(root, 'config.yaml'), configCount = 0;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--' || /^--config[-_]?path(?:=|$)/i.test(args[i]) && !/^--configPath(?:=|$)/.test(args[i])) fail('PM2 配置参数写法不能可靠确认，请手动停止并指定 --config。');
        if (/^--global(?:=|$)/.test(args[i])) fail('全局模式不使用当前 ST 根配置；请按实际部署方式人工核对。');
        if (args[i] === '--configPath' || args[i].startsWith('--configPath=')) {
            const value = args[i] === '--configPath' ? args[++i] : args[i].slice('--configPath='.length);
            if (!value || value.startsWith('--') || ++configCount > 1) fail('PM2 配置路径参数不明确，未修改。');
            configPath = path.resolve(root, value);
        }
    }
    const override = env.SILLYTAVERN_ENABLESERVERPLUGINS ?? env.env?.SILLYTAVERN_ENABLESERVERPLUGINS;
    if (override !== undefined && String(override).toLowerCase() !== 'true') fail('PM2 环境变量覆盖了服务端插件开关，请先核对该服务的配置。');
    if (!['online', 'stopped'].includes(env.status)) fail('PM2 服务不是可确认的运行或停止状态，未操作。');
    return { id: item.pm_id, name, status: env.status, configPath };
}

/** Only fixed code targets are replaced. Account data, chat files and Qianmu are never traversed. */
export async function installYimu({ stRoot, config, stopped = false, pm2, sourceRoot = sourceDirectory, onProgress = () => {} },
    { run = command, build = buildYimu, protect = protectCopy, stat = fs.stat, rename = fs.rename } = {}) {
    const root = await checkedRoot(stRoot);
    if (pm2 && stopped) fail('请选择明确的 PM2 服务，或确认 ST 已停止，不能同时设置。');
    if (!pm2 && !stopped) fail('请先停止 ST 并确认，或明确指定要管理的 PM2 服务。');
    const processInfo = pm2 ? await pm2Target(pm2, root, run) : null;
    let configFile;
    if (config) configFile = path.resolve(root, config);
    else if (processInfo) configFile = processInfo.configPath;
    else {
        const candidates = [];
        for (const candidate of ['config.yaml', 'config/config.yaml']) if (await exists(path.join(root, candidate))) candidates.push(path.join(root, candidate));
        if (candidates.length !== 1 || !samePath(candidates[0], path.join(root, 'config.yaml'))) fail('无法唯一确认 ST 默认配置，请用 --config 指定正在使用的配置文件。');
        configFile = candidates[0];
    }
    if (processInfo && !samePath(configFile, processInfo.configPath)) fail('--config 与所选 PM2 服务实际启动配置不一致，未修改。');
    if (!inside(root, configFile)) fail('配置文件必须位于已确认的 ST 根目录内。');
    if (!samePath(path.dirname(configFile), root)) await descendants(root, path.dirname(configFile));
    const configStat = await plain(configFile, false), configBytes = await fs.readFile(configFile), nextConfig = enableServerPlugins(configBytes);
    const configChanged = !configBytes.equals(nextConfig);
    if (configChanged && (await stat(configFile)).dev !== (await stat(path.dirname(configFile))).dev) fail('配置文件本身是独立挂载，不能原子替换；请在原部署处启用插件后重试。');
    const targets = {
        frontend: path.join(root, 'public/scripts/extensions/third-party/yimu'),
        server: path.join(root, 'plugins/yimu'),
    };
    const old = {};
    for (const [kind, target] of Object.entries(targets)) {
        await descendants(root, path.dirname(target));
        old[kind] = await installed(target, kind, root);
        if (old[kind] && (await stat(target)).dev !== (await stat(path.dirname(target))).dev) fail('忆幕目标目录本身是独立挂载，未强制覆盖；请先核对挂载方式。');
    }
    if (Boolean(old.frontend) !== Boolean(old.server)) fail('忆幕前后端安装不完整，请先保留现状并核对，未覆盖。');
    if (old.frontend && (old.frontend.receipt.commit !== old.server.receipt.commit || old.frontend.receipt.version !== old.server.receipt.version
        || old.frontend.files['contract.mjs'] !== old.server.files['contract.mjs'])) fail('已有忆幕前后端版本不一致，未覆盖。');
    const commit = await sourceCommit(sourceRoot, run);
    const lock = path.join(root, '.yimu-installer.lock'), owner = randomUUID();
    try { await fs.mkdir(lock); } catch (error) { if (error.code === 'EEXIST') fail('已有安装锁，请核查是否有另一安装或未完成回退。'); throw error; }
    await fs.writeFile(path.join(lock, 'owner'), owner, { flag: 'wx', mode: 0o600 });
    let transaction, pm2Stopped = false, moved = [], configApplied = false, committed = false, rollbackFailed = false;
    const workspaces = [];
    let configWorkspace = null, configNext, configOriginal, configFailed;
    const cleanupWorkspaces = async () => {
        for (const work of workspaces) {
            if (!await exists(work.folder)) continue;
            await plain(work.folder, true);
            if (work.kind === 'config') {
                const approved = { 'config.original': [configBytes, path.join(transaction, 'config.original')],
                    'config.next': [nextConfig, path.join(transaction, 'config.next')],
                    'config.failed': [nextConfig, path.join(transaction, 'failed/config')] };
                for (const name of await fs.readdir(work.folder)) {
                    if (!approved[name]) fail('配置暂存有不明文件，保留现场，未重启。');
                    const file = path.join(work.folder, name), [bytes, backup] = approved[name];
                    await plain(file, false);
                    if (!(await fs.readFile(file)).equals(bytes)) fail('配置暂存已变化，保留现场，未重启。');
                    if (!await exists(backup)) { await fs.copyFile(file, backup, 1); await protect(file, backup); }
                    if (!(await fs.readFile(backup)).equals(bytes)) fail('配置暂存校验失败。');
                    await fs.unlink(file);
                }
            } else {
                for (const name of await fs.readdir(work.folder)) {
                    const part = work.parts[name];
                    if (!part) fail('代码暂存有不明文件，保留现场，未重启。');
                    const folder = path.join(work.folder, name);
                    if (!await exists(part.backup)) await copyFlat(folder, part.backup, part.files);
                    if (!sameMap(await fileMap(part.backup), part.files)) fail('旧代码备份不完整，未清理暂存。');
                    await removeKnownFlat(folder, part.files);
                }
            }
            await fs.rmdir(work.folder);
        }
    };
    try {
        const backupRoot = path.join(root, '.yimu-install-backups');
        await descendants(root, backupRoot, true, 0o700);
        transaction = await fs.mkdtemp(path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
        await fs.chmod(transaction, 0o700);
        const output = path.join(transaction, 'candidate');
        await onProgress({ phase: 'build' });
        const stamp = await build(output);
        const maps = await verifyBuild(output, stamp, sourceRoot, commit, run);
        await fs.mkdir(path.join(transaction, 'previous'));
        await fs.mkdir(path.join(transaction, 'failed'));
        if (configChanged) {
            const original = path.join(transaction, 'config.original');
            await fs.writeFile(original, configBytes, { flag: 'wx', mode: configStat.mode & 0o777 });
            await protect(configFile, original);
            const next = path.join(transaction, 'config.next');
            await fs.writeFile(next, nextConfig, { flag: 'wx', mode: configStat.mode & 0o777 });
            await protect(configFile, next);
        }
        configNext = path.join(transaction, 'config.next'); configOriginal = path.join(transaction, 'config.original'); configFailed = path.join(transaction, 'failed/config');
        const staged = {}, priorPaths = {}, failedPaths = {}, codeWork = {}, newFiles = {}, oldFiles = {};
        for (const kind of ['frontend', 'server']) {
            const codeFolder = path.join(output, kind, 'yimu');
            await fs.chmod(codeFolder, 0o755);
            for (const name of Object.keys(maps[kind])) await fs.chmod(path.join(codeFolder, name), 0o644);
            await fs.writeFile(path.join(output, kind, 'yimu', RECEIPT), JSON.stringify({
                installer: INSTALLER_ID, kind, root, commit, version: VERSION, files: maps[kind],
            }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            newFiles[kind] = { ...maps[kind], [RECEIPT]: sha(await fs.readFile(path.join(codeFolder, RECEIPT))) };
            oldFiles[kind] = old[kind] ? { ...old[kind].files, [RECEIPT]: old[kind].receiptHash } : null;
            staged[kind] = codeFolder; priorPaths[kind] = path.join(transaction, 'previous', kind); failedPaths[kind] = path.join(transaction, 'failed', kind);
        }
        await onProgress({ phase: 'beforeCommit' });
        await plain(root, true); await plain(configFile, false);
        if (!(await fs.readFile(configFile)).equals(configBytes)) fail('安装期间 ST 配置发生变化，已保留改动，未覆盖。');
        for (const [kind, target] of Object.entries(targets)) {
            await descendants(root, path.dirname(target), true);
            const current = await installed(target, kind, root);
            if (current?.receiptHash !== old[kind]?.receiptHash || !sameMap(current?.files || {}, old[kind]?.files || {})) fail('安装期间目标文件发生变化，未覆盖。');
        }
        if (processInfo) {
            const current = await pm2Target(pm2, root, run);
            if (current.id !== processInfo.id || current.status !== processInfo.status || !samePath(current.configPath, configFile)) fail('所选 PM2 服务在安装期间发生变化，未操作。');
            if (processInfo.status === 'online') {
                await run('pm2', ['stop', String(processInfo.id)]); pm2Stopped = true;
                const stoppedTarget = await pm2Target(pm2, root, run);
                if (stoppedTarget.id !== processInfo.id || stoppedTarget.status !== 'stopped' || !samePath(stoppedTarget.configPath, configFile)) fail('PM2 未确认停止或配置路径变化，未置换代码。');
            }
        }
        // Bind-mounted parents require a same-device staging directory. These
        // temporary directories exist only while ST is stopped, and are removed
        // before any restart so ST's extension/plugin scanners never see them.
        const rootDevice = (await stat(transaction)).dev;
        for (const [kind, target] of Object.entries(targets)) {
            const parent = path.dirname(target);
            if ((await stat(parent)).dev === rootDevice) continue;
            const folder = await fs.mkdtemp(path.join(parent, '.yimu-install-'));
            const work = { kind, folder, parts: {
                candidate: { files: newFiles[kind], backup: staged[kind] },
                failed: { files: newFiles[kind], backup: failedPaths[kind] },
            } };
            if (old[kind]) {
                work.parts.previous = { files: oldFiles[kind], backup: priorPaths[kind] };
                work.parts.restore = work.parts.previous;
            }
            workspaces.push(work); codeWork[kind] = work;
            await fs.chmod(folder, 0o700);
            if (old[kind]) await copyFlat(target, priorPaths[kind], oldFiles[kind]);
            await copyFlat(staged[kind], path.join(folder, 'candidate'), newFiles[kind], true);
            staged[kind] = path.join(folder, 'candidate'); priorPaths[kind] = path.join(folder, 'previous'); failedPaths[kind] = path.join(folder, 'failed');
        }
        if (configChanged && (await stat(path.dirname(configFile))).dev !== rootDevice) {
            const folder = await fs.mkdtemp(path.join(path.dirname(configFile), '.yimu-install-'));
            configWorkspace = { kind: 'config', folder }; workspaces.push(configWorkspace);
            await fs.chmod(folder, 0o700);
            for (const name of ['config.original', 'config.next']) {
                await fs.copyFile(path.join(transaction, name), path.join(folder, name), 1);
                await protect(configFile, path.join(folder, name));
            }
            configNext = path.join(folder, 'config.next'); configOriginal = path.join(folder, 'config.original'); configFailed = path.join(folder, 'config.failed');
        }
        for (const [kind, target] of Object.entries(targets)) {
            await descendants(root, path.dirname(target));
            const latest = await installed(target, kind, root);
            if (latest?.receiptHash !== old[kind]?.receiptHash || !sameMap(latest?.files || {}, old[kind]?.files || {})) fail('停止期间目标文件发生变化，未覆盖。');
            const prior = priorPaths[kind];
            if (old[kind]) await rename(target, prior);
            moved.push({ kind, target, prior, failed: failedPaths[kind], work: codeWork[kind], oldFiles: oldFiles[kind], newFiles: newFiles[kind], hasOld: Boolean(old[kind]), hasNew: false });
            await rename(staged[kind], target);
            moved.at(-1).hasNew = true;
            await onProgress({ phase: kind + '-installed' });
        }
        if (configChanged) {
            if (!(await fs.readFile(configFile)).equals(configBytes)) fail('写入前 ST 配置已变化，未覆盖。');
            await rename(configNext, configFile); configApplied = true;
            await onProgress({ phase: 'config-installed' });
        }
        for (const [kind, target] of Object.entries(targets)) {
            const checked = await installed(target, kind, root);
            if (checked.receipt.commit !== commit || checked.receipt.version !== VERSION || !sameMap(checked.files, maps[kind])) fail('安装后文件校验失败。');
        }
        await cleanupWorkspaces();
        await onProgress({ phase: 'staging-cleaned' });
        await fs.writeFile(path.join(transaction, 'result.json'), JSON.stringify({
            version: VERSION, commit, targets, config: configFile, configChanged, runtimeVerified: false,
            sameDeviceStagingRemoved: workspaces.map(work => work.folder),
        }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        committed = true;
        await pruneInstallBackups(backupRoot);
        if (pm2Stopped) {
            const current = await pm2Target(pm2, root, run);
                if (current.id !== processInfo.id || current.status !== 'stopped' || !samePath(current.configPath, configFile)) fail('PM2 状态发生变化。');
            await run('pm2', ['start', String(processInfo.id)]); pm2Stopped = false;
        }
        return { installed: true, version: VERSION, commit, backup: transaction, targets, runtimeVerified: false,
            restart: processInfo?.status === 'online' ? 'pm2-started-unverified' : 'manual-start-required' };
    } catch (error) {
        if (error.code === 'EXDEV' || error.code === 'EBUSY') error.message = '目标是独立挂载或不能原子置换，未强制覆盖。' + error.message;
        if (!committed) {
            try {
                if (configApplied) {
                    if (!(await fs.readFile(configFile)).equals(nextConfig)) fail('配置已有新的改动，未覆盖回退；请使用备份人工核对。');
                    if (configWorkspace && !await exists(configWorkspace.folder)) await fs.mkdir(configWorkspace.folder, { mode: 0o700 });
                    if (!await exists(configOriginal)) { await fs.copyFile(path.join(transaction, 'config.original'), configOriginal, 1); await protect(configFile, configOriginal); }
                    await rename(configFile, configFailed);
                    await rename(configOriginal, configFile);
                }
                for (const item of [...moved].reverse()) {
                    if (item.work && !await exists(item.work.folder)) await fs.mkdir(item.work.folder, { mode: 0o700 });
                    if (item.hasNew) await rename(item.target, item.failed);
                    if (item.hasOld) {
                        if (item.work && (!await exists(item.prior) || !sameMap(await fileMap(item.prior), item.oldFiles))) {
                            const restore = path.join(item.work.folder, 'restore');
                            await copyFlat(path.join(transaction, 'previous', item.kind), restore, item.oldFiles, true);
                            await rename(restore, item.target);
                        } else await rename(item.prior, item.target);
                    }
                }
                await cleanupWorkspaces();
            } catch (rollback) { rollbackFailed = true; error.message += ' 回退未完整完成：' + rollback.message; }
            if (pm2Stopped) {
                try {
                    const current = await pm2Target(pm2, root, run);
                    if (current.id !== processInfo.id || current.status !== 'stopped' || !samePath(current.configPath, configFile)) fail('PM2 状态已变化。');
                    await run('pm2', ['start', String(processInfo.id)]); pm2Stopped = false;
                } catch { error.message += ' 本次未自动启动 ST。'; }
            }
        }
        if (rollbackFailed) error.message += ' 回退未完成。';
        if (committed) error.message += ' 文件已更新，但运行状态未确认。';
        throw error;
    } finally {
        if (!rollbackFailed) {
            await plain(lock, true);
            const lockOwner = path.join(lock, 'owner');
            if (await fs.readFile(lockOwner, 'utf8') === owner) { await fs.unlink(lockOwner); await fs.rmdir(lock); }
        }
    }
}

export function parseArgs(args) {
    const options = { stRoot: process.cwd() };
    for (let i = 0; i < args.length; i++) {
        const option = args[i];
        if (option === '--stopped') options.stopped = true;
        else if (option === '--help') options.help = true;
        else if (['--st-root', '--config', '--pm2'].includes(option)) {
            const value = args[++i]; if (!value || value.startsWith('--')) fail('参数缺少值：' + option);
            options[{ '--st-root': 'stRoot', '--config': 'config', '--pm2': 'pm2' }[option]] = value;
        } else fail('未知参数：' + option);
    }
    return options;
}

async function main() {
    if (Number(process.versions.node.split('.')[0]) < 18) fail('忆幕安装需要 Node.js 18 或更高版本。');
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log('在 ST 根目录运行。可选：--st-root 路径，--config 正在使用的配置，--pm2 明确服务名；非 PM2 请先停止 ST 并用 --stopped 确认。安装和更新使用同一命令。');
        return;
    }
    if (!options.pm2 && !options.stopped) {
        if (!process.stdin.isTTY) fail('请先停止 ST，并加 --stopped；或用 --pm2 指定明确的服务名。');
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { options.stopped = (await input.question('请先停止 ST 后端（关闭网页不算）。确认已停止后输入 STOPPED：')).trim() === 'STOPPED'; }
        finally { input.close(); }
    }
    const result = await installYimu(options);
    if (process.env.YIMU_INSTALLER_QUIET !== '1') console.log('忆幕已更新至 v' + result.version + '。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error('忆幕更新失败：' + error.message); process.exitCode = 1; });
}
