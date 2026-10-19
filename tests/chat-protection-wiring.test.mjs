import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

function fixture() {
    const original = () => 'native', guards = [], calls = { log: 0, notice: 0, observe: 0 };
    const context = vm.createContext({ fetch: original, location: { origin: 'https://synthetic.invalid' },
        initialized: true, isRuntimeOwner: () => true, ctx: () => ({}), resolveImageAccountNamespace: async () => 'st-user:synthetic',
        toast: () => { calls.notice++; }, pushLog: entry => { calls.log++; assert.equal(entry.status, 'blocked'); assert.equal(entry.kind, 'chat-protection'); assert.ok(entry.error); assert.ok(entry.time); assert.equal(entry.request, undefined); },
        uid: () => 'synthetic-guard',
        createChatWriteGuard: options => {
            const guard = { options, fetch: () => 'guarded', observeCurrent: async () => { calls.observe++; }, disposed: false,
                dispose() { this.disposed = true; } };
            guards.push(guard); return guard;
        },
    });
    vm.runInContext('let chatWriteGuard = null, chatWriteFetchBefore = null;\n' +
        ['installChatWriteGuard', 'observeChatWriteBaseline', 'disposeChatWriteGuard'].map(storyboardFunctionSource).join('\n'), context);
    return { context, original, guards, calls };
}

test('lifecycle owns one fetch wrapper, restores it on disable, and can reinstall', async () => {
    const f = fixture(); f.context.installChatWriteGuard(); f.context.installChatWriteGuard();
    assert.equal(f.guards.length, 1); assert.equal(f.context.fetch, f.guards[0].fetch);
    f.context.observeChatWriteBaseline(); await Promise.resolve(); assert.equal(f.calls.observe, 1);
    f.guards[0].options.onBlock(); assert.equal(f.calls.notice, 1); assert.equal(f.calls.log, 1);
    f.context.disposeChatWriteGuard(); assert.equal(f.guards[0].disposed, true); assert.equal(f.context.fetch, f.original);
    f.context.installChatWriteGuard(); assert.equal(f.guards.length, 2);
});

test('disabling does not remove a later third-party fetch wrapper', () => {
    const f = fixture(); f.context.installChatWriteGuard();
    const next = () => 'later wrapper'; f.context.fetch = next;
    f.context.disposeChatWriteGuard(); assert.equal(f.context.fetch, next); assert.equal(f.guards[0].disposed, true);
});

test('protection log renders the actual reason without pretending to be a model request', () => {
    const context = vm.createContext({ htmlEscape: text => text.replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
    vm.runInContext(storyboardFunctionSource('renderLogDetail'), context);
    const html = context.renderLogDetail({ kind: 'chat-protection', error: '<blocked>' });
    assert.match(html, /&lt;blocked&gt;/); assert.doesNotMatch(html, /发送|返回|暂无/);
    assert.match(source, /blocked: '已拦截'/); assert.match(source, /'chat-protection': '聊天保护'/);
});

test('init, loaded events and cleanup use the actual protection lifecycle', () => {
    const init = storyboardFunctionSource('init'), cleanup = storyboardFunctionSource('cleanupRuntime'), events = storyboardFunctionSource('bindEvents');
    assert.match(init, /installChatWriteGuard\(\)/);
    assert.match(init, /initialized = true;\s*observeChatWriteBaseline\(\)/);
    assert.match(events, /const rerenderHandler = async \(\) => \{\s*observeChatWriteBaseline\(\)/);
    assert.match(events, /const appReadyHandler = async \(\) => \{\s*observeChatWriteBaseline\(\)/);
    assert.match(cleanup, /initialized = false;\s*disposeChatWriteGuard\(\)/);
});

test('toolbox opens without an active chat and backup scans stay behind the explicit recovery action', () => {
    const open = storyboardFunctionSource('openFloorNavigator'), mount = storyboardFunctionSource('mountFloorChatRecovery');
    assert.match(open, /聊天工具包/); assert.match(open, /data-floor-tab="recovery"/);
    assert.match(open, /if \(floorNavigatorView === 'recovery'\) void mountFloorChatRecovery\(root\)/);
    assert.doesNotMatch(open, /if \(!chat\.length\) return/);
    assert.doesNotMatch(mount, /chatRecoveryClient\.(?:load|recover|verify)\(/);
    assert.match(mount, /chatRecoveryNamespace !== namespace/);
    assert.match(mount, /confirmDialog\('找回聊天', htmlEscape\(message\)\)/);
    assert.doesNotMatch(storyboardFunctionSource('closeFloorNavigator'), /chatRecoveryClient.*dispose/);
    assert.match(source, /chatRecoveryClient\?\.dispose\(\); chatRecoveryClient = null/);
});
