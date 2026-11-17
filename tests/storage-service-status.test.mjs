import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {setImmediate as flush} from 'node:timers/promises';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

// C-13 ④：后端服务卡不再有刷新键与版本号行；版本仍读取，只在配套版本与运行版本不同时，
// 状态标签变为「正常 · 有可用更新」，并显示一个打开安装说明的小图标。
const htmlEscape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const fixture = () => {
  const label = {dataset: {}, textContent: '', title: ''}, guide = {hidden: true, onclick: null};
  const modal = {open: true, classList: {contains: () => modal.open},
    querySelector: selector => selector === '.sd-optional-service-label' ? label : selector === '.sd-storage-service-guide' ? guide : null,
    querySelectorAll: () => []};
  const counters = {load: 0, probe: 0, guidance: 0}; let release, reject;
  const context = vm.createContext({htmlEscape, VERSION:'1.59.392', MODAL_ID: 'fixture', document: {getElementById: () => modal},
    optionalServiceState: {status: 'idle', services: [], checkedAt: 0}, optionalServiceProbePromise: null,
    ctx: () => ({getRequestHeaders: () => ({'X-CSRF-Token': 'synthetic'})}),
    featureRuntime: {load: async () => {counters.load++; return {probeQianmuOptionalService: async () => {
      counters.probe++; return new Promise((resolve, fail) => {release = resolve; reject = fail;});
    }};}},
    showQianmuUpdateGuidance: () => {counters.guidance++;}, scheduleStorageScan: () => {},
    renderModal: () => assert.fail('backend check must not redraw the modal'),
    paintStorageManagementCard: () => assert.fail('backend check must not replace the storage card'),
  });
  vm.runInContext(['optionalServiceLabel', 'optionalServiceLatestDisplay', 'optionalServiceDetail', 'renderStorageServiceStatus', 'paintOptionalServiceState', 'refreshOptionalServiceState', 'bindStorageManagementEvents'].map(section).join('\n'), context);
  return {context, modal, label, guide, counters, resolve: value => release(value), reject: value => reject(value)};
};

test('compact backend footer covers every state, has no refresh button or version rows, and exposes no diagnostics', () => {
  const f = fixture();
  for (const [status, expected] of [['idle', '未检测'], ['checking', '检测中'], ['ready', '正常'], ['missing', '未安装'], ['unsupported', '不支持'], ['error', '未启动 / 出错']]) {
    f.context.optionalServiceState = {status, services: [], version: '<unsafe>', message: '"<error>'};
    const html = f.context.renderStorageServiceStatus();
    assert.match(html, new RegExp(expected)); assert.match(html, /role="status" aria-live="polite"/);
    assert.doesNotMatch(html, /sd-storage-service-refresh|sd-storage-service-versions|sd-storage-service-current|sd-storage-service-latest|fa-rotate|重新检测/);
    assert.doesNotMatch(html, /<unsafe>|<error>|运行与性能|活动观察器|最慢重绘/);
    assert.match(html, /class="sd-icon-btn sd-storage-service-guide" title="安装说明" aria-label="后端服务安装说明" hidden>/, 'the guide entry stays hidden without an update');
    assert.doesNotMatch(html, /v\d+\.\d+\.\d+/, 'no version number is shown on the card');
  }
});

