import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installYimu, enableServerPlugins, parseArgs, RECEIPT } from '../scripts/install-yimu.mjs';
import { FRONTEND, BACKEND } from '../scripts/build-yimu.mjs';
import { VERSION } from '../yimu/contract.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const command = (file, args, options = {}) => exec(file, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
const present = async target => { try { await fs.lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const initialConfig = 'port: 8000\nenableServerPlugins: false # keep this\nprivateValue: never-print-this\n';

async function fixture(t) {
    const parent = await fs.realpath(os.tmpdir()), temp = await fs.mkdtemp(path.join(parent, 'yimu-install-test-'));
    t.after(async () => {
        const actual = await fs.realpath(temp);
        assert.equal(path.dirname(actual), parent); assert.match(path.basename(actual), /^yimu-install-test-/);
        await fs.rm(actual, { recursive: true, force: false });
    });
    const root = path.join(temp, 'ST with spaces'), sourceRoot = path.join(temp, 'source');
    await fs.mkdir(root); await fs.mkdir(sourceRoot);
    const write = async (base, file, bytes) => { await fs.mkdir(path.dirname(path.join(base, file)), { recursive: true }); await fs.writeFile(path.join(base, file), bytes); };
    await write(root, 'package.json', '{"name":"sillytavern","version":"1.19.0"}');
    for (const file of ['server.js', 'src/server-startup.js', 'public/scripts/extensions.js']) await write(root, file, '// synthetic ST only\n');
    await write(root, 'start.sh', '#!/bin/sh\nnode "server.js" "$@"\n');
    await write(root, 'config.yaml', initialConfig);
    await write(root, 'data/test-user/.yimu/do-not-touch', 'account-memory');
    await write(root, 'data/test-user/chats/actor/chat.jsonl', 'original-chat');
    await write(root, 'data/test-user/secrets.json', 'original-secret');
    await write(root, 'plugins/Omniscene/keep.js', 'original-qianmu-server');
    await write(root, 'public/scripts/extensions/third-party/qianmu/keep.js', 'original-qianmu-frontend');
    const names = [...new Set([...FRONTEND, ...BACKEND, 'README.md'])];
    for (const name of names) {
        const from = name === 'LICENSE' ? path.join(project, name) : path.join(project, 'yimu', name);
        await write(sourceRoot, name === 'LICENSE' ? name : 'yimu/' + name, await fs.readFile(from));
    }
    for (const file of ['scripts/install-yimu.mjs', 'scripts/build-yimu.mjs', 'install-yimu.sh', 'install-yimu.ps1']) {
        await write(sourceRoot, file, await fs.readFile(path.join(project, file)));
    }
    const git = async (...args) => (await command('git', ['-c', 'core.hooksPath=' + path.join(temp, 'no-hooks'), '-C', sourceRoot, ...args])).stdout.trim();
    await git('init', '--initial-branch=refactor/storyboard-modularization');
    await git('config', 'user.name', 'Yimu Installer Test'); await git('config', 'user.email', 'installer@example.invalid');
    await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.autocrlf', 'false');
    await git('add', '.'); await git('commit', '-m', 'isolated fixture');
    const commit = await git('rev-parse', 'HEAD');
    const build = async output => {
        await fs.mkdir(output);
        const stamp = { version: VERSION, files: {} };
        for (const [kind, files] of [['frontend', FRONTEND], ['server', BACKEND]]) {
            const folder = path.join(output, kind, 'yimu'); await fs.mkdir(folder, { recursive: true });
            for (const file of files) {
                const bytes = await fs.readFile(path.join(sourceRoot, file === 'LICENSE' ? file : 'yimu/' + file));
                await fs.writeFile(path.join(folder, file), bytes);
                stamp.files[kind + '/yimu/' + file] = sha(bytes);
            }
        }
        await fs.writeFile(path.join(output, 'build.json'), JSON.stringify(stamp));
        return stamp;
    };
    const options = { stRoot: root, sourceRoot, stopped: true };
    const dependencies = { build, protect: async () => {} };
    const frontend = path.join(root, 'public/scripts/extensions/third-party/yimu'), server = path.join(root, 'plugins/yimu');
    const verifyUntouched = async () => {
        for (const [file, value] of [
            ['data/test-user/.yimu/do-not-touch', 'account-memory'], ['data/test-user/chats/actor/chat.jsonl', 'original-chat'],
            ['data/test-user/secrets.json', 'original-secret'], ['plugins/Omniscene/keep.js', 'original-qianmu-server'],
            ['public/scripts/extensions/third-party/qianmu/keep.js', 'original-qianmu-frontend'],
            ['server.js', '// synthetic ST only\n'], ['public/scripts/extensions.js', '// synthetic ST only\n'],
        ]) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), value);
    };
    return { root, sourceRoot, temp, options, dependencies, frontend, server, git, commit, build, write, verifyUntouched };
}

