/**
 * headless.js — `ucode -p "task"`: one job, no keyboard, then exit.
 *
 * For scripts, CI and the eval set. Progress goes to stderr, the answer to
 * stdout (or, with --json, one JSON object describing the run), and the exit
 * code says whether it worked. Nobody is there to approve anything, so every
 * question is answered no — unless --yes says to answer yes.
 */

import { Readable } from 'node:stream';
import { Plain } from '../ui/plain.js';
import { Agent } from './loop.js';
import { requestCount } from './provider.js';
import { stopServers } from '../tools/shell.js';
import { closeBrowser } from '../tools/browser.js';

export class Headless extends Plain {
  constructor({ cwd, yes = false }) {
    super({ cwd, input: Readable.from([]), output: process.stderr });
    this.yes = yes;
    this.answer = '';
  }

  assistant(text, opts = {}) {
    super.assistant(text, opts);
    if (!opts.replay && String(text).trim()) this.answer = String(text).trim();
  }

  confirm({ action }) {
    this.note(`${this.yes ? 'approved' : 'declined'} (no one to ask): ${action}`);
    return Promise.resolve(this.yes);
  }
}

/** Run one prompt. Resolves to the exit code. */
export async function runHeadless({ cwd, prompt, json = false, yes = false, plan = false, write = (s) => process.stdout.write(s) }) {
  const ui = new Headless({ cwd, yes });
  const agent = new Agent({ cwd, ui });
  if (plan) ui.mode = 'plan';
  const started = Date.now();
  const sent = requestCount();
  let error = null;
  try {
    await agent.bootstrap();
    agent.startMcp();
    await agent.mcpStarting;
    await agent.turn(prompt);
  } catch (err) {
    error = err;
    ui.error(err);
  } finally {
    stopServers();
    agent.mcp?.close();
    await closeBrowser().catch(() => {});
    await agent.settled?.().catch(() => {});
  }

  const ok = !error && !agent.endedSilently;
  if (json) {
    write(`${JSON.stringify({
      ok,
      answer: ui.answer,
      files: [...(agent.touched ?? [])],
      steps: agent.stats.steps,
      requests: requestCount() - sent,
      ms: Date.now() - started,
      error: error ? (error.failed ?? error.message ?? String(error)) : null,
    })}\n`);
  } else if (ui.answer) {
    write(`${ui.answer}\n`);
  }
  return ok ? 0 : 1;
}
