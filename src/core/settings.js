// SPDX-License-Identifier: AGPL-3.0-only - ucode, made and tested by om dixit. Additional terms: see NOTICE.
/**
 * settings.js — what ucode may do without asking, and what runs around its work.
 *
 *   ~/.ucode/settings.json          yours, in every project
 *   <project>/.ucode/settings.json  this project's, on top of yours
 *
 *   {
 *     "commands": "ask",              ask before every command ("auto", the default, runs them)
 *     "allow": ["npm test"],          never asked about: a command by its first words, or "mcp:server__tool"
 *     "hooks": {
 *       "afterEdit": ["npx prettier --write {files}"],
 *       "beforeCommand": ["node guard.js"]     a non-zero exit stops the command
 *     }
 *   }
 *
 * A project's own hooks and MCP servers run commands on this computer, and a
 * cloned repository can carry any it likes. So they run only once the user
 * has said yes to them, and saying yes is remembered against exactly what was
 * approved: change the hooks and ucode asks again.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UCODE_DIR = path.join(os.homedir(), '.ucode');
export const USER_SETTINGS = path.join(UCODE_DIR, 'settings.json');
export const TRUST_FILE = path.join(UCODE_DIR, 'trusted.json');
export const projectSettingsFile = (cwd) => path.join(cwd, '.ucode', 'settings.json');

export async function readJson(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(temp, file);
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter((s) => s.trim());

/** Both files, merged: allow lists add up, the project's "commands" wins. */
export async function loadSettings(cwd, { userFile = USER_SETTINGS } = {}) {
  const [user, project] = await Promise.all([readJson(userFile), readJson(projectSettingsFile(cwd))]);
  const hooks = (s, key) => list(s.hooks?.[key]);
  return {
    commands: (project.commands ?? user.commands) === 'ask' ? 'ask' : 'auto',
    allow: [...new Set([...list(user.allow), ...list(project.allow)])],
    hooks: { afterEdit: hooks(user, 'afterEdit'), beforeCommand: hooks(user, 'beforeCommand') },
    projectHooks: { afterEdit: hooks(project, 'afterEdit'), beforeCommand: hooks(project, 'beforeCommand') },
  };
}

/**
 * What "always allow" remembers: "npm test" for `npm test -- --watch`. Never
 * shorter than a flag: allowing `node -e "…"` once must not allow every
 * `node -e` after it, so a command whose second word is a flag is kept whole.
 */
export function commandKey(command) {
  const words = String(command).trim().split(/\s+/).filter(Boolean);
  if (!words[1] || words[1].startsWith('-')) return words.join(' ');
  return words.slice(0, 2).join(' ');
}

/** Is this command (or "mcp:name") on the allow list? A whole-word prefix counts. */
export function isAllowed(allow, command) {
  const c = String(command).trim();
  // Chained commands are never covered by an entry for their first part.
  if (/[;&|`$<>]/.test(c) && !c.startsWith('mcp:')) return false;
  return allow.some((a) => c === a || c.startsWith(`${a} `));
}

/** Add an entry to this project's allow list. */
export async function addAllow(cwd, entry) {
  const file = projectSettingsFile(cwd);
  const settings = await readJson(file);
  const allow = list(settings.allow);
  if (!allow.includes(entry)) await writeJson(file, { ...settings, allow: [...allow, entry] });
}

/**
 * What was approved, down to the scripts it runs. Hashing only the settings
 * text would let `node .ucode/guard.js` be approved and guard.js swapped
 * afterwards, so every word of the commands that names a file in the project
 * adds that file's contents. (A package fetched by npx is not covered: pin
 * its version in the command to approve one release.)
 */
async function fingerprint(cwd, value) {
  const hash = createHash('sha1').update(JSON.stringify(value));
  const words = JSON.stringify(value).match(/[\w./\\@-]+\.\w+/g) ?? [];
  for (const word of [...new Set(words)].sort()) {
    const abs = path.resolve(cwd, word);
    if (!abs.startsWith(path.resolve(cwd))) continue;
    const text = await fs.readFile(abs).catch(() => null);
    if (text) hash.update(`\0${word}\0`).update(text);
  }
  return hash.digest('hex');
}

/** Has the user approved exactly this (the project's hooks, its MCP servers) here before? */
export async function isTrusted(cwd, what, value, file = TRUST_FILE) {
  const all = await readJson(file);
  return all[`${path.resolve(cwd)}#${what}`] === (await fingerprint(cwd, value));
}

export async function trust(cwd, what, value, file = TRUST_FILE) {
  const all = await readJson(file);
  await writeJson(file, { ...all, [`${path.resolve(cwd)}#${what}`]: await fingerprint(cwd, value) });
}

/** A path safe to put on a shell command line as it is. */
const SAFE_PATH = /^[\w./\\ @+~-]+$/;

/**
 * Run one hook. `{files}` becomes the changed files, quoted; they are also in
 * UCODE_FILES. Resolves to { code, output } and never throws.
 */
export function runHook(command, { cwd, files = [], env = {}, timeout = 30_000 } = {}) {
  const quoted = files.filter((f) => SAFE_PATH.test(f)).map((f) => `"${f}"`).join(' ');
  const line = String(command).includes('{files}') ? String(command).split('{files}').join(quoted) : String(command);
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(line, {
        cwd, shell: true, windowsHide: true,
        env: { ...process.env, ...env, UCODE_FILES: files.join('\n') },
      });
    } catch (err) {
      resolve({ code: -1, output: err.message });
      return;
    }
    const timer = setTimeout(() => { output += `\n(stopped after ${timeout / 1000}s)`; child.kill(); }, timeout);
    child.stdout?.on('data', (d) => { output += d; });
    child.stderr?.on('data', (d) => { output += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, output: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output: output.trim() }); });
  });
}
