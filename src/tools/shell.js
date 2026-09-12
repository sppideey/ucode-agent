/**
 * shell.js — running commands.
 *
 * Most of this file is about the ways a spawned command can go wrong in a way
 * that hurts the agent rather than the task: one that waits for a keyboard it
 * will never get, one that never exits, one that kills the runtime the agent is
 * running on, one whose grandchild holds the pipe open so the close event never
 * arrives. Each is handled explicitly, because each has exactly one symptom from
 * the outside — the agent appears to freeze.
 */

import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolFailure } from '../core/failure.js';
import { resolveIn, guard, result, getRoot, MAX_OUTPUT } from './shared.js';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const LIVE_LINES = 200;

/**
 * Anything that looks like a dev server. These never finish on their own, so
 * waiting for them to is a guaranteed timeout — they are started in the
 * background instead, and watched only until they say they are ready.
 */
const LOOKS_LIKE_SERVER =
  /(\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b|\b(?:vite|next dev|next start|nuxt dev|astro dev|webpack serve|svelte-kit dev|serve)\b|\buvicorn\b|\bgunicorn\b|\bflask run\b|\bdjango[\w-]* runserver\b|\bmanage\.py runserver\b|\brails server\b|\bhttp\.server\b|\bhttp-server\b|\blive-server\b)/i;

/** A foreground server that was explicitly asked for still gets a short leash. */
const SERVER_TIMEOUT = 30_000;

/**
 * Installs are slow and legitimately so: create-next-app pulls hundreds of
 * packages and a cold cargo build compiles the world. Cutting that off at two
 * minutes leaves a half-written project on disk, which from the outside looks
 * exactly like the agent giving up in the middle. Ten minutes, still bounded.
 */
const INSTALL_TIMEOUT = 600_000;
const LOOKS_LIKE_INSTALL =
  /(\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|create)\b|\bnpx\s+(?:create-|degit\b|shadcn)|\bpip3?\s+install\b|\bpoetry\s+(?:install|add)\b|\bcargo\s+(?:build|install|fetch)\b|\bgo\s+(?:mod\s+download|get)\b|\bbundle\s+install\b|\bcomposer\s+(?:install|require)\b|\bgit\s+clone\b)/i;

/**
 * Commands that kill a whole class of process rather than one process.
 *
 * `taskkill /IM node.exe /F` takes down the agent itself — it runs on Node —
 * along with the editor, any other servers, and everything else sharing the
 * runtime. It is a real failure mode, not a hypothetical one: a dev server
 * stops answering, the model tries the right PID, misses, and escalates to
 * killing all of Node, at which point it has killed the process it was
 * reporting to and hangs until something times out.
 *
 * Refused with an explanation, so the model can pick the narrow thing instead.
 */
