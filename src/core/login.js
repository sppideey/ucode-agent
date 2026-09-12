/**
 * login.js — putting the API key somewhere ucode will always find it.
 *
 * A key in a project's .env is a key you set up again in the next folder, and
 * on the next machine. This writes it once to ~/.ucode/.env, which every
 * project on the machine reads, so setting ucode up somewhere new — a borrowed
 * laptop, a machine you are demonstrating on — is one command.
 *
 * The file is written with owner-only permissions, and the existing contents
 * are kept: a key is replaced in place rather than by rewriting the file.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ENV_FILE } from './provider.js';

const NAME = 'OPENROUTER_API_KEY';

/** A plausible OpenRouter key, so a typo is caught here and not mid-answer. */
export function looksLikeKey(key) {
  return typeof key === 'string' && /^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

/** Put `key` in the machine-wide env file, keeping whatever else is in it. */
export function withKey(existing, key) {
  const line = `${NAME}=${key}`;
  const lines = String(existing ?? '').split('\n');
  let replaced = false;
  const out = lines.map((l) => {
    if (new RegExp(`^\\s*(?:export\\s+)?${NAME}\\s*=`).test(l)) {
      replaced = true;
      return line;
    }
    return l;
  });
  if (!replaced) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.splice(out.length - 1, 0, line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export async function saveKey(key) {
  const trimmed = String(key ?? '').trim();

  if (!trimmed) {
    return `  Usage: ucode login <key>\n\n  Get one free at https://openrouter.ai/keys\n  It is saved to ${ENV_FILE} and used by every project on this machine.`;
  }
  if (!looksLikeKey(trimmed)) {
    return `  That does not look like an OpenRouter key — they start with "sk-".\n  Get one at https://openrouter.ai/keys`;
  }

  const existing = await fs.readFile(ENV_FILE, 'utf8').catch(() => '');
  await fs.mkdir(path.dirname(ENV_FILE), { recursive: true });
  await fs.writeFile(ENV_FILE, withKey(existing, trimmed), { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(ENV_FILE, 0o600).catch(() => {});

  return `  Key saved to ${ENV_FILE}\n  Every project on this machine will use it. Run ucode anywhere to start.`;
}
