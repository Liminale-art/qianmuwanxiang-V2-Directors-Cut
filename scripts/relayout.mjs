// Moves tracked files between folders and rewrites every literal relative reference to them.
// Dry run by default; pass --apply to write. Moves come from a JSON file: [{"from":"a.js","to":"server/a.js"}].
//
//   node scripts/relayout.mjs moves.json            # report planned rewrites, change nothing
//   node scripts/relayout.mjs moves.json --apply    # git mv + rewrite, then run the full suite
//
// Revert a batch with `git revert <commit>`; the tool never deletes content.
// Only literal string references are rewritten. Anything else that names a moved file
// (computed URLs, regexes, bare names in prose) is reported as "unresolved" for manual review,
// and --apply refuses to run while unresolved references remain unless --allow-unresolved is given.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = path.posix;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const TEXT = /\.(?:m?js|css|json|html|sh|ps1)$/;

function relativeSpecifier(fromFile, target) {
  let rel = posix.relative(posix.dirname(fromFile), target);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

export async function planRelayout(moves) {
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  const trackedSet = new Set(tracked);
  const map = new Map();
  for (const { from, to } of moves) {
    if (!trackedSet.has(from)) throw new Error(`not tracked: ${from}`);
    if (trackedSet.has(to) || map.has(from)) throw new Error(`target exists or duplicate: ${to}`);
    if (posix.basename(from) !== posix.basename(to)) throw new Error(`renaming is not supported, only moving: ${from}`);
    map.set(from, to);
  }
  const newPath = file => map.get(file) || file;
  const names = new Map([...map.keys()].map(file => [posix.basename(file), file]));
  const edits = new Map(), unresolved = [];
  const escaped = [...names.keys()].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Any quoted relative specifier ("./x", "../a/b.js", optional ?query) that resolves to a tracked file.
  const literal = /(['"`])((?:\.{1,2}\/)+[^'"`\s?#${}]+)((?:\?[^'"`\s]*)?)\1/g;
  const mention = new RegExp(`(?:^|[^A-Za-z0-9_-])(${escaped})(?![A-Za-z0-9_-])`, 'g');
  for (const file of tracked.filter(file => TEXT.test(file) && file !== 'MODULES.md')) {
    const source = await readFile(path.join(root, file), 'utf8');
    let next = source;
    const notes = [];
    // One pass, resolved against the file's current location: a reference changes when either end moves.
    next = next.replace(literal, (whole, quote, specifier, query) => {
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!trackedSet.has(resolved) || (!map.has(resolved) && !map.has(file))) return whole;
      const replacement = relativeSpecifier(newPath(file), newPath(resolved));
      if (replacement === specifier) return whole;
      notes.push(`${specifier} -> ${replacement}`);
      return `${quote}${replacement}${query}${quote}`;
    });
    if (file === 'release-files.json') {
      next = next.replace(/"([^"]+)"/g, (whole, value) => map.has(value) ? (notes.push(`${value} -> ${map.get(value)}`), `"${map.get(value)}"`) : whole);
    }
    // Repo-root-relative forms that name a root file directly: browser checks served from the repo root
    // (`import('/x.js')`) and release-list assertions (`files.includes('x.js')`).
    next = next.replace(/(\bimport\(\s*)(['"])\/([\w.-]+)\2/g, (whole, head, quote, name) =>
      map.has(name) ? (notes.push(`/${name} -> /${map.get(name)}`), `${head}${quote}/${map.get(name)}${quote}`) : whole);
    next = next.replace(/(\bfiles\.includes\(\s*)(['"])([\w.-]+)\2/g, (whole, head, quote, name) =>
      map.has(name) ? (notes.push(`${name} -> ${map.get(name)} (release assertion)`), `${head}${quote}${map.get(name)}${quote}`) : whole);
    // Anything still naming a moved file outside a correctly resolving literal needs a human look.
    const targets = new Set(map.values());
    const home = posix.dirname(newPath(file));
    for (const line of next.split('\n')) {
      const rest = line
        .replace(literal, (whole, quote, specifier) => targets.has(posix.normalize(posix.join(home, specifier))) ? '' : whole)
        .replace(/"([^"]+)"/g, (whole, value) => file === 'release-files.json' && targets.has(value) ? '' : whole)
        .replace(/(['"])\/?([\w.-]+\/[\w./-]+)\1/g, (whole, quote, value) => targets.has(value) ? '' : whole);
      if ([...rest.matchAll(mention)].length) unresolved.push(`${file}: ${line.trim().slice(0, 160)}`);
    }
    if (next !== source) edits.set(file, { next, notes });
  }
  return { map, edits, unresolved: [...new Set(unresolved)] };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [movesFile] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  if (!movesFile) { console.error('usage: node scripts/relayout.mjs moves.json [--apply] [--allow-unresolved]'); process.exit(2); }
  const apply = process.argv.includes('--apply');
  const moves = JSON.parse(await readFile(movesFile, 'utf8'));
  const plan = await planRelayout(moves);
  let count = 0;
  for (const [file, { notes }] of plan.edits) { count += notes.length; console.log(`${file}: ${notes.length} rewrite(s)`); }
  console.log(`moves ${plan.map.size}, files edited ${plan.edits.size}, rewrites ${count}, unresolved ${plan.unresolved.length}`);
  for (const line of plan.unresolved) console.log(`  UNRESOLVED ${line}`);
  if (!apply) process.exit(0);
  if (plan.unresolved.length && !process.argv.includes('--allow-unresolved')) { console.error('refusing to apply with unresolved references'); process.exit(1); }
  if (git('status', '--porcelain', '--untracked-files=no').trim()) { console.error('working tree has tracked changes; commit or stash first'); process.exit(1); }
  for (const [from, to] of plan.map) {
    await mkdir(path.join(root, posix.dirname(to)), { recursive: true });
    execFileSync('git', ['mv', '--', from, to], { cwd: root });
  }
  for (const [file, { next }] of plan.edits) await writeFile(path.join(root, plan.map.get(file) || file), next);
  console.log('applied; now run the full test suite, entry budget and release dry run');
}
