import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    createNativeBackupPolicyService,
    patchNativeBackupCountConfig,
    readNativeBackupCountConfig,
    ST_NATIVE_BACKUP_POLICY,
} from '../qianmu-st-backup-policy-service.js';

test('native backup policy reads and patches only backups.common.numberOfBackups', () => {
    const source = 'port: 8000\nbackups:\n  common:\n    numberOfBackups: 50 # keep this comment\n  chat:\n    enabled: true\n';
    assert.deepEqual(readNativeBackupCountConfig(source), { value: 50, configuredValue: 50, source: 'config' });
    const patched = patchNativeBackupCountConfig(source, 120);
    assert.match(patched, /numberOfBackups: 120 # keep this comment/u);
    assert.match(patched, /enabled: true/u);
    assert.equal(readNativeBackupCountConfig(patched).value, 120);
});

test('native backup policy can insert the missing key in an existing backups block', () => {
    const source = 'backups:\n  common:\n    # ST will normally add this key\n';
    const patched = patchNativeBackupCountConfig(source, 75);
    assert.match(patched, /common:\n    # ST will normally add this key\n    numberOfBackups: 75/u);
    assert.equal(readNativeBackupCountConfig(patched).value, 75);
});

test('native backup policy service writes atomically and confirms the new value', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qianmu-st-backup-policy-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const configPath = path.join(root, 'config.yaml');
    await fs.writeFile(configPath, 'backups:\n  common:\n    numberOfBackups: 50\n', 'utf8');
    const service = createNativeBackupPolicyService({ configPath, env: {} });
    const before = await service.read();
    assert.equal(before.ok, true); assert.equal(before.value, 50); assert.equal(before.writable, true);
    const changed = await service.write(120);
    assert.equal(changed.changed, true); assert.equal(changed.value, 120); assert.equal(changed.requiresRestart, true);
    assert.match(await fs.readFile(configPath, 'utf8'), /numberOfBackups: 120/u);
    const unchanged = await service.write(120);
    assert.equal(unchanged.changed, false); assert.equal(unchanged.requiresRestart, false);
    await assert.rejects(service.write(ST_NATIVE_BACKUP_POLICY.min - 1), /须为/iu);
});

test('environment override is reported and cannot be replaced through the config interface', async () => {
    const service = createNativeBackupPolicyService({
        configPath: path.join(os.tmpdir(), 'qianmu-st-backup-policy-does-not-need-to-exist.yaml'),
        env: { [ST_NATIVE_BACKUP_POLICY.envKey]: '88' },
    });
    const current = await service.read();
    assert.equal(current.value, 88); assert.equal(current.source, 'environment'); assert.equal(current.writable, false);
    await assert.rejects(service.write(120), /环境变量控制/u);
});

test('a manually larger ST value remains readable but is not writable through the bounded UI', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qianmu-st-backup-policy-large-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const configPath = path.join(root, 'config.yaml');
    await fs.writeFile(configPath, 'backups:\n  common:\n    numberOfBackups: 600\n', 'utf8');
    const current = await createNativeBackupPolicyService({ configPath, env: {} }).read();
    assert.equal(current.value, 600);
    assert.equal(current.writable, false);
    assert.match(current.message, /超过千幕界面上限 500/u);
});
