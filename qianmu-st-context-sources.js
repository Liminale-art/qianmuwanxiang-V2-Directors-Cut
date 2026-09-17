import { isNoisePresetName, normalizePresetEntries, parseAnyString, parseNameSource, uniqueClean } from './qianmu-storyboard-utils.js';

// Read-only ST extension APIs. Never expose module-private state on window or patch host files.
// CC prompt material deliberately uses the openai manager, not a text-completion sampling preset.
const attempt = (read, fallback) => { try { return read(); } catch (_) { return fallback; } };
const manager = context => attempt(() => context.getPresetManager?.('openai'), null);
const presetNames = names => uniqueClean(names).filter(name => !isNoisePresetName(name));
const copyPrompts = value => structuredClone(normalizePresetEntries(value));
const copyWorld = (value, name) => structuredClone(Array.isArray(value) ? value : Object.values(value?.entries || value?.[name]?.entries || {}));
const namesOnly = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()))];
const headers = (context, globals) => context.getRequestHeaders?.() || { 'Content-Type': 'application/json', 'X-CSRF-Token': globals.document?.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || globals.token || '' };

export function stCurrentPresetName(context, globals = globalThis) {
    const chat = context.chatCompletionSettings || {};
    const names = [attempt(() => manager(context)?.getSelectedPresetName(), ''), chat.preset_settings_openai, chat.preset_settings, chat.name, chat.preset, chat.presetName, chat.preset_name];
    if (typeof context.getPresetManager !== 'function') names.push(globals.power_user?.preset_settings, globals.oai_settings?.preset_settings_openai,
        globals.oai_settings?.preset_settings, globals.textgenerationwebui_settings?.preset, globals.novelai_settings?.preset, context.preset_settings, context.settings?.preset_settings);
    return presetNames(names.flatMap(parseAnyString))[0] || '';
}

export function stCurrentPresetEntries(context) {
    return Array.isArray(context.chatCompletionSettings?.prompts) ? copyPrompts(context.chatCompletionSettings.prompts) : [];
}

export function stPresetNames(context, globals = globalThis) {
    const current = stCurrentPresetName(context, globals);
    if (typeof context.getPresetManager === 'function') {
        const names = attempt(() => manager(context)?.getAllPresets(), []);
        return presetNames([current, ...namesOnly(names)]);
    }
    const sources = [globals.preset_names, globals.presetNames, globals.oai_settings?.presets, globals.oai_settings?.preset_names,
        globals.textgenerationwebui_presets, globals.novelai_presets, globals.power_user?.presets, context.preset_names, context.presetNames, context.presets,
        attempt(() => globals.TavernHelper?.getPresetNames?.(), [])];
    return presetNames([current, ...sources.flatMap(parseNameSource)]);
}

export function stPresetEntries(context, name, globals = globalThis) {
    if (!name) return [];
    if (name === stCurrentPresetName(context, globals) && Array.isArray(context.chatCompletionSettings?.prompts)) return stCurrentPresetEntries(context);
    if (typeof context.getPresetManager === 'function') {
        const preset = attempt(() => manager(context)?.getCompletionPresetByName?.(name), null);
        // Missing/empty official data is authoritative; do not resurrect an old helper/global snapshot.
        return preset ? copyPrompts(preset.prompts || []) : [];
    }
    const helper = attempt(() => globals.TavernHelper?.getPreset?.(name), null);
    if (helper?.prompts || Array.isArray(helper)) return copyPrompts(helper.prompts || helper);
    for (const pool of [globals.presets, globals.oai_settings?.presets, globals.power_user?.presets, context.presets]) {
        const preset = (pool && Object.hasOwn(pool, name) ? pool[name] : null) || (Array.isArray(pool) ? pool.find(row => row?.name === name) : null);
        if (preset?.prompts || Array.isArray(preset)) return copyPrompts(preset.prompts || preset);
    }
    return [];
}

export async function stWorldBookEntries(context, name, globals = globalThis) {
    if (!name) return [];
    if (typeof context.loadWorldInfo === 'function') {
        try { return copyWorld(await context.loadWorldInfo(name), name); }
        catch (_) { globals.console?.warn('[千幕] ST 世界书读取未完成，请重新刷新取材。'); return []; }
    }
    for (const read of [() => globals.TavernHelper?.getWorldbook?.(name), () => globals.getWorldbook?.(name)]) {
        try { const value = await read(); if (value) return copyWorld(value, name); } catch (_) { /* Older optional helpers may be unavailable. */ }
    }
    try {
        const response = await globals.fetch('/api/worldinfo/get', { method: 'POST', headers: headers(context, globals), body: JSON.stringify({ name }) });
        if (response.ok) return copyWorld(await response.json(), name);
    } catch (_) { globals.console?.warn('[千幕] 世界书读取未完成，请重新刷新取材。'); }
    return [];
}

export async function stWorldBookNames(context, globals = globalThis) {
    if (typeof context.getWorldInfoNames === 'function') {
        try { return namesOnly(await context.getWorldInfoNames()); }
        catch (_) { globals.console?.warn('[千幕] ST 世界书目录读取未完成，请重新刷新取材。'); return []; }
    }
    // Older hosts: this official endpoint is POST, and its file_id (not display name) opens the file.
    try {
        const response = await globals.fetch('/api/worldinfo/list', { method: 'POST', headers: headers(context, globals), body: '{}' });
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data)) return namesOnly(data.map(row => typeof row === 'string' ? row : row && Object.hasOwn(row, 'file_id') ? row.file_id : row?.name));
            if (Array.isArray(data?.world_names || data?.worldNames)) return namesOnly(data.world_names || data.worldNames);
        }
    } catch (_) { /* No settings dump or global promotion is used to recover a missing directory API. */ }
    let helper = [];
    try { helper = parseAnyString(await globals.TavernHelper?.getWorldbookNames?.()); } catch (_) {}
    return namesOnly([...helper, ...parseAnyString(globals.world_names), ...parseAnyString(globals.world_info_names)]);
}
