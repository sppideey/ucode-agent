/**
 * cache.js — the starter's packages, installed once and reused.
 *
 * A new app's `npm install` is a minute of the model waiting on the network
 * for a tree it has installed a hundred times before. The first install of a
 * starter is kept in ~/.ucode/cache, keyed by the lockfile, and every app
 * after that gets it as hard links: the same files on disk under a new name,
 * so it costs no extra space and finishes in seconds.
 *
 * Hard links rather than a junction or a symlink, because Turbopack refuses a
 * node_modules that points outside the project. Anything that cannot be linked
 * — another drive, a filesystem without links — is copied instead, and if even
 * that fails the normal install runs as before.
 *
 * A cache entry is only used once its marker file is there, which is written
 * last: a half-written cache from an interrupted copy is ignored, not used.
 *
 * The key is the *starter's* lockfile, never the app's. npm rewrites an app's
 * package-lock.json as it installs, so keying on that would file the cache
 * under one name and look it up under another — a cache that never hits and
 * never says why.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const MARKER = '.ucode-complete';

/** Written into node_modules by build tools; never worth carrying between apps. */
const NOT_WORTH_KEEPING = new Set(['.cache', '.vite', '.turbo']);

export const cacheRoot = (home = os.homedir()) => path.join(home, '.ucode', 'cache');

/** Where this starter's install lives, given its lockfile text. */
export function slotFor(template, lockText, home) {
  const hash = createHash('sha1').update(String(lockText ?? '')).digest('hex').slice(0, 12);
  return path.join(cacheRoot(home), `${template}-${hash}`);
}

/**
 * Copy a tree as hard links, falling back to real copies where linking fails.
 * `skip` names top-level entries to leave behind.
 */
export async function linkTree(from, to, skip = null) {
  let files = 0;
  const walk = async (src, dst, top) => {
    await fs.mkdir(dst, { recursive: true });
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
      if (top && skip?.has(entry.name)) continue;
      const a = path.join(src, entry.name);
      const b = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        await walk(a, b, false);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(a).catch(() => null);
        if (target) await fs.symlink(target, b).catch(() => fs.copyFile(a, b).catch(() => {}));
      } else {
        await fs.link(a, b).catch(() => fs.copyFile(a, b));
        files++;
      }
    }
  };
  await walk(from, to, true);
  return files;
}

/**
 * Put the cached packages into the app, if this starter has been installed
 * before. Returns how many files were linked, or 0 when there is no cache.
 */
export async function restore(appDir, template, lockText, { home } = {}) {
  if (!lockText) return 0;
  const slot = slotFor(template, lockText, home);
  if (!(await fs.stat(path.join(slot, MARKER)).catch(() => null))) return 0;
  const target = path.join(appDir, 'node_modules');
  if (await fs.stat(target).catch(() => null)) return 0; // already installed
  try {
    return await linkTree(path.join(slot, 'node_modules'), target);
  } catch {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    return 0; // a partial restore is worse than none: let npm do it
  }
}

/**
 * Keep this app's node_modules as the cache for its starter, so the next app
 * starts from it. Runs after a successful install and never throws.
 */
export async function populate(appDir, template, lockText, { home } = {}) {
  try {
    if (!lockText) return false;
    const slot = slotFor(template, lockText, home);
    if (await fs.stat(path.join(slot, MARKER)).catch(() => null)) return false;
    const from = path.join(appDir, 'node_modules');
    if (!(await fs.stat(from).catch(() => null))) return false;
    await fs.rm(slot, { recursive: true, force: true }).catch(() => {});
    await linkTree(from, path.join(slot, 'node_modules'), NOT_WORTH_KEEPING);
    await fs.writeFile(path.join(slot, MARKER), `${template}\n${new Date().toISOString()}\n`);
    return true;
  } catch {
    return false; // the cache is an optimisation; never let it break a build
  }
}
