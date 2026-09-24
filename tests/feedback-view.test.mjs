import test from 'node:test';
import assert from 'node:assert/strict';
import { mountFeedback } from '../qianmu-feedback-view.js';
import { feedbackFixture, settleFeedback } from './helpers/feedback-fixture.mjs';

const environment = { qianmuVersion: '1.59.366', backendVersion: '1.2.3', backendStatus: 'ready' };
function setup(options = {}, fixtureOptions) {
    const f = feedbackFixture(fixtureOptions);
    f.dispose = mountFeedback(f.host, { scope: {}, environment, download: f.download, ...options }); return f;
}
async function write(f, label, value) { const input = f.get(label); input.value = value; await input.emit(label === '反馈功能模块' ? 'change' : 'input'); return input; }

test('feedback is local-only until explicit copy/download, with unconfigured mail explained', () => {
    const f = setup();
    assert.match(f.host.textContent, /反馈邮箱尚未配置/); assert.match(f.host.textContent, /发件地址/);
    assert.equal(f.button('复制报告').disabled, true); assert.equal(f.button('保存报告').disabled, true);
    assert.equal(f.all().filter(node => node.tagName === 'A').length, 0);
    assert.equal(f.downloaded.length, 0); assert.equal(f.copied.length, 0); f.dispose();
});
test('opaque scope with secret getters is never inspected or serialized', () => {
    const scope = new Proxy({}, { get() { throw Error('private settings'); }, ownKeys() { throw Error('enumeration'); } });
    const f = setup({ scope }); assert.match(f.host.textContent, /问题描述/); f.dispose(true);
});
test('typing keeps the same controls, does not render HTML and exports exactly the visible preview', async () => {
    const f = setup(); const input = await write(f, '问题描述', '<img src=x onerror=alert(1)>\n按钮异常');
    await write(f, '复现步骤', '点击一次'); await write(f, '反馈功能模块', '便笺');
    assert.equal(f.get('问题描述'), input); assert.equal(f.all().filter(node => node.tagName === 'IMG').length, 0);
    const preview = f.get('反馈报告完整预览').textContent;
    await f.button('复制报告').emit('click'); await f.button('保存报告').emit('click');
    assert.deepEqual(f.copied, [preview]); assert.equal(await f.downloaded[0].blob.text(), preview);
    assert.equal(f.downloaded[0].name, 'qianmu-feedback.txt'); assert.match(f.status().textContent, /发起报告下载.*尚未发送/); f.dispose();
});
test('diagnostic exclusions update preview and copy together', async () => {
    const f = setup(); await write(f, '问题描述', '错误');
    for (const node of f.all().filter(node => node.type === 'checkbox')) { node.checked = false; await node.emit('change'); }
    await f.button('复制报告').emit('click');
    assert.match(f.copied[0], /无（未附带诊断）/); assert.doesNotMatch(f.copied[0], /Firefox|Windows|1.59.366/); f.dispose();
});
test('draft survives panel rerender for the same scope, but not another scope', async () => {
    const scope = {}, f = setup({ scope }); await write(f, '问题描述', '会话草稿');
    const browser = f.get('附带浏览器'); browser.checked = false; await browser.emit('change'); f.dispose();
    const again = setup({ scope }); assert.equal(again.get('问题描述').value, '会话草稿'); assert.equal(again.get('附带浏览器').checked, false); again.dispose();
    const other = setup(); assert.equal(other.get('问题描述').value, ''); other.dispose();
    const cleared = setup({ scope }); cleared.dispose(true);
    const fresh = setup({ scope }); assert.equal(fresh.get('问题描述').value, ''); fresh.dispose();
});
test('rerender restores focused draft caret only when no unrelated control has focus', async () => {
    const scope = {}, f = setup({ scope }); const input = await write(f, '问题描述', '这里继续编辑'); input.focus(); input.setSelectionRange(2, 4); f.dispose();
    const again = setup({ scope }); assert.equal(again.doc.activeElement, again.get('问题描述')); assert.equal(again.get('问题描述').selectionStart, 2); assert.equal(again.get('问题描述').selectionEnd, 4); again.dispose();
    const separate = feedbackFixture(); separate.doc.activeElement = separate.create('input'); const originalFocus = separate.doc.activeElement;
    const stop = mountFeedback(separate.host, { scope }); assert.equal(separate.doc.activeElement, originalFocus); stop(true);
});
test('clipboard denial keeps text and offers saving without pretending success', async () => {
    const f = setup({}, { copy: async () => { throw Error('PRIVATE browser details'); } }); await write(f, '问题描述', '保留');
    await f.button('复制报告').emit('click');
    assert.match(f.status().textContent, /复制未成功/); assert.doesNotMatch(f.status().textContent, /PRIVATE/);
    assert.equal(f.get('问题描述').value, '保留'); assert.equal(f.button('保存报告').disabled, false); f.dispose();
});
test('clipboard result for an older preview does not claim that edited text was copied', async () => {
    let finish; const f = setup({}, { copy: () => new Promise(resolve => { finish = resolve; }) });
    await write(f, '问题描述', '旧值'); const pending = f.button('复制报告').emit('click'); await settleFeedback();
    await write(f, '问题描述', '新值'); assert.equal(f.button('复制报告').disabled, true);
    finish(); await pending;
    assert.match(f.copied[0], /旧值/); assert.match(f.get('反馈报告完整预览').textContent, /新值/); assert.equal(f.status().textContent, ''); f.dispose();
});
test('removed or invalidated views cannot copy/download or reappear on late clipboard results', async () => {
    let valid = true, finish; const f = setup({ isCurrent: () => valid }, { copy: () => new Promise(resolve => { finish = resolve; }) });
    await write(f, '问题描述', '草稿'); const button = f.button('保存报告');
    const pending = f.button('复制报告').emit('click'); await settleFeedback();
    valid = false; f.dispose(); finish(); await pending; await button.emit('click');
    assert.equal(f.host.children.length, 0); assert.equal(f.downloaded.length, 0);
});
test('invalid or oversized text disables export rather than silently truncating', async () => {
    const f = setup(); await write(f, '问题描述', '文'.repeat(6001));
    assert.match(f.get('反馈报告完整预览').textContent, /最多 6000/);
    await f.button('保存报告').emit('click'); await f.button('复制报告').emit('click');
    assert.equal(f.downloaded.length + f.copied.length, 0); f.dispose();
});
test('download errors expose no raw exception data', async () => {
    const f = setup({ download() { throw Error('PRIVATE file system'); } }); await write(f, '问题描述', '问题'); await f.button('保存报告').emit('click');
    assert.match(f.status().textContent, /未能发起下载/); assert.doesNotMatch(f.status().textContent, /PRIVATE/); f.dispose();
});
test('configured mail opening is explicit and reports not sent, without report text in the URL', async () => {
    const f = setup({ contact: { address: 'feedback@example.test', identityVerified: true } });
    await write(f, '问题描述', 'PRIVATE draft');
    const link = f.all().find(node => node.tagName === 'A'); assert.doesNotMatch(decodeURIComponent(link.href), /PRIVATE/);
    assert.equal(f.copied.length, 0); await link.emit('click'); assert.match(f.status().textContent, /尚未发送/);
    await f.button('复制邮箱地址').emit('click'); assert.deepEqual(f.copied, ['feedback@example.test']); f.dispose();
});