test('a differing paired version turns the label into an update notice with a guide entry; matching versions stay plain', () => {
  const f = fixture();
  f.context.optionalServiceState = {status: 'ready', services: ['doubao-tts'], version: '1.55.0', latestVersion: ''};
  let html = f.context.renderStorageServiceStatus();
  assert.match(html, />正常 · 有可用更新<\/b>/);
  assert.match(html, /title="服务端 v1\.55\.0 → v1\.59\.392，可按安装说明更新"/, 'hover names both versions; the paired version falls back to this front end');
  assert.match(html, /sd-storage-service-guide" title="安装说明" aria-label="后端服务安装说明" ><i class="fa-solid fa-circle-question"/);
  f.context.paintOptionalServiceState();
  assert.equal(f.label.textContent, '正常 · 有可用更新'); assert.equal(f.guide.hidden, false);

  f.context.optionalServiceState = {status: 'ready', services: ['doubao-tts'], version: '1.55.0', latestVersion: 'v1.60.0'};
  assert.match(f.context.renderStorageServiceStatus(), /服务端 v1\.55\.0 → v1\.60\.0/, 'a verified remote version is preferred');

  f.context.optionalServiceState = {status: 'ready', services: ['doubao-tts'], version: '1.59.392', latestVersion: ''};
  html = f.context.renderStorageServiceStatus();
  assert.match(html, />正常<\/b>/); assert.match(html, /title="豆包语音网关"/); assert.match(html, /sd-storage-service-guide"[^>]* hidden>/);
  f.context.paintOptionalServiceState();
  assert.equal(f.label.textContent, '正常'); assert.equal(f.guide.hidden, true);

  // A missing or unreadable running version is never an "update".
  for (const state of [{status: 'missing', services: [], version: '', latestVersion: '1.60.0'}, {status: 'ready', services: [], version: '<img>', latestVersion: '1.60.0'}, {status: 'error', services: [], version: '1.0.0', latestVersion: '1.60.0'}]) {
    f.context.optionalServiceState = state;
    assert.equal(f.context.optionalServiceLatestDisplay().update, false);
    assert.doesNotMatch(f.context.renderStorageServiceStatus(), /有可用更新/);
  }
});

test('the guide entry opens the update guidance; versions are still read and validated', () => {
  const f = fixture();
  f.context.bindStorageManagementEvents(f.modal);
  assert.equal(typeof f.guide.onclick, 'function'); f.guide.onclick(); assert.equal(f.counters.guidance, 1);
  assert.equal(f.counters.probe, 0, 'binding and the guide never start a probe');
  f.context.optionalServiceState = {status:'ready',services:[],version:'1.2.3',latestVersion:'v1.2.4'};
  assert.equal(f.context.optionalServiceLabel('current'), 'v1.2.3'); assert.equal(f.context.optionalServiceLabel('latest'), 'v1.2.4');
  assert.deepEqual({...f.context.optionalServiceLatestDisplay()}, {label: '配套', version: 'v1.2.4', update: true});
  f.context.optionalServiceState.version = '1.2.4';
  assert.deepEqual({...f.context.optionalServiceLatestDisplay()}, {label: '最新', version: 'v1.2.4', update: false}, 'only the installed matching release is the latest');
  for (const latestVersion of [undefined,null,{},371,'','latest','<img src=x>','1.2.3\n','1.2.3-'+ 'a'.repeat(80)]) {
    f.context.optionalServiceState.latestVersion = latestVersion;
    assert.equal(f.context.optionalServiceLabel('latest'),'未获取');
    assert.equal(f.context.optionalServiceLatestDisplay().version, 'v1.59.392');
    assert.doesNotMatch(f.context.renderStorageServiceStatus(), /<img/);
  }
  f.context.optionalServiceState.status='error';assert.equal(f.context.optionalServiceLabel('current'),'未获取');
});

test('a probe updates only the live label and guide, is cached, and failure recovers without rejection', async () => {
  const f = fixture(), first = f.context.refreshOptionalServiceState(false); await flush();
  assert.equal(f.counters.probe, 1); assert.equal(f.label.textContent, '检测中');
  f.resolve({status: 'ready', services: ['doubao-tts'], version: '1.59.392', checkedAt: Date.now()}); await first;
  assert.equal(f.label.textContent, '正常'); assert.equal(f.label.title, '豆包语音网关'); assert.equal(f.guide.hidden, true);
  await f.context.refreshOptionalServiceState(false); assert.equal(f.counters.probe, 1, 'fresh result remains cached');
  const second = f.context.refreshOptionalServiceState(true); await flush();
  f.reject(Error('synthetic failure')); await second;
  assert.equal(f.context.optionalServiceState.status, 'error'); assert.equal(f.context.optionalServiceProbePromise, null);
  assert.equal(f.label.textContent, '未启动 / 出错');
});

test('closing the modal prevents late probe results from touching a hidden footer; a verified latest version survives failed probes', async () => {
  const f = fixture(); f.context.optionalServiceState.latestVersion = '1.59.392';
  let pending = f.context.refreshOptionalServiceState(true); await flush();
  f.modal.open = false; f.label.textContent = 'closed view';
  f.resolve({status: 'ready', services: [], version: '1.59.392', checkedAt: Date.now()}); await pending;
  assert.equal(f.label.textContent, 'closed view'); assert.equal(f.context.optionalServiceState.status, 'ready');
  f.modal.open = true; f.context.paintOptionalServiceState(); assert.equal(f.label.textContent, '正常');
  pending = f.context.refreshOptionalServiceState(true); await flush();
  f.resolve({status: 'missing', services: [], checkedAt: Date.now()}); await pending;
  assert.equal(f.context.optionalServiceState.latestVersion, '1.59.392'); assert.equal(f.label.textContent, '未安装');
  pending = f.context.refreshOptionalServiceState(true); await flush(); f.reject(Error('synthetic')); await pending;
  assert.equal(f.context.optionalServiceState.latestVersion, '1.59.392');
});
