// SPDX-License-Identifier: AGPL-3.0-only - ucode, made and tested by om dixit. Additional terms: see NOTICE.
/**
 * search.js — finding things: what is in a directory, which files match a
 * name pattern, and which lines match a regular expression.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ToolFailure } from '../core/failure.js';
import {
  resolveIn, guard, result, fsFailure, looksBinary, bytes, walk, globToRegExp,
  SKIP, MAX_GLOB_HITS, MAX_GREP_HITS, WALK_WIDTH,
} from './shared.js';

/** Whether `rg` runs here, asked once. UCODE_RIPGREP=0 never uses it. */
let hasRipgrep;
function ripgrepReady() {
  if (process.env.UCODE_RIPGREP === '0') return Promise.resolve(false);
  hasRipgrep ??= new Promise((resolve) => {
    const child = spawn('rg', ['--version'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return hasRipgrep;
}

/**
 * The same search through ripgrep, with the same rules as the walk below: the
 * same folders skipped, hidden files and .gitignored ones searched, the same
 * line format. Resolves to { hits, files }, or null when ripgrep is missing or
 * cannot read the pattern.
 */
async function ripgrep(pattern, dir, { filter, ignoreCase }) {
  if (!(await ripgrepReady())) return null;
  const args = ['--line-number', '--no-heading', '--color', 'never', '--hidden', '--no-ignore', '--sort', 'path'];
  for (const skip of SKIP) args.push('-g', `!${skip}/`);
  if (filter) args.push('-g', filter);
  if (ignoreCase) args.push('-i');
  args.push('-e', pattern, '--', '.');

  return new Promise((resolve) => {
    const hits = [];
    const files = new Set();
    let rest = '';
    let done = false;
    const child = spawn('rg', args, { cwd: dir, windowsHide: true });
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    child.on('error', () => finish(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        const m = /^(.*?):(\d+):(.*)$/.exec(line);
        if (!m || hits.length >= MAX_GREP_HITS) continue;
        const rel = m[1].replace(/^\.[\\/]/, '').replace(/\\/g, '/');
        const text = m[3].trim();
        files.add(rel);
        hits.push(`${rel}:${m[2]}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
      }
      if (hits.length >= MAX_GREP_HITS) { child.kill(); finish({ hits, files: files.size }); }
    });
    // 0 found, 1 nothing found, 2 an error such as a pattern it cannot read.
    child.on('close', (code) => finish(code === 0 || code === 1 || hits.length ? { hits, files: files.size } : null));
  });
}

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

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`);

  // Every size looked up at once rather than one stat after another.
  const files = await Promise.all(
    entries
      .filter((e) => !e.isDirectory())
      .map(async (entry) => {
        if (!entry.isFile()) return `${entry.name} (link or device)`;
        try {
          return `${entry.name} (${bytes((await fs.stat(path.join(target.abs, entry.name))).size)})`;
        } catch {
          // A file that disappeared between the listing and the stat is not
          // worth failing the whole call over.
          return entry.name;
        }
      })
  );

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

  // A directory goes to ripgrep when it is installed: it is many times faster
  // on a real project. A pattern ripgrep reads differently (lookarounds,
  // back-references) makes it fail, and the search below runs instead.
  if (!stat.isFile()) {
    const fast = await ripgrep(pattern, target.abs, { filter, ignoreCase: ignore_case });
    if (fast) {
      if (!fast.hits.length) {
        return result(`No line matched /${pattern}/ under ${target.show}${filter ? ` (limited to ${filter})` : ''}.`, 'no matches');
      }
      const capped = fast.hits.length >= MAX_GREP_HITS
        ? `\n[stopped at ${MAX_GREP_HITS} matches — narrow the pattern, or pass a glob]`
        : '';
      return result(
        fast.hits.join('\n') + capped,
        `${fast.hits.length} match${fast.hits.length === 1 ? '' : 'es'} in ` +
        `${fast.files} file${fast.files === 1 ? '' : 's'}`
      );
    }
  }

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

  // Files are read a batch at a time rather than one after another — the
  // search itself is instant, it is the waiting on each read that adds up. The
  // batch is scanned in its original order, so the same search always lists
  // its matches the same way.
  for (let at = 0; at < candidates.length && hits.length < MAX_GREP_HITS; at += WALK_WIDTH) {
    const batch = candidates.slice(at, at + WALK_WIDTH);
    const read = await Promise.all(batch.map((rel) =>
      fs.readFile(path.join(base, rel)).then((buf) => ({ rel, buf }), () => ({ rel, buf: null }))
    ));

    for (const { rel, buf } of read) {
      if (hits.length >= MAX_GREP_HITS) break;
      if (!buf || looksBinary(buf.subarray(0, 4096))) continue;

      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < MAX_GREP_HITS; i++) {
        re.lastIndex = 0;
        if (!re.test(lines[i])) continue;
        inFiles.add(rel);
        const text = lines[i].trim();
        hits.push(`${rel}:${i + 1}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
      }
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
