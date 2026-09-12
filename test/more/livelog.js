// Errors from the running app, picked up without being asked.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { errorsIn, freshErrors, LogWatch } from '../../src/core/livelog.js';

export default async function ({ test, section, ok, eq, tmp }) {
  section('reading a dev server log');

  await test('a thrown error is picked up with the stack that names the file', () => {
    const found = errorsIn([
      '  ▲ Next.js 15.0.0',
      '  ⨯ TypeError: Cannot read properties of undefined (reading "name")',
      '    at UserCard (src/components/UserCard.tsx:12:20)',
      '    at renderWithHooks (node_modules/react-dom/index.js:1)',
      '  GET / 500 in 42ms',
    ].join('\n'));
    eq(found.length, 1);
    ok(found[0].includes('Cannot read properties of undefined'), found[0]);
    ok(found[0].includes('src/components/UserCard.tsx:12'), 'the stack says where, so it comes too');
  });

  await test('a broken import is an error', () => {
    ok(errorsIn('Module not found: Can\'t resolve "@/lib/db"').length === 1);
    ok(errorsIn('Failed to compile').length === 1);
    ok(errorsIn('Error: connect ECONNREFUSED 127.0.0.1:5432').length === 1);
  });

  await test('warnings and the ready banner are not errors', () => {
    eq(errorsIn([
      '  ✓ Ready in 1.2s',
      'warn  - Fast Refresh had to perform a full reload',
      '(node:123) DeprecationWarning: punycode is deprecated',
      '✓ Compiled successfully',
    ].join('\n')), []);
  });

  await test('terminal colour is not part of the message', () => {
    const found = errorsIn('[31m⨯ Error: boom[0m');
    eq(found.length, 1);
    ok(!found[0].includes('['), found[0]);
    ok(found[0].includes('Error: boom'), found[0]);
  });

  await test('a quiet log says nothing', () => {
    eq(errorsIn('GET / 200 in 12ms\nGET /about 200 in 3ms'), []);
    eq(errorsIn(''), []);
  });

  section('saying it once');

  await test('the same failure on every refresh is news once', () => {
    const seen = new Set();
    const e = ['⨯ Error: boom at page.tsx:4'];
    eq(freshErrors(e, seen).length, 1);
    eq(freshErrors(e, seen).length, 0, 'the second request is not new information');
  });

  await test('the same failure with different numbers is still the same failure', () => {
    const seen = new Set();
    eq(freshErrors(['⨯ Error: boom in 42ms'], seen).length, 1);
    eq(freshErrors(['⨯ Error: boom in 91ms'], seen).length, 0);
  });

  await test('a different failure is new', () => {
    const seen = new Set();
    eq(freshErrors(['⨯ Error: boom'], seen).length, 1);
    eq(freshErrors(['⨯ TypeError: other'], seen).length, 1);
  });

  section('watching the log grow');

  const logFile = path.join(tmp, 'server.log');
  const server = { url: 'http://localhost:3000', log: logFile };

  await test('only what is new since the last look gets read', async () => {
    await fs.writeFile(logFile, 'GET / 200\n', 'utf8');
    const watch = new LogWatch();
    eq(await watch.since([server]), null, 'nothing wrong yet');

    await fs.appendFile(logFile, '⨯ Error: it broke\n    at page.tsx:3\n', 'utf8');
    const found = await watch.since([server]);
    ok(found.includes('it broke'), found);
    ok(found.includes('http://localhost:3000'), 'it says which app');

    eq(await watch.since([server]), null, 'the same error is not reported twice');
  });

  await test('a log that is emptied starts again rather than throwing', async () => {
    const watch = new LogWatch();
    await fs.writeFile(logFile, '⨯ Error: first\n', 'utf8');
    ok(await watch.since([server]));
    await fs.writeFile(logFile, '', 'utf8'); // restarted, log truncated
    eq(await watch.since([server]), null);
    await fs.appendFile(logFile, '⨯ Error: after the restart\n', 'utf8');
    ok((await watch.since([server])).includes('after the restart'));
  });

  await test('a log that is not there is quietly skipped', async () => {
    const watch = new LogWatch();
    eq(await watch.since([{ url: 'x', log: path.join(tmp, 'no-such.log') }]), null);
    eq(await watch.since([{ url: 'x' }]), null, 'a server with no log at all');
    eq(await watch.since([]), null);
  });
}
