/**
 * symbols.js — a map of what this codebase declares, so "where is the tip
 * calculated" is one lookup rather than five greps.
 *
 * grep finds every line that mentions a name; almost all of them are uses,
 * and the one that matters is the declaration. This reads each source file
 * once and records only the declarations: functions, classes, components,
 * types, and the route a Next.js page answers on.
 *
 * The scan is by pattern, not by a parser. A parser would be exact but would
 * mean carrying TypeScript itself and paying its start-up on every lookup;
 * declarations are one of the few things regular expressions read reliably,
 * because they sit at the start of a line in formatted code. What this can
 * miss is a declaration written unusually — and a miss costs a grep, which
 * is where we started.
 *
 * The index is held per directory and rebuilt when a file's modified time
 * moves, so an edit is picked up without a rescan of everything.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveIn, guard, result, walk } from './shared.js';

/** Files worth reading for declarations. */
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/i;

/** How much of a file to read; a declaration past this is a generated file's. */
const MAX_BYTES = 400_000;

const PATTERNS = [
  // export function foo(...) / export default function foo(...)
  { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  // class Foo / export class Foo
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  // const foo = (...) => / const foo = async (...) => / const foo = function
  { kind: 'function', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/ },
  // type Foo = / interface Foo / enum Foo
  { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[<=]/ },
  { kind: 'type', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  // Python
  { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  { kind: 'class', re: /^\s*class\s+([A-Za-z_][\w]*)/ },
];

/** A capitalised function in a .tsx file is a component, and worth saying so. */
const isComponent = (name, rel) => /^[A-Z]/.test(name) && /\.[jt]sx$/i.test(rel);

/**
 * The URL a Next.js app-router file answers on: src/app/blog/[slug]/page.tsx
 * is /blog/[slug]. Route groups in brackets-as-parens are not part of the path.
 */
export function routeFor(rel) {
  const m = rel.replace(/\\/g, '/').match(/(?:^|\/)app\/(.*)\/(page|route|layout)\.[jt]sx?$/i);
  if (!m) {
    if (/(?:^|\/)app\/(page|route|layout)\.[jt]sx?$/i.test(rel.replace(/\\/g, '/'))) return '/';
    return null;
  }
  const url = m[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s)).join('/');
  return `/${url}`;
}

/** Every declaration in one file's text, with the line it sits on. */
export function declarationsIn(rel, text) {
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const { kind, re } of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const name = m[1];
      found.push({
        name,
        kind: isComponent(name, rel) && kind === 'function' ? 'component' : kind,
        file: rel,
        line: i + 1,
        text: line.trim().slice(0, 160),
      });
      break; // one declaration to a line
    }
  }
  return found;
}

const indexes = new Map(); // root -> { files: Map<rel, {at, symbols}> }

/**
 * Read the declarations of every source file under `root`, reusing what was
 * read before for files whose modified time has not moved.
 */
export async function buildIndex(root) {
  let index = indexes.get(root);
  if (!index) { index = { files: new Map() }; indexes.set(root, index); }

  const rels = (await walk(root, {})).filter((rel) => SOURCE.test(rel));
  const seen = new Set();

  await Promise.all(rels.map(async (rel) => {
    seen.add(rel);
    const abs = path.join(root, rel);
    let stat;
    try { stat = await fs.stat(abs); } catch { return; }
    if (stat.size > MAX_BYTES) return;
    const had = index.files.get(rel);
    if (had && had.at === stat.mtimeMs) return; // unchanged since last time
    const text = await fs.readFile(abs, 'utf8').catch(() => null);
    if (text === null) return;
    index.files.set(rel, { at: stat.mtimeMs, symbols: declarationsIn(rel, text) });
  }));

  for (const rel of [...index.files.keys()]) if (!seen.has(rel)) index.files.delete(rel);

  const symbols = [];
  for (const { symbols: s } of index.files.values()) symbols.push(...s);
  return { symbols, fileCount: index.files.size };
}

/** Forget what was read, so the next lookup starts clean. */
export function clearIndex() { indexes.clear(); }

const KINDS = new Set(['function', 'class', 'type', 'component']);

/**
 * Where a name is declared. An exact match wins; failing that, anything
 * containing it, so a half-remembered name still lands.
 */
export async function findSymbol({ name, kind, path: p = '.' }) {
  const wanted = String(name ?? '').trim();
  if (!wanted) {
    return result('Pass the name of a function, component, class or type to look for.', 'nothing to look for');
  }

  const target = resolveIn(p || '.', 'find_symbol', 'path');
  await guard(target, `read ${target.abs}`);

  const { symbols, fileCount } = await buildIndex(target.abs);
  const pool = kind && KINDS.has(kind) ? symbols.filter((s) => s.kind === kind) : symbols;

  const lower = wanted.toLowerCase();
  let hits = pool.filter((s) => s.name === wanted);
  let how = 'exactly';
  if (!hits.length) {
    hits = pool.filter((s) => s.name.toLowerCase() === lower);
    how = 'ignoring case';
  }
  if (!hits.length) {
    hits = pool.filter((s) => s.name.toLowerCase().includes(lower));
    how = 'containing';
  }

  if (!hits.length) {
    return result(
      `Nothing declared as "${wanted}" in ${target.show} (read ${fileCount} source files).\n` +
      'It may be imported from a package, spelled differently, or built at runtime — grep will find uses.',
      'not declared here'
    );
  }

  hits.sort((a, b) => a.name.length - b.name.length || a.file.localeCompare(b.file));
  const shown = hits.slice(0, 25);
  const lines = shown.map((s) => {
    const route = routeFor(s.file);
    return `${s.file}:${s.line}  ${s.kind}  ${s.name}${route ? `  [route ${route}]` : ''}\n    ${s.text}`;
  });

  const more = hits.length > shown.length ? `\n[${hits.length - shown.length} more]` : '';
  return result(
    `Declared ${how} "${wanted}":\n\n${lines.join('\n')}${more}`,
    `${hits.length} declaration${hits.length === 1 ? '' : 's'}`
  );
}

/**
 * What a file declares, and what a folder's files declare — the shape of the
 * code without reading all of it.
 */
export async function outline({ path: p = '.' }) {
  const target = resolveIn(p || '.', 'outline', 'path');
  await guard(target, `read ${target.abs}`);

  const stat = await fs.stat(target.abs).catch(() => null);
  if (stat?.isFile()) {
    const text = await fs.readFile(target.abs, 'utf8').catch(() => '');
    const found = declarationsIn(target.show, text);
    if (!found.length) return result(`${target.show} declares nothing this can see.`, 'nothing declared');
    return result(
      `${target.show}\n` + found.map((s) => `  ${s.line}: ${s.kind} ${s.name}`).join('\n'),
      `${found.length} declaration${found.length === 1 ? '' : 's'}`
    );
  }

  const { symbols, fileCount } = await buildIndex(target.abs);
  if (!symbols.length) return result(`No declarations found under ${target.show}.`, 'nothing declared');

  const byFile = new Map();
  for (const s of symbols) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }

  const files = [...byFile.keys()].sort();
  const shown = files.slice(0, 60);
  const body = shown.map((f) => {
    const route = routeFor(f);
    const names = byFile.get(f).map((s) => s.name).slice(0, 12).join(', ');
    return `${f}${route ? `  [route ${route}]` : ''}\n  ${names}`;
  });

  const more = files.length > shown.length ? `\n[${files.length - shown.length} more files]` : '';
  return result(
    `${symbols.length} declarations across ${fileCount} files in ${target.show}:\n\n${body.join('\n')}${more}`,
    `${symbols.length} declarations`
  );
}