function pm2(f, overrides = {}) {
    const calls = [], state = { id: 42, name: 'chosen-st', status: 'online', cwd: f.root,
        executable: path.join(f.root, 'start.sh'), args: [], ...overrides };
    const run = async (file, args, options) => {
        if (file !== 'pm2') return command(file, args, options);
        calls.push([...args]);
        if (args[0] === 'jlist') return { stdout: JSON.stringify([{ name: state.name, pm_id: state.id, pm2_env: {
            pm_cwd: state.cwd, pm_exec_path: state.executable, status: state.status, args: state.args, ...state.env,
        } }, ...(state.extra || [])]) };
        assert.equal(args[1], String(state.id));
        if (args[0] === 'stop') { if (state.failStop) throw Error('synthetic stop failure'); state.status = 'stopped'; }
        if (args[0] === 'start') { if (state.failStart) throw Error('synthetic start failure'); state.status = 'online'; }
        return { stdout: '' };
    };
    return { calls, state, run };
}

test('fresh paired install checks exact commit/version/hashes and never touches account data, ST core or Qianmu', async t => {
    const f = await fixture(t);
    const result = await installYimu(f.options, f.dependencies);
    assert.equal(result.version, VERSION); assert.equal(result.commit, f.commit); assert.equal(result.runtimeVerified, false);
    assert.equal(result.restart, 'manual-start-required');
    for (const [kind, folder] of [['frontend', f.frontend], ['server', f.server]]) {
        const receipt = JSON.parse(await fs.readFile(path.join(folder, RECEIPT), 'utf8'));
        assert.equal(receipt.commit, f.commit); assert.equal(receipt.version, VERSION); assert.equal(receipt.kind, kind);
        for (const [file, hash] of Object.entries(receipt.files)) assert.equal(sha(await fs.readFile(path.join(folder, file))), hash);
    }
    assert.equal(await fs.readFile(path.join(f.root, 'config.yaml'), 'utf8'), initialConfig.replace('false', 'true'));
    assert.equal(await fs.readFile(path.join(result.backup, 'config.original'), 'utf8'), initialConfig);
    assert.equal(await present(path.join(f.root, '.yimu-installer.lock')), false);
    await f.verifyUntouched();
});

test('same command updates both sides and retains the exact prior installation as a recoverable directory', async t => {
    const f = await fixture(t); await installYimu(f.options, f.dependencies);
    const prior = await fs.readFile(path.join(f.frontend, 'index.mjs'));
    await fs.appendFile(path.join(f.sourceRoot, 'yimu/index.mjs'), '\n// next synthetic commit\n');
    await f.git('add', '.'); await f.git('commit', '-m', 'synthetic update');
    const result = await installYimu(f.options, f.dependencies);
    assert.notEqual(result.commit, f.commit);
    assert.deepEqual(await fs.readFile(path.join(result.backup, 'previous/frontend/index.mjs')), prior);
    assert.equal(JSON.parse(await fs.readFile(path.join(result.backup, 'previous/server', RECEIPT), 'utf8')).commit, f.commit);
    assert.match(await fs.readFile(path.join(f.frontend, 'index.mjs'), 'utf8'), /next synthetic commit/);
    await f.verifyUntouched();
});

