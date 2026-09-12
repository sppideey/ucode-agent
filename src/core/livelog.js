/**
 * livelog.js — errors from the running app, without being asked.
 *
 * A dev server reports a broken import or a thrown render the moment it
 * happens, into a log nobody is reading. The model finds out much later, from
 * a build, or from the user saying the page is blank. This reads what the
 * server has written since the last look and hands back anything that is
 * actually an error.
 *
 * Only new bytes are read, so a server running for an hour costs one small
 * read. Errors a dev server repeats on every request are reported once, not
 * once per refresh.
 */

import { promises as fs } from 'node:fs';

/** Lines that mean something is broken. */
const ERROR = /(?:^|\s)(?:⨯|✘|ERROR|Error:|TypeError:|ReferenceError:|SyntaxError:|RangeError:)|Failed to compile|Module not found|Cannot find module|Unhandled(?:Promise)?Rejection|ERR_[A-Z_]+|error TS\d+/;

/** Lines that look alarming but are not: warnings, notices, and the ready banner. */
const NOT_AN_ERROR = /\b(?:warn|warning|deprecat|notice|experimental|✓|ready in|compiled successfully|No errors? found)\b/i;

/** Whatever colour a terminal put on it is not part of the message. */
const stripAnsi = (s) => s.replace(/\[[0-9;]*[A-Za-z]/g, '');

/**
 * The error blocks in a chunk of log. An error's first line is the message and
 * the indented lines under it are its stack, which is where the file is named,
 * so they come along.
 */
export function errorsIn(text) {
  const lines = stripAnsi(String(text ?? '')).split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!ERROR.test(line) || NOT_AN_ERROR.test(line)) continue;
    const block = [line.trimEnd()];
    // Take the indented continuation, which holds the file and line number.
    for (let j = i + 1; j < lines.length && block.length < 8; j++) {
      if (!/^\s+\S/.test(lines[j])) break;
      block.push(lines[j].trimEnd());
      i = j;
    }
    found.push(block.join('\n').trim());
  }
  return found;
}

/**
 * What is worth telling the model about, given what it has already been told.
 * A dev server prints the same failure on every request; it is news once.
 */
export function freshErrors(errors, alreadySeen) {
  const out = [];
  for (const e of errors) {
    const key = e.split('\n')[0].replace(/\d+/g, '#').slice(0, 200);
    if (alreadySeen.has(key)) continue;
    alreadySeen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Watches each server log from wherever it was last read.
 *
 * A log that is deleted or replaced starts again from nothing rather than
 * throwing; a server's log going away is not worth failing a turn over.
 */
export class LogWatch {
  constructor() {
    this.at = new Map();   // log path -> bytes already read
    this.seen = new Set(); // error signatures already reported
  }

  /** New error text across these logs, or null when everything is quiet. */
  async since(servers) {
    const blocks = [];
    for (const server of servers) {
      if (!server?.log) continue;
      const from = this.at.get(server.log) ?? 0;
      let text = '';
      try {
        const { size } = await fs.stat(server.log);
        if (size < from) { this.at.set(server.log, 0); continue; } // truncated: start over
        if (size === from) continue;
        const handle = await fs.open(server.log, 'r');
        try {
          const length = Math.min(size - from, 200_000);
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, size - length);
          text = buffer.toString('utf8');
        } finally {
          await handle.close();
        }
        this.at.set(server.log, size);
      } catch {
        continue; // the log went away; nothing to report
      }

      const fresh = freshErrors(errorsIn(text), this.seen);
      if (fresh.length) blocks.push({ server, errors: fresh });
    }

    if (!blocks.length) return null;

    return blocks
      .map(({ server, errors }) =>
        `The app running at ${server.url ?? server.command ?? 'the dev server'} reported this:\n` +
        errors.slice(0, 5).join('\n\n'))
      .join('\n\n');
  }
}
