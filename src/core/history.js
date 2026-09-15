/**
 * history.js — conversations on disk.
 *
 * One JSON file per session under ~/.ucode/sessions. The file always holds the
 * complete history, tool calls and results included, even when the copy being
 * sent to the model has had its older turns folded into a summary.
 *
 * Saving happens after every turn and after every tool result, so a crash, a
 * Ctrl+C or a closed terminal costs nothing.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Failure } from './failure.js';

export const HOME = path.join(os.homedir(), '.ucode');

export function sessionsDir(home = HOME) {
  return path.join(home, 'sessions');
}

export function sessionFile(id, home = HOME) {
  return path.join(sessionsDir(home), `${id}.json`);
}

/**
 * A session's label, taken from the first thing the user said.
 *
 * This is what the resume list shows, so it has to read like a name rather
 * than like the top of a paragraph.
 */
export function titleFrom(text) {
  const first = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);

  if (!first) return 'Untitled';

  let title = first
    .replace(/^\/+/, '')
    .replace(/^[-*>#\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) return 'Untitled';
  if (title.length > 60) title = `${title.slice(0, 59).trimEnd()}…`;
  return title[0].toUpperCase() + title.slice(1);
}

export function newSession(cwd = process.cwd(), model = '') {
  const now = new Date().toISOString();
  return {
    id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    title: 'Untitled',
    cwd: path.resolve(cwd),
    model,
    createdAt: now,
    updatedAt: now,
    usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
    messages: [],
  };
}

async function ensureDir(home) {
  const dir = sessionsDir(home);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new Failure({
      kind: 'sessions_unwritable',
      attempted: `creating ${dir}`,
      failed: `${err.code ?? ''} ${err.message}`.trim(),
      fix: 'Check that your home directory is writable, or point HOME somewhere that is.',
      cause: err,
    });
  }
  return dir;
}

/**
 * Write the session out.
 *
 * Via a temp file and a rename, so a save interrupted halfway can never leave
 * a truncated session behind — the previous good file stays until the new one
 * is complete.
 */
export async function save(session, { home = HOME } = {}) {
  await ensureDir(home);

  session.updatedAt = new Date().toISOString();
  if (!session.title || session.title === 'Untitled') {
    const first = session.messages.find((m) => m.role === 'user');
    if (first) session.title = titleFrom(first.content);
  }

  const target = sessionFile(session.id, home);
  const temp = `${target}.${process.pid}.tmp`;

  try {
    // Compact, not pretty. The whole file is rewritten after every tool
    // result, and on a long build with file contents in it the indentation was
    // roughly half of what got written each time — for a file read by programs,
    // not by people. `node -e "console.log(require('./x.json').messages)"` or
    // /resume reads it either way.
    await fs.writeFile(temp, JSON.stringify(session), 'utf8');
    await fs.rename(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw new Failure({
      kind: 'save_failed',
      attempted: `saving this session to ${target}`,
      failed: `${err.code ?? ''} ${err.message}`.trim(),
      fix:
        'Check free space and permissions on ~/.ucode/sessions. The conversation is ' +
        'still in memory, so fixing it means the next turn saves everything.',
      cause: err,
    });
  }

  return target;
}

export async function load(id, { home = HOME } = {}) {
  const file = sessionFile(id, home);
  let raw;

  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Failure({
        kind: 'no_such_session',
        attempted: `resuming ${id}`,
        failed: `There is no session file at ${file}.`,
        fix: 'Run /resume to see the sessions that do exist.',
        cause: err,
      });
    }
    throw new Failure({
      kind: 'session_unreadable',
      attempted: `reading session ${id}`,
      failed: `${err.code ?? ''} ${err.message}`.trim(),
      fix: 'Check permissions on ~/.ucode/sessions.',
      cause: err,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Failure({
      kind: 'session_corrupt',
      attempted: `resuming ${id}`,
      failed: `${file} is not valid JSON (${err.message}) — most likely truncated by a hard kill.`,
      fix: `Start fresh with /new. Deleting ${file} is safe; it only affects that one conversation.`,
      cause: err,
    });
  }

  if (!parsed || !Array.isArray(parsed.messages)) {
    throw new Failure({
      kind: 'session_corrupt',
      attempted: `resuming ${id}`,
      failed: `${file} is valid JSON but holds no message history.`,
      fix: `Start fresh with /new. The file is at ${file} if you want to look at it.`,
    });
  }

  // Fill in whatever an older or hand-edited file happens to be missing.
  return {
    usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
    title: 'Untitled',
    cwd: process.cwd(),
    model: '',
    createdAt: parsed.updatedAt ?? new Date().toISOString(),
    ...parsed,
    id: parsed.id ?? id,
  };
}

/** The opening line of a conversation, for the resume list. */
function previewOf(messages) {
  const first = messages.find((m) => m.role === 'user' && m.content?.trim());
  if (!first) return '';
  const line = first.content.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

/** When something last happened, and when it started. */
function lastReplyOf(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content?.trim());
  if (!last) return '';
  const line = last.content.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

/**
 * Every saved session, newest first, with the ones belonging to this folder
 * pulled to the front — which is the whole point of the list when you have
 * conversations spread across a dozen projects.
 *
 * A file that will not parse is reported separately rather than breaking the
 * listing: one bad session must never hide the other forty.
 */
export async function list({ home = HOME, cwd = null } = {}) {
  const dir = sessionsDir(home);

  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return Object.assign([], { unreadable: [] });
    throw new Failure({
      kind: 'list_failed',
      attempted: `listing ${dir}`,
      failed: `${err.code ?? ''} ${err.message}`.trim(),
      fix: 'Check that ~/.ucode/sessions exists and is readable.',
      cause: err,
    });
  }

  const here = cwd ? path.resolve(cwd) : null;
  const sessions = [];
  const unreadable = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      if (!parsed || !Array.isArray(parsed.messages)) throw new Error('no messages');
      const where = parsed.cwd ?? '';
      const turns = parsed.messages.filter((m) => m.role === 'user').length;
      sessions.push({
        id: parsed.id ?? path.basename(file, '.json'),
        title: parsed.title ?? 'Untitled',
        cwd: where,
        model: parsed.model ?? '',
        createdAt: parsed.createdAt ?? parsed.updatedAt ?? null,
        updatedAt: parsed.updatedAt ?? parsed.createdAt ?? null,
        messageCount: parsed.messages.length,
        turns,
        preview: previewOf(parsed.messages),
        lastReply: lastReplyOf(parsed.messages),
        usage: parsed.usage ?? null,
        mine: here ? path.resolve(where || '.') === here : false,
      });
    } catch {
      unreadable.push(file);
    }
  }

  const byRecency = (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
  const ordered = here
    ? [...sessions.filter((s) => s.mine).sort(byRecency), ...sessions.filter((s) => !s.mine).sort(byRecency)]
    : sessions.sort(byRecency);

  return Object.assign(ordered, { unreadable });
}

/** The most recent session started in this folder, if there is one. */
export async function latestHere(cwd, { home = HOME } = {}) {
  const all = await list({ home, cwd });
  return all.find((s) => s.mine) ?? null;
}

export async function remove(id, { home = HOME } = {}) {
  await fs.rm(sessionFile(id, home), { force: true });
}

export async function removeAll({ home = HOME } = {}) {
  const dir = sessionsDir(home);
  try {
    for (const file of await fs.readdir(dir)) {
      if (file.endsWith('.json')) await fs.rm(path.join(dir, file), { force: true });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
