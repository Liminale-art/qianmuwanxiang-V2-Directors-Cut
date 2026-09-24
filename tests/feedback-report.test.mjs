import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackPlatform, feedbackDiagnostics, feedbackReport } from '../qianmu-feedback-report.js';
import * as feedback from '../qianmu-feedback-report.js';

test('feedback exports only local report and coarse diagnostic helpers without a receiving service', () => {
    assert.deepEqual(Object.keys(feedback).sort(), ['feedbackDiagnostics','feedbackPlatform','feedbackReport']);
});
test('diagnostics use own whitelisted data properties and never inspect secrets', () => {
    const source = { qianmuVersion: '1.59.369', backendStatus: 'ready', os: 'Windows', browser: 'Firefox' };
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
test('report preserves intentional input including boundary whitespace without separate module or steps fields', () => {
    const text=' <script>手动输入</script>\n第二段 ';
    const report=feedbackReport({description:text});
    assert.ok(report.includes('问题描述\n'+text+'\n\n附带诊断'));
    assert.doesNotMatch(report,/功能模块：|复现步骤/);assert.match(report,/暂无可识别的诊断信息/);
});

test('diagnostics are always attached and obsolete exclusions cannot hide them or add private fields', () => {
    const diagnostics={qianmuVersion:'1.2.3',stVersion:'1.12.0',backendVersion:'1.2.0',backendStatus:'error',os:'iOS',browser:'Safari'};
    const excluded=feedbackDiagnostics(diagnostics).map(row=>row.key);
    const report=feedbackReport({description:'问题',steps:'PRIVATE steps',module:'PRIVATE module',diagnostics,excluded:[...excluded,'apiKey']});
    for(const row of feedbackDiagnostics(diagnostics))assert.ok(report.includes(row.label+'：'+row.value));
    assert.doesNotMatch(report,/PRIVATE|apiKey/);
});

test('long input is complete including multibyte characters and the last line', () => {
    const text='文🙂\n'.repeat(30000)+'不可丢失的结尾';
    assert.ok(feedbackReport({description:text}).includes(text));
});

test('empty or non-string descriptions fail without an exportable report', () => {
    for(const description of ['', ' \n ', null, 1])assert.throws(()=>feedbackReport({description}),/描述/);
});