test('unmanaged targets and unknown local modifications are preserved rather than adopted or overwritten', async t => {
    for (const mutation of ['unmanaged', 'modified', 'extra-file', 'extra-directory']) {
        const f = await fixture(t);
        if (mutation !== 'unmanaged') await installYimu(f.options, f.dependencies);
        else await fs.mkdir(f.frontend, { recursive: true });
        if (mutation === 'modified') await fs.appendFile(path.join(f.frontend, 'index.mjs'), '\nlocal-edit');
        else if (mutation === 'extra-directory') await fs.mkdir(path.join(f.server, 'user-folder'));
        else await fs.writeFile(path.join(f.frontend, 'personal.txt'), 'keep');
        await assert.rejects(installYimu(f.options, f.dependencies), /未覆盖|本地修改|额外子目录/);
        if (mutation === 'modified') assert.match(await fs.readFile(path.join(f.frontend, 'index.mjs'), 'utf8'), /local-edit/);
        else if (mutation === 'extra-directory') assert.equal(await present(path.join(f.server, 'user-folder')), true);
        else assert.equal(await fs.readFile(path.join(f.frontend, 'personal.txt'), 'utf8'), 'keep');
        await f.verifyUntouched();
    }
});

test('partial or mismatched managed installations are not silently merged', async t => {
    const f = await fixture(t); await installYimu(f.options, f.dependencies);
    await fs.rename(f.server, path.join(f.root, 'server-kept-outside-loader'));
    await assert.rejects(installYimu(f.options, f.dependencies), /不完整/);
    assert.equal(await present(path.join(f.root, 'server-kept-outside-loader')), true);
    await fs.rename(path.join(f.root, 'server-kept-outside-loader'), f.server);
    const record = JSON.parse(await fs.readFile(path.join(f.frontend, RECEIPT), 'utf8'));
    record.version = 'unverified';
    await fs.writeFile(path.join(f.frontend, RECEIPT), JSON.stringify(record));
    await assert.rejects(installYimu(f.options, f.dependencies), /实际版本与安装记录不符/);
});

test('dirty source, forged build hashes and mismatched actual package versions fail before installation', async t => {
    for (const mode of ['dirty', 'tamper', 'version']) {
        const f = await fixture(t);
        if (mode === 'dirty') await fs.appendFile(path.join(f.sourceRoot, 'yimu/index.mjs'), '\nnot-committed');
        const build = async output => {
            const stamp = await f.build(output);
            const file = mode === 'version' ? 'server/yimu/package.json' : 'frontend/yimu/index.mjs';
            if (mode === 'version') await fs.writeFile(path.join(output, file), '{"name":"yimu","version":"999.0.0","main":"server-plugin.mjs"}');
            if (mode === 'tamper') await fs.appendFile(path.join(output, file), '\nnot-from-commit');
            if (mode !== 'dirty') stamp.files[file] = sha(await fs.readFile(path.join(output, file)));
            return stamp;
        };
        await assert.rejects(installYimu(f.options, { ...f.dependencies, build }), /未提交|同一源码提交|版本/);
        assert.equal(await present(f.frontend), false); assert.equal(await present(f.server), false);
        assert.equal(await fs.readFile(path.join(f.root, 'config.yaml'), 'utf8'), initialConfig);
    }
});

test('a mid-install failure restores both previous targets and the configuration without deleting failed evidence', async t => {
    for (const existing of [false, true]) {
        const f = await fixture(t);
        if (existing) await installYimu(f.options, f.dependencies);
        const before = await fs.readFile(path.join(f.root, 'config.yaml'));
        const oldReceipt = existing ? await fs.readFile(path.join(f.frontend, RECEIPT)) : null;
        await assert.rejects(installYimu({ ...f.options, onProgress(event) {
            if (event.phase === 'frontend-installed') throw Error('synthetic file failure');
        } }, f.dependencies), /synthetic file failure.*保留目录/);
        assert.deepEqual(await fs.readFile(path.join(f.root, 'config.yaml')), before);
        if (existing) assert.deepEqual(await fs.readFile(path.join(f.frontend, RECEIPT)), oldReceipt);
        else { assert.equal(await present(f.frontend), false); assert.equal(await present(f.server), false); }
        await f.verifyUntouched();
    }
});

