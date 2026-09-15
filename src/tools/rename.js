/**
 * rename.js — renaming a name everywhere it is that name.
 *
 * Most failed edits are a find-and-replace that matched too much: renaming
 * `id` rewrites `width`, `idle` and every `id` inside a string or a comment,
 * and the model then spends three steps undoing it. The fix is not a bigger
 * regular expression — it is to stop treating code as text.
 *
 * This walks each file as code: it knows where a string, a template literal
 * and a comment begin and end, and only renames an identifier sitting in
 * actual code, whole, not as part of a longer word. That is short of a
 * parser — it cannot tell two different `user` variables in two scopes apart
 * — so it reports exactly what it changed and where, and leaves the model to
 * read the diff. It is the difference between an edit that is usually right
 * and one that is usually wrong.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ToolFailure } from '../core/failure.js';
import { resolveIn, guard, result, walk, writeTracked } from './shared.js';

const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/i;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const wordChar = (c) => c !== undefined && /[\w$]/.test(c);

/**
 * Rename `from` to `to` in one file's text, skipping strings and comments.
 * Returns the new text and the 1-based lines that changed.
 */
export function renameIn(text, from, to) {
  const out = [];
  const lines = [];
  let line = 1;
  let i = 0;
  const n = text.length;

  // Where we are: code, or inside something that is not code.
  let mode = 'code';
  let quote = '';
  // Template literals can hold ${ code }, so the nesting is tracked.
  const templates = [];

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '\n') line++;

    if (mode === 'line-comment') {
      if (c === '\n') mode = 'code';
      out.push(c); i++; continue;
    }
    if (mode === 'block-comment') {
      if (c === '*' && next === '/') { out.push('*/'); i += 2; mode = 'code'; continue; }
      out.push(c); i++; continue;
    }
    if (mode === 'string') {
      if (c === '\\') { out.push(c, next ?? ''); i += 2; continue; }
      if (c === quote) { mode = 'code'; quote = ''; }
      if (c === '\n' && quote !== '`') { mode = 'code'; quote = ''; } // an unterminated quote
      out.push(c); i++; continue;
    }
    if (mode === 'template') {
      if (c === '\\') { out.push(c, next ?? ''); i += 2; continue; }
      if (c === '`') { mode = templates.pop() ?? 'code'; out.push(c); i++; continue; }
      if (c === '$' && next === '{') { templates.push('template'); mode = 'code'; out.push('${'); i += 2; continue; }
      out.push(c); i++; continue;
    }

    // mode === 'code'
    if (c === '/' && next === '/') { mode = 'line-comment'; out.push('//'); i += 2; continue; }
    if (c === '/' && next === '*') { mode = 'block-comment'; out.push('/*'); i += 2; continue; }
    if (c === '#') { mode = 'line-comment'; out.push(c); i++; continue; } // python
    if (c === '"' || c === "'") { mode = 'string'; quote = c; out.push(c); i++; continue; }
    if (c === '`') { mode = 'template'; out.push(c); i++; continue; }
    if (c === '}' && templates.length) { mode = templates.pop(); out.push(c); i++; continue; }

    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && wordChar(text[j])) j++;
      const word = text.slice(i, j);
      if (word === from && !wordChar(text[i - 1])) {
        out.push(to);
        if (lines[lines.length - 1] !== line) lines.push(line);
      } else {
        out.push(word);
      }
      i = j;
      continue;
    }

    out.push(c);
    i++;
  }

  return { text: out.join(''), lines };
}

/** Rename a name across every source file under a path. */
export async function renameSymbol({ name, to, path: p = '.' }) {
  const from = String(name ?? '').trim();
  const into = String(to ?? '').trim();

  if (!IDENT.test(from) || !IDENT.test(into)) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: `renaming ${from || '(nothing)'} to ${into || '(nothing)'}`,
      failed: 'Both names must be plain identifiers: letters, digits, _ or $, not starting with a digit.',
      fix: 'To change something that is not an identifier, use edit_file or multi_edit.',
    });
  }
  if (from === into) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: `renaming ${from}`,
      failed: 'The old and new names are the same.',
      fix: 'Pass the name you want it to become.',
    });
  }

  const target = resolveIn(p || '.', 'rename_symbol', 'path');
  await guard(target, `rename ${from} to ${into} under ${target.abs}`);

  const stat = await fs.stat(target.abs).catch(() => null);
  const rels = stat?.isFile() ? [''] : (await walk(target.abs, {})).filter((rel) => SOURCE.test(rel));

  const changed = [];
  let total = 0;

  for (const rel of rels) {
    const abs = rel ? path.join(target.abs, rel) : target.abs;
    const before = await fs.readFile(abs, 'utf8').catch(() => null);
    if (before === null || !before.includes(from)) continue;
    const { text, lines } = renameIn(before, from, into);
    if (!lines.length || text === before) continue;
    await writeTracked(abs, text);
    changed.push({ rel: rel || target.show, lines });
    total += lines.length;
  }

  if (!changed.length) {
    return result(
      `Nothing to rename: "${from}" does not appear as a name in any code under ${target.show}.\n` +
      'It may only exist in strings or comments, which are deliberately left alone, or be spelled differently.',
      'no occurrences'
    );
  }

  const shown = changed.slice(0, 40).map((f) => `${f.rel} (${f.lines.length} line${f.lines.length === 1 ? '' : 's'}: ${f.lines.slice(0, 12).join(', ')}${f.lines.length > 12 ? '…' : ''})`);
  const more = changed.length > shown.length ? `\n[${changed.length - shown.length} more files]` : '';

  return result(
    `Renamed ${from} to ${into} in ${changed.length} file${changed.length === 1 ? '' : 's'}:\n\n${shown.join('\n')}${more}\n\n` +
    'Strings and comments were left alone. If the name was meant to change in one of those too, edit it directly.',
    `${total} line${total === 1 ? '' : 's'} in ${changed.length} file${changed.length === 1 ? '' : 's'}`
  );
}
