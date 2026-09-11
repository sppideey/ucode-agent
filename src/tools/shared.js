/**
 * shared.js — the plumbing every tool sits on.
 *
 * Path resolution, the session root, confirmation, output caps, filesystem
 * errors worth reading, directory walking, glob matching, and the line diff
 * that makes an edit visible. Nothing here is a tool; everything here is what
 * the tools are built out of.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ToolFailure, Declined } from '../core/failure.js';

/**
 * How much of a result the model may see.
 *
 * File reads get a larger budget than everything else on purpose. Starving the
 * model of the file it is about to edit costs far more — in wrong edits and in
 * extra round trips — than the tokens it saves. A runaway build log still
 * needs a firm lid, which is what the smaller cap is for.
 */
export const MAX_OUTPUT = Number(process.env.UCODE_MAX_TOOL_OUTPUT) || 12_000;
export const MAX_FILE_OUTPUT = Number(process.env.UCODE_MAX_FILE_OUTPUT) || 48_000;

export const READ_LINES = 600;
export const MAX_GLOB_HITS = 200;
export const MAX_GREP_HITS = 100;

/** Directories nobody means to search. */
export const SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.nuxt', '.svelte-kit', '.cache', 'coverage', '__pycache__',
  '.venv', 'venv', '.tox', '.pytest_cache', 'target', '.gradle', '.idea',
  'vendor', 'Pods', '.terraform',
]);

// ---------------------------------------------------------------------------
// Session root
// ---------------------------------------------------------------------------

let root = process.cwd();

export function setRoot(dir) {
  root = path.resolve(dir);
  return root;
}

export function getRoot() {
  return root;
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * The UI installs the real prompt here. Keeping it as an injection point means
 * no tool owns a readline instance, and all of them stay testable.
 */
let asker = null;

export function setConfirm(fn) {
  asker = fn;
}

export async function confirm(action, detail, risk = 'write') {
  if (!asker) {
    throw new ToolFailure({
      kind: 'cannot_ask',
      attempted: action,
      failed: 'That needs the user to approve it, and there is no way to ask them from here.',
      fix: 'Run ucode in a terminal so it can prompt before acting.',
    });
  }
  if (!(await asker({ action, detail, risk }))) throw new Declined(action);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function resolveIn(input, tool, argName = 'path') {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: `running ${tool}`,
      failed: `The "${argName}" argument was missing or was not a string.`,
      fix: `Call ${tool} again with ${argName} set to a path relative to the project root.`,
    });
  }
  const abs = path.resolve(root, input.trim());
  const rel = path.relative(root, abs);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return {
    abs,
    inside,
    // Short when it is in the project, fully spelled out when it is not — the
    // display string is also the warning.
    show: inside ? (rel === '' ? '.' : rel.split(path.sep).join('/')) : abs,
  };
}

