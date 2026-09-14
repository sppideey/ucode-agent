/**
 * undo.js — what every file looked like before this turn touched it.
 *
 * ucode edits files on its own. Until now there was no way back from that: a
 * turn that went wrong left the work in whatever state it reached, and the
 * only recovery was git, if the project had git and the user had committed.
 * An agent that writes to your disk without an undo is asking for a kind of
 * trust it has not earned.
 *
 * So the original of every file is kept the first time a turn writes to it —
 * the first time only, because the point of an undo is the state before the
 * turn, not before the last of six edits to the same file. A file that did not
 * exist is remembered as absent, and undoing removes it again.
 *
 * Kept in memory, for one turn. Persisting it would be a different feature
 * with a different set of questions (how many turns, where, how big), and the
 * turn you want back is almost always the one that just happened.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** abs path -> the contents before this turn, or null when it did not exist. */
let before = new Map();
let armed = false;

/** A new turn: nothing remembered yet, and from here on writes are recorded. */
export function beginTurn() {
  before = new Map();
  armed = true;
}

/**
 * Remember a file as it is now, if this turn has not already seen it.
 *
 * Reading before every write costs one stat and one read on files that are
 * about to be rewritten anyway. Never throws: failing to record an undo is a
 * reason to have no undo, never a reason to fail the write.
 */
export async function remember(abs) {
  if (!armed || before.has(abs)) return;
  try {
    before.set(abs, await fs.readFile(abs, 'utf8'));
  } catch {
    before.set(abs, null); // did not exist, so undoing means deleting it
  }
}

/** How many files this turn has changed so far. */
export function changedCount() {
  return before.size;
}

/**
 * Put every file back the way it was, and say what was done.
 *
 * Returns { restored, removed, failed } rather than throwing, because a
 * partial undo is still worth reporting: knowing four of five files went back
 * is the difference between fixing one thing by hand and wondering.
 */
export async function undoTurn() {
  const out = { restored: [], removed: [], failed: [] };

  for (const [abs, text] of before) {
    try {
      if (text === null) {
        await fs.rm(abs, { force: true });
        out.removed.push(abs);
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
        await fs.writeFile(abs, text, 'utf8');
        out.restored.push(abs);
      }
    } catch (err) {
      out.failed.push(`${abs}: ${err.message}`);
    }
  }

  before = new Map();
  return out;
}