test('concurrent configuration and target modifications are not overwritten during admission', async t => {
    for (const targetChanged of [false, true]) {
        const f = await fixture(t); if (targetChanged) await installYimu(f.options, f.dependencies);
        let changed;
        const result = installYimu({ ...f.options, onProgress(event) {
            if (event.phase === 'beforeCommit') {
                // Start the mutation before the installer's following filesystem awaits.
                changed = fs.appendFile(targetChanged ? path.join(f.frontend, 'index.mjs') : path.join(f.root, 'config.yaml'), '\nuser-concurrent-change');
                return changed;
            }
        } }, f.dependencies);
        await assert.rejects(result, /变化|本地修改/); await changed;
        assert.match(await fs.readFile(targetChanged ? path.join(f.frontend, 'index.mjs') : path.join(f.root, 'config.yaml'), 'utf8'), /user-concurrent-change/);
    }
});

test('linked plugin parents cannot redirect writes to an account or another deployment', async t => {
    const f = await fixture(t), outside = path.join(f.temp, 'not-the-ST-plugin-directory');
    await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep'), 'untouched');
    await fs.rename(path.join(f.root, 'plugins'), path.join(f.root, 'original-plugins'));
    await fs.symlink(outside, path.join(f.root, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installYimu(f.options, f.dependencies), /链接/);
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'untouched');
    assert.equal(await present(path.join(outside, 'yimu')), false);
});

test('ST root, traversal, ambiguous configuration, links and stale locks are rejected without broad writes', async t => {
    const f = await fixture(t);
    await assert.rejects(installYimu({ ...f.options, stRoot: f.temp }, f.dependencies));
    await assert.rejects(installYimu({ ...f.options, config: '../outside.yaml' }, f.dependencies), /根目录内/);
    await f.write(f.root, 'config/config.yaml', initialConfig);
    await assert.rejects(installYimu(f.options, f.dependencies), /唯一确认/);
    await fs.mkdir(path.join(f.root, '.yimu-installer.lock'));
    await assert.rejects(installYimu({ ...f.options, config: 'config.yaml' }, f.dependencies), /安装锁/);
    await f.verifyUntouched();
});

test('PM2 stop/start is bound to the selected unique service id, actual cwd and startup config', async t => {
    const f = await fixture(t); await f.write(f.root, 'config/active.yaml', initialConfig);
    const process = pm2(f, { args: ['--configPath', 'config/active.yaml'] });
    const result = await installYimu({ ...f.options, stopped: false, pm2: 'chosen-st' }, { ...f.dependencies, run: process.run });
    assert.deepEqual(process.calls.filter(args => args[0] !== 'jlist'), [['stop', '42'], ['start', '42']]);
    assert.equal(await fs.readFile(path.join(f.root, 'config.yaml'), 'utf8'), initialConfig);
    assert.equal(await fs.readFile(path.join(f.root, 'config/active.yaml'), 'utf8'), initialConfig.replace('false', 'true'));
    assert.equal(result.restart, 'pm2-started-unverified'); assert.equal(result.runtimeVerified, false);
    await f.verifyUntouched();
});

