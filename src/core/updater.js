/**
 * updater.js — staying current without anyone running npm by hand.
 *
 * On every launch ucode asks the registry, in the background, whether a newer
 * version exists. If one does, it installs it globally, detached, while you
 * work. The version you are running carries on untouched; the next launch is
 * the new one. Nothing about starting ucode waits on any of this.
 *
 * It stays out of the way in three cases: a development checkout (updating
 * would overwrite the `npm link` that points at your working copy), when
 * UCODE_NO_UPDATE is set, and when another ucode is already updating.
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

const PACKAGE = 'ucode-agent';
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME = path.join(os.homedir(), '.ucode');
const LOCK = path.join(HOME, 'update.lock');
const LOG = path.join(HOME, 'update.log');
const LOCK_TTL = 10 * 60_000;

/** "1.10.0" > "1.9.3" — numeric, part by part. */
export function newer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

function isDevCheckout() {
  return existsSync(path.join(PACKAGE_ROOT, '.git'));
}

async function latestVersion() {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {
    signal: AbortSignal.timeout(5_000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return null;
  return (await res.json())?.version ?? null;
}

/** Is that process still running? A lock held by a dead one is not a lock. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Take the update lock, unless a live process holds it.
 *
 * The lock used to be dropped by the parent watching the installer exit — but
 * the installer is detached and ucode usually leaves first, so the handler
 * never ran and the lock sat there blocking every update until it aged out.
 * Now the holder is checked for a pulse, so a lock left by a process that has
 * gone is simply taken over.
 */
async function takeLock() {
  try {
    const stat = await fs.stat(LOCK);
    const holder = parseInt(await fs.readFile(LOCK, 'utf8').catch(() => ''), 10);
    if (alive(holder) && Date.now() - stat.mtimeMs < LOCK_TTL) return false;
  } catch { /* no lock — good */ }
  await fs.mkdir(HOME, { recursive: true });
  await fs.writeFile(LOCK, String(process.pid));
  return true;
}

export async function releaseLock() {
  await fs.rm(LOCK, { force: true }).catch(() => {});
}

/**
 * Install the newer version and return true once it is on disk.
 *
 * This one waits. It is used at startup, where waiting a few seconds once per
 * release is the whole point: the alternative is being told an update exists
 * and running the old one anyway.
 */
export async function installNow(version) {
  if (!(await takeLock())) return false;
  try {
    const done = await new Promise((resolve) => {
      const child = spawn(`npm install -g ${PACKAGE}@${version} --no-audit --no-fund --silent`, {
        shell: true, windowsHide: true, stdio: 'ignore',
      });
      child.on('exit', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 90_000);
    });
    return done;
  } finally {
    await releaseLock();
  }
}

/** The newest version on the registry, if it is newer than this one. */
export async function pendingUpdate() {
  try {
    if (process.env.UCODE_NO_UPDATE || isDevCheckout() || !VERSION) return null;
    const latest = await latestVersion();
    return latest && newer(latest, VERSION) ? latest : null;
  } catch {
    return null;
  }
}

/**
 * Check, and install if there is something newer.
 *
 * @param {object} o
 * @param {(v: string) => void} [o.onUpdated]  called when the install finishes
 */
export async function autoUpdate({ onUpdated } = {}) {
  try {
    if (process.env.UCODE_NO_UPDATE || isDevCheckout() || !VERSION) return;
    const latest = await latestVersion();
    if (!latest || !newer(latest, VERSION)) return;
    if (!(await takeLock())) return;

    const log = await fs.open(LOG, 'w');
    const child = spawn(`npm install -g ${PACKAGE}@${latest} --no-audit --no-fund`, {
      shell: true,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await log.close();
    child.unref();

    // The lock is cleared by whoever took it. This process may well be gone
    // before npm finishes, so it cannot be left to an exit handler here.
    child.on('exit', async (code) => {
      await releaseLock();
      if (code === 0) onUpdated?.(latest);
    });
    child.on('error', async () => { await releaseLock(); });
    // And if this process leaves first, release it on the way out.
    process.once('exit', () => { try { rmSync(LOCK, { force: true }); } catch {} });
  } catch {
    // An update check must never be the reason ucode misbehaves. Offline,
    // registry down, no permission to install globally: all silently skipped.
  }
}
