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
        toast: () => { calls.notice++; }, pushLog: () => { calls.log++; },
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
    assert.equal(f.guards[0].options.onBlock, undefined, 'use the guard default silent observer');
    assert.equal(f.calls.notice, 0); assert.equal(f.calls.log, 0);
    f.context.disposeChatWriteGuard(); assert.equal(f.guards[0].disposed, true); assert.equal(f.context.fetch, f.original);
    f.context.installChatWriteGuard(); assert.equal(f.guards.length, 2);
});

test('disabling does not remove a later third-party fetch wrapper', () => {
    const f = fixture(); f.context.installChatWriteGuard();
    const next = () => 'later wrapper'; f.context.fetch = next;
    f.context.disposeChatWriteGuard(); assert.equal(f.context.fetch, next); assert.equal(f.guards[0].disposed, true);
});

test('historical protection entries stay silent and do not occupy the five visible log slots', () => {
    const history = [
        { id: 'guard', kind: 'chat-protection', get error() { assert.fail('hidden protection details must not be read'); } },
        ...Array.from({ length: 6 }, (_, i) => ({ id: `model-${i}`, kind: 'director' })),
    ];
    const rendered = [], settings = { logHistory: history }, context = vm.createContext({
        settings, LOG_LIMIT: 5, FLOAT_SIZE_MIN: 24, FLOAT_SIZE_MAX: 100, feedbackOpenScope: null,
        uniqueClean: values => values.filter(Boolean), getFloatSize: () => 40,
        htmlEscape: value => String(value ?? ''), renderLogEntry: entry => { rendered.push(entry); return `<p>${entry.id}</p>`; },
        renderQuickWheelSettings: () => '', renderStorageManagementCard: () => '',
    });
    vm.runInContext(storyboardFunctionSource('renderPlugTab'), context);
    const html = context.renderPlugTab();
    assert.deepEqual(rendered, history.slice(1, 6)); assert.equal(settings.logHistory, history);
    assert.equal(history.length, 7); assert.doesNotMatch(html, /chat-protection|model-5/);
    settings.logHistory = [history[0]]; rendered.length = 0;
    assert.match(context.renderPlugTab(), /暂无日志/); assert.deepEqual(rendered, []);
});

test('init, loaded events and cleanup use the actual protection lifecycle', () => {
    const init = storyboardFunctionSource('init'), cleanup = storyboardFunctionSource('cleanupRuntime'), events = storyboardFunctionSource('bindEvents');
    assert.match(init, /installChatWriteGuard\(\)/);
    assert.ok(init.indexOf('initialized = true;') >= 0 && init.indexOf('observeChatWriteBaseline()') > init.indexOf('initialized = true;'), 'baseline observation runs after the guard is enabled');
    assert.match(events, /const rerenderHandler = async \(\) => \{\s*observeChatWriteBaseline\(\)/);
    assert.match(events, /const appReadyHandler = async \(\) => \{\s*observeChatWriteBaseline\(\)/);
    assert.match(cleanup, /initialized = false;\s*disposeChatWriteGuard\(\)/);
});

test('toolbox opens without an active chat and backup scans stay behind the explicit backup action', () => {
    const open = storyboardFunctionSource('openFloorNavigator'), close = storyboardFunctionSource('closeFloorNavigator'), mount = storyboardFunctionSource('mountFloorChatRecovery');
    assert.match(open, /聊天工具包/); assert.match(open, /data-floor-tab="recovery"/);
    assert.match(open, /if \(floorNavigatorView === 'recovery'\) void mountFloorChatRecovery\(root\)/);
    assert.doesNotMatch(open, /if \(!chat\.length\) return/);
    assert.doesNotMatch(mount, /chatRecoveryClient\.(?:load|recover|verify)\(/);
    assert.match(mount, /chatRecoveryNamespace !== namespace/);
    assert.match(mount, /confirmDialog\('聊天备份', htmlEscape\(message\)\)/);
    assert.match(open, /__qianmuOutsideHandler/); assert.match(open, /document\.addEventListener\('pointerdown', outside, true\)/);
    assert.match(close, /document\.removeEventListener\('pointerdown', outside, true\)/);
    // Isolated from ST's document-level drawer dismissal, as the notes panel is.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'click'])
        assert.match(open, new RegExp(`root\\.on${type} = isolateFromHostMenus`));
    assert.match(open, /const isolateFromHostMenus = \(event\) => event\.stopPropagation\(\)/);
    assert.doesNotMatch(storyboardFunctionSource('closeFloorNavigator'), /chatRecoveryClient.*dispose/);
    assert.match(source, /chatRecoveryClient\?\.dispose\(\); chatRecoveryClient = null/);
});
