/**
 * git.js — which branch you are on, read off the disk rather than shelled out.
 *
 * The header wants one word. Spawning `git` to get it would cost a process at
 * startup and fail differently on every machine, where `.git/HEAD` is a single
 * line in a documented format that has not changed in twenty years.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** `ref: refs/heads/main` → `main`; a bare sha → its first seven characters. */
export function parseHead(text) {
  const head = String(text ?? '').trim();
  if (!head) return '';
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1];
  // A detached head is the commit itself, which is worth saying as such.
  return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : '';
}

/**
 * The repository directory for a folder, walking up until one is found.
 *
 * In a worktree or a submodule `.git` is a file pointing elsewhere, so the
 * pointer is followed — otherwise every worktree would report no branch.
 */
function repoDir(start) {
  let dir = path.resolve(start);
  for (let up = 0; up < 40; up++) {
    const dot = path.join(dir, '.git');
    try {
      const stat = statSync(dot);
      if (stat.isDirectory()) return dot;
      if (stat.isFile()) {
        const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'));
        if (link) return path.resolve(dir, link[1].trim());
        return '';
      }
    } catch {
      // Not here; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
  return '';
}

/**
 * The branch name for a folder, or '' when it is not a repository.
 *
 * Never throws. A header that cannot be drawn because a permission check
 * failed on a folder above the project would be a worse bug than a missing
 * word, so every failure here is the same as "not a repository".
 */
export function gitBranch(cwd) {
  try {
    const dir = repoDir(cwd);
    if (!dir) return '';
    return parseHead(readFileSync(path.join(dir, 'HEAD'), 'utf8'));
  } catch {
    return '';
  }
}
