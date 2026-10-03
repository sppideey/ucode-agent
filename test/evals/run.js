/**
 * evals/run.js — real jobs, end to end, against the real model.
 *
 * The unit tests check the parts. This checks whether ucode can actually
 * finish a job: each task gets a fresh folder (with starting files where the
 * job is a change), runs `ucode -p` in it, and is then checked by code — the
 * files are there, the scripts parse, the bug is gone.
 *
 * It spends real free-tier requests (about 15 a task), so it is not part of
 * `npm test`. Run it before a big release:  npm run eval   (or: node test/evals/run.js quiz bugfix)
 */

import { spawnSync } from 'node:child_process';
import { promises as fs, existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHtml } from '../../src/core/htmlcheck.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The app folder a build made: the one subfolder with an index.html, or the folder itself. */
function appDir(dir) {
  if (existsSync(path.join(dir, 'index.html'))) return dir;
  const sub = readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && existsSync(path.join(dir, e.name, 'index.html')));
  return sub ? path.join(dir, sub.name) : null;
}

/** A built page: it exists, its inline scripts parse, its own scripts pass node --check. */
function pageWorks(dir, words = []) {
  const app = appDir(dir);
  if (!app) return 'no index.html was made';
  const html = readFileSync(path.join(app, 'index.html'), 'utf8');
  if (checkHtml(html).length) return 'an inline script does not parse';
  for (const f of readdirSync(app).filter((n) => /\.m?js$/.test(n))) {
    const r = spawnSync(process.execPath, ['--check', path.join(app, f)], { encoding: 'utf8' });
    if (r.status !== 0) return `${f} does not parse`;
  }
  const all = readdirSync(app).map((f) => { try { return readFileSync(path.join(app, f), 'utf8'); } catch { return ''; } }).join('\n').toLowerCase();
  const missing = words.filter((w) => !all.includes(w));
  return missing.length ? `missing: ${missing.join(', ')}` : null;
}

const TASKS = [
  { name: 'tasks', prompt: 'make me a tasks app', check: (d) => pageWorks(d, ['localstorage']) },
  { name: 'quiz', prompt: 'make a 5 question quiz about space', check: (d) => pageWorks(d, ['score']) },
  { name: 'stopwatch', prompt: 'build a stopwatch with laps', check: (d) => pageWorks(d, ['lap']) },
  { name: 'calculator', prompt: 'make a calculator', check: (d) => pageWorks(d) },
  { name: 'tictactoe', prompt: 'make tic tac toe for two players', check: (d) => pageWorks(d) },
  { name: 'landing', prompt: 'make a landing page for a school science fair', check: (d) => pageWorks(d, ['science']) },
  {
    name: 'bugfix',
    prompt: 'the test fails - fix the bug in math.js',
    files: {
      'package.json': '{ "type": "module", "scripts": { "test": "node test.js" } }',
      'math.js': 'export function average(xs) {\n  let total = 0;\n  for (const x of xs) total += x;\n  return total / (xs.length - 1);\n}\n',
      'test.js': "import assert from 'node:assert';\nimport { average } from './math.js';\nassert.equal(average([2, 4, 6]), 4);\nconsole.log('ok');\n",
    },
    check: (d) => (spawnSync(process.execPath, ['test.js'], { cwd: d }).status === 0 ? null : 'test.js still fails'),
  },
  {
    name: 'feature',
    prompt: 'add a function median(xs) to stats.js and export it',
    files: { 'stats.js': 'export function mean(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n' },
    check: async (d) => {
      const { median } = await import(`file://${path.join(d, 'stats.js').replace(/\\/g, '/')}?t=${Date.now()}`);
      return median?.([3, 1, 2]) === 2 && median([4, 1, 3, 2]) === 2.5 ? null : 'median is missing or wrong';
    },
  },
  {
    name: 'rename',
    prompt: 'rename the function calc to calculateTotal everywhere',
    files: {
      'cart.js': "export function calc(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n",
      'main.js': "import { calc } from './cart.js';\nconsole.log(calc([{ price: 2 }]));\n",
    },
    check: (d) => {
      const all = readFileSync(path.join(d, 'cart.js'), 'utf8') + readFileSync(path.join(d, 'main.js'), 'utf8');
      return /\bcalc\b/.test(all) || !all.includes('calculateTotal') ? 'calc was not renamed everywhere' : null;
    },
  },
  {
    name: 'question',
    prompt: 'what does this project do?',
    files: { 'README.md': '# Weather\nA tiny app that shows the weather for your city.\n' },
    check: (d, run) => (/weather/i.test(run.answer ?? '') ? null : 'the answer did not say what the project is'),
  },
];

const wanted = process.argv.slice(2);
const chosen = wanted.length ? TASKS.filter((t) => wanted.includes(t.name)) : TASKS;
const results = [];

for (const task of chosen) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ucode-eval-${task.name}-`));
  for (const [file, text] of Object.entries(task.files ?? {})) await fs.writeFile(path.join(dir, file), text);
  process.stdout.write(`  ${task.name.padEnd(12)} `);
  const run = spawnSync(process.execPath, [path.join(ROOT, 'ucode.js'), '-p', task.prompt, '--json', '--yes', '-C', dir], {
    encoding: 'utf8', env: { ...process.env, UCODE_OPEN: '0' }, timeout: 15 * 60_000,
  });
  let out = {};
  try { out = JSON.parse(run.stdout.trim().split('\n').pop()); } catch { out = { ok: false, error: 'no JSON from ucode' }; }
  let problem = out.ok ? null : `run failed: ${out.error ?? 'no error given'}`;
  if (!problem) {
    try { problem = await task.check(dir, out); } catch (err) { problem = err.message; }
  }
  results.push({ name: task.name, pass: !problem, ms: out.ms ?? 0, requests: out.requests ?? 0 });
  process.stdout.write(`${problem ? `FAIL  ${problem}` : 'pass'}  ${Math.round((out.ms ?? 0) / 1000)}s  ${out.requests ?? '?'} requests\n`);
}

const passed = results.filter((r) => r.pass).length;
const avg = (k) => Math.round(results.reduce((s, r) => s + r[k], 0) / Math.max(1, results.length));
process.stdout.write(`\n  ${passed}/${results.length} passed · ${Math.round(avg('ms') / 1000)}s and ${avg('requests')} requests a task on average\n\n`);
process.exitCode = passed === results.length ? 0 : 1;
