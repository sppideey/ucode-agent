/**
 * files.js — reading and changing files.
 *
 * The rule that matters most in here: an edit never guesses. Zero matches or
 * two matches is an error with an explanation, never a silent partial change.
 * A wrong edit that reports success is the single most expensive thing a
 * coding agent can do, because everything after it is built on a lie.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ToolFailure } from '../core/failure.js';
import {
  resolveIn, guard, result, fsFailure, looksBinary, toLines, bytes,
  changedRegion, renderDiff, renderNewFile, READ_LINES, MAX_FILE_OUTPUT,
} from './shared.js';
import { packageJsonWritten } from './shell.js';
import { parse as parseSource } from '@babel/parser';

export async function readFile({ path: p, offset = 1, limit = READ_LINES }) {
  const target = resolveIn(p, 'read_file');
  await guard(target, `read ${target.abs}`);
  const attempted = `reading ${target.show}`;

  let stat;
  try {
    stat = await fs.stat(target.abs);
  } catch (err) {
    throw fsFailure(err, attempted, target.show);
  }

  if (stat.isDirectory()) {
    throw new ToolFailure({
      kind: 'is_directory',
      attempted,
      failed: `${target.show} is a directory.`,
      fix: `Use list_dir with path "${target.show}" to see what is in it.`,
    });
  }

  let buf;
  try {
    buf = await fs.readFile(target.abs);
  } catch (err) {
    throw fsFailure(err, attempted, target.show);
  }

  if (looksBinary(buf.subarray(0, 8192))) {
    throw new ToolFailure({
      kind: 'binary',
      attempted,
      failed: `${target.show} is a binary file (${bytes(stat.size)}).`,
      fix: 'ucode reads text only. Inspect it with run_command and a tool built for the format.',
    });
  }

  const lines = toLines(buf.toString('utf8'));
  const from = Math.max(1, Math.floor(Number(offset) || 1));
  const count = Math.max(1, Math.floor(Number(limit) || READ_LINES));
  const slice = lines.slice(from - 1, from - 1 + count);

  if (slice.length === 0) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted,
      failed: `offset ${from} is past the end of the file, which has ${lines.length} lines.`,
      fix: `Read again with an offset between 1 and ${lines.length}.`,
    });
  }

  const last = from + slice.length - 1;
  const width = String(last).length;
  // The numbers are a gutter for the model to reason about, and they are
  // stated to be display-only in the tool description, because an edit whose
  // old_string still carries them will never match.
  const body = slice.map((line, i) => `${String(from + i).padStart(width)} | ${line}`).join('\n');

  const more = last < lines.length
    ? `\n\n[lines ${from}-${last} of ${lines.length}. Continue with offset=${last + 1}.]`
    : '';

  return result(
    body + more,
    more || from > 1 ? `lines ${from}-${last} of ${lines.length}` : `${lines.length} lines`,
    MAX_FILE_OUTPUT
  );
}

/**
 * Everything that writes a file ends here. A package.json with dependencies
 * starts its install in the background at once, while the rest of the app is
 * still being written.
 */
function written(target, content) {
  if (path.basename(target.abs) === 'package.json') packageJsonWritten(target.abs, content);
}

const PARSEABLE = /\.(?:[cm]?[jt]sx?)$/i;

/**
 * Does this source parse? Checked the moment a file is written.
 *
 * Measured on a real build: a JSX typo sat unnoticed until `npm run build`,
 * which takes up to a minute, failed on it — then the fix, then another full
 * build. Parsing the file takes milliseconds, so the error comes back in the
 * same step that wrote it, with the line, while the model still has the file
 * in front of it. Syntax only: types are checked at the end of the turn.
 */
