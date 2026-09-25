/**
 * attach.js — the "+ file" button: choosing reference files and turning them
 * into something the model can use.
 *
 * The chooser is the computer's own (Finder on macOS, the Open dialog on
 * Windows, zenity on Linux), so a sketch on the Desktop or a brief in
 * Downloads is two clicks away. Where there is none, the caller falls back to
 * a list of the project's files.
 *
 * Images go to the model as pictures; text files ride on the request as
 * reference, under their own name. Anything else is refused with a reason.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const IMAGE = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' };

/** Bigger than this and a picture is refused rather than sent. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Bigger than this and a text file is refused: it would crowd out the conversation. */
export const MAX_TEXT_BYTES = 100 * 1024;

/** Folders never listed in the fallback picker. */
const SKIP = new Set(['node_modules', '.git', '.next', '.ucode', 'dist', 'build', '.turbo', '.vercel']);

/** The native "choose a file" command for this platform, or null when there is none to try. */
function chooserFor(platform) {
  if (platform === 'darwin') {
    return ['osascript', ['-e', 'POSIX path of (choose file with prompt "Add a file for ucode")']];
  }
  if (platform === 'win32') {
    const script =
      'Add-Type -AssemblyName System.Windows.Forms;' +
      '$d = New-Object System.Windows.Forms.OpenFileDialog;' +
      '$d.Title = "Add a file for ucode";' +
      'if ($d.ShowDialog() -eq "OK") { [Console]::Out.Write($d.FileName) }';
    return ['powershell.exe', ['-NoProfile', '-STA', '-Command', script]];
  }
  return ['zenity', ['--file-selection', '--title=Add a file for ucode']];
}

/**
 * Ask the user for a file with the system's own dialog.
 * Resolves to a path, null when they cancelled, or undefined when there is no dialog here.
 */
export function chooseFile({ platform = process.platform, run = execFile } = {}) {
  const [cmd, args] = chooserFor(platform);
  return new Promise((resolve) => {
    run(cmd, args, { timeout: 10 * 60_000, windowsHide: false }, (err, stdout) => {
      const picked = String(stdout ?? '').trim();
      if (picked) return resolve(picked);
      // The program could not start (ENOENT, EACCES: a string code) means no
      // dialog here; a non-zero exit from one that ran is a cancel.
      resolve(typeof err?.code === 'string' ? undefined : null);
    });
  });
}

/** Files under `root` for the fallback picker, nearest first, at most `limit`. */
export async function projectFiles(root, limit = 200) {
  const found = [];
  const queue = [''];
  while (queue.length && found.length < limit) {
    const dir = queue.shift();
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) queue.push(rel); }
      else if (e.isFile() && found.length < limit) found.push(rel);
    }
  }
  return found;
}

/**
 * Read chosen files into what a request carries.
 * Returns { images: [dataUrl], text: string to append to the request, notes: [line for the user] }.
 */
export async function loadAttachments(files) {
  const images = [];
  const blocks = [];
  const notes = [];

  for (const file of files) {
    const name = path.basename(file);
    let buf;
    try {
      buf = await fs.readFile(file);
    } catch {
      notes.push(`could not read ${name} — skipped`);
      continue;
    }

    const kind = IMAGE[path.extname(name).slice(1).toLowerCase()];
    if (kind) {
      if (buf.length > MAX_IMAGE_BYTES) { notes.push(`${name} is over 10 MB — skipped`); continue; }
      images.push(`data:image/${kind};base64,${buf.toString('base64')}`);
      notes.push(`attached ${name}`);
      continue;
    }

    if (buf.subarray(0, 8192).includes(0)) {
      notes.push(`${name} is not a picture or a text file — skipped`);
      continue;
    }
    if (buf.length > MAX_TEXT_BYTES) { notes.push(`${name} is over 100 KB of text — skipped`); continue; }
    const text = buf.toString('utf8').trimEnd();
    // A fence longer than any run of backticks inside, so the file cannot close it early.
    const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
    blocks.push(`Reference file ${name}, attached by the user:\n${fence}\n${text}\n${fence}`);
    notes.push(`attached ${name}`);
  }

  return { images, text: blocks.length ? `\n\n${blocks.join('\n\n')}` : '', notes };
}
