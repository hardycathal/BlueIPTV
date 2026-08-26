#!/usr/bin/env node
/**
 * Static parse check.
 *
 * Parses every application source file with Babel, configured for ES modules and
 * JSX. Catches syntax errors before they reach a device build, which on a React
 * Native project is otherwise a slow feedback loop.
 *
 * Deliberately not a linter and not a test suite. It verifies one thing and
 * says so, rather than implying coverage that does not exist.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');

const ROOT = process.cwd();
const DIRS = [
  'components',
  'context',
  'database',
  'navigation',
  'screens',
  'services',
  'utils',
  'plugins',
];
const ROOT_FILES = ['App.js', 'index.js', 'theme.js'];
const EXTS = new Set(['.js', '.jsx', '.mjs']);

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // directory absent is not a failure
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (EXTS.has(extname(full))) acc.push(full);
  }
  return acc;
}

const files = [
  ...ROOT_FILES.map((f) => join(ROOT, f)).filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  }),
  ...DIRS.flatMap((d) => walk(join(ROOT, d))),
];

if (files.length === 0) {
  console.error('No source files found. Check the working directory.');
  process.exit(1);
}

let failed = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  try {
    parse(readFileSync(file, 'utf8'), {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'classProperties', 'objectRestSpread', 'optionalChaining',
                'nullishCoalescingOperator', 'dynamicImport'],
    });
    console.log(`  ok    ${rel}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${rel}`);
    console.error(`        ${err.message}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} files parsed cleanly.`);

if (failed > 0) {
  console.error(`${failed} file(s) failed to parse.`);
  process.exit(1);
}