export function syntaxProblem(file, text) {
  if (!PARSEABLE.test(file)) return null;
  const ext = path.extname(file).toLowerCase();
  const plugins = ext === '.tsx'
    ? ['typescript', 'jsx']
    : /^\.[cm]?ts$/.test(ext) ? ['typescript'] : ['jsx'];
  const where = (loc) => (loc ? `line ${loc.line}, column ${loc.column + 1}` : 'somewhere in the file');
  const clean = (m) => String(m).replace(/\s*\(\d+:\d+\)\s*$/, '');
  try {
    const ast = parseSource(text, {
      sourceType: 'unambiguous',
      plugins: [...plugins, 'decorators-legacy'],
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
    const first = ast.errors?.[0];
    return first ? `${where(first.loc)}: ${clean(first.message)}` : null;
  } catch (err) {
    return `${where(err.loc)}: ${clean(err.message)}`;
  }
}

/** The warning appended to a result when a file does not parse. */
const brokenNote = (show, problem) =>
  `\n\n⚠ ${show} does not parse — ${problem}. Fix it now: the build will fail on it.`;

/** A file this short comes back whole after an edit; longer ones show the part around the change. */
const SHOW_WHOLE = 250;
const AROUND = 15;

/**
 * The file as it stands after an edit, with the same line-number gutter as
 * read_file.
 *
 * Measured on a real build: the model read the same component thirteen times
 * in one turn, because an edit's result showed only the lines it replaced and
 * the next edit needed the file as it now was. Sending the current text back
 * with the edit costs the same tokens the re-read would have, and saves the
 * round trip every time.
 */
function nowReads(show, text, at, span) {
  const lines = toLines(text);
  const whole = lines.length <= SHOW_WHOLE;
  const from = whole ? 1 : Math.max(1, at - AROUND);
  const to = whole ? lines.length : Math.min(lines.length, at + span + AROUND);
  const width = String(to).length;
  const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(width)} | ${l}`).join('\n');
  const heading = whole
    ? `${show} now reads (all ${lines.length} lines`
    : `${show} now reads, lines ${from}-${to} of ${lines.length}`;
  return `\n\n${heading} — this is the current text, so there is no need to read it again):\n${body}`;
}

/** At most this many files in one read_files call. */
const MAX_BATCH = 20;

/**
 * Several files in one call.
 *
 * Reading from disk takes a millisecond. What makes reading slow is the round
 * trip around it: every file read on its own is a whole request to the model,
 * and on a reasoning model that is several seconds of thinking before it even
 * asks for the next one. Reading the six files a change touches in one call
 * turns six of those into one.
 *
 * The files are read in parallel, and a missing one is reported in its place
 * rather than failing the rest — one wrong path should not cost the other five.
 */
export async function readFiles({ paths, limit = READ_LINES }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'reading several files',
      failed: 'The "paths" argument must be a non-empty array of file paths.',
      fix: 'Pass paths as ["src/app.js", "src/lib/api.js", ...].',
    });
  }

  const wanted = [...new Set(paths.map((p) => String(p ?? '').trim()).filter(Boolean))];
  const batch = wanted.slice(0, MAX_BATCH);
  const dropped = wanted.slice(MAX_BATCH);

  const readOne = (p) => readFile({ path: p, limit }).then(
    (out) => ({ p, out }),
    (err) => ({ p, err })
  );

  // Anything outside the project needs a yes, and two questions cannot be
  // asked at once — so those go one at a time. Everything else goes together.
  const outside = batch.some((p) => !resolveIn(p, 'read_files', 'paths').inside);
  const settled = [];
  if (outside) {
    for (const p of batch) settled.push(await readOne(p));
  } else {
    settled.push(...(await Promise.all(batch.map(readOne))));
  }

  // Two whole files' worth of output between them. Past that, the rest are
  // named rather than silently cut, so the model knows to ask again.
  const budget = MAX_FILE_OUTPUT * 2;
  let used = 0;
  let read = 0;
  let failed = 0;
  let lines = 0;
  const blocks = [];
  const deferred = [];

  for (const { p, out, err } of settled) {
    if (err) {
      failed++;
      blocks.push(`=== ${p} — could not be read ===\n${err.forModel ? err.forModel() : err.message}`);
      continue;
    }
    const block = `=== ${p} (${out.summary}) ===\n${out.content}`;
    if (read > 0 && used + block.length > budget) {
      deferred.push(p);
      continue;
    }
    blocks.push(block);
    used += block.length;
    read++;
    // "42 lines" for a whole file, "lines 1-600 of 900" for a page of one.
    const whole = /^(\d+) lines$/.exec(out.summary);
    const page = /^lines (\d+)-(\d+)/.exec(out.summary);
    lines += whole ? Number(whole[1]) : page ? Number(page[2]) - Number(page[1]) + 1 : 0;
  }

  const leftOver = [...deferred, ...dropped];
  if (leftOver.length) {
    blocks.push(
      `[not included, to stay inside one reply: ${leftOver.join(', ')}. ` +
      'Read those with another read_files call.]'
    );
  }

  return result(
    blocks.join('\n\n'),
    `${read} file${read === 1 ? '' : 's'} · ${lines} lines` +
      (failed ? ` · ${failed} missing` : '') +
      (leftOver.length ? ` · ${leftOver.length} deferred` : ''),
    budget + 2_000
  );
}

/** Write one file, returning the rows that show what changed. */
async function put(target, content, { diffMax = 16 } = {}) {
  const attempted = `writing ${target.show}`;

  // Read what is there before clobbering it, so an overwrite can be shown as
  // an actual diff rather than as a claim that something changed.
  let previous = null;
  try {
    previous = await fs.readFile(target.abs, 'utf8');
  } catch {
    previous = null; // missing, or binary — either way it is treated as new
  }

  try {
    await fs.mkdir(path.dirname(target.abs), { recursive: true });
    await fs.writeFile(target.abs, content, 'utf8');
  } catch (err) {
    throw fsFailure(err, attempted, target.show);
  }
  written(target, content);

  const existed = previous !== null;
  const lineCount = content === '' ? 0 : toLines(content).length;
  const diff = existed
    ? renderDiff(changedRegion(previous, content), { max: diffMax })
    : (content === '' ? [] : renderNewFile(content, diffMax));

  return {
    existed,
    lineCount,
    diff,
    problem: syntaxProblem(target.abs, content),
    line: `${existed ? 'Overwrote' : 'Created'} ${target.show} ` +
      `(${lineCount} lines, ${bytes(Buffer.byteLength(content))})`,
  };
}

export async function writeFile({ path: p, content }) {
  const target = resolveIn(p, 'write_file');
  if (typeof content !== 'string') {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: `writing ${target.show}`,
      failed: 'The "content" argument was missing or was not a string.',
      fix: 'Call write_file again with content set to the whole text of the file.',
    });
  }
  await guard(target, `write ${target.abs}`);

  const written = await put(target, content);
  const out = result(
    `${written.line}.${written.problem ? brokenNote(target.show, written.problem) : ''}`,
    `${written.existed ? 'overwrote' : 'created'} · ${written.lineCount} lines${written.problem ? ' · does not parse' : ''}`
  );
  out.diff = written.diff;
  return out;
}

/**
 * Several files in one call.
 *
 * Scaffolding a project is twenty writes before anything can be run, and doing
 * that one round trip at a time is most of the wait.
 */
export async function batchWrite({ files }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'writing several files',
      failed: 'The "files" argument must be a non-empty array.',
      fix: 'Pass files as [{ path, content }, ...].',
    });
  }

  const lines = [];
  const diff = [];
  let created = 0;
  let broken = 0;

  for (const [index, file] of files.entries()) {
    const { path: p, content } = file ?? {};
    if (typeof p !== 'string' || typeof content !== 'string') {
      throw new ToolFailure({
        kind: 'bad_args',
        attempted: `writing file ${index + 1} of ${files.length}`,
        failed: 'Every entry needs "path" and "content", both strings.',
        fix: `Fix entry ${index + 1} and call batch_write again. ${index} file(s) were already written.`,
      });
    }

    const target = resolveIn(p, 'batch_write');
    await guard(target, `write ${target.abs}`);

    // Per-file diffs are kept short here; twenty files at sixteen rows each
    // would bury the reply under three hundred lines of gutter.
    const written = await put(target, content, { diffMax: 6 });
    if (!written.existed) created++;
    lines.push(written.line + (written.problem ? brokenNote(target.show, written.problem) : ''));
    if (written.problem) broken++;
    diff.push(`~${target.show}`, ...written.diff);
  }

  const out = result(
    lines.join('\n'),
    `${files.length} file${files.length === 1 ? '' : 's'} · ${created} new${broken ? ` · ${broken} do not parse` : ''}`
  );
  out.diff = diff;
  return out;
}

/**
 * Why an old_string missed, worked out rather than guessed at.
 *
 * "not found" tells the model nothing it did not already know. Whether the
 * text is present with different whitespace, or present but only its first
 * line, is the difference between a fix on the next step and three more
 * failed attempts.
 */
function explainMiss(original, oldString, show) {
  const flatten = (s) => s.replace(/\s+/g, ' ').trim();
  const firstLine = oldString.split('\n')[0].trim();

  if (flatten(original).includes(flatten(oldString))) {
    return {
      failed: `old_string is not in ${show} as written — the text is there, but the whitespace differs.`,
      fix: "Match the file's own indentation exactly: tabs versus spaces, and the line breaks.",
    };
  }

  const nearby = firstLine.length > 3
    ? original.split(/\r?\n/)
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => line.includes(firstLine))
        .slice(0, 3)
    : [];

  if (nearby.length) {
    return {
      failed:
        `old_string is not in ${show}. Its first line does appear at ` +
        `line${nearby.length > 1 ? 's' : ''} ${nearby.map(([n]) => n).join(', ')}, ` +
        'so it is the lines after it that differ.',
      fix: `Read ${show} around line ${nearby[0][0]} and copy the block exactly as it is.`,
    };
  }

  return {
    failed: `old_string does not appear anywhere in ${show}.`,
    fix: `Read ${show} again and copy the text verbatim, without the line-number gutter.`,
  };
}

/** Apply one replacement to a string, or explain precisely why it cannot. */
function replaceOnce(text, { old_string, new_string }, { show, attempted, label = '' }) {
  const prefix = label ? `${label}: ` : '';

  if (typeof old_string !== 'string' || typeof new_string !== 'string') {
    throw new ToolFailure({
      kind: 'bad_args', attempted,
      failed: `${prefix}old_string and new_string must both be strings.`,
      fix: 'Fix that entry and call again. Nothing was written.',
    });
  }
  if (old_string === '') {
    throw new ToolFailure({
      kind: 'bad_args', attempted,
      failed: `${prefix}old_string was empty.`,
      fix: 'edit_file replaces existing text. Use write_file to create a file.',
    });
  }
  if (old_string === new_string) {
    throw new ToolFailure({
      kind: 'bad_args', attempted,
      failed: `${prefix}old_string and new_string are identical, so the edit would change nothing.`,
      fix: 'Set new_string to the text you actually want there.',
    });
  }

  // Models write \n. A file checked out on Windows is often \r\n, and then an
  // otherwise perfect old_string can never match. Speak the file's dialect.
  let oldText = old_string;
  let newText = new_string;
  if (text.includes('\r\n') && !oldText.includes('\r')) {
    oldText = oldText.replace(/\r?\n/g, '\r\n');
    newText = newText.replace(/\r?\n/g, '\r\n');
  }

  const ambiguous = (hits, how = '') => new ToolFailure({
    kind: 'ambiguous', attempted,
    failed: `${prefix}old_string appears ${hits} times in ${show}${how}. Refusing to guess which one you meant.`,
    fix: 'Add surrounding lines to old_string until it matches exactly one place.',
    detail: { hits },
  });

  const hits = text.split(oldText).length - 1;
  if (hits > 1) throw ambiguous(hits);
  if (hits === 1) {
    const at = text.slice(0, text.indexOf(oldText)).split(/\r?\n/).length;
    return { text: text.replace(oldText, () => newText), at, loose: false };
  }

  // No exact match. The commonest reason by far is whitespace — tabs against
  // spaces, a different indent depth, trailing spaces — with every word right.
  // Match line by line ignoring that, and re-indent the replacement to fit.
  // Still unique or nothing: a loose match found twice is refused like any other.
  const loose = looseReplace(text, old_string, new_string);
  if (loose?.count === 1) return { text: loose.text, at: loose.at, loose: true };
  if (loose?.count > 1) throw ambiguous(loose.count, ' once whitespace is ignored');

  const { failed, fix } = explainMiss(text, old_string, show);
  throw new ToolFailure({ kind: 'no_match', attempted, failed: prefix + failed, fix });
}

/**
 * Find old_string by its lines' content alone and swap in new_string, indented
 * the way the file is indented at that spot. Returns { count } when it finds
 * none or several, and { count: 1, text, at } when it finds exactly one.
 */
function looseReplace(text, oldString, newString) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  const want = oldString.replace(/\r/g, '').split('\n');
  while (want.length > 1 && !want[want.length - 1].trim()) want.pop();
  while (want.length > 1 && !want[0].trim()) want.shift();
  const target = want.map((l) => l.trim());
  if (target.every((t) => !t)) return null;

  const starts = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let same = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j].trim() !== target[j]) { same = false; break; }
    }
    if (same) starts.push(i);
  }
  if (starts.length !== 1) return { count: starts.length };

  const start = starts[0];
  const indent = (l) => /^[ \t]*/.exec(l)[0];
  const first = want.findIndex((l) => l.trim());
  const fileIndent = indent(lines[start + first]);
  const wroteIndent = indent(want[first]);

  const replacement = newString.replace(/\r/g, '').split('\n');
  if (replacement.length > 1 && replacement[replacement.length - 1] === '') replacement.pop();
  const reindented = replacement.map((l) => {
    if (!l.trim()) return l.trim();
    const body = l.startsWith(wroteIndent) ? l.slice(wroteIndent.length) : l.replace(/^[ \t]*/, '');
    return fileIndent + body;
  });

  const out = [...lines.slice(0, start), ...reindented, ...lines.slice(start + want.length)];
  return { count: 1, text: out.join(eol), at: start + 1 };
}

export async function editFile({ path: p, old_string, new_string }) {
  const target = resolveIn(p, 'edit_file');
  const attempted = `editing ${target.show}`;
  await guard(target, `edit ${target.abs}`);

  let original;
  try {
    original = await fs.readFile(target.abs, 'utf8');
  } catch (err) {
    throw fsFailure(err, attempted, target.show);
  }

  const { text, at, loose } = replaceOnce(original, { old_string, new_string }, {
    show: target.show, attempted,
  });

  try {
    await fs.writeFile(target.abs, text, 'utf8');
  } catch (err) {
    throw fsFailure(err, attempted, target.show);
  }
  written(target, text);

  const delta = toLines(text).length - toLines(original).length;
  const change = delta === 0 ? 'same line count' : `${delta > 0 ? '+' : ''}${delta} lines`;
  const how = loose ? ', matched ignoring whitespace and re-indented to fit' : '';

  const span = toLines(new_string).length;
  const out = result(
    `Replaced one occurrence in ${target.show} at line ${at} (${change}${how}).` +
      (syntaxProblem(target.abs, text) ? brokenNote(target.show, syntaxProblem(target.abs, text)) : '') +
      nowReads(target.show, text, at, span),
    `1 change at line ${at} · ${change}${loose ? ' · whitespace-tolerant' : ''}${syntaxProblem(target.abs, text) ? ' · does not parse' : ''}`,
    MAX_FILE_OUTPUT
  );
  // The replacement is diffed on its own and offset to where it landed, so
  // the gutter shows the file's line numbers rather than 1, 2, 3.
  out.diff = renderDiff(changedRegion(old_string, new_string), { offset: at - 1 });
  return out;
}

/**
 * Several replacements in one file, applied in order, each seeing the result
 * of the one before it.
 *
 * Everything is validated against a working copy first. If the third edit is
 * ambiguous, none of the three are written — a half-applied set of edits is a
 * file in a state nobody designed.
 */
export async function multiEdit({ path: p, edits }) {
  const target = resolveIn(p, 'multi_edit');
  const attempted = `editing ${target.show}`;

  if (!Array.isArray(edits) || edits.length === 0) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted,
      failed: 'The "edits" argument must be a non-empty array.',
      fix: 'Pass edits as [{ old_string, new_string }, ...].',
    });
  }

  await guard(target, `edit ${target.abs}`);

  let original;
  try {
    original = await fs.readFile(target.abs, 'utf8');
  } catch (err) {
    throw fsFailure(err, attempted, target.show);
  }

  let text = original;
  const diff = [];

  for (const [index, edit] of edits.entries()) {
    const applied = replaceOnce(text, edit ?? {}, {
      show: target.show,
      attempted,
      label: `edit ${index + 1} of ${edits.length}`,
    });
    diff.push(
      ...renderDiff(changedRegion(edit.old_string, edit.new_string), {
        offset: applied.at - 1,
        max: 8,
      })
    );
    text = applied.text;
  }

  try {
    await fs.writeFile(target.abs, text, 'utf8');
  } catch (err) {
    throw fsFailure(err, attempted, target.show);
  }
  written(target, text);

  const delta = toLines(text).length - toLines(original).length;
  const change = delta === 0 ? 'same line count' : `${delta > 0 ? '+' : ''}${delta} lines`;

  const out = result(
    `Applied ${edits.length} edits to ${target.show} (${change}).` +
      (syntaxProblem(target.abs, text) ? brokenNote(target.show, syntaxProblem(target.abs, text)) : '') +
      nowReads(target.show, text, 1, toLines(text).length),
    `${edits.length} edits · ${change}`,
    MAX_FILE_OUTPUT
  );
  out.diff = diff;
  return out;
}

/**
 * Exact replacements across several files in one call.
 *
 * A change that touches the route, the component and the type together is one
 * round trip instead of three. Every edit in every file is applied to a copy
 * in memory first; if any of them fails, nothing is written anywhere — a
 * cross-file change that half landed leaves the project in a state that
 * compiles nowhere.
 */
export async function editFiles({ files }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'editing several files',
      failed: 'The "files" argument must be a non-empty array.',
      fix: 'Pass files as [{ path, edits: [{ old_string, new_string }, ...] }, ...].',
    });
  }

  const planned = [];
  const seen = new Set();

  for (const [i, entry] of files.entries()) {
    const target = resolveIn(entry?.path, 'edit_files');
    const attempted = `editing ${target.show}`;

    if (seen.has(target.abs)) {
      throw new ToolFailure({
        kind: 'bad_args', attempted,
        failed: `${target.show} is listed twice.`,
        fix: 'List each file once, with all of its edits together. Nothing was written.',
      });
    }
    seen.add(target.abs);

    if (!Array.isArray(entry.edits) || entry.edits.length === 0) {
      throw new ToolFailure({
        kind: 'bad_args', attempted,
        failed: `File ${i + 1} (${target.show}) has no edits.`,
        fix: 'Give every file a non-empty edits array. Nothing was written.',
      });
    }

    await guard(target, `edit ${target.abs}`);

    let original;
    try {
      original = await fs.readFile(target.abs, 'utf8');
    } catch (err) {
      throw fsFailure(err, attempted, target.show);
    }

    let text = original;
    const diff = [`~${target.show}`];
    for (const [j, edit] of entry.edits.entries()) {
      const applied = replaceOnce(text, edit ?? {}, {
        show: target.show,
        attempted,
        label: `${target.show}, edit ${j + 1} of ${entry.edits.length} (nothing was written)`,
      });
      diff.push(...renderDiff(changedRegion(edit.old_string, edit.new_string), { offset: applied.at - 1, max: 6 }));
      text = applied.text;
    }
    planned.push({ target, text, diff, count: entry.edits.length });
  }

  for (const { target, text } of planned) {
    try {
      await fs.writeFile(target.abs, text, 'utf8');
    } catch (err) {
      throw fsFailure(err, `editing ${target.show}`, target.show);
    }
    written(target, text);
  }

  const edits = planned.reduce((n, p) => n + p.count, 0);
  const out = result(
    planned.map((p) => {
      const problem = syntaxProblem(p.target.abs, p.text);
      return `Edited ${p.target.show} (${p.count} change${p.count === 1 ? '' : 's'})` +
        (problem ? brokenNote(p.target.show, problem) : '');
    }).join('\n'),
    `${planned.length} files · ${edits} edits`
  );
  out.diff = planned.flatMap((p) => p.diff);
  return out;
}
