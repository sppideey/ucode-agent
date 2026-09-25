/**
 * opener.js — showing a finished page or a running server in the user's own
 * browser.
 *
 * Kept apart from the loop because it is the one place ucode starts a program
 * on a path the model chose, and that deserves to be read on its own.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';

/** Is this a web address rather than a file on disk? */
const isWeb = (target) => /^https?:\/\//.test(target);

/**
 * Only pages inside the project are opened. A folder name comes from the
 * model, and a UNC path (\\host\share) would have explorer reach out to
 * another machine.
 */
export function insideRoot(target, root) {
  const rel = path.relative(root, target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Open a URL or a page inside `root`. Returns whether an opener was started.
 *
 * A file goes to explorer on Windows, not `cmd /c start`: an & in a folder
 * name would be a second command to cmd.
 */
export function openInBrowser(target, { root }) {
  const web = isWeb(target);
  if (!web && !insideRoot(target, root)) return false;
  const [cmd, args] = process.platform === 'win32'
    ? (web ? ['cmd', ['/c', 'start', '', target]] : ['explorer.exe', [target]])
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [target]];
  try {
    // A missing opener (no xdg-open) fails later, as an event; unheard, it would crash ucode.
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
    return true;
  } catch {
    return false; // no browser to open — the link is in the answer
  }
}
