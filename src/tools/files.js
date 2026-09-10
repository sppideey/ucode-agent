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

  const existed = previous !== null;
  const lineCount = content === '' ? 0 : toLines(content).length;
  const diff = existed
    ? renderDiff(changedRegion(previous, content), { max: diffMax })
    : (content === '' ? [] : renderNewFile(content, diffMax));

  return {
    existed,
    lineCount,
    diff,
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
  const out = result(`${written.line}.`, `${written.existed ? 'overwrote' : 'created'} · ${written.lineCount} lines`);
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
    lines.push(written.line);
    diff.push(`~${target.show}`, ...written.diff);
  }

  const out = result(
    lines.join('\n'),
    `${files.length} file${files.length === 1 ? '' : 's'} · ${created} new`
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

  const hits = text.split(old_string).length - 1;

  if (hits === 0) {
    const { failed, fix } = explainMiss(text, old_string, show);
    throw new ToolFailure({ kind: 'no_match', attempted, failed: prefix + failed, fix });
  }
  if (hits > 1) {
    throw new ToolFailure({
      kind: 'ambiguous', attempted,
      failed: `${prefix}old_string appears ${hits} times in ${show}. Refusing to guess which one you meant.`,
      fix: 'Add surrounding lines to old_string until it matches exactly one place.',
      detail: { hits },
    });
  }

  const at = text.slice(0, text.indexOf(old_string)).split(/\r?\n/).length;
  return { text: text.replace(old_string, () => new_string), at };
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

  const { text, at } = replaceOnce(original, { old_string, new_string }, {
    show: target.show, attempted,
  });

  try {
    await fs.writeFile(target.abs, text, 'utf8');
  } catch (err) {
    throw fsFailure(err, attempted, target.show);
  }

  const delta = toLines(text).length - toLines(original).length;
  const change = delta === 0 ? 'same line count' : `${delta > 0 ? '+' : ''}${delta} lines`;

  const out = result(
    `Replaced one occurrence in ${target.show} at line ${at} (${change}).`,
    `1 change at line ${at} · ${change}`
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

  const delta = toLines(text).length - toLines(original).length;
  const change = delta === 0 ? 'same line count' : `${delta > 0 ? '+' : ''}${delta} lines`;

  const out = result(
    `Applied ${edits.length} edits to ${target.show} (${change}).`,
    `${edits.length} edits · ${change}`
  );
  out.diff = diff;
  return out;
}
