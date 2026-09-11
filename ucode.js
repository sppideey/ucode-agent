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

import { Agent } from './src/core/loop.js';
import { setModel, modelName, MODELS, DEFAULT_MODEL, ENV_FILE } from './src/core/provider.js';
import { VERSION } from './src/core/version.js';
import { Plain } from './src/ui/plain.js';
import { blue, dim, sky } from './src/ui/theme.js';

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

function usage() {
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
    '    -h, --help         this message\n\n' +
    `  ${sky('Models')}\n${models}\n\n` +
    `  Needs UCODE_API_KEY in the environment or in ${ENV_FILE}\n` +
    '  Free keys: https://openrouter.ai/keys\n\n'
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return usage();

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

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
