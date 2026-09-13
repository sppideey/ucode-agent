/**
 * context.js — what the model knows about the project before it asks.
 *
 * Two things go into the system prompt at the start of every turn:
 *
 *   the project map   every file, and the names each code file exports, so the
 *                     model can go straight to the right file instead of
 *                     spending round trips on list_dir and grep to find it
 *
 *   project memory    UCODE.md — the stack, the commands, the conventions, the
 *                     preferences — written once, remembered every session
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walk } from '../tools/shared.js';

export const MEMORY_FILE = 'UCODE.md';
export const GLOBAL_MEMORY = path.join(os.homedir(), '.ucode', MEMORY_FILE);

const MAP_FILES = 400;
const MAP_CHARS = 8_000;
const MEMORY_CHARS = 6_000;
const SYMBOL_BYTES = 120_000;
const SYMBOLS_PER_FILE = 8;

const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|vue|svelte)$/i;

// Files the map never needs to name.
const NOISE = /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|.*\.map|.*\.min\.[jc]ss?|\.DS_Store|next-env\.d\.ts)$/i;

/** Parsed symbols, kept per file until the file's mtime changes. */
const symbolCache = new Map();

function symbolsIn(file, text) {
  const found = [];
  const add = (name) => { if (name && !found.includes(name)) found.push(name); };

  if (/\.py$/i.test(file)) {
    for (const m of text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) add(m[1]);
  } else if (/\.go$/i.test(file)) {
    for (const m of text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm)) add(m[1]);
    for (const m of text.matchAll(/^type\s+([A-Z]\w*)/gm)) add(m[1]);
  } else if (/\.rs$/i.test(file)) {
    for (const m of text.matchAll(/^pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)/gm)) add(m[1]);
  } else {
    for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
    if (/export\s+default\s+(?:async\s+)?function\s*\(/.test(text)) add('default');
    for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) add(part.trim().split(/\s+as\s+/).pop());
    }
  }

  return found.slice(0, SYMBOLS_PER_FILE);
}

async function symbolsFor(root, rel) {
  const abs = path.join(root, rel);
  try {
    const stat = await fs.stat(abs);
    if (stat.size > SYMBOL_BYTES) return [];
    const cached = symbolCache.get(abs);
    if (cached && cached.mtime === stat.mtimeMs) return cached.symbols;
    const symbols = symbolsIn(rel, await fs.readFile(abs, 'utf8'));
    symbolCache.set(abs, { mtime: stat.mtimeMs, symbols });
    return symbols;
  } catch {
    return [];
  }
}

/**
 * A compact outline of the project: directories, their files, and what each
 * code file exports. Bounded, so a large repository costs a fixed amount of
 * context rather than all of it.
 */
export async function projectMap(root) {
  const all = (await walk(root, { limit: MAP_FILES * 3 })).filter((f) => !NOISE.test(f));
  if (all.length === 0) return '(the folder is empty — this is a new project)';

  const files = all.slice(0, MAP_FILES).sort();
  const symbols = await Promise.all(
    files.map((f) => (CODE.test(f) ? symbolsFor(root, f) : Promise.resolve([])))
  );

  const byDir = new Map();
  files.forEach((f, i) => {
    const dir = path.posix.dirname(f);
    const name = path.posix.basename(f);
    const line = symbols[i].length ? `${name} · ${symbols[i].join(', ')}` : name;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(line);
  });

  const out = [];
  let size = 0;
  let shown = 0;
  for (const [dir, entries] of byDir) {
    const block = [dir === '.' ? './' : `${dir}/`, ...entries.map((e) => `  ${e}`)].join('\n');
    if (size + block.length > MAP_CHARS) {
      out.push(`… ${files.length - shown} more files not shown`);
      break;
    }
    out.push(block);
    size += block.length;
    shown += entries.length;
  }
  if (all.length > MAP_FILES) out.push(`… the project has ${all.length}+ files; the rest are not listed`);

  return out.join('\n');
}

/**
 * Is there any code here yet?
 *
 * Answered from the map that has just been built rather than by walking the
 * tree a second time. A folder with no code file in it has nothing to look up,
 * rename or type-check, so the tools that do those things are dead weight in
 * every request of the turn — and the whole tool list is re-read by the
 * provider on every step.
 */
export function hasCode(map) {
  return /\.(?:[cm]?[jt]sx?|py|go|rs|vue|svelte)(?![\w-])/i.test(String(map ?? ''));
}

async function readCapped(file) {
  try {
    const text = (await fs.readFile(file, 'utf8')).trim();
    if (!text) return '';
    return text.length > MEMORY_CHARS ? `${text.slice(0, MEMORY_CHARS)}\n… (cut)` : text;
  } catch {
    return '';
  }
}

/**
 * Standing instructions: ~/.ucode/UCODE.md for how you like to work anywhere,
 * then <project>/UCODE.md for this project. The project file comes second so
 * it wins where the two disagree.
 */
export async function loadMemory(root) {
  const personal = await readCapped(GLOBAL_MEMORY);
  const project = await readCapped(path.join(root, MEMORY_FILE));
  const parts = [];
  if (personal) parts.push(`From ~/.ucode/${MEMORY_FILE} (applies everywhere):\n${personal}`);
  if (project) parts.push(`From ./${MEMORY_FILE} (this project):\n${project}`);
  return parts.join('\n\n');
}

/** Append one note to this project's UCODE.md, creating it if needed. */
export async function remember(root, note) {
  const file = path.join(root, MEMORY_FILE);
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    existing = `# Project memory\n\nucode reads this at the start of every session in this folder.\n\n`;
  }
  const line = `- ${String(note).trim().replace(/\s+/g, ' ')}\n`;
  const sep = existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(file, existing + sep + line, 'utf8');
  return file;
}
