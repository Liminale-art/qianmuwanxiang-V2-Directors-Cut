import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {setImmediate as flush} from 'node:timers/promises';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const htmlEscape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const fixture = () => {
  const label = {dataset: {}, textContent: '', title: ''}, latestLabel = {textContent:''}, versions = {current:{textContent:''},latest:{textContent:''}}, attributes = {}, button = {isConnected: true, setAttribute: (key, value) => {attributes[key] = value;}};
  const modal = {open: true, classList: {contains: () => modal.open}, contains: node => node === button && button.isConnected,
    querySelector: selector => selector === '.sd-optional-service-label' ? label : selector === '.sd-storage-service-refresh' ? button
      : selector === '.sd-storage-service-latest-label' ? latestLabel : versions[selector.replace('.sd-storage-service-','')] || null,
    querySelectorAll: () => []};
  const counters = {load: 0, probe: 0, latest: 0, video: 0}; let release, reject;
  const context = vm.createContext({htmlEscape, VERSION:'1.59.388', MODAL_ID: 'fixture', document: {getElementById: () => modal},
    optionalServiceState: {status: 'idle', services: [], checkedAt: 0}, optionalServiceProbePromise: null,
    ctx: () => ({getRequestHeaders: () => ({'X-CSRF-Token': 'synthetic'})}),
    featureRuntime: {load: async () => {counters.load++; return {probeQianmuOptionalService: async () => {
      counters.probe++; return new Promise((resolve, fail) => {release = resolve; reject = fail;});
    }};}},
    refreshQianmuUpdateStatus: async force => {assert.equal(force,true);counters.latest++;},
    renderModal: () => assert.fail('backend check must not redraw the modal'),
    paintStorageManagementCard: () => assert.fail('backend check must not replace the storage card'),
    storyboardPaintVideoConnectionState: async () => {counters.video++;},
  });
  vm.runInContext(['optionalServiceLabel', 'optionalServiceLatestDisplay', 'optionalServiceDetail', 'renderStorageServiceStatus', 'paintOptionalServiceState', 'refreshOptionalServiceState', 'bindStorageManagementEvents'].map(section).join('\n'), context);
  return {context, modal, label, latestLabel, versions, button, attributes, counters, resolve: value => release(value), reject: value => reject(value)};
};

test('compact backend footer covers ready, missing, checking and failure without exposing diagnostics', () => {
  const f = fixture();
  for (const [status, expected] of [['idle', '未检测'], ['checking', '检测中'], ['ready', '正常'], ['missing', '未安装'], ['unsupported', '不支持'], ['error', '未启动 / 出错']]) {
    f.context.optionalServiceState = {status, services: [], version: '<unsafe>', message: '"<error>'};
    const html = f.context.renderStorageServiceStatus();
    assert.match(html, new RegExp(expected)); assert.match(html, /role="status" aria-live="polite"/);
    assert.match(html, /class="sd-icon-btn sd-storage-service-refresh"[^>]*title="重新检测后端服务与配套版本"[^>]*aria-label="重新检测后端服务与配套版本"[^>]*><i class="fa-solid fa-rotate" aria-hidden="true"><\/i><\/button>/);
    assert.doesNotMatch(html, />重新检测<\/button>|<unsafe>|<error>|运行与性能|活动观察器|最慢重绘/);
    assert.match(html, new RegExp(`aria-busy="${status === 'checking'}"`));
  }
});

test('repeated binding and clicks coalesce both service and release checks; completion only updates live footer fields', async () => {
  const f = fixture();
  f.context.bindStorageManagementEvents(f.modal); f.context.bindStorageManagementEvents(f.modal);
  f.button.onclick(); f.button.onclick();
  await flush();
  assert.equal(f.counters.probe, 1); assert.equal(f.counters.latest,1,'the button must refresh release metadata independently of backend health');
  assert.equal(f.attributes['aria-busy'], 'true'); assert.equal(f.label.textContent, '检测中');
  const pending = f.context.optionalServiceProbePromise;
  f.resolve({status: 'ready', services: ['doubao-tts'], version: '1.59.388', checkedAt: Date.now()}); await pending;
  assert.equal(f.label.textContent, '正常'); assert.equal(f.label.title, '豆包语音网关');
  assert.equal(f.versions.current.textContent, 'v1.59.388'); assert.equal(f.latestLabel.textContent, '配套');assert.equal(f.versions.latest.textContent, 'v1.59.388');
  await flush(); assert.equal(f.counters.video, 0, 'retired video settings are not probed by the shared service footer');
  assert.equal(f.attributes['aria-busy'], 'false'); assert.equal(f.attributes['aria-disabled'], 'false');
  await f.context.refreshOptionalServiceState(false); assert.equal(f.counters.probe, 1, 'fresh result remains cached');
  f.context.bindStorageManagementEvents(f.modal); f.button.onclick(); await flush();
  assert.equal(f.counters.probe, 2, 'explicit recheck bypasses cache once');assert.equal(f.counters.latest,2);
  const next = f.context.optionalServiceProbePromise;
  f.resolve({status: 'missing', services: [], checkedAt: Date.now()}); await next;
  assert.equal(f.label.textContent, '未安装');assert.equal(f.versions.current.textContent, '未安装');
  assert.equal(f.latestLabel.textContent,'配套');assert.equal(f.versions.latest.textContent,'v1.59.388');
});