const KILLS_EVERYTHING =
  /(\btaskkill\b[^|;&]*\/IM\s+(?:node|node\.exe|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)\b|\b(?:killall|pkill)\s+(?:-\w+\s+)*(?:node|nodejs)\b|\bpkill\b[^|;&]*-f\s+(?:node|npm|pnpm)\b|\bStop-Process\b[^|;&]*-Name\s+["']?node)/i;

// ---------------------------------------------------------------------------
// The environment a command runs in
// ---------------------------------------------------------------------------

/**
 * What every command inherits on top of the user's own environment.
 *
 * Each line removes a way for a command to be slow or to stall:
 *
 *   CI                  scaffolders use their defaults instead of asking,
 *                       and test runners run once instead of watching forever
 *   npm_config_yes      npx installs without its "Ok to proceed? (y)"
 *   fund / audit        npm skips two network round trips on every install
 *   update_notifier     and the version check on every invocation
 *   NEXT_TELEMETRY      Next skips its telemetry notice and ping
 *   NO_COLOR            output comes back as text rather than escape codes,
 *                       which the model would otherwise have to read past
 */
export function childEnv(base = process.env) {
  return {
    ...base,
    CI: '1',
    npm_config_yes: 'true',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
    // Take a package from the local cache when it is there, instead of asking
    // the registry whether a newer copy exists first. Installing the same
    // framework for the second app in a day goes from network-bound to disk-bound.
    npm_config_prefer_offline: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

/**
 * Kill a command and everything it started.
 *
 * Killing only the shell leaves the dev server it launched still running, and
 * on Windows a surviving grandchild that inherited our stdio keeps the pipe
 * open — so 'close' never fires and the loop waits forever.
 */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* best effort */ }
    try { process.kill(pid); } catch { /* already gone */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    try { spawn('pkill', ['-P', String(pid), '-9'], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

const LOG_DIR = path.join(os.tmpdir(), 'ucode-logs');

/** How long to watch a server for a sign of life before handing back anyway. */
const READY_WAIT = Number(process.env.UCODE_READY_WAIT_MS) || 45_000;

/** Once a URL has been printed, how long to wait for it to also say "ready". */
const URL_GRACE = 6_000;

const POLL = 150;

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const URL_IN_LOG = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+\.local)(?::\d{2,5})?(?:\/[^\s'")\]]*)?/i;

const READY_IN_LOG =
  /(\bready in\b|✓\s*ready|\bready\b[^\n]*\d+(?:\.\d+)?\s?m?s\b|compiled successfully|compiled client and server|\blistening (?:on|at)\b|server (?:is )?(?:running|started|listening|ready)|\brunning (?:on|at)\b|started server on|application startup complete|development server is running|serving (?:http|at|on)|available on:)/i;

/** The URL a person would type: 0.0.0.0 and [::] do not open on Windows. */
function tidyUrl(url) {
  return url
    .replace(/:\/\/(?:0\.0\.0\.0|\[::1?\])/, '://localhost')
    .replace(/\/$/, '');
}

function readLog(file) {
  try {
    const size = statSync(file).size;
    const text = readFileSync(file, 'utf8');
    // Only the recent part matters, and a chatty server can print a lot.
    return stripAnsi(size > 65_536 ? text.slice(-65_536) : text);
  } catch {
    return '';
  }
}

function tail(text, keep = 14) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.length <= keep ? lines : [`… ${lines.length - keep} earlier lines`, ...lines.slice(-keep)];
}

function stopHint(pid) {
  return process.platform === 'win32' ? `taskkill /PID ${pid} /T /F` : `kill -- -${pid}`;
}

/**
 * Start something long-running, and come back the moment it is usable.
 *
 * The old way was to start it and return after a fixed half second, which told
 * the model nothing: not whether it had crashed, not which port it chose, not
 * whether it was ready. The model then had to probe, usually too early, and a
 * slow reasoning model spends most of a minute per probe.
 *
 * Instead its output goes to a log file — a file, not a pipe, because nobody
 * will be reading a pipe once this returns and a full pipe stalls the server —
 * and the log is watched until one of three things happens: it prints that it
 * is ready, it exits, or the wait runs out. Whichever comes first is reported
 * with the URL it is actually listening on.
 */
/** Dev servers that said they were ready, newest last — for opening the app when a turn ends. */
const readyServers = [];

/** Servers that became ready at or after `since` (epoch ms). */
export function serversReadySince(since = 0) {
  return readyServers.filter((s) => s.at >= since);
}

function startServer(command, workdir, { env } = {}) {
  return new Promise((resolve, reject) => {
    let log;
    let fd;
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      log = path.join(LOG_DIR, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.log`);
      fd = openSync(log, 'a');
    } catch (err) {
      reject(new ToolFailure({
        kind: 'log_unwritable',
        attempted: `starting "${command}" in the background`,
        failed: `Could not create a log file in ${LOG_DIR}: ${err.message}`,
        fix: 'Check that the temp directory is writable.',
        cause: err,
      }));
      return;
    }

    let child;
    try {
      child = spawn(command, {
        cwd: workdir.abs,
        shell: true,
        windowsHide: true,
        // Not detached on Windows, and this is load-bearing. A detached process
        // there has no console, and programs launched under it write nothing
        // to a redirected file — measured: every one of node, npm and next
        // produced an empty log, so a server's "ready" line never arrived and
        // every start waited out the full timer. Attached, the output lands.
        // The server itself still outlives ucode: only this shell is tied to
        // ucode's job object, and the job lets grandchildren break away.
        detached: process.platform !== 'win32',
        stdio: ['ignore', fd, fd],
        env,
      });
    } catch (err) {
      closeSync(fd);
      reject(new ToolFailure({
        kind: 'spawn_failed',
        attempted: `starting "${command}" in the background`,
        failed: `The shell would not start: ${err.message}`,
        fix: 'Check the command name and that a shell is on PATH.',
        cause: err,
      }));
      return;
    }

    // The child holds its own handle to the log now.
    closeSync(fd);
    child.unref();

    const started = Date.now();
    let exitCode = null;
    let spawnError = null;
    let urlSeenAt = null;
    let done = false;

    child.on('exit', (code) => { exitCode = code ?? -1; });
    child.on('error', (err) => { spawnError = err; });

    const finish = (build) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      resolve(build());
    };

    const describeRun = (lines) => [
      ...lines,
      `Command: ${command}`,
      `Directory: ${workdir.show}`,
      `Output log: ${log}`,
    ].join('\n');

    const check = () => {
      const text = readLog(log);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);

      if (spawnError) {
        finish(() => {
          const out = result(
            describeRun([`It could not start: ${spawnError.message}`]),
            'failed to start'
          );
          out.output = tail(text);
          return out;
        });
        return;
      }

      if (exitCode !== null) {
        finish(() => {
          const out = result(
            describeRun([
              `It exited with code ${exitCode} after ${seconds}s, before it was ready.`,
              '',
              text.trim() || '(it printed nothing)',
            ]),
            `exited ${exitCode} before it was ready`
          );
          out.exitCode = exitCode;
          out.output = tail(text);
          return out;
        });
        return;
      }

      const url = URL_IN_LOG.exec(text)?.[0]
        ?? (/\bport\s+(\d{2,5})\b/i.exec(text) ? `http://localhost:${/\bport\s+(\d{2,5})\b/i.exec(text)[1]}` : null);
      if (url && urlSeenAt === null) urlSeenAt = Date.now();
      const ready = READY_IN_LOG.test(text);
      const graceOver = urlSeenAt !== null && Date.now() - urlSeenAt >= URL_GRACE;

      if ((ready && url) || graceOver || (ready && Date.now() - started > 1500)) {
        finish(() => {
          const where = url ? tidyUrl(url) : null;
          if (where) readyServers.push({ url: where, pid: child.pid, at: Date.now() });
          return result(
            describeRun([
              `Running in the background as PID ${child.pid}, ready after ${seconds}s.`,
              where ? `Open it at ${where}` : 'It did not print a URL; check the log for the port.',
              `Stop it with: ${stopHint(child.pid)}`,
              '',
              'Do not start it again — it is already running.',
            ]),
            where ? `ready · ${where} · PID ${child.pid}` : `ready · PID ${child.pid}`
          );
        });
        return;
      }

      if (Date.now() - started >= READY_WAIT) {
        finish(() => {
          const out = result(
            describeRun([
              `Still starting after ${Math.round(READY_WAIT / 1000)}s — running as PID ${child.pid}, ` +
                'but it has not said it is ready yet.',
              url ? `It mentioned ${tidyUrl(url)}.` : '',
              `Stop it with: ${stopHint(child.pid)}`,
              '',
              text.trim() ? `Latest output:\n${tail(text).join('\n')}` : '(no output yet)',
            ].filter((l) => l !== '')),
            `still starting · PID ${child.pid}`
          );
          out.output = tail(text);
          return out;
        });
      }
    };

    const timer = setInterval(check, POLL);
  });
}

// ---------------------------------------------------------------------------
// Installing in the background
// ---------------------------------------------------------------------------

/**
 * Installs already running, by directory.
 *
 * The moment a package.json with dependencies is written, its install starts
 * in the background — while the model is still writing the components. By the
 * time it asks to install, build or start the app, the install is usually done
 * or nearly so, and whatever wait is left is the remainder rather than the
 * whole thing.
 */
const installs = new Map();

/** The package manager a project already uses, going by its lockfile. */
export function packageManagerFor(dir) {
  const has = (f) => { try { statSync(path.join(dir, f)); return true; } catch { return false; } };
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  // npm by default, deliberately: pnpm 10+ refuses to run install scripts
  // without an interactive approval, which fails the install outright here.
  return 'npm';
}

function runInstall(dir) {
  const pm = packageManagerFor(dir);
  const command = pm === 'npm' ? 'npm install --no-audit --no-fund' : `${pm} install`;
  const started = Date.now();

  const promise = new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, {
        cwd: dir, shell: true, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(),
      });
    } catch (err) {
      resolve({ code: -1, output: err.message, command, seconds: 0 });
      return;
    }
    const take = (chunk) => { if (output.length < MAX_OUTPUT * 2) output += stripAnsi(chunk.toString()); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => killTree(child.pid), INSTALL_TIMEOUT);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim(), command, seconds: Math.round((Date.now() - started) / 1000) });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: err.message, command, seconds: 0 });
    });
  });

  const entry = { promise, stale: false };
  installs.set(dir, entry);
  // If package.json changed again while this was running, go once more.
  promise.then(() => {
    if (installs.get(dir) !== entry) return;
    if (entry.stale) runInstall(dir);
    else installs.delete(dir);
  });
  return entry;
}