/** Reaching outside the folder ucode was started in always needs a yes. */
export async function guard(target, action) {
  if (target.inside) return;
  await confirm(action, `${target.abs}\nThat is outside this session's root (${root}).`, 'outside');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function cap(text, limit = MAX_OUTPUT) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n... [cut here — ${s.length - limit} more characters]`;
}

/** Every tool resolves to this shape: what the model reads, plus a one-liner. */
export function result(content, summary, limit = MAX_OUTPUT) {
  return { content: cap(content, limit), summary };
}

// ---------------------------------------------------------------------------
// Filesystem errors, translated
// ---------------------------------------------------------------------------

export function fsFailure(err, attempted, target) {
  const code = err?.code;
  const common = { attempted, cause: err };

  if (code === 'ENOENT') {
    return new ToolFailure({
      ...common,
      kind: 'not_found',
      failed: `Nothing exists at ${target}.`,
      fix: 'Check the path with list_dir or glob first. Paths are relative to the project root.',
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ToolFailure({
      ...common,
      kind: 'permission_denied',
      failed: `The operating system refused access to ${target} (${code}).`,
      fix: 'Check the permissions, or whether another program has the file open and locked.',
    });
  }
  if (code === 'EISDIR') {
    return new ToolFailure({
      ...common,
      kind: 'is_directory',
      failed: `${target} is a directory, not a file.`,
      fix: 'Use list_dir to see inside it.',
    });
  }
  if (code === 'ENOTDIR') {
    return new ToolFailure({
      ...common,
      kind: 'not_directory',
      failed: `Something along the path ${target} is a file, not a directory.`,
      fix: 'Re-check each segment of the path with list_dir.',
    });
  }
  return new ToolFailure({
    ...common,
    kind: 'io_error',
    failed: `${code ? `${code}: ` : ''}${err?.message ?? String(err)}`,
    fix: 'Confirm the path exists and is readable, then try once more.',
  });
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export const looksBinary = (buf) => buf.includes(0);

/**
 * Split into lines the way a person counts them: a file ending in a newline
 * has that many lines, not one more empty one at the bottom.
 */
export function toLines(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function clip(text, n = 60) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

/**
 * The changed region between two texts, with real line numbers on both sides.
 *
 * No diff algorithm is needed for what the tools actually do. Trimming the
 * identical lines off the top and the bottom leaves exactly the block that
 * changed, and the trimmed counts are the line numbers — removed lines
 * numbered where they were in the old file, added lines numbered where they
 * now are in the new one. Getting that right matters: a diff whose numbers
 * are decorative is worse than a diff with no numbers, because it invites you
 * to jump to a line that has nothing to do with the change.
 */
export function changedRegion(oldText, newText) {
  const before = toLines(oldText);
  const after = toLines(newText);

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;

  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;

  return {
    removed: before.slice(head, before.length - tail).map((text, i) => ({ n: head + i + 1, text })),
    added: after.slice(head, after.length - tail).map((text, i) => ({ n: head + i + 1, text })),
  };
}

/**
 * Render a change for the screen as `-12| old` / `+12| new` rows.
 *
 * `offset` shifts both sides when the region being diffed is an excerpt rather
 * than a whole file — an edit_file replacement knows the line it landed on, so
 * the numbers shown are the file's numbers rather than the excerpt's.
 * A row with no number is a note about what was left out, never part of the
 * change itself.
 */
export function renderDiff({ removed, added }, { offset = 0, max = 16 } = {}) {
  const out = [];
  const room = Math.max(2, Math.floor(max / 2));

  for (const line of removed.slice(0, room)) out.push(`-${line.n + offset}| ${line.text}`);
  if (removed.length > room) out.push(`-… ${removed.length - room} more removed`);

  for (const line of added.slice(0, room)) out.push(`+${line.n + offset}| ${line.text}`);
  if (added.length > room) out.push(`+… ${added.length - room} more added`);

  return out;
}

/** The first lines of a brand-new file, so creating one shows something. */
export function renderNewFile(content, max = 16) {
  const lines = toLines(content);
  const out = lines.slice(0, max).map((text, i) => `+${i + 1}| ${text}`);
  if (lines.length > max) out.push(`+… ${lines.length - max} more lines`);
  return out;
}

// ---------------------------------------------------------------------------
// Walking and globbing
// ---------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A small glob: `**`, `*`, `?` and `{a,b}`. */
export function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:[^/]*/)*'; i += 3; }  // spans directories
        else { re += '.*'; i += 2; }
      } else { re += '[^/]*'; i += 1; }
    } else if (c === '?') {
      re += '[^/]'; i += 1;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) { re += '\\{'; i += 1; }
      else {
        const alts = pattern.slice(i + 1, end).split(',').map((a) => escapeRe(a.trim()));
        re += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else {
      re += escapeRe(c); i += 1;
    }
  }
  // Windows paths are case-insensitive, so matching should be too.
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

/**
 * Every file under a directory, as posix-style relative paths.
 * Build and vendor folders are skipped unless the caller says otherwise, and
 * an unreadable directory is stepped over rather than aborting the walk.
 */
export async function walk(base, { includeSkipped = false, limit = 20_000 } = {}) {
  const files = [];
  let level = [''];

  // A level of the tree at a time, with every directory on that level read at
  // once. Reading them one after another spends most of a large walk waiting
  // on the disk for directories that did not depend on each other.
  while (level.length && files.length < limit) {
    const next = [];
    for (let i = 0; i < level.length && files.length < limit; i += WALK_WIDTH) {
      const slice = level.slice(i, i + WALK_WIDTH);
      const listed = await Promise.all(slice.map((relDir) =>
        fs.readdir(path.join(base, relDir), { withFileTypes: true }).then(
          (entries) => ({ relDir, entries }),
          () => ({ relDir, entries: [] })   // unreadable: step over it
        )
      ));

      // Results are consumed in the order the directories were queued, so the
      // walk comes out the same every time however the reads finished.
      for (const { relDir, entries } of listed) {
        for (const entry of entries) {
          const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (!includeSkipped && SKIP.has(entry.name)) continue;
            next.push(rel);
          } else if (entry.isFile()) {
            files.push(rel);
          }
        }
      }
    }
    level = next;
  }

  return files.slice(0, limit);
}

/** How many directories, or files, are read at the same time. */
export const WALK_WIDTH = 32;
