/**
 * commands.js — slash commands the user writes themselves.
 *
 *   ~/.ucode/commands/<name>.md          yours, everywhere
 *   <project>/.ucode/commands/<name>.md  this project's (wins over yours)
 *
 * The file is a prompt. `/name some words` sends it, with $ARGUMENTS replaced
 * by the words — or the words added at the end when the file has no
 * $ARGUMENTS. Its first line is what /help shows.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const USER_COMMANDS = path.join(os.homedir(), '.ucode', 'commands');
export const projectCommands = (cwd) => path.join(cwd, '.ucode', 'commands');

async function readDir(dir) {
  const found = new Map();
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const name = entry.name.replace(/\.md$/i, '').toLowerCase();
    if (!/^[a-z0-9][\w-]*$/.test(name)) continue;
    const body = await fs.readFile(path.join(dir, entry.name), 'utf8').catch(() => null);
    if (!body?.trim()) continue;
    const first = body.trim().split('\n')[0].replace(/^#+\s*/, '').trim();
    found.set(name, { name, body: body.trim(), description: first.slice(0, 70) });
  }
  return found;
}

/** Every command, by name without the slash. */
export async function loadCommands(cwd, { userDir = USER_COMMANDS } = {}) {
  const [mine, project] = await Promise.all([readDir(userDir), readDir(projectCommands(cwd))]);
  return new Map([...mine, ...project]);
}

/** The prompt a command sends, given what was typed after it. */
export function expandCommand(body, args = '') {
  const words = String(args).trim();
  if (body.includes('$ARGUMENTS')) return body.split('$ARGUMENTS').join(words);
  return words ? `${body}\n\n${words}` : body;
}
