#!/usr/bin/env node

/**
 * BUILD GUARD — every local module a source file imports must actually be in
 * the repository, and must not be empty.
 *
 * This exists because the exact same class of bug shipped to production twice:
 *
 *   - `lib/transaction-store.js` was require()d by server.js and imported by
 *     four /api functions, but the file was never committed. Everything worked
 *     on the author's laptop (where the file existed, untracked) and every
 *     Vercel deployment crashed with ERR_MODULE_NOT_FOUND on cold start.
 *   - `lib/ledger.js` WAS committed, but as a ZERO-BYTE file, so
 *     `ledger.addTransaction` was undefined and the gateway 500'd on the first
 *     request. A plain "does the file exist?" check would have missed it.
 *
 * So a simple `fs.existsSync` is not enough. A local checkout is not the
 * deployment: what gets deployed is what git tracks. This script therefore
 * resolves each dependency against `git ls-files` — the file must be TRACKED,
 * present and non-empty.
 *
 * It also verifies that every `dest` in vercel.json points at a real tracked
 * file, since a route to a missing function is a 404 that only appears in
 * production.
 *
 * Run it in CI (and in `npm test`) so the build fails here, loudly, instead of
 * at 2am in a serverless cold start.
 *
 *   node scripts/verify-module-graph.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const problems = [];

function fail(message) {
  failures++;
  problems.push(message);
  console.error(`  ✗ ${message}`);
}

/** Files git actually tracks — i.e. what a fresh clone / deployment receives. */
function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return new Set(output.split('\0').filter(Boolean));
}

let tracked;
let gitAvailable = true;
try {
  tracked = trackedFiles();
} catch (error) {
  // Never block a build just because git is unavailable (e.g. a shallow
  // artifact-only build context). Fall back to on-disk checks and say so.
  gitAvailable = false;
  tracked = null;
  console.warn(`! git is unavailable (${error.message}); falling back to on-disk checks only.`);
}

/** Source files whose dependencies we verify. */
function sourceFiles() {
  if (tracked) {
    return [...tracked].filter(f => /\.(js|mjs|cjs)$/.test(f) && !f.startsWith('node_modules/'));
  }
  const output = execFileSync(
    'find',
    ['.', '-name', 'node_modules', '-prune', '-o', '-type', 'f', '-name', '*.js', '-print',
      '-o', '-type', 'f', '-name', '*.mjs', '-print'],
    { cwd: root, encoding: 'utf8' }
  );
  return output.split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
}

/**
 * Find local dependencies: require('./x'), require('../x'),
 * import ... from './x', await import('./x'), export ... from './x'.
 * Bare specifiers (express, @supabase/supabase-js) are npm's problem, not ours.
 */
function localDependencies(source) {
  const specifiers = new Set();
  const patterns = [
    /\brequire\(\s*['"](\.[^'"]*)['"]\s*\)/g,
    /\bfrom\s*['"](\.[^'"]*)['"]/g,
    /\bimport\(\s*['"](\.[^'"]*)['"]\s*\)/g,
    /\bimport\s*['"](\.[^'"]*)['"]/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      // Skip a require()/import that is itself inside a string literal — the
      // test suite asserts on source text like `includes("require('./lib/x')")`,
      // which is an assertion about code, not an actual dependency.
      const previousChar = match.index > 0 ? source[match.index - 1] : '';
      if (previousChar === '"' || previousChar === "'" || previousChar === '`') continue;
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

/** Strip comments so a documented example path is not mistaken for a real import. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Resolve a specifier the way Node would: exact path, then .js/.mjs/.cjs/.json,
 * then <dir>/index.*  — returning the repo-relative path that satisfied it.
 */
function resolveSpecifier(fromFile, specifier) {
  const base = path.join(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    path.join(base, 'index.js'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs')
  ];

  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    const absolute = path.join(root, normalized);
    const existsOnDisk = existsSync(absolute) && statSync(absolute).isFile();
    const isTracked = tracked ? tracked.has(normalized) : existsOnDisk;
    if (isTracked && existsOnDisk) return { resolved: normalized, absolute };
    // Present locally but NOT committed: the exact transaction-store bug.
    if (existsOnDisk && !isTracked) {
      return { resolved: normalized, absolute, untracked: true };
    }
  }
  return null;
}

console.log('# Local module graph');

for (const file of sourceFiles().sort()) {
  const absolute = path.join(root, file);
  if (!existsSync(absolute)) continue;

  const source = stripComments(readFileSync(absolute, 'utf8'));

  for (const specifier of localDependencies(source)) {
    const match = resolveSpecifier(file, specifier);

    if (!match) {
      fail(`${file} imports '${specifier}', which does not exist in the repository`);
      continue;
    }
    if (match.untracked) {
      fail(
        `${file} imports '${specifier}' -> ${match.resolved}, which exists locally but is NOT ` +
          'tracked by git. It will be missing from the deployment. ' +
          `Run: git add ${match.resolved}`
      );
      continue;
    }
    if (statSync(match.absolute).size === 0) {
      fail(`${file} imports '${specifier}' -> ${match.resolved}, which is an EMPTY file (0 bytes)`);
    }
  }
}

// ------------------------------------------------------- vercel.json routing
console.log('# vercel.json routes');

const vercelConfigPath = path.join(root, 'vercel.json');
if (existsSync(vercelConfigPath)) {
  let config;
  try {
    config = JSON.parse(readFileSync(vercelConfigPath, 'utf8'));
  } catch (error) {
    fail(`vercel.json is not valid JSON: ${error.message}`);
  }

  for (const route of (config && config.routes) || []) {
    const dest = route && route.dest;
    // Only literal file destinations are checkable; skip captures/rewrites.
    if (!dest || !/\.(js|mjs|cjs)$/.test(dest) || dest.includes('$')) continue;

    const relative = path.normalize(dest.replace(/^\//, ''));
    const absolute = path.join(root, relative);
    const existsOnDisk = existsSync(absolute);
    const isTracked = tracked ? tracked.has(relative) : existsOnDisk;

    if (!existsOnDisk) {
      fail(`vercel.json routes '${route.src}' to '${dest}', which does not exist`);
    } else if (!isTracked) {
      fail(
        `vercel.json routes '${route.src}' to '${dest}', which is not tracked by git ` +
          `(run: git add ${relative})`
      );
    } else if (statSync(absolute).size === 0) {
      fail(`vercel.json routes '${route.src}' to '${dest}', which is an EMPTY file (0 bytes)`);
    }
  }
}

// --------------------------------------------------------- empty tracked files
console.log('# Empty source files');

for (const file of (tracked ? [...tracked] : []).sort()) {
  if (!/\.(js|mjs|cjs)$/.test(file)) continue;
  const absolute = path.join(root, file);
  if (existsSync(absolute) && statSync(absolute).size === 0) {
    fail(`${file} is tracked but EMPTY (0 bytes) — it exports nothing`);
  }
}

if (failures) {
  console.error(`\n${failures} broken module reference(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nA module that is missing, untracked or empty deploys as a crash. Fix the ' +
      'references above before merging.'
  );
  process.exit(1);
}

console.log(
  `\n✓ Every local import resolves to a tracked, non-empty file${
    gitAvailable ? '' : ' (on-disk check only — git was unavailable)'
  }.`
);
