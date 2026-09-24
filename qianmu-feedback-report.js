// Public feedback is a separate, deliberately small contract. Never pass logs,
// chat, settings, request bodies or workflow JSON through a generic redactor.
export const FEEDBACK_CONTACT = Object.freeze({ address: '', identityVerified: false });
export const FEEDBACK_TEXT_LIMIT = 6000;
export const FEEDBACK_MODULES = Object.freeze(['其他', '分镜', '推演', '配音', '伴读', '场外特助', '正文收藏', '便笺', '小组件', '设置与数据']);

const systems = ['Windows', 'macOS', 'iOS', 'Android', 'Linux'];
const browsers = ['Edge', 'Firefox', 'Chrome', 'Safari'];
const statuses = Object.freeze({ idle: '尚未检测', checking: '检测中', ready: '可用', missing: '未安装', unsupported: '不支持', error: '暂不可达' });
// Only own data properties are eligible, including on the explicitly named keys.
// Accessor values and unknown objects are not read, coerced or traversed.
function own(source, key) {
    if (!source || typeof source !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function version(value) {
    return typeof value === 'string' && /^v?\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value) ? value.replace(/^v/, '') : '';
}

export function feedbackPlatform(userAgent) {
    const ua = typeof userAgent === 'string' ? userAgent : '';
    const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Macintosh|Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
    const browser = /Edg(?:e|A|iOS)?\//i.test(ua) ? 'Edge' : /Firefox|FxiOS/i.test(ua) ? 'Firefox' : /Chrome|CriOS/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : '';
    return { os, browser };
}

export function feedbackDiagnostics(source = {}) {
    const rows = [];
    for (const [key, label] of [['qianmuVersion', '千幕版本'], ['stVersion', 'ST 版本'], ['backendVersion', '后端版本']]) {
        const value = version(own(source, key));
        if (value) rows.push(Object.freeze({ key, label, value }));
    }
    const status = own(source, 'backendStatus');
    if (typeof status === 'string' && Object.hasOwn(statuses, status)) rows.push(Object.freeze({ key: 'backendStatus', label: '后端状态（页面快照）', value: statuses[status] }));
    for (const [key, label, allowed] of [['os', '系统', systems], ['browser', '浏览器', browsers]]) {
        const value = own(source, key);
        if (typeof value === 'string' && allowed.includes(value)) rows.push(Object.freeze({ key, label, value }));
    }
    return Object.freeze(rows);
}

export function feedbackReport({ description = '', steps = '', module = '其他', diagnostics = {}, excluded = [] } = {}) {
    if (typeof description !== 'string' || !description.trim()) throw new Error('请先描述遇到的问题。');
    if (typeof steps !== 'string' || description.length > FEEDBACK_TEXT_LIMIT || steps.length > FEEDBACK_TEXT_LIMIT) throw new Error(`问题描述和复现步骤各最多 ${FEEDBACK_TEXT_LIMIT} 字，请精简后再导出。`);
    if (!FEEDBACK_MODULES.includes(module)) throw new Error('请选择列表中的功能模块。');
    const omitted = new Set(Array.isArray(excluded) ? excluded.filter(key => typeof key === 'string') : []);
    const rows = feedbackDiagnostics(diagnostics).filter(row => !omitted.has(row.key));
    return ['千幕问题反馈', `功能模块：${module}`, '', '问题描述', description.trim(), ...(steps.trim() ? ['', '复现步骤', steps.trim()] : []), '', '附带诊断', rows.length ? rows.map(row => `${row.label}：${row.value}`).join('\n') : '无（未附带诊断）'].join('\n');
}

export function feedbackMailLink(contact = FEEDBACK_CONTACT) {
    const address = own(contact, 'address');
    if (own(contact, 'identityVerified') !== true || typeof address !== 'string' || address.length > 254 || !/^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(address)) return null;
    // No diagnostic or user text is put in a URL. Sending remains the user's
    // explicit action in their own mail client, including manual attachments.
    return Object.freeze({ address, href: `mailto:${address}?subject=${encodeURIComponent('千幕问题反馈')}&body=${encodeURIComponent('请在这里粘贴已核对的反馈报告；如需截图，请自行确认后添加附件。')}` });
}