test('wrong PM2 root, conflicting config, global mode, env override and custom wrapper never stop any process', async t => {
    for (const mode of ['cwd', 'config', 'global', 'override', 'wrapper', 'wrapper-cd', 'wrapper-env', 'string-args', 'duplicate']) {
        const f = await fixture(t);
        const process = pm2(f);
        if (mode === 'cwd') process.state.cwd = f.temp;
        if (mode === 'config') { process.state.args = ['--configPath=config/active.yaml']; await f.write(f.root, 'config/active.yaml', initialConfig); }
        if (mode === 'global') process.state.args = ['--global'];
        if (mode === 'override') process.state.env = { SILLYTAVERN_ENABLESERVERPLUGINS: 'false' };
        if (mode === 'wrapper') await fs.writeFile(path.join(f.root, 'start.sh'), 'node server.js --configPath other.yaml\n');
        if (mode === 'wrapper-cd') await fs.writeFile(path.join(f.root, 'start.sh'), 'cd /elsewhere\nnode "server.js" "$@"\n');
        if (mode === 'wrapper-env') await fs.writeFile(path.join(f.root, 'start.sh'), 'export SILLYTAVERN_ENABLESERVERPLUGINS=false\nnode "server.js" "$@"\n');
        if (mode === 'string-args') process.state.args = '--configPath maybe quoted.yaml';
        if (mode === 'duplicate') process.state.extra = [{ name: 'chosen-st', pm_id: 99 }];
        await assert.rejects(installYimu({ ...f.options, stopped: false, pm2: 'chosen-st', ...(mode === 'config' ? { config: 'config.yaml' } : {}) },
            { ...f.dependencies, run: process.run }));
        assert.deepEqual(process.calls.filter(args => args[0] !== 'jlist'), []);
        assert.equal(await present(f.frontend), false); await f.verifyUntouched();
    }
});

test('PM2 restart failure does not falsely report success or downgrade files after a possible new runtime start', async t => {
    const f = await fixture(t), process = pm2(f, { failStart: true });
    await assert.rejects(installYimu({ ...f.options, stopped: false, pm2: 'chosen-st' }, { ...f.dependencies, run: process.run }), /文件已核验安装.*运行状态尚未确认/);
    assert.equal(await present(path.join(f.frontend, RECEIPT)), true);
    assert.equal(await present(path.join(f.server, RECEIPT)), true);
    assert.deepEqual(process.calls.filter(args => args[0] !== 'jlist'), [['stop', '42'], ['start', '42']]);
});

test('failed paired update restores old code before restarting only its explicitly selected PM2 service', async t => {
    const f = await fixture(t); await installYimu(f.options, f.dependencies);
    const process = pm2(f), receipt = await fs.readFile(path.join(f.server, RECEIPT));
    await assert.rejects(installYimu({ ...f.options, stopped: false, pm2: 'chosen-st', onProgress(event) {
        if (event.phase === 'server-installed') throw Error('synthetic commit failure');
    } }, { ...f.dependencies, run: process.run }), /synthetic commit failure/);
    assert.deepEqual(await fs.readFile(path.join(f.server, RECEIPT)), receipt);
    assert.deepEqual(process.calls.filter(args => args[0] !== 'jlist'), [['stop', '42'], ['start', '42']]);
});

test('configuration editing preserves BOM, newline, comments and rejects unsafe YAML forms', () => {
    const bom = Buffer.from('\uFEFFenableServerPlugins: false # note\r\nother: preserved\r\n');
    assert.equal(enableServerPlugins(bom).toString(), bom.toString().replace('false', 'true'));
    assert.equal(enableServerPlugins(Buffer.from('other: preserved\n')).toString(), 'other: preserved\nenableServerPlugins: true\n');
    for (const text of ['enableServerPlugins: false\nenableServerPlugins: true\n', 'enableServerPlugins: "false"\n',
        '---\nport: 1\n---\nenableServerPlugins: true\n', '<<: *defaults\n', '{enableServerPlugins: false}\n',
        '  port: 8000\n  enableServerPlugins: false\n', '  port: 8000\n', 'parent:\n  enableServerPlugins: false\n']) {
        assert.throws(() => enableServerPlugins(Buffer.from(text)));
    }
    assert.throws(() => enableServerPlugins(Buffer.from([0xff, 0xfe])));
    assert.deepEqual(parseArgs(['--st-root', '/st', '--pm2', 'chosen', '--config', 'config.yaml']), { stRoot: '/st', pm2: 'chosen', config: 'config.yaml' });
    assert.throws(() => parseArgs(['--pm2'])); assert.throws(() => parseArgs(['--unknown']));
});

