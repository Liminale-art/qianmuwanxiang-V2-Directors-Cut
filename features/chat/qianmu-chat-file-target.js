// Shared exact ST file locator. No filesystem, host state, credentials or narrative imports.
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const fail = () => { throw Object.assign(new Error('聊天定位无效，请重新打开目标聊天'), { code: 'chat_file_target' }); };
function basename(value, max = 250) {
    if (typeof value !== 'string' || !value || value !== value.trim() || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) || /[. ]$/.test(value)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || new TextEncoder().encode(value).byteLength > max
        || new TextDecoder().decode(new TextEncoder().encode(value)) !== value) fail();
    return value;
}
export function chatFileTarget(value) {
    if (!object(value) || !['character', 'group'].includes(value.kind)) fail();
    const fields = value.kind === 'character' ? ['kind', 'chatId', 'avatar'] : ['kind', 'chatId'];
    if (Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) fail();
    const target = { kind: value.kind, chatId: basename(value.chatId, 249) };
    if (value.kind === 'character') {
        target.avatar = basename(value.avatar); if (!target.avatar.endsWith('.png')) fail();
        basename(target.avatar.replace('.png', '')); // Match ST's exact folder rule, not a guessed sanitized path.
    }
    return target;
}
