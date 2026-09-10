/**
 * search.js — finding things: what is in a directory, which files match a
 * name pattern, and which lines match a regular expression.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ToolFailure } from '../core/failure.js';
import {
  resolveIn, guard, result, fsFailure, looksBinary, bytes, walk, globToRegExp,
  SKIP, MAX_GLOB_HITS, MAX_GREP_HITS,
} from './shared.js';

export async function listDir({ path: p = '.' }) {
  const target = resolveIn(p || '.', 'list_dir');
  await guard(target, `list ${target.abs}`);
  const attempted = `listing ${target.show}`;

  let entries;
  try {
    entries = await fs.readdir(target.abs, { withFileTypes: true });
  } catch (err) {
    throw fsFailure(err, attempted, target.show);
  }

  const dirs = [];
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(`${entry.name}/`);
    } else if (entry.isFile()) {
      let size = '';
      try {
        size = ` (${bytes((await fs.stat(path.join(target.abs, entry.name))).size)})`;
      } catch {
        // A file that disappeared between the listing and the stat is not
        // worth failing the whole call over.
      }
      files.push(`${entry.name}${size}`);
    } else {
      files.push(`${entry.name} (link or device)`);
    }
  }

  dirs.sort();
  files.sort();

  return result(
    `${target.show}/\n${[...dirs, ...files].join('\n') || '(empty)'}`,
    `${dirs.length} dir${dirs.length === 1 ? '' : 's'}, ${files.length} file${files.length === 1 ? '' : 's'}`
  );
}

export async function glob({ pattern, path: p = '.' }) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'matching files by name',
      failed: 'The "pattern" argument was missing or empty.',
      fix: 'Pass something like "**/*.js" or "src/**/*.{ts,tsx}".',
    });
  }

  const target = resolveIn(p || '.', 'glob');
  await guard(target, `search ${target.abs}`);

  const re = globToRegExp(pattern.trim());
  // If the pattern names an ignored folder outright, the user meant it.
  const includeSkipped = [...SKIP].some((d) => pattern.includes(d));
  const all = await walk(target.abs, { includeSkipped });
  const matched = all.filter((rel) => re.test(rel));

  if (matched.length === 0) {
    return result(
      `Nothing matched "${pattern}" under ${target.show}. Looked at ${all.length} files; ` +
      'build and vendor folders are skipped unless the pattern names one.',
      'no matches'
    );
  }

  // Newest first: when hunting through an unfamiliar codebase, the files
  // somebody touched recently are nearly always the ones that matter.
  const dated = await Promise.all(
    matched.slice(0, 2000).map(async (rel) => {
      try {
        return { rel, at: (await fs.stat(path.join(target.abs, rel))).mtimeMs };
      } catch {
        return { rel, at: 0 };
      }
    })
  );
  dated.sort((a, b) => b.at - a.at);

  const shown = dated.slice(0, MAX_GLOB_HITS).map((f) => f.rel);
  const extra = matched.length > shown.length
    ? `\n[${matched.length - shown.length} more not shown]`
    : '';

  return result(
    shown.join('\n') + extra,
    `${matched.length} match${matched.length === 1 ? '' : 'es'}`
  );
}

export async function grep({ pattern, path: p = '.', glob: filter, ignore_case = false }) {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'searching file contents',
      failed: 'The "pattern" argument was missing or empty.',
      fix: 'Pass a regular expression, for example "function\\\\s+\\\\w+".',
    });
  }

  let re;
  try {
    re = new RegExp(pattern, ignore_case ? 'i' : '');
  } catch (err) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'searching file contents',
      failed: `"${pattern}" is not a valid regular expression: ${err.message}`,
      fix: 'Escape the metacharacters ( . * + ? [ ] ( ) { } | \\ ) or use a simpler pattern.',
      cause: err,
    });
  }

  const target = resolveIn(p || '.', 'grep');
  await guard(target, `search ${target.abs}`);

  const stat = await fs.stat(target.abs).catch((err) => {
    throw fsFailure(err, 'searching file contents', target.show);
  });

  let base = target.abs;
  let candidates;
  if (stat.isFile()) {
    base = path.dirname(target.abs);
    candidates = [path.basename(target.abs)];
  } else {
    candidates = await walk(target.abs);
    if (filter) {
      const fre = globToRegExp(filter);
      candidates = candidates.filter((rel) => fre.test(rel));
    }
  }

  const hits = [];
  const inFiles = new Set();

  for (const rel of candidates) {
    if (hits.length >= MAX_GREP_HITS) break;
    let buf;
    try {
      buf = await fs.readFile(path.join(base, rel));
    } catch {
      continue;
    }
    if (looksBinary(buf.subarray(0, 4096))) continue;

    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < MAX_GREP_HITS; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      inFiles.add(rel);
      const text = lines[i].trim();
      hits.push(`${rel}:${i + 1}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
    }
  }

  if (hits.length === 0) {
    return result(
      `No line matched /${pattern}/ under ${target.show}` +
      `${filter ? ` (limited to ${filter})` : ''}. Read ${candidates.length} files.`,
      'no matches'
    );
  }

  const capped = hits.length >= MAX_GREP_HITS
    ? `\n[stopped at ${MAX_GREP_HITS} matches — narrow the pattern, or pass a glob]`
    : '';

  return result(
    hits.join('\n') + capped,
    `${hits.length} match${hits.length === 1 ? '' : 'es'} in ` +
    `${inFiles.size} file${inFiles.size === 1 ? '' : 's'}`
  );
}