test('production configuration permission-copy path runs only on the isolated fixture', async t => {
    const f = await fixture(t);
    const result = await installYimu(f.options, { build: f.build });
    assert.equal(result.installed, true); await f.verifyUntouched();
});

for (const engine of process.platform === 'win32' ? ['shell', 'powershell'] : ['shell']) {
    test(engine + ' one-command bootstrap installs from a local synthetic delivery branch and forwards arguments', async t => {
        const f = await fixture(t);
        const empty = path.join(f.temp, 'empty-git-config'); await fs.writeFile(empty, '');
        const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'url.' + pathToFileURL(f.sourceRoot).href + '.insteadOf',
            GIT_CONFIG_VALUE_0: 'https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git',
            GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' };
        const binary = engine === 'shell' ? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh')
            : path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const args = engine === 'shell' ? [path.join(project, 'install-yimu.sh'), '--stopped', '--st-root', f.root]
            : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'install-yimu.ps1'), '--stopped', '--st-root', f.root];
        const result = await command(binary, args, { cwd: f.root, env });
        assert.equal(JSON.parse(await fs.readFile(path.join(f.frontend, RECEIPT), 'utf8')).commit, f.commit);
        assert.equal(result.stdout.includes('never-print-this'), false);
        await f.verifyUntouched();
    });
}

if (process.platform === 'win32') test('PowerShell pasted script-block returns to its caller on success and throws rather than exits on failure', async t => {
    for (const succeeds of [true, false]) {
        const f = await fixture(t), empty = path.join(f.temp, 'empty-git-config'); await fs.writeFile(empty, '');
        const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'url.' + pathToFileURL(f.sourceRoot).href + '.insteadOf',
            GIT_CONFIG_VALUE_0: 'https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git',
            GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' };
        const quote = value => "'" + value.replaceAll("'", "''") + "'";
        const code = '$script=[scriptblock]::Create([IO.File]::ReadAllText(' + quote(path.join(project, 'install-yimu.ps1')) + ')); '
            + 'try { & $script --stopped --st-root ' + quote(succeeds ? f.root : f.temp) + '; [Console]::WriteLine("INSTALL_RETURNED"); } '
            + 'catch { [Console]::WriteLine("INSTALL_THROWN"); }; [Console]::WriteLine("PARENT_SHELL_ALIVE")';
        const result = await command(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
            { cwd: f.root, env });
        assert.match(result.stdout, /PARENT_SHELL_ALIVE/);
        assert.match(result.stdout, succeeds ? /INSTALL_RETURNED/ : /INSTALL_THROWN/);
        assert.equal(await present(path.join(f.frontend, RECEIPT)), succeeds);
        await f.verifyUntouched();
    }
});

if (process.platform === 'win32') test('Windows npm PM2 cmd shim uses only the selected synthetic id, never a real process', async t => {
    const f = await fixture(t);
    const stateFile = path.join(f.root, 'synthetic-pm2-state.json');
    await fs.writeFile(stateFile, JSON.stringify({ status: 'online', actions: [] }));
    await fs.writeFile(path.join(f.root, 'pm2.cmd'), '@echo off\r\nnode "%~dp0synthetic-pm2.mjs" %*\r\n');
    await fs.writeFile(path.join(f.root, 'synthetic-pm2.mjs'),
        "import fs from 'node:fs'; const file=" + JSON.stringify(stateFile) + ";const state=JSON.parse(fs.readFileSync(file));"
        + "const action=process.argv[2]; state.actions.push(process.argv.slice(2));"
        + "if(action==='stop')state.status='stopped';if(action==='start')state.status='online';"
        + "if(action==='jlist')console.log(JSON.stringify([{name:'chosen-st',pm_id:42,pm2_env:{pm_cwd:"
        + JSON.stringify(f.root) + ",pm_exec_path:" + JSON.stringify(path.join(f.root, 'server.js'))
        + ",status:state.status,args:[]}}]));fs.writeFileSync(file,JSON.stringify(state));");
    await command(process.execPath, [path.join(f.sourceRoot, 'scripts/install-yimu.mjs'), '--st-root', f.root, '--pm2', 'chosen-st'], { cwd: f.root });
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.deepEqual(state.actions.filter(args => args[0] !== 'jlist'), [['stop', '42'], ['start', '42']]);
    assert.equal(state.status, 'online'); await f.verifyUntouched();
});

