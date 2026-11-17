import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

assert.doesNotMatch(source, /^import[^\n]*qianmu-reader\.js/m, 'the companion parser must stay outside the startup module graph');
assert.match(source, /readerCore:\s*\{[\s\S]*loadLocalChunk\('\.\/qianmu-reader\.js\?v=1\.59\.202'\)[\s\S]*reader = module/, 'the companion parser must load through the shared recoverable feature runtime');
assert.match(source, /function renderCoreadRuntimeGate\(\)[\s\S]*\['idle','loading'\].includes\(runtime.status\)[\s\S]*ensureCoreadReaderRuntime\(\{ rerender: true \}\)[\s\S]*sd-coread-runtime-retry/, 'both first entry and in-flight warmup must render on completion and expose retry');
assert.match(source, /case 'coread': return COREAD_ENABLED \? \(reader \? renderCoreadTab\(\) : renderCoreadRuntimeGate\(\)\)/, 'the companion page must not render reader-dependent content before its parser is ready');
assert.match(source, /function bindCoreadTabEvents\(root\) \{[\s\S]*if \(!reader\) return;[\s\S]*bindLibraryViewEvents\(root\)/, 'the companion page must not bind reader-dependent actions before its parser is ready');

const interceptor = source.slice(source.indexOf('async function qianmuDirectorInterceptor(chat)'), source.indexOf('function directorMainlineStarted'));
assert.doesNotMatch(interceptor, /ensureCoreadReaderRuntime|coread/i, 'story generation must not load or consult the companion reader');

const initStart = source.indexOf('function init()');
const initEnd = source.indexOf('function destroy()');
const initSource = source.slice(initStart, initEnd);
assert.doesNotMatch(initSource, /ensureCoreadReaderRuntime\(/, 'normal startup must not eagerly parse the companion module');

console.log('Companion reader lazy-load contract OK');