/**
 * Called whenever a package.json is written. Starts an install if it declares
 * dependencies, or marks a running one to go again with the new list.
 */
export function packageJsonWritten(file, content) {
  let pkg;
  try { pkg = JSON.parse(content); } catch { return; }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (Object.keys(deps).length === 0) return;

  const dir = path.dirname(file);
  const running = installs.get(dir);
  if (running) running.stale = true;
  else runInstall(dir);
}

/** The install running in exactly this folder, to follow it to its end. */
export function installIn(dir) {
  return installs.get(path.resolve(dir))?.promise ?? null;
}

/** The install running for this directory or any folder above it, if one is. */
function installFor(dir) {
  let at = path.resolve(dir);
  for (;;) {
    if (installs.has(at)) return { dir: at, entry: installs.get(at) };
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

const PLAIN_INSTALL = /^\s*(?:npm\s+(?:i|install)|pnpm\s+(?:i|install)|yarn(?:\s+install)?|bun\s+(?:i|install))(?:\s+--?[\w-]+(?:=\S+)?)*\s*$/i;

/**
 * Wait for a background install before running something that needs it — and
 * if the command IS that install, hand back the background one's result
 * instead of doing it twice.
 */
async function awaitInstall(command, workdir, onOutput) {
  // Models often write `cd app && npm run build` instead of passing cwd, so the
  // directory a command really runs in is read off the front of it.
  const cd = /^\s*cd\s+(?:\/d\s+)?("?)([^"&|;]+?)\1\s*(?:&&|;)\s*/i.exec(command);
  const dir = cd ? path.resolve(workdir.abs, cd[2].trim()) : path.resolve(workdir.abs);
  const rest = cd ? command.slice(cd[0].length) : command;

  const found = installFor(dir);
  if (!found) return null;

  onOutput?.(['waiting for the install that started when package.json was written']);
  let done = await found.entry.promise;
  // It may have been restarted for a newer package.json; wait for that too.
  while (installs.get(found.dir) && installs.get(found.dir) !== found.entry) {
    done = await installs.get(found.dir).promise;
  }

  if (!PLAIN_INSTALL.test(rest) || path.resolve(found.dir) !== dir) return null;

  const out = result(
    `The install already ran in the background as soon as package.json was written ` +
      `(\`${done.command}\`, ${done.seconds}s).\n\nexit code: ${done.code}\n\n${done.output || '(no output)'}`,
    `already installed in the background · exit ${done.code} · ${done.seconds}s`
  );
  out.exitCode = done.code;
  if (done.code !== 0) out.output = tail(done.output);
  return out;
}

// ---------------------------------------------------------------------------
// What a failed build is really asking for
// ---------------------------------------------------------------------------

/**
 * Plain next steps for the build failures that send a model down a hole.
 *
 * Measured: a missing shadcn component failed the build, and instead of
 * adding it the model spent a dozen steps listing node_modules, then deleted
 * the app and started over. The error names exactly what is missing; this
 * turns that into the one command that fixes it.
 */
export function buildHints(output, dir = null) {
  const hints = [];
  const seen = new Set();
  const add = (key, text) => {
    if (seen.has(key)) return;
    seen.add(key);
    hints.push(text);
  };

  const UI = /(?:Can't resolve|Cannot find module) '@\/components\/ui\/([\w-]+)'/g;
  for (const m of output.matchAll(UI)) {
    add(`ui:${m[1]}`, `The shadcn component "${m[1]}" is not in this project. Add it with ` +
      `\`npx shadcn@latest add ${m[1]} -y\` (cwd: the app folder), then build again. ` +
      'Do not look inside node_modules.');
  }

  const PKG = /(?:Can't resolve|Cannot find module) '((?:@[\w.-]+\/)?[\w.-]+)(\/[^']*)?'/g;
  for (const m of output.matchAll(PKG)) {
    const [, pkg, subpath] = m;
    if (pkg.startsWith('.')) continue;
    if (subpath && dir && installed(dir, pkg)) {
      // Installed, but that path inside it does not exist: an import copied
      // from an older version. Installing it again changes nothing.
      add(`sub:${pkg}${subpath}`, `"${pkg}" is installed, but "${pkg}${subpath}" does not exist — ` +
        `that path is from an older version. Import from "${pkg}" itself` +
        (pkg === 'next-themes'
          ? '; for the provider\'s props use `React.ComponentProps<typeof NextThemesProvider>`.'
          : ', or check its package.json "exports" for the right path.') +
        ' Do not reinstall it.');
      continue;
    }
    add(`pkg:${pkg}`, `The package "${pkg}" is not installed. Install it with ` +
      `\`npm install ${pkg}\` (cwd: the app folder), then build again.`);
  }

  if (/Parsing ecmascript source code failed|Expression expected|Unexpected token/.test(output)) {
    add('syntax', 'A file does not parse. Open the file and line the error names, fix that ' +
      'syntax, then build again.');
  }

  return hints;
}

/** Is this package installed for the project at dir (or a folder above it)? */
function installed(dir, pkg) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    try {
      statSync(path.join(at, 'node_modules', pkg, 'package.json'));
      return true;
    } catch { /* not here */ }
    if (path.dirname(at) === at) return false;
  }
}

/** The folder a command really runs in: its cwd, moved by a leading `cd x &&`. */
function effectiveDir(command, workdir) {
  const cd = /^\s*cd\s+(?:\/d\s+)?("?)([^"&|;]+?)\1\s*(?:&&|;)\s*/i.exec(command);
  return cd ? path.resolve(workdir.abs, cd[2].trim()) : path.resolve(workdir.abs);
}

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------

export async function runCommand({ command, cwd, timeout_ms, background }, { onOutput } = {}) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'running a command',
      failed: 'The "command" argument was missing or empty.',
      fix: 'Pass the whole command line as one string.',
    });
  }

  // `sleep 3 && curl localhost:3000` after the server already reported ready
  // is a wait for nothing. Measured on a real build; the sleep is dropped.
  const napping = /^\s*(?:sleep\s+\d+(?:\.\d+)?|timeout\s+\/t\s+\d+(?:\s+\/nobreak)?)\s*(?:&&|;)\s*/i.exec(command);
  if (napping && readyServers.length) command = command.slice(napping[0].length);

  if (KILLS_EVERYTHING.test(command)) {
    throw new ToolFailure({
      kind: 'suicidal_command',
      attempted: `running \`${command.trim().slice(0, 80)}\``,
      failed:
        'That kills every process of its kind, which includes the one running this ' +
        'agent — the session would end in the middle of the task.',
      fix:
        'Kill the single process instead. Start long-running things with background: ' +
        'true, which hands back a PID, then stop that PID by number. For a stuck port, ' +
        'find its owner first: `netstat -ano | findstr :3000` on Windows, ' +
        '`lsof -i :3000` elsewhere.',
    });
  }

  const workdir = cwd
    ? resolveIn(cwd, 'run_command', 'cwd')
    : { abs: getRoot(), inside: true, show: '.' };
  await guard(workdir, `run a command in ${workdir.abs}`);

  const env = childEnv();
  const server = LOOKS_LIKE_SERVER.test(command);

  // Anything run where a background install is still going waits for it —
  // two installs in one folder corrupt node_modules, and a build before the
  // install finishes fails for no reason the model could see.
  const alreadyInstalled = await awaitInstall(command, workdir, onOutput);
  if (alreadyInstalled) return alreadyInstalled;

  // A dev server is backgrounded whether or not the model remembered to ask.
  // Only an explicit `background: false` keeps one in the foreground.
  if (background || (server && background !== false)) {
    return startServer(command, workdir, { env });
  }

  let timeout = Math.min(Math.max(Number(timeout_ms) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);
  // An explicit timeout_ms is the caller's decision and is left alone. These
  // only adjust the default.
  if (!timeout_ms && LOOKS_LIKE_INSTALL.test(command)) timeout = INSTALL_TIMEOUT;
  if (!timeout_ms && server) timeout = Math.min(timeout, SERVER_TIMEOUT);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, {
        cwd: workdir.abs,
        shell: true,
        windowsHide: true,
        // No stdin. A command that asks a question gets end-of-input at once
        // and either takes its default or fails in a second — instead of
        // waiting, on an open pipe nobody writes to, until the timeout.
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      reject(new ToolFailure({
        kind: 'spawn_failed',
        attempted: `running "${command}"`,
        failed: `The shell would not start: ${err.message}`,
        fix: 'Check the command name and that a shell is on PATH.',
        cause: err,
      }));
      return;
    }

    let captured = '';
    let timedOut = false;
    let done = false;
    let timer = null;
    let backstop = null;

    // Output is reported while it happens, so a slow build is something you
    // watch rather than something you sit through. Whole lines only — a
    // partial line waits for its newline — and a \r progress bar collapses to
    // its latest state, since a line meant to overwrite itself should not
    // scroll past a hundred times.
    const live = typeof onOutput === 'function' ? onOutput : null;
    let held = '';
    let livePrinted = 0;
    let liveCapped = false;

    const take = (chunk) => {
      const text = stripAnsi(chunk.toString());
      // Collect more than will be shown, then trim once at the end.
      if (captured.length < MAX_OUTPUT * 4) captured += text;
      if (!live || liveCapped) return;

      held += text;
      const parts = held.split(/\r?\n/);
      held = parts.pop();
      if (!parts.length) return;

      const lines = parts.map((l) => l.split('\r').pop());
      const room = LIVE_LINES - livePrinted;
      if (lines.length > room) {
        lines.length = Math.max(0, room);
        liveCapped = true;
        lines.push('… the rest is in the final output');
      }
      livePrinted += lines.length;
      if (lines.length) live(lines);
    };

    child.stdout?.on('data', take);
    child.stderr?.on('data', take);

    /**
     * The single place this promise resolves. Both the close event and the
     * post-kill backstop land here, so nothing can leave it pending: a killed
     * shell whose grandchild still holds our stdio never emits 'close', and
     * that used to freeze the entire agent.
     */
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      if (live && held.trim() && !liveCapped) live([held.split('\r').pop()]);
      held = '';

      const body = captured.trim() || '(no output)';
      // What survives on screen: nothing when it worked and the user already
      // watched it, the tail when it did not.
      const shown = (failed) => (live && !failed && !liveCapped ? [] : tail(body));

      if (timedOut) {
        let content = `Timed out after ${Math.round(timeout / 1000)}s and was killed.\n\n${body}`;
        if (server || READY_IN_LOG.test(captured)) {
          content +=
            '\n\nThat looks like a server rather than a command that finishes. Run it ' +
            'again without background: false — ucode starts servers in the background ' +
            'and reports the URL as soon as it is ready.';
        } else if (/\?\s*›|\(y\/n\)|\[y\/N\]|press enter|select an option|use arrow keys/i.test(captured)) {
          content +=
            '\n\nIt looks like it stopped to ask a question. Nothing can answer it — pass ' +
            'the non-interactive flag instead (--yes, -y, --defaults, or the option it asked about).';
        }
        const out = result(content, `timed out after ${Math.round(timeout / 1000)}s`);
        out.output = shown(true);
        resolve(out);
        return;
      }

      const count = captured.trim() ? captured.trim().split(/\r?\n/).length : 0;
      const hints = code !== 0 ? buildHints(captured, effectiveDir(command, workdir)) : [];
      const advice = hints.length ? `\n\nWhat to do:\n${hints.map((h) => `- ${h}`).join('\n')}` : '';
      const out = result(
        `exit code: ${code}\n\n${body}${advice}`,
        `exit ${code} · ${count} line${count === 1 ? '' : 's'}`
      );
      out.exitCode = code;
      out.output = shown(code !== 0);
      resolve(out);
    };

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // The tree kill is best effort; if the pipes stay open, force the
      // resolution anyway. The loop has to move on either way.
      backstop = setTimeout(() => finish(null), 2500);
    }, timeout);

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      reject(new ToolFailure({
        kind: 'spawn_failed',
        attempted: `running "${command}"`,
        failed: `The command could not run: ${err.message}`,
        fix: 'Check the executable name and your PATH.',
        cause: err,
      }));
    });

    child.on('close', (code) => finish(code));
  });
}

/**
 * Several commands at once, with a ceiling on how many run together.
 *
 * Install, build and test are independent often enough to be worth it, and
 * three round trips become one.
 */
export async function runCommands({ commands, max_parallel = 3 }, opts = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'running several commands',
      failed: 'The "commands" argument must be a non-empty array.',
      fix: 'Pass commands as [{ command, cwd?, timeout_ms?, background? }, ...].',
    });
  }

  const width = Math.min(Math.max(Number(max_parallel) || 3, 1), 10);
  const finished = new Array(commands.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= commands.length) return;
      try {
        finished[i] = { ok: await runCommand(commands[i] ?? {}, opts) };
      } catch (err) {
        finished[i] = { err };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, commands.length) }, worker));

  const blocks = finished.map((r, i) => {
    const label = `${i + 1}. ${commands[i]?.command ?? '(missing command)'}`;
    if (r.err) return `${label}\nFAILED: ${r.err.failed ?? r.err.message}`;
    return `${label}\n${r.ok.content}`;
  });

  const summary = finished
    .map((r, i) => `${i + 1}. ${r.err ? 'failed' : r.ok.summary}`)
    .join(' · ');

  return result(blocks.join('\n\n---\n\n'), `${commands.length} commands: ${summary}`);
}