function mountedParents(f) {
    const parents = [path.dirname(f.frontend), path.dirname(f.server), path.join(f.root, 'config')];
    const device = target => {
        const resolved = path.resolve(target);
        const index = parents.findIndex(parent => resolved === parent || resolved.startsWith(parent + path.sep));
        return index === -1 ? 1 : index + 2;
    };
    const renames = [];
    return {
        parents, renames,
        stat: async target => ({ ...await fs.stat(target), dev: device(target) }),
        rename: async (from, to) => {
            renames.push([from, to]);
            if (device(from) !== device(to)) throw Object.assign(new Error('synthetic EXDEV'), { code: 'EXDEV' });
            await fs.rename(from, to);
        },
        clean: async () => {
            for (const parent of parents) if (await present(parent)) {
                assert.deepEqual((await fs.readdir(parent)).filter(name => name.startsWith('.yimu-install-')), []);
            }
        },
    };
}

test('distinct parent mounts use local atomic moves, retain hash-verified root backups and remove scanner-visible staging', async t => {
    const f = await fixture(t), mounts = mountedParents(f);
    await f.write(f.root, 'config/active.yaml', initialConfig);
    const options = { ...f.options, config: 'config/active.yaml' }, dependencies = { ...f.dependencies, stat: mounts.stat, rename: mounts.rename };
    const first = await installYimu(options, dependencies); await mounts.clean();
    assert.equal(first.installed, true);
    const before = await fs.readFile(path.join(f.server, RECEIPT));
    const second = await installYimu(options, dependencies); await mounts.clean();
    assert.deepEqual(await fs.readFile(path.join(second.backup, 'previous/server', RECEIPT)), before);
    assert.equal(await fs.readFile(path.join(first.backup, 'config.original'), 'utf8'), initialConfig);
    assert.ok(mounts.renames.some(([from]) => from.includes('.yimu-install-')));
    await f.verifyUntouched();
});

test('cross-mount rollback after configuration commit and after completed cleanup restores both code and config before PM2 starts', async t => {
    for (const failurePhase of ['config-installed', 'staging-cleaned']) {
        const f = await fixture(t), mounts = mountedParents(f);
        await f.write(f.root, 'config/active.yaml', initialConfig);
        const dependencies = { ...f.dependencies, stat: mounts.stat, rename: mounts.rename };
        await installYimu({ ...f.options, config: 'config/active.yaml' }, dependencies);
        const previous = await fs.readFile(path.join(f.frontend, RECEIPT));
        await fs.writeFile(path.join(f.root, 'config/active.yaml'), initialConfig);
        const process = pm2(f, { args: ['--configPath=config/active.yaml'] });
        const run = async (file, args, options) => {
            if (file === 'pm2' && args[0] === 'start') await mounts.clean();
            return process.run(file, args, options);
        };
        await assert.rejects(installYimu({ ...f.options, stopped: false, pm2: 'chosen-st', onProgress(event) {
            if (event.phase === failurePhase) throw Error('synthetic post-commit failure');
        } }, { ...dependencies, run }), /synthetic post-commit failure/);
        assert.deepEqual(await fs.readFile(path.join(f.frontend, RECEIPT)), previous);
        assert.equal(await fs.readFile(path.join(f.root, 'config/active.yaml'), 'utf8'), initialConfig);
        await mounts.clean(); assert.equal(process.state.status, 'online'); await f.verifyUntouched();
    }
});

