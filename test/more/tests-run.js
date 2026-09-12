// Running the tests a change actually affects.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { testRunnerFor, relatedCommand, isTestFile, summariseFailures } from '../../src/core/tests.js';

export default async function ({ test, section, ok, eq, tmp }) {
  section('finding the test runner');

  const at = async (name, files) => {
    const dir = path.join(tmp, 'runners', name);
    await fs.mkdir(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, f), body, 'utf8');
    }
    return dir;
  };
  const pkg = (o) => JSON.stringify(o);

  await test('vitest and jest are found in the dependencies', async () => {
    eq(await testRunnerFor(await at('v', { 'package.json': pkg({ devDependencies: { vitest: '^2' } }) })), 'vitest');
    eq(await testRunnerFor(await at('j', { 'package.json': pkg({ devDependencies: { jest: '^29' } }) })), 'jest');
  });

  await test('a test script names the runner even when the dependency is hoisted away', async () => {
    eq(await testRunnerFor(await at('vs', { 'package.json': pkg({ scripts: { test: 'vitest run' } }) })), 'vitest');
  });

  await test('a python project is recognised by its config', async () => {
    eq(await testRunnerFor(await at('py', { 'pyproject.toml': '[tool.pytest.ini_options]\n' })), 'pytest');
  });

  await test('a project with no runner is left alone', async () => {
    eq(await testRunnerFor(await at('none', { 'package.json': pkg({ name: 'x' }) })), null);
    eq(await testRunnerFor(await at('empty', {})), null);
  });

  await test('a broken package.json does not throw', async () => {
    eq(await testRunnerFor(await at('broken', { 'package.json': '{ not json' })), null);
  });

  section('choosing which tests to run');

  await test('vitest and jest are each asked for the tests that reach the file', () => {
    const v = relatedCommand('vitest', ['src/lib/money.ts']);
    ok(v.includes('vitest related'), v);
    ok(v.includes('--run'), 'it must not sit in watch mode waiting for a keypress');
    const j = relatedCommand('jest', ['src/lib/money.ts']);
    ok(j.includes('--findRelatedTests'), j);
  });

  await test('a passing run with no matching test is not a failure', () => {
    ok(relatedCommand('vitest', ['a.ts']).includes('--passWithNoTests'));
    ok(relatedCommand('jest', ['a.ts']).includes('--passWithNoTests'));
  });

  await test('paths are quoted and slashed so a Windows path survives the shell', () => {
    const cmd = relatedCommand('vitest', ['src\\lib\\my file.ts']);
    ok(cmd.includes('"src/lib/my file.ts"'), cmd);
  });

  await test('pytest runs the changed test files, and stands aside otherwise', () => {
    ok(relatedCommand('pytest', ['tests/test_money.py']).includes('test_money.py'));
    eq(relatedCommand('pytest', ['app/money.py']), null, 'it cannot work out which tests cover it');
  });

  await test('nothing changed means nothing to run', () => {
    eq(relatedCommand('vitest', []), null);
    eq(relatedCommand(null, ['a.ts']), null);
  });

  await test('a test file is recognised however the project spells it', () => {
    ok(isTestFile('src/money.test.ts'));
    ok(isTestFile('src/money.spec.tsx'));
    ok(isTestFile('src/__tests__/money.ts'));
    ok(isTestFile('tests/test_money.py'));
    ok(isTestFile('app/money_test.py'));
    ok(!isTestFile('src/money.ts'), 'ordinary source is not a test');
    ok(!isTestFile('src/latest/thing.ts'), 'a folder that merely contains "test" is not a test folder');
  });

  section('reporting a failure');

  await test('the failing lines are kept and the noise dropped', () => {
    const out = [
      'RUN v2.0.0',
      '✓ src/ok.test.ts (3)',
      '✗ src/money.test.ts > adds the tip',
      'AssertionError: expected 12 to be 10',
      'Expected: 10',
      'Received: 12',
      'Test Files  1 failed | 1 passed',
    ].join('\n');
    const kept = summariseFailures('vitest', out);
    ok(kept.includes('adds the tip'), kept);
    ok(kept.includes('Expected: 10'), 'the model needs the numbers');
    ok(!kept.includes('RUN v2.0.0'), 'the banner is noise');
  });

  await test('an unfamiliar shape of output still returns something to read', () => {
    const kept = summariseFailures('jest', 'something went wrong\n\nin a way we do not parse');
    ok(kept.includes('something went wrong'), kept);
  });

  await test('a very long failure is cut to what fits', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `✗ failure ${i}`).join('\n');
    eq(summariseFailures('vitest', huge).split('\n').length, 40);
  });
}
