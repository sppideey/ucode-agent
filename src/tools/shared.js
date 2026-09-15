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
// The request behind the call
// ---------------------------------------------------------------------------

/**
 * What the user asked for this turn, in their own words.
 *
 * A tool cannot normally see the request that led to it, and for almost
 * everything that is right — a tool should act on its arguments. The starter
 * is the exception. "Make me a plain HTML app" is not a preference to be
 * weighed against the convenience of a framework, but the model weighs it
 * anyway: it reads "app", reaches for the starter with the component library
 * in it, and the user waits through an npm install they explicitly said they
 * did not want. Keeping the request here lets create_app check the instruction
 * rather than trust the argument it was handed.
 */
let request = '';

export function setRequest(text) {
  request = String(text ?? '');
}

/** "plain html", "vanilla js", "simple static page". */
const WANTS_PLAIN = /\b(?:plain|pure|vanilla|static|simple|basic|raw|just)\s+(?:html|js|javascript|css)\b/i;
/** "an html app", "one html page". */
const HTML_THING = /\bhtml\s+(?:app|page|site|website|file|thing)\b/i;
/** "no framework", "without react", "don't use next". */
const NO_FRAMEWORK =
  /\b(?:no|without|not?\s+use|don'?t\s+use|do\s+not\s+use|skip)\s+(?:a\s+|any\s+)?(?:framework|frameworks|react|next\.?js|next|npm|node|build\s+step|bundler)\b/i;
/** Naming one on purpose outranks every hint above. */
const NAMES_FRAMEWORK = /\b(?:next\.?js|nextjs|react|tailwind|shadcn|typescript|database|api\s+routes?|server\s+side|auth)\b/i;

/**
 * Did the user rule out a framework in so many words?
 *
 * Saying "no react" settles it on its own. Asking for "an html app" settles it
 * only when the same breath does not also ask for Next.js — "export this
 * Next.js app as static html" names the framework on purpose, and a request
 * that specific is not one to overrule.
 */
export function askedForPlainHtml() {
  if (NO_FRAMEWORK.test(request)) return true;
  if (!WANTS_PLAIN.test(request) && !HTML_THING.test(request)) return false;
  return !NAMES_FRAMEWORK.test(request);
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

// ---------------------------------------------------------------------------
// Files as ucode last left them
// ---------------------------------------------------------------------------

/**
 * abs path -> the modification time ucode last saw, after reading or writing it.
 *
 * An agent that rewrites a whole file is trusting that the file still says what
 * it said when it was read. That holds right up until someone has the editor
 * open beside the terminal, saves a change mid-turn, and has it overwritten
 * without a word — the one failure here that costs work nobody can get back,
 * since the undo only holds what the turn itself replaced.
 *
 * So every read and every write leaves a stamp, and a whole-file overwrite
 * checks it first. Edits do not need the check: they read the file again a
 * moment before they touch it, and match their old_string against what is
 * actually there.
 */
const known = new Map();

/** Record a file as ucode now knows it. Never throws: a missing stamp only costs the check. */
export async function noteFile(abs) {
  try {
    known.set(abs, (await fs.stat(abs)).mtimeMs);
  } catch {
    known.delete(abs);
  }
}

/**
 * Write a file and stamp it, so the next overwrite knows this change was ours.
 *
 * @param {string} abs
 * @param {string} data
 * @param {BufferEncoding} [encoding]
 */
export async function writeTracked(abs, data, encoding = 'utf8') {
  await fs.writeFile(abs, data, encoding);
  await noteFile(abs);
}

/** Forget a file, so the next write to it goes through unchallenged. */
export function forgetFile(abs) {
  known.delete(abs);
}

/**
 * Refuse to overwrite a file that somebody else has changed since ucode read it.
 *
 * Only ever fires once per file: the stamp is dropped on the way out, so the
 * model reads the file again — which is what the message tells it to do — and
 * the next attempt writes normally. A file ucode has never seen is not guarded,
 * because there is nothing to compare it against and a first write is not a
 * clobber.
 */
export async function assertUnchanged(abs, show) {
  const seen = known.get(abs);
  if (seen === undefined) return;

  let now;
  try {
    now = (await fs.stat(abs)).mtimeMs;
  } catch {
    return; // gone, or unreadable — the write itself will say so
  }
  // Filesystems report times at different resolutions; a millisecond of slack
  // costs nothing and stops a same-second write reading as someone else's.
  if (Math.abs(now - seen) < 1) return;

  known.delete(abs);
  throw new ToolFailure({
    kind: 'changed_on_disk',
    attempted: `overwriting ${show}`,
    failed: `${show} has changed on disk since you last read it — someone else has edited it.`,
    fix:
      `Read ${show} again, fold your change into what is there now, and write it once more. ` +
      'Writing the version you had would throw their edit away.',
  });
}
