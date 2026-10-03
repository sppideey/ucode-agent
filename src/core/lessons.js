/**
 * lessons.js — the mistakes ucode keeps catching, remembered across sessions.
 *
 * Every fix round is ucode finding something wrong with what the model built.
 * The same few things come up build after build: a script that does not parse,
 * a button wired to nothing, a list that forgets itself on reload. Counting
 * them costs nothing, and the ones that keep happening go into the system
 * prompt as a short warning — said before the build, where it is free, instead
 * of after it, where it costs a fix round.
 *
 * The lessons themselves are fixed sentences, not something the model writes:
 * a note in the prompt of every future build should never be a model's guess.
 *
 * Kept in ~/.ucode/lessons.json. Failing to read or write it never matters.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LESSONS_FILE = path.join(os.homedir(), '.ucode', 'lessons.json');

const KINDS = [
  { id: 'js-parse', test: /does not parse|SyntaxError|Unexpected token/i,
    lesson: 'Scripts have failed to parse. Before finishing, check every script you wrote for unclosed brackets, braces and template strings.' },
  { id: 'css-var', test: /custom propert(?:y is|ies are) used and never defined/i,
    lesson: 'Stylesheets have used custom properties that were never defined. Define every token in :root before using it.' },
  { id: 'dead-button', test: /NOTHING HAPPENS/,
    lesson: 'Buttons have done nothing when clicked. Wire every control to a handler, attached after its element exists.' },
  { id: 'add-broken', test: /ADDING DOES NOT WORK/,
    lesson: 'Adding an item has failed. The form handler must prevent the default, read the inputs, update the list, render and save.' },
  { id: 'no-persist', test: /works until you refresh/i,
    lesson: 'Data has been lost on reload. Save to localStorage on every change and load it when the page starts.' },
  { id: 'console', test: /Console errors/i,
    lesson: 'Pages have thrown console errors. Check that every element you query exists, and wrap JSON.parse of saved data in try/catch.' },
  { id: 'type-errors', test: /error TS\d+/,
    lesson: 'TypeScript errors have come back. Match prop and function types exactly, and check an import exists before using it.' },
  { id: 'tests', test: /tests covering your change fail/i,
    lesson: 'Changes have broken existing tests. Read a function\'s tests before changing what it returns.' },
  { id: 'generic', test: /generated look/i,
    lesson: 'Designs have come out generic: the starter\'s colours, Inter, purple gradients. Choose the accent and typeface first, and use them.' },
];

/** Which kinds of mistake a block of problems text contains. */
export function kindsIn(problems) {
  const text = String(problems ?? '');
  return KINDS.filter((k) => k.test.test(text)).map((k) => k.id);
}

async function readCounts(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** Count the mistakes in this fix round. Never throws. */
export async function noteMistakes(problems, file = LESSONS_FILE) {
  const found = kindsIn(problems);
  if (!found.length || process.env.UCODE_LESSONS === '0') return;
  try {
    const counts = await readCounts(file);
    const next = { ...counts };
    for (const id of found) next[id] = (Number(next[id]) || 0) + 1;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2));
    await fs.rename(temp, file);
  } catch { /* a lesson not saved is a lesson not learned, never a broken turn */ }
}

/** The lessons worth repeating: seen at least `min` times, the commonest first. */
export async function lessonsText(file = LESSONS_FILE, { min = 2, max = 3 } = {}) {
  if (process.env.UCODE_LESSONS === '0') return '';
  const counts = await readCounts(file);
  const top = KINDS
    .filter((k) => (Number(counts[k.id]) || 0) >= min)
    .sort((a, b) => counts[b.id] - counts[a.id])
    .slice(0, max);
  return top.map((k) => `- ${k.lesson}`).join('\n');
}
