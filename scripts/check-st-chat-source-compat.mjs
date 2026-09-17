// Execute selected functions from a pinned official reference clone with synthetic state only.
// All fetches and mutations below are in-memory fixtures, never a running ST installation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { captureCurrentChatSource } from '../qianmu-current-chat-source.js';
const repository = process.env.QIANMU_ST_UPSTREAM;
if (!repository) throw Error('Set QIANMU_ST_UPSTREAM to a local official reference clone containing 1.19.0.');
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1048576 });
const commit = git('rev-parse', '1.19.0^{commit}').trim(); assert.equal(commit, '7e8663cd9c184a550b37238218bdd32c6efc68e9');
const read = file => git('show', `1.19.0:${file}`), main = read('public/script.js'), groupsCode = read('public/scripts/group-chats.js');
const emitterCode = read('public/lib/eventemitter.js'), checks = [], check = (name, result) => { assert.ok(result, name); checks.push(name); };
function definition(source, name) {
    const start = source.indexOf(`export async function ${name}(`), end = source.indexOf('\n}', start);
    if (start < 0 || end < 0) throw Error('Missing official function: ' + name); return source.slice(start, end + 2).replace(/^export /, '');
}
function fixture({ ok = true, sanitized = 'Accepted name' } = {}) {
    const events = [], calls = [], warnings = [];
    const host = { characters: [{ avatar: 'A.png', chat: 'Chat A' }, { avatar: 'B.png', chat: 'Other chat' }], groups: [{ id: 'g', chat_id: 'Chat A', chats: ['Chat A','Other'] }], this_chid: 0 };
    const quiet = { debug() {}, trace() {}, warn() {}, error(...args) { warnings.push(args); } };
    const sandbox = vm.createContext({ ...host, console: quiet, localStorage: { getItem: () => null },
        event_types: { CHAT_RENAMED: 'chat_renamed', CHAT_DELETED: 'chat_deleted', GROUP_CHAT_DELETED: 'group_chat_deleted' },
        getCurrentChatId: () => 'Chat A', getRequestHeaders: () => ({}), equalsIgnoreCaseAndAccents: (a,b) => a.toLowerCase() === b.toLowerCase(),
        fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok, json: async () => ({ sanitizedFileName: sanitized }) }; },
        $: () => ({ val() {} }), createOrEditCharacter: async () => {}, reloadCurrentChat: async () => {},
        renameGroupChat: async (groupId, oldName, newName) => { host.groups.find(row => row.id === groupId).chat_id = newName; },
        unshallowCharacter: async () => {}, updateRemoteChatName: async () => {}, editGroup: async () => {},
        t: parts => parts.join(''), toastr: { warning() {}, error() {} }, delay: async () => {}, callGenericPopup: async () => {}, POPUP_TYPE: { TEXT: 1 },
    });
    const bus = vm.runInContext(emitterCode.replace(/^export \{ EventEmitter \};?\s*$/m, '') + '\nnew EventEmitter()', sandbox); sandbox.eventSource = bus;
    for (const name of ['chat_renamed','chat_deleted','group_chat_deleted']) bus.on(name, value => events.push({ name, value }));
    // The borrowed UI context deliberately has not refreshed yet: rely on the real event contract, not mock field changes.
    const context = { characterId: 0, groupId: null, chatId: 'Chat A', characters: [{ avatar: 'A.png', chat: 'Chat A' }], groups: [{ id: 'g', chat_id: 'Chat A' }],
        chat: [], chatMetadata: { integrity: 'host-incarnation', story_director_liminale: { preserve: true } }, eventSource: bus };
    return { context, host, events, calls, bus, warnings, source: () => captureCurrentChatSource({ getContext: () => context, epoch: () => 0 }),
        run(name, ...args) { const code = name === 'deleteGroupChatByName' ? groupsCode : main; return vm.runInContext(definition(code, name) + '\n' + name, sandbox)(...args); } };
}
const contextCode = read('public/scripts/st-context.js');
check('official context exposes current chat, metadata and removable event source', /chatMetadata: chat_metadata/.test(contextCode) && /eventTypes: event_types/.test(contextCode) && /eventSource,/.test(contextCode) && /EventEmitter\.prototype\.removeListener/.test(emitterCode));
{
    const f = fixture(), s = f.source(); let after = 0; f.bus.on('chat_renamed', () => { after++; });
    await f.run('renameGroupOrCharacterChat', { characterId: 0, oldFileName: 'Chat A', newFileName: 'Submitted? name' });
    const event = f.events.find(row => row.name === 'chat_renamed').value;
    check('actual rename event retains the request filename even when server accepted another name', f.host.characters[0].chat === 'Accepted name' && event.newFileName === 'Submitted? name.jsonl');
    check('shared source invalidates without adopting the unverified destination or changing metadata', !s.isCurrent() && s.source.chatKey === 'Chat A' && f.context.chatMetadata.story_director_liminale.preserve);
    check('unsubscribing source guards does not skip later native event listeners', after === 1 && f.bus.events.chat_renamed.length === 2);
}
{
    const f = fixture({ ok: false }), s = f.source();
    await f.run('renameGroupOrCharacterChat', { characterId: 0, oldFileName: 'Chat A', newFileName: 'new' });
    check('failed official rename emits no success notification or invented destination', f.events.length === 0 && s.isCurrent()); s.close();
}
{
    const f = fixture(), s = f.source(), before = JSON.stringify(f.context.chatMetadata);
    await f.run('deleteCharacterChatByName', 1, 'Chat A');
    check('actual inactive-character deletion reports only a filename without owner', f.calls[0].body.avatar_url === 'B.png' && f.events[0].value === 'Chat A' && typeof f.events[0].value === 'string');
    check('ambiguous same-name deletion cancels the borrowed scope without deleting another character data', !s.isCurrent() && JSON.stringify(f.context.chatMetadata) === before);
}
{
    const f = fixture({ ok: false }), s = f.source(); await f.run('deleteCharacterChatByName', 1, 'Chat A');
    check('failed character deletion does not trigger source cleanup or deletion', f.events.length === 0 && s.isCurrent()); s.close();
}
{
    const f = fixture(); f.context.groupId = 'g'; const s = f.source(), before = JSON.stringify(f.context.chatMetadata);
    await f.run('deleteGroupChatByName', 'g', 'Chat A');
    check('actual group deletion also supplies only a chat name and invalidates the matching borrowed source', f.events[0].name === 'group_chat_deleted' && f.events[0].value === 'Chat A' && !s.isCurrent());
    check('group source cancellation does not modify the retained gallery metadata', JSON.stringify(f.context.chatMetadata) === before);
}
{
    const f = fixture({ ok: false }); f.context.groupId = 'g'; const s = f.source(); await f.run('deleteGroupChatByName', 'g', 'Chat A');
    check('a failed group delete cannot be inferred as successful from its optimistic in-memory list change', !f.host.groups[0].chats.includes('Chat A') && f.events.length === 0 && s.isCurrent()); s.close();
}
const bookmarks = read('public/scripts/bookmarks.js');
check('official chat load emits CHAT_LOADED only after getChatResult can render fresh extension views', /await getChatResult\(\);\s*eventSource\.emit\(event_types\.CHAT_LOADED/.test(main));
{
    const f = fixture(), old = f.source(); await f.bus.emit('chat_changed'); const current = f.source(); await f.bus.emit('chat_loaded', { detail: { id: 0 } });
    check('native trailing load notification preserves the fresh scope while leaving the old scope invalid', !old.isCurrent() && current.isCurrent()); current.close();
}
check('official host owns integrity creation for character and group chats', /chat_metadata\.integrity = uuidv4\(\)/.test(main) && /metadata\.integrity = uuidv4\(\)/.test(groupsCode));
check('official branch and checkpoint creation mint a fresh host integrity rather than relying on filename', (bookmarks.match(/const newMetadata = \{ main_chat: [^,]+, integrity: uuidv4\(\) \}/g) || []).length === 2);
console.log(JSON.stringify({ passed: checks.length, checks, officialVersion: '1.19.0', commit, productionDataRead: false, external: 0,
    scope: 'actual tagged event emitter, rename and deletion functions with entirely synthetic host/network state; not production deletion, automatic migration or a global-UUID guarantee' }));
