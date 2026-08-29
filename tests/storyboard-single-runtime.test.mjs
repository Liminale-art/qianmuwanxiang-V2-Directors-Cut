import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

const quarantinedRuntimeModules = [
  'qianmu-storyboard-frame.js',
  'qianmu-storyboard-frame-ui.js',
  'qianmu-storyboard-integration.js',
  'qianmu-storyboard-config-modal.js',
  'qianmu-storyboard-config-ui.js',
  'qianmu-storyboard-style-injector.js',
  'qianmu-storyboard-storage.js',
];

for (const moduleName of quarantinedRuntimeModules) {
  const escaped = moduleName.replaceAll('.', '\\.');
  assert.doesNotMatch(
    source,
    new RegExp(`from ['"]\\./${escaped}`),
    `${moduleName} is an unfinished prototype and must not be linked into the production entry point`,
  );
}

assert.doesNotMatch(source, /\binitStoryboardIntegration\s*\(/, 'the prototype integration must not create a second floor observer');
assert.doesNotMatch(source, /\bcleanupStoryboardIntegration\s*\(/, 'production cleanup must not depend on the quarantined runtime');
assert.doesNotMatch(source, /\binjectAllStoryboardStyles\s*\(/, 'prototype styles must not be injected over the stable storyboard UI');
assert.doesNotMatch(source, /\bopenStoryboardConfigModal\s*\(/, 'the storyboard must not open a second configuration state store');

const configBinding = source.slice(
  source.indexOf("root.querySelector('.sd-storyboard-config-btn')"),
  source.indexOf("root.querySelectorAll('[data-storyboard-source]')"),
);
assert.match(configBinding, /state\.view = 'create'/, 'the configuration button must stay inside the stable storyboard workbench');
assert.match(configBinding, /saveSettings\(\)[\s\S]*renderModal\(\)/, 'the stable workbench remains the single persisted configuration surface');

assert.match(source, /storyboardInjectMessageButtons/, 'the mature chat-floor entry point must remain available');
assert.match(source, /storyboardHandleAutomaticCapture/, 'the mature automatic workflow must remain available');

console.log('Storyboard single-runtime contract OK');
