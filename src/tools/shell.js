/**
 * shell.js — running commands.
 *
 * Most of this file is about the ways a spawned command can go wrong in a way
 * that hurts the agent rather than the task: one that never exits, one that
 * kills the runtime the agent is running on, one whose grandchild holds the
 * pipe open so the close event never arrives. Each of those is handled
 * explicitly, because each of them has exactly one symptom from the outside —
 * the agent appears to freeze.
 */

import { spawn } from 'node:child_process';
import { ToolFailure } from '../core/failure.js';
import { resolveIn, guard, result, getRoot, MAX_OUTPUT } from './shared.js';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const LIVE_LINES = 200;

/**
 * A dev server runs until something stops it, so waiting out the full default
 * spends a whole turn learning nothing. Anything that looks like one gets a
 * short leash and a hint to re-run it detached.
 */
const SERVER_TIMEOUT = 30_000;
const LOOKS_LIKE_SERVER =
  /(\bnpm run\s+(?:dev|start|serve|preview|watch)\b|\b(?:vite|next dev|nuxt dev|astro dev|webpack serve|svelte-kit dev|serve)\b|\buvicorn\b|\bgunicorn\b|\bflask run\b|\bdjango[\w-]* runserver\b|\brails server\b)/i;

/**
 * Installs are slow and legitimately so: create-next-app pulls hundreds of
 * packages and a cold cargo build compiles the world. Cutting that off at two
 * minutes leaves a half-written project on disk, which from the outside looks
 * exactly like the agent giving up in the middle. Ten minutes, still bounded.
 */
const INSTALL_TIMEOUT = 600_000;
const LOOKS_LIKE_INSTALL =
  /(\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|create)\b|\bnpx\s+(?:create-|degit\b)|\bpip3?\s+install\b|\bpoetry\s+(?:install|add)\b|\bcargo\s+(?:build|install|fetch)\b|\bgo\s+(?:mod\s+download|get)\b|\bbundle\s+install\b|\bcomposer\s+(?:install|require)\b|\bgit\s+clone\b)/i;

const SERVER_READY =
  /(Local:|https?:\/\/localhost|listening\s+on|running\s+on|server(\s+is)?\s+(?:started|ready|running)|ready in|compiled successfully)/i;

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

/**
 * Kill a command and everything it started.
 *
 * Killing only the shell leaves the dev server it launched still running, and
 * on Windows a surviving grandchild that inherited our stdio keeps the pipe
 * open — so 'close' never fires and the loop waits forever.
 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* best effort */ }
    try { process.kill(pid); } catch { /* already gone */ }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    try { spawn('pkill', ['-P', String(pid), '-9'], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
}

function startDetached(command, workdir) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, {
        cwd: workdir.abs,
        shell: true,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
    } catch (err) {
      reject(new ToolFailure({
        kind: 'spawn_failed',
        attempted: `starting "${command}" in the background`,
        failed: `The shell would not start: ${err.message}`,
        fix: 'Check the command name and that a shell is on PATH.',
        cause: err,
      }));
      return;
    }

    child.unref();
    child.on('error', (err) => {
      reject(new ToolFailure({
        kind: 'spawn_failed',
        attempted: `starting "${command}" in the background`,
        failed: `The command could not run: ${err.message}`,
        fix: 'Check the executable name and your PATH.',
        cause: err,
      }));
    });

    // A moment to let it fail loudly if it is going to, then report the PID.
    setTimeout(() => {
      resolve(child.pid
        ? result(
            `Running in the background as PID ${child.pid}.\nCommand: ${command}\nDirectory: ${workdir.show}`,
            `background · PID ${child.pid}`
          )
        : result(`It may not have started.\nCommand: ${command}`, 'background · no PID'));
    }, 500);
  });
}

export async function runCommand({ command, cwd, timeout_ms, background }, { onOutput } = {}) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'running a command',
      failed: 'The "command" argument was missing or empty.',
      fix: 'Pass the whole command line as one string.',
    });
  }

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

  if (background) return startDetached(command, workdir);

  let timeout = Math.min(Math.max(Number(timeout_ms) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);
  // An explicit timeout_ms is the caller's decision and is left alone. These
  // only adjust the default.
  if (!timeout_ms && LOOKS_LIKE_INSTALL.test(command)) timeout = INSTALL_TIMEOUT;
  const server = LOOKS_LIKE_SERVER.test(command);
  if (!timeout_ms && server) timeout = Math.min(timeout, SERVER_TIMEOUT);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, { cwd: workdir.abs, shell: true, windowsHide: true });
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
      const text = chunk.toString();
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
      const tail = (failed, keep = 14) => {
        if (live && !failed && !liveCapped) return [];
        const all = body.split(/\r?\n/);
        return all.length <= keep ? all : [`… ${all.length - keep} earlier lines`, ...all.slice(-keep)];
      };

      if (timedOut) {
        let content = `Timed out after ${Math.round(timeout / 1000)}s and was killed.\n\n${body}`;
        if (server || SERVER_READY.test(captured)) {
          content +=
            '\n\nThat looks like a server rather than a command that finishes. Start it ' +
            'again with background: true — the tool returns its PID straight away — and ' +
            'then check it separately, e.g. curl http://localhost:PORT.';
        }
        const out = result(content, `timed out after ${Math.round(timeout / 1000)}s`);
        out.output = tail(true);
        resolve(out);
        return;
      }

      const count = captured.trim() ? captured.trim().split(/\r?\n/).length : 0;
      const out = result(
        `exit code: ${code}\n\n${body}`,
        `exit ${code} · ${count} line${count === 1 ? '' : 's'}`
      );
      out.exitCode = code;
      out.output = tail(code !== 0);
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