test('unknown local staging content preserves the maintenance lock and leaves PM2 stopped instead of exposing it to the loader', async t => {
    const f = await fixture(t), mounts = mountedParents(f), process = pm2(f);
    let note;
    await assert.rejects(installYimu({ ...f.options, stopped: false, pm2: 'chosen-st', async onProgress(event) {
        if (event.phase === 'server-installed') {
            const parent = path.dirname(f.server);
            const folder = (await fs.readdir(parent)).find(name => name.startsWith('.yimu-install-'));
            note = path.join(parent, folder, 'unknown-user-note'); await fs.writeFile(note, 'preserve');
        }
    } }, { ...f.dependencies, stat: mounts.stat, rename: mounts.rename, run: process.run }), /回退未完整完成.*停服暂存/);
    assert.equal(await fs.readFile(note, 'utf8'), 'preserve');
    assert.equal(await present(path.join(f.root, '.yimu-installer.lock')), true);
    assert.equal(process.state.status, 'stopped');
    assert.equal(process.calls.some(args => args[0] === 'start'), false);
    await f.verifyUntouched();
});

test('mounted target directories and individual config files are refused before replacement', async t => {
    for (const what of ['target', 'config']) {
        const f = await fixture(t);
        if (what === 'target') await installYimu(f.options, f.dependencies);
        const selected = what === 'target' ? f.server : path.join(f.root, 'config.yaml');
        const stat = async target => ({ ...await fs.stat(target), dev: path.resolve(target) === selected ? 99 : 1 });
        const before = await fs.readFile(path.join(f.root, 'config.yaml'));
        await assert.rejects(installYimu(f.options, { ...f.dependencies, stat }), /独立挂载/);
        assert.deepEqual(await fs.readFile(path.join(f.root, 'config.yaml')), before); await f.verifyUntouched();
    }
});

test('an unexpected atomic-move EXDEV never triggers a destructive copy-over fallback', async t => {
    const f = await fixture(t); await installYimu(f.options, f.dependencies);
    const before = await fs.readFile(path.join(f.frontend, RECEIPT)); let failed = false;
    const rename = async (from, to) => {
        if (!failed && from === f.server) { failed = true; throw Object.assign(new Error('simulated mount boundary'), { code: 'EXDEV' }); }
        await fs.rename(from, to);
    };
    await assert.rejects(installYimu(f.options, { ...f.dependencies, rename }), /独立挂载或不能原子置换/);
    assert.deepEqual(await fs.readFile(path.join(f.frontend, RECEIPT)), before);
    assert.equal(await present(path.join(f.server, RECEIPT)), true); await f.verifyUntouched();
});

test('POSIX restrictive umask leaves new runtime code public-readable and config ownership unchanged', { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t), config = path.join(f.root, 'config.yaml');
    await fs.rename(path.dirname(f.frontend), path.join(f.temp, 'preserved-third-party'));
    await fs.rename(path.dirname(f.server), path.join(f.temp, 'preserved-plugins'));
    await fs.chmod(config, 0o640);
    if (process.getuid() === 0) await fs.chown(config, 12345, 12345);
    const before = await fs.stat(config), oldMask = process.umask(0o077);
    let result;
    try { result = await installYimu(f.options, { build: f.build }); } finally { process.umask(oldMask); }
    for (const folder of [f.frontend, f.server]) {
        assert.equal((await fs.stat(path.dirname(folder))).mode & 0o777, 0o755);
        assert.equal((await fs.stat(folder)).mode & 0o777, 0o755);
        assert.equal((await fs.stat(path.join(folder, 'contract.mjs'))).mode & 0o777, 0o644);
        assert.equal((await fs.stat(path.join(folder, RECEIPT))).mode & 0o777, 0o600);
    }
    assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o700);
    const after = await fs.stat(config);
    assert.deepEqual([after.uid, after.gid, after.mode & 0o777], [before.uid, before.gid, before.mode & 0o777]);
});