test('probe failure recovers controls without rejection or dropping existing application state', async () => {
  const f = fixture(), pending = f.context.refreshOptionalServiceState(true); await flush();
  f.reject(Error('synthetic failure')); await pending;
  assert.equal(f.context.optionalServiceState.status, 'error'); assert.equal(f.context.optionalServiceProbePromise, null);
  assert.equal(f.label.textContent, '未启动 / 出错'); assert.equal(f.attributes['aria-disabled'], 'false');
});

test('closing the modal prevents late probe results from touching a hidden footer', async () => {
  const f = fixture(), pending = f.context.refreshOptionalServiceState(true); await flush();
  f.modal.open = false; f.label.textContent = 'closed view';
  f.resolve({status: 'ready', services: [], checkedAt: Date.now()}); await pending;
  assert.equal(f.label.textContent, 'closed view'); assert.equal(f.context.optionalServiceState.status, 'ready');
  f.modal.open = true; f.context.paintOptionalServiceState(); assert.equal(f.label.textContent, '正常');
});

test('detached, replaced or closed service controls cannot launch a probe', async () => {
  const f = fixture(); f.context.bindStorageManagementEvents(f.modal);
  f.button.isConnected = false; f.button.onclick(); await flush(); assert.equal(f.counters.probe, 0);assert.equal(f.counters.latest,0);
  f.button.isConnected = true; f.modal.open = false; f.button.onclick(); await flush(); assert.equal(f.counters.probe, 0);assert.equal(f.counters.latest,0);
  f.modal.open = true; f.modal.contains = () => false; f.button.onclick(); await flush(); assert.equal(f.counters.probe, 0);assert.equal(f.counters.latest,0);
});

test('unknown and mismatched backend versions show the paired branch without calling it the installed latest', () => {
  const f=fixture();
  f.context.optionalServiceState={status:'ready',services:[],version:'1.55.0',latestVersion:''};
  let html=f.context.renderStorageServiceStatus();
  assert.match(html,/当前 <b class="sd-storage-service-current">v1\.55\.0/);
  assert.match(html,/sd-storage-service-latest-label">配套<\/span> <b class="sd-storage-service-latest">v1\.59\.388/);
  assert.doesNotMatch(html,/sd-storage-service-latest-label">最新/);
  f.context.paintOptionalServiceState();assert.equal(f.latestLabel.textContent,'配套');assert.equal(f.versions.latest.textContent,'v1.59.388');
  f.context.optionalServiceState={status:'missing',services:[],version:'',latestVersion:''};
  html=f.context.renderStorageServiceStatus();assert.match(html,/当前 <b class="sd-storage-service-current">未安装/);
  assert.match(html,/sd-storage-service-latest-label">配套<\/span> <b class="sd-storage-service-latest">v1\.59\.388/);
  f.context.optionalServiceState={status:'ready',services:[],version:'1.55.0',latestVersion:'1.59.388'};
  html=f.context.renderStorageServiceStatus();assert.match(html,/sd-storage-service-latest-label">配套<\/span> <b class="sd-storage-service-latest">v1\.59\.388/);
  f.context.paintOptionalServiceState();assert.equal(f.latestLabel.textContent,'配套');assert.equal(f.versions.latest.textContent,'v1.59.388');
  f.context.optionalServiceState.version='1.59.388';f.context.paintOptionalServiceState();
  assert.equal(f.latestLabel.textContent,'最新','only the installed matching release can be called latest');
  f.context.optionalServiceState.latestVersion='';f.context.paintOptionalServiceState();
  assert.equal(f.latestLabel.textContent,'配套');assert.equal(f.versions.latest.textContent,'v1.59.388','a failed release check cannot retain a stale latest label');
});

test('current and latest versions stay distinct and only verified version strings are displayed', () => {
  const f = fixture();
  f.context.optionalServiceState = {status:'ready',services:[],version:'1.2.3',latestVersion:'v1.2.4'};
  assert.match(f.context.renderStorageServiceStatus(), /sd-storage-service-current">v1\.2\.3/);
  assert.match(f.context.renderStorageServiceStatus(), /sd-storage-service-latest">v1\.2\.4/);
  assert.match(f.context.renderStorageServiceStatus(),/sd-storage-service-latest-label">配套/);
  for (const latestVersion of [undefined,null,{},371,'','latest','<img src=x>','1.2.3\n','1.2.3-'+ 'a'.repeat(80)]) {
    f.context.optionalServiceState.latestVersion = latestVersion;
    assert.equal(f.context.optionalServiceLabel('latest'),'未获取');
    assert.match(f.context.renderStorageServiceStatus(),/sd-storage-service-latest-label">配套<\/span> <b class="sd-storage-service-latest">v1\.59\.388/);
    assert.doesNotMatch(f.context.renderStorageServiceStatus(),/sd-storage-service-latest">v1\.2\.3|<img/);
  }
  f.context.optionalServiceState.status='error';assert.equal(f.context.optionalServiceLabel('current'),'未获取');
  assert.equal(f.counters.probe,0,'render and version lookup never start requests');
});

test('health refresh preserves a separately verified latest version through missing and failed probes', async () => {
  const f=fixture();f.context.optionalServiceState.latestVersion='1.59.388';
  let pending=f.context.refreshOptionalServiceState(true);await flush();
  f.resolve({status:'missing',services:[],checkedAt:Date.now()});await pending;
  assert.equal(f.versions.latest.textContent,'v1.59.388');assert.equal(f.versions.current.textContent,'未安装');
  pending=f.context.refreshOptionalServiceState(true);await flush();f.reject(Error('synthetic'));await pending;
  assert.equal(f.versions.latest.textContent,'v1.59.388');assert.equal(f.versions.current.textContent,'未获取');
});
