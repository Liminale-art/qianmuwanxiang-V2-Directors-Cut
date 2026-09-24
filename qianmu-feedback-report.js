// Public feedback is a separate, deliberately small contract. Never pass logs,
// chat, settings, request bodies or workflow JSON through a generic redactor.
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

export function feedbackReport({ description = '', diagnostics = {} } = {}) {
    if (typeof description !== 'string' || !description.trim()) throw new Error('请先描述遇到的问题。');
    const rows = feedbackDiagnostics(diagnostics);
    return ['千幕问题反馈', '', '问题描述', description, '', '附带诊断', rows.length ? rows.map(row => `${row.label}：${row.value}`).join('\n') : '暂无可识别的诊断信息'].join('\n');
}
