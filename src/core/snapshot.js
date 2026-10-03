/**
 * snapshot.js — the whole project as it was before each turn, for /undo.
 *
 * undo.js remembers files ucode's own tools write, for one turn. That misses
 * everything a command changes — a script that rewrites a config, a generator
 * that adds twenty files — and it forgets the moment the next turn starts. So
 * the project is snapshotted before every turn into a hidden git repository
 * of ucode's own, under ~/.ucode/snapshots: the project's own .git is never
 * read or written, and a folder with no git at all gets the same undo.
 *
 * The project's .gitignore is honoured, and node_modules and build output are
 * always left out: they are huge, and an install can simply be run again.
 *
 * ponytail: snapshots are never pruned. Git only stores what changed, so a
 * long-lived project grows by its edits; `git gc` in the snapshot folder, or
 * deleting it, is the upgrade path if that ever matters.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walk } from '../tools/shared.js';

export const SNAPSHOT_HOME = path.join(os.homedir(), '.ucode', 'snapshots');

/** Past this many files, snapshotting every turn would cost real time. */
export const MAX_FILES = 3000;

const EXCLUDE = [
  'node_modules/', '.next/', 'dist/', 'build/', 'out/', 'coverage/', '.cache/', '.turbo/',
  '.venv/', 'venv/', '__pycache__/', 'target/', '.ucode/', '*.log',
];

function run(args, { cwd }) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      resolve({ code: -1, out: '', err: e.message });
      return;
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

export class Snapshots {
  constructor(cwd, { home = SNAPSHOT_HOME } = {}) {
    this.cwd = path.resolve(cwd);
    const id = createHash('sha1').update(this.cwd.toLowerCase()).digest('hex').slice(0, 16);
    this.gitDir = path.join(home, `${id}.git`);
    this.usable = null; // decided once, by ready()
  }

  git(args) {
    return run([
      `--git-dir=${this.gitDir}`, `--work-tree=${this.cwd}`,
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.longpaths=true',
      '-c', 'user.name=ucode', '-c', 'user.email=ucode@localhost', '-c', 'commit.gpgsign=false',
      ...args,
    ], { cwd: this.cwd });
  }

  /**
   * Whether this folder can be snapshotted: git is installed, the folder is a
   * project rather than a home directory or a drive, and it is small enough
   * that a snapshot costs a moment.
   */
  async ready() {
    if (this.usable !== null) return this.usable;
    this.usable = false;
    if (process.env.UCODE_SNAPSHOTS === '0') return false;
    const home = path.resolve(os.homedir());
    if (this.cwd === home || this.cwd === path.parse(this.cwd).root) return false;
    const files = await walk(this.cwd, { limit: MAX_FILES + 1 }).catch(() => null);
    if (!files || files.length > MAX_FILES) return false;
    try {
      await fs.access(path.join(this.gitDir, 'HEAD'));
    } catch {
      await fs.mkdir(path.dirname(this.gitDir), { recursive: true });
      const init = await run(['init', '-q', '--bare', this.gitDir], { cwd: path.dirname(this.gitDir) });
      if (init.code !== 0) return false;
    }
    await fs.mkdir(path.join(this.gitDir, 'info'), { recursive: true });
    await fs.writeFile(path.join(this.gitDir, 'info', 'exclude'), `${EXCLUDE.join('\n')}\n`);
    this.usable = true;
    return true;
  }

  /** Record the project as it is now. Resolves to the snapshot id, or null. */
  async take(label = 'snapshot') {
    if (!(await this.ready())) return null;
    const add = await this.git(['add', '-A', '.']);
    if (add.code !== 0) return null;
    const commit = await this.git(['commit', '-q', '--allow-empty', '--no-verify', '-m', label]);
    if (commit.code !== 0) return null;
    const head = await this.git(['rev-parse', 'HEAD']);
    return head.code === 0 ? head.out.trim() : null;
  }

  /** Files that differ between a snapshot and now: [{ status: 'A'|'M'|'D', file }]. */
  async changedSince(id) {
    const now = await this.take('now');
    if (!now) return [];
    const diff = await this.git(['diff', '--name-status', '--no-renames', id, now]);
    if (diff.code !== 0) return [];
    return diff.out.split('\n').filter(Boolean).map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status[0], file: rest.join('\t') };
    });
  }

  /**
   * Put the project back the way it was at a snapshot. Files made since are
   * removed; files changed or deleted since come back.
   */
  async restore(id) {
    const out = { restored: [], removed: [], failed: [] };
    const changes = await this.changedSince(id);
    for (const { status, file } of changes) {
      if (status === 'A') {
        try {
          await fs.rm(path.join(this.cwd, file), { force: true });
          out.removed.push(file);
        } catch (err) {
          out.failed.push(`${file}: ${err.message}`);
        }
      }
    }
    const back = changes.filter((c) => c.status !== 'A').map((c) => c.file);
    // In batches: Windows caps a command line at 32K characters.
    for (let i = 0; i < back.length; i += 100) {
      const batch = back.slice(i, i + 100);
      const checkout = await this.git(['checkout', id, '--', ...batch]);
      if (checkout.code === 0) out.restored.push(...batch);
      else out.failed.push(checkout.err.trim().split('\n')[0] || 'git checkout failed');
    }
    return out;
  }
}
