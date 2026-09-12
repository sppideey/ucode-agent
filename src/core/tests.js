/**
 * tests.js — running the tests a change actually affects.
 *
 * A project's whole suite is too slow to run after every edit, and running
 * nothing means the model learns a change was wrong from the user rather than
 * from the code. Both vitest and jest can be asked which tests reach a given
 * file and run only those, which is usually a second or two.
 *
 * Nothing is installed to make this work. If the project has no test runner,
 * or has one that cannot answer "which tests cover this file", the checks
 * stay as they were: this adds a signal where one is available, and is silent
 * where it is not.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const has = (deps, name) => Boolean(deps[name]);

/** A file that is itself a test, and so is its own related test. */
export const isTestFile = (rel) =>
  /(?:^|[\\/])(?:__tests__|tests?)[\\/]/.test(rel) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(rel) ||
  /(?:^|[\\/])test_[^\\/]+\.py$/i.test(rel) || /_test\.py$/i.test(rel);

/**
 * Which runner this project uses, read from its package.json. Only runners
 * that can select tests by the file they cover are worth naming here.
 */
export async function testRunnerFor(dir) {
  const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null);
  if (raw) {
    let pkg;
    try { pkg = JSON.parse(raw); } catch { pkg = null; }
    if (pkg) {
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const script = String(pkg.scripts?.test ?? '');
      if (has(deps, 'vitest') || /\bvitest\b/.test(script)) return 'vitest';
      if (has(deps, 'jest') || /\bjest\b/.test(script)) return 'jest';
    }
  }
  const py = await Promise.all(
    ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].map((f) =>
      fs.access(path.join(dir, f)).then(() => true, () => false))
  );
  return py.some(Boolean) ? 'pytest' : null;
}

/** Quote a path for a shell, and use forward slashes so Windows agrees. */
const arg = (p) => `"${p.replace(/\\/g, '/')}"`;

/**
 * The command that runs only the tests reaching these files, or null when
 * this runner cannot narrow it down.
 *
 * pytest has no "which tests cover this file", so it gets the test files from
 * among those changed — enough to catch a test edited into failing, and
 * honest about being less than the others.
 */
export function relatedCommand(runner, files) {
  const list = files.filter(Boolean);
  if (!list.length) return null;

  if (runner === 'vitest') {
    return `npx --no-install vitest related --run --passWithNoTests ${list.map(arg).join(' ')}`;
  }
  if (runner === 'jest') {
    return `npx --no-install jest --findRelatedTests --passWithNoTests --silent ${list.map(arg).join(' ')}`;
  }
  if (runner === 'pytest') {
    const tests = list.filter(isTestFile);
    if (!tests.length) return null;
    return `python -m pytest -q ${tests.map(arg).join(' ')}`;
  }
  return null;
}

/** The failing part of a test run, kept to what a model can act on. */
export function summariseFailures(runner, output, limit = 40) {
  const lines = String(output ?? '').split('\n');
  const interesting = lines.filter((l) =>
    /^\s*(?:✗|×|✕|FAIL|●|E\s|_{3,}|AssertionError|Expected|Received|at\s)/.test(l) ||
    /\b\d+ failed\b/i.test(l) || /^FAILED /.test(l)
  );
  const kept = (interesting.length ? interesting : lines.filter((l) => l.trim())).slice(0, limit);
  return kept.join('\n');
}
