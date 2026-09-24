import test from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_CONTACT, FEEDBACK_MODULES, FEEDBACK_TEXT_LIMIT, feedbackPlatform, feedbackDiagnostics, feedbackReport, feedbackMailLink } from '../qianmu-feedback-report.js';

test('feedback defaults have no recipient or sending capability', () => {
    assert.deepEqual(FEEDBACK_CONTACT, { address: '', identityVerified: false });
    assert.equal(feedbackMailLink(), null);
    assert.ok(Object.isFrozen(FEEDBACK_CONTACT));
    assert.ok(Object.isFrozen(FEEDBACK_MODULES));
});
test('diagnostics use own whitelisted data properties and never inspect secrets', () => {
    const source = { qianmuVersion: '1.59.365', backendStatus: 'ready', os: 'Windows', browser: 'Firefox' };
    for (const key of ['stVersion', 'backendVersion', 'apiKey', 'headers', 'logHistory', 'chat', 'workflow', 'toJSON']) Object.defineProperty(source, key, { enumerable: true, get() { throw Error('must not read ' + key); } });
    const rows = feedbackDiagnostics(source);
    assert.deepEqual(rows.map(row => row.key), ['qianmuVersion', 'backendStatus', 'os', 'browser']);
    assert.ok(Object.isFrozen(rows)); assert.ok(rows.every(Object.isFrozen));
    assert.equal(feedbackDiagnostics(Object.create({ qianmuVersion: '1.2.3' })).length, 0);
});
test('arbitrary fields, raw messages, source paths, headers and URLs never enter a report', () => {
    const diagnostics = { qianmuVersion: '1.2.3', statusCode: 'PRIVATE', workflow: 'PRIVATE', sourceLocation: 'C:/PRIVATE', url: 'https://PRIVATE', chat: 'PRIVATE', prompt: 'PRIVATE', headers: { Authorization: 'PRIVATE' }, logHistory: ['PRIVATE'] };
    const report = feedbackReport({ description: '按钮不响应', diagnostics });
    assert.match(report, /千幕版本：1.2.3/); assert.doesNotMatch(report, /PRIVATE|https:|Authorization/);
});
test('only bare numeric versions are accepted, with no private build suffix', () => {
    for (const value of ['1.2.3', 'v1.2.3']) assert.equal(feedbackDiagnostics({ stVersion: value })[0].value, '1.2.3');
    for (const value of ['1.2.3-private', '1.2.3\nkey', ' 1.2.3', '1.2.3/path', '12345.2.3', '1.2', 123, null, { toString() { throw Error('coercion'); } }]) assert.deepEqual(feedbackDiagnostics({ stVersion: value }), []);
});
test('state, system and browser are enums rather than free text', () => {
    assert.deepEqual(feedbackDiagnostics({ os: 'DEVICE_NAME', browser: 'SECRET_UA', backendStatus: 'https://private' }), []);
    for (const backendStatus of ['idle', 'checking', 'ready', 'missing', 'unsupported', 'error']) assert.equal(feedbackDiagnostics({ backendStatus }).length, 1);
});
for (const [ua, os, browser] of [
    ['Mozilla Windows Chrome/100 Safari/537 Edg/100', 'Windows', 'Edge'],
    ['Mozilla Android Chrome/100 Safari/537', 'Android', 'Chrome'],
    ['iPhone Mac OS X CriOS/123 Safari/604', 'iOS', 'Chrome'],
    ['iPad FxiOS/100 Safari/604', 'iOS', 'Firefox'],
    ['Macintosh Version/17 Safari/604', 'macOS', 'Safari'],
    ['Linux Firefox/110', 'Linux', 'Firefox'],
    ['PRIVATE unknown client', '', ''],
]) test(`platform reduces ${os || 'unknown'} / ${browser || 'unknown'} to family names only`, () => assert.deepEqual(feedbackPlatform(ua), { os, browser }));
test('unknown non-string user agents are not coerced', () => assert.deepEqual(feedbackPlatform({ toString() { throw Error(); } }), { os: '', browser: '' }));
test('report preserves intentional user text as text and omits empty optional steps', () => {
    const report = feedbackReport({ description: ' <script>手动输入</script>\n第二段 ', module: '便笺' });
    assert.match(report, /<script>手动输入<\/script>\n第二段/); assert.match(report, /功能模块：便笺/);
    assert.doesNotMatch(report, /复现步骤/); assert.match(report, /无（未附带诊断）/);
});
test('every diagnostic can be excluded and unsupported exclusion keys add nothing', () => {
    const diagnostics = { qianmuVersion: '1.2.3', stVersion: '1.12.0', backendVersion: '1.2.0', backendStatus: 'error', os: 'iOS', browser: 'Safari' };
    const excluded = feedbackDiagnostics(diagnostics).map(row => row.key);
    const report = feedbackReport({ description: '问题', steps: '第一步\n第二步', diagnostics, excluded: [...excluded, 'apiKey'] });
    assert.match(report, /复现步骤\n第一步\n第二步/); assert.match(report, /无（未附带诊断）/);
    assert.doesNotMatch(report, /1.12|Safari|iOS|apiKey/);
});
test('oversized descriptions and steps fail explicitly instead of truncating', () => {
    const text = '文'.repeat(FEEDBACK_TEXT_LIMIT);
    assert.ok(feedbackReport({ description: text }).includes(text));
    assert.throws(() => feedbackReport({ description: text + '尾' }), /最多/);
    assert.throws(() => feedbackReport({ description: '问题', steps: text + '尾' }), /最多/);
});
test('empty input and unknown modules fail without an exportable report', () => {
    for (const description of ['', ' \n ', null, 1]) assert.throws(() => feedbackReport({ description }), /描述/);
    assert.throws(() => feedbackReport({ description: '问题', module: '私人角色名' }), /功能模块/);
});
test('a future verified brand mail link never carries report data and is not a send operation', () => {
    const value = feedbackMailLink({ address: 'feedback@example.test', identityVerified: true, apiKey: 'PRIVATE' });
    assert.equal(value.address, 'feedback@example.test'); assert.match(value.href, /^mailto:feedback@example\.test\?subject=/);
    assert.doesNotMatch(value.href, /PRIVATE/); assert.match(decodeURIComponent(value.href), /粘贴已核对/);
});
test('unverified contacts and mail header/URL injection are unavailable', () => {
    assert.equal(feedbackMailLink({ address: 'feedback@example.test', identityVerified: false }), null);
    for (const address of ['x@example.test\r\nBcc:a@evil.test', 'a@example.test?body=secret', 'a@example.test,b@example.test', 'javascript:alert(1)', 'a%0A@example.test', '']) assert.equal(feedbackMailLink({ address, identityVerified: true }), null);
    const contact = {}; Object.defineProperty(contact, 'address', { get() { throw Error('private'); } });
    assert.equal(feedbackMailLink(contact), null);
});
