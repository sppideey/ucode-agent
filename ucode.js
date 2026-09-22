#!/usr/bin/env node
/**
 * ucode.js — the command.
 *
 * Parses the arguments, builds an Agent, and gets out of the way. Everything
 * of substance is under src/.
 */

import path from 'node:path';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { VERSION } from './src/core/version.js';
import { blue, dim, sky } from './src/ui/theme.js';

/**
 * The agent and the provider are loaded when a session actually starts.
 *
 * Between them they pull in the OpenAI SDK and every tool, which is most of
 * the two and a half seconds ucode used to take before printing anything at
 * all — including for `--version`, which needs none of it.
 */
const heavy = () => Promise.all([
  import('./src/core/loop.js'),
  import('./src/core/provider.js'),
  import('./src/ui/plain.js'),
]);

function parseArgs(argv) {
  const args = { debug: false, model: null, cwd: process.cwd(), help: false, plan: false, version: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--debug') args.debug = true;
    else if (a === '--plan') args.plan = true;
    else if (a === '--model' || a === '-m') args.model = argv[++i];
    else if (a === '--cwd' || a === '-C') args.cwd = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
  }

  return args;
}

async function usage() {
  const [, { MODELS, modelName, DEFAULT_MODEL, ENV_FILE }] = await heavy();
  const entries = Object.entries(MODELS);
  const width = Math.max(...entries.map(([, m]) => m.name.length));
  const models = entries
    .map(([id, m]) => `      ${m.name.padEnd(width)}   ${dim(id)}`)
    .join('\n');

  process.stdout.write(
    `\n  ${blue('ucode')} — a terminal coding agent\n\n` +
    '  ucode [options]\n\n' +
    `    -m, --model <id>   which model to use (default: ${modelName(DEFAULT_MODEL)})\n` +
    '    -C, --cwd <dir>    work in another directory\n' +
    '        --plan         start in plan mode: read and research, change nothing\n' +
    '        --debug        print stack traces when something breaks\n' +
    '    -v, --version      print the version\n' +
    '    -h, --help         this message\n' +
    '    doctor             check that everything ucode needs is working\n' +
    '    login <key>        save your key for every folder on this machine\n\n' +
    `  ${sky('Models')}\n${models}\n\n` +
    `  Needs NVIDIA_API_KEY in the environment or in ${ENV_FILE}\n` +
    '  Free keys: https://build.nvidia.com\n\n'
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return usage();

  if (process.argv[2] === 'login') {
    const { saveKey } = await import('./src/core/login.js');
    process.stdout.write(`${await saveKey(process.argv[3])}
`);
    return;
  }

  if (process.argv[2] === 'doctor') {
    const { runDoctor } = await import('./src/core/doctor.js');
    process.stdout.write(`${(await runDoctor()).join('\n')}\n`);
    return;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  // Update before the session starts, not after it ends.
  //
  // Installing in the background and taking effect "next time" means the run
  // you are doing now — the one that might be a demo — is the old one, and you
  // have no way to know. So if there is something newer, it goes on now and
  // this process hands over to it. The wait is a few seconds, once per
  // release; every other launch pays one quick question to the registry.
  //
  // Only when a person is sitting there. Handing over means re-running this
  // process, and a run whose input is a pipe has that input consumed by the
  // handover — `cat prompt.txt | ucode` printed "updating…" and then did
  // nothing at all. Piped runs take the background update and carry on.
  if (!args.version && process.stdin.isTTY &&
      process.argv[2] !== 'login' && process.argv[2] !== 'doctor') {
    const { pendingUpdate, installNow } = await import('./src/core/updater.js');
    const waiting = await pendingUpdate();
    if (waiting) {
      process.stdout.write(`  updating to v${waiting}…\n`);
      if (await installNow(waiting)) {
        const { spawnSync } = await import('node:child_process');
        const run = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
          stdio: 'inherit',
          env: { ...process.env, UCODE_NO_UPDATE: '1' }, // the new one must not check again
        });
        process.exit(run.status ?? 0);
      }
      // It did not take. Carry on with the version already here rather than
      // making a failed update the reason ucode will not start.
    }
  }

  const [{ Agent }, { setModel }, { Plain }] = await heavy();

  if (args.model) {
    try {
      setModel(args.model);
    } catch (err) {
      new Plain({ cwd: args.cwd }).error(err);
      process.exitCode = 1;
      return;
    }
  }

  const agent = new Agent({ cwd: args.cwd, debug: args.debug });
  if (args.plan) agent.ui.mode = 'plan';

  try {
    await agent.start();
  } catch (err) {
    agent.ui.error(err, { debug: args.debug });
    await agent.persist().catch(() => {});
    agent.ui.close();
    process.exitCode = 1;
  } finally {
    // Take the dev servers down with the session that started them, however it
    // ended. killTree was written for this and nothing ever called it, so every
    // build left its server running: twenty-four builds in an afternoon left
    // seventy-three node processes alive, the oldest for three and a half
    // hours, holding the ports the next run wanted.
    try {
      const { stopServers } = await import('./src/tools/shell.js');
      stopServers();
    } catch { /* nothing started, or already gone */ }
  }
}

/**
 * Was this file launched, or imported?
 *
 * Importing it — which another front end would do to reuse Agent — must not
 * open a terminal session. The obvious check is comparing `import.meta.url`
 * with argv[1], and it is wrong: after `npm link`, argv[1] arrives as the path
 * through the symlink in the global node_modules while `import.meta.url` has
 * already been resolved to the real file. The two never match, so the command
 * starts, matches nothing, and exits successfully having done absolutely
 * nothing — which is a great deal harder to diagnose than a crash.
 *
 * Comparing real paths is what actually answers the question.
 */
function launchedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;

  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (launchedDirectly()) main();
