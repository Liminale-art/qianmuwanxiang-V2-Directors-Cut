#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

function portablePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function safeRelativePath(value, label = 'path') {
  const portable = portablePath(value);
  const parts = portable.split('/').filter(Boolean);
  if (!portable || path.isAbsolute(value) || parts.includes('..') || portable.startsWith('/')) {
    throw new Error(`${label} must stay inside the project: ${value}`);
  }
  return parts.join('/');
}

function inside(base, relative) {
  const target = path.resolve(base, ...safeRelativePath(relative).split('/'));
  const prefix = `${path.resolve(base)}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error(`path escaped its boundary: ${relative}`);
  return target;
}

async function walkDirectory(root, relative, output = []) {
  const directory = inside(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = portablePath(path.posix.join(portablePath(relative), entry.name));
    if (entry.isSymbolicLink()) throw new Error(`release directories may not contain symlinks: ${child}`);
    if (entry.isDirectory()) await walkDirectory(root, child, output);
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

export async function loadReleaseConfig(root = PROJECT_ROOT) {
  const raw = await readFile(path.join(root, 'release-files.json'), 'utf8');
  const config = JSON.parse(raw);
  if (config?.schemaVersion !== 1) throw new Error('unsupported release-files schema');
  if (!Array.isArray(config.files) || !Array.isArray(config.directories)) throw new Error('release whitelist is incomplete');
  return config;
}

export async function collectReleaseFiles(root = PROJECT_ROOT, config = null) {
  config ||= await loadReleaseConfig(root);
  const files = new Set(config.files.map((item) => safeRelativePath(item, 'release file')));
  for (const directory of config.directories) {
    const safeDirectory = safeRelativePath(directory, 'release directory');
    for (const file of await walkDirectory(root, safeDirectory)) files.add(file);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function localReferences(file, text) {
  const references = [];
  if (file.endsWith('.js')) {
    const matcher = /(?:\bfrom\s*|\bimport\s*\()\s*['"](\.\/[^'"]+)['"]/g;
    for (const match of text.matchAll(matcher)) references.push(match[1]);
    const assetMatcher = /\bnew\s+URL\(\s*['"](\.\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    for (const match of text.matchAll(assetMatcher)) references.push(match[1]);
  }
  if (file.endsWith('.css')) {
    const matcher = /url\(\s*['"]?([^'"\)]+)['"]?\s*\)/g;
    for (const match of text.matchAll(matcher)) {
      const value = match[1].trim();
      if (!/^(?:data:|https?:|#|var\()/i.test(value)) references.push(value);
    }
  }
  if (file === 'manifest.json') {
    const manifest = JSON.parse(text);
    if (manifest.js) references.push(manifest.js);
    if (manifest.css) references.push(manifest.css);
  }
  return references;
}

function referencedFile(fromFile, reference) {
  const clean = String(reference).split(/[?#]/, 1)[0];
  if (!clean || clean.startsWith('/') || clean.startsWith('../')) return '';
  return portablePath(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean)));
}

export async function validateReleasePlan(root = PROJECT_ROOT, config = null, files = null) {
  config ||= await loadReleaseConfig(root);
  files ||= await collectReleaseFiles(root, config);
  const forbiddenSegments = new Set((config.forbiddenSegments || []).map(portablePath));
  const forbiddenFiles = new Set((config.forbiddenFiles || []).map(portablePath));
  const fileSet = new Set(files);
  const missing = [];
  const invalid = [];
  const dangling = [];

  for (const file of files) {
    const normalized = safeRelativePath(file, 'planned file');
    const parts = normalized.split('/');
    if (parts.some((part) => forbiddenSegments.has(part)) || forbiddenFiles.has(normalized)) invalid.push(normalized);
    let stat;
    try { stat = await lstat(inside(root, normalized)); }
    catch (_) { missing.push(normalized); continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) invalid.push(normalized);
    if (!/\.(?:js|css|json)$/.test(normalized)) continue;
    const text = await readFile(inside(root, normalized), 'utf8');
    for (const reference of localReferences(normalized, text)) {
      const dependency = referencedFile(normalized, reference);
      if (dependency && !fileSet.has(dependency)) dangling.push(`${normalized} -> ${dependency}`);
    }
  }

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!manifest.version || manifest.version !== packageJson.version) invalid.push('manifest/package version mismatch');
  for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'manifest.json', 'index.js', 'style.css']) {
    if (!fileSet.has(required)) missing.push(required);
  }
  if (missing.length || invalid.length || dangling.length) {
    throw new Error([
      missing.length ? `missing: ${[...new Set(missing)].join(', ')}` : '',
      invalid.length ? `forbidden/invalid: ${[...new Set(invalid)].join(', ')}` : '',
      dangling.length ? `unlisted dependencies: ${[...new Set(dangling)].join(', ')}` : '',
    ].filter(Boolean).join('\n'));
  }
  return { manifest, packageJson, files };
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function outputFiles(root, relative = '', output = []) {
  const directory = relative ? inside(root, relative) : root;
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = portablePath(path.posix.join(relative, entry.name));
    if (entry.isDirectory()) await outputFiles(root, child, output);
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

export async function buildRelease({ root = PROJECT_ROOT, dryRun = false } = {}) {
  const config = await loadReleaseConfig(root);
  const plan = await validateReleasePlan(root, config);
  const outputRoot = inside(root, safeRelativePath(config.outputDirectory, 'output directory'));
  const folderName = `${safeRelativePath(config.bundleName, 'bundle name')}-v${plan.manifest.version}`;
  const destination = inside(outputRoot, folderName);
  if (dryRun) return { ...plan, destination, dryRun: true };

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of plan.files) {
    const target = inside(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(inside(root, file), target);
  }

  const releaseInfo = {
    schemaVersion: 1,
    name: plan.manifest.display_name,
    version: plan.manifest.version,
    package: config.bundleName,
    source: plan.manifest.homePage,
    fileCount: plan.files.length,
  };
  await writeFile(path.join(destination, 'release-info.json'), `${JSON.stringify(releaseInfo, null, 2)}\n`, 'utf8');
  const copied = await outputFiles(destination);
  const checksums = [];
  for (const file of copied) checksums.push(`${await sha256(inside(destination, file))}  ${file}`);
  await writeFile(path.join(destination, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8');
  return { ...plan, destination, checksums: checksums.length, dryRun: false };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  buildRelease().then((result) => {
    console.log(JSON.stringify({ version: result.manifest.version, files: result.files.length, destination: result.destination }, null, 2));
  }).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
