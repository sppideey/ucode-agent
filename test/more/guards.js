// The guards added in 1.46: not clobbering somebody else's edit, not calling
// a project's existing type errors your own, not leaking background processes,
// and a worker that stays inside its window.
import { promises as fs, utimesSync } from 'node:fs';
import path from 'node:path';
import { writeFile, readFile, editFile } from '../../src/tools/files.js';
import { setRoot } from '../../src/tools/shared.js';
import { packageJsonWritten, installIn, stopServers } from '../../src/tools/shell.js';
import { typeErrorKey, typeErrorFile, thinWorker } from '../../src/core/loop.js';

export default async function ({ test, section, ok, eq, sandbox }) {
  // A folder per test, under the suite's own sandbox, and the root put back
  // afterwards so the suites that follow are unaffected.
  const root = sandbox;
  const make = async (name) => {
    const dir = path.join(root, 'guards', name);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  section('overwriting a file somebody else changed');

  // Nudge a file's timestamp forward, since a same-millisecond write is
  // deliberately treated as ours.
  const touchLater = (file) => {
    const then = new Date(Date.now() + 5000);
    utimesSync(file, then, then);
  };

  await test('two writes of our own go through', async () => {
    const dir = await make('write-twice');
    setRoot(dir);
    await writeFile({ path: 'a.txt', content: 'one' });
    await writeFile({ path: 'a.txt', content: 'two' });
    eq(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'two');
  });

  await test('a file changed since it was read is not overwritten', async () => {
    const dir = await make('write-stale');
    setRoot(dir);
    const file = path.join(dir, 'a.txt');
    await writeFile({ path: 'a.txt', content: 'ours' });
    await readFile({ path: 'a.txt' });

    await fs.writeFile(file, 'theirs', 'utf8');
    touchLater(file);

    let refused = null;
    try {
      await writeFile({ path: 'a.txt', content: 'mine' });
    } catch (err) {
      refused = err;
    }
    eq(refused?.kind, 'changed_on_disk');
    eq(await fs.readFile(file, 'utf8'), 'theirs', 'their edit must survive');
  });

  await test('the next attempt writes, so nothing is stuck', async () => {
    const dir = await make('write-retry');
    setRoot(dir);
    const file = path.join(dir, 'a.txt');
    await writeFile({ path: 'a.txt', content: 'ours' });
    await fs.writeFile(file, 'theirs', 'utf8');
    touchLater(file);
    try { await writeFile({ path: 'a.txt', content: 'mine' }); } catch { /* the one refusal */ }
    await writeFile({ path: 'a.txt', content: 'merged' });
    eq(await fs.readFile(file, 'utf8'), 'merged');
  });

  await test('a file ucode has never seen is not guarded', async () => {
    const dir = await make('write-unseen');
    setRoot(dir);
    await fs.writeFile(path.join(dir, 'theirs.txt'), 'existing', 'utf8');
    await writeFile({ path: 'theirs.txt', content: 'fine' });
    eq(await fs.readFile(path.join(dir, 'theirs.txt'), 'utf8'), 'fine');
  });

  await test('an edit still applies to a file changed underneath it', async () => {
    const dir = await make('edit-stale');
    setRoot(dir);
    const file = path.join(dir, 'a.txt');
    await writeFile({ path: 'a.txt', content: 'hello world' });
    await fs.writeFile(file, 'hello world\nand more', 'utf8');
    touchLater(file);
    await editFile({ path: 'a.txt', old_string: 'world', new_string: 'there' });
    eq(await fs.readFile(file, 'utf8'), 'hello there\nand more');
  });

  section('type errors that were already there');

  await test('the same error keeps its identity when it moves down the file', () => {
    const a = "src/app.ts(12,5): error TS2322: Type 'x' is not assignable.";
    const b = "src/app.ts(40,9): error TS2322: Type 'x' is not assignable.";
    eq(typeErrorKey(a), typeErrorKey(b));
  });

  await test('two different errors in one file are two errors', () => {
    const a = "src/app.ts(12,5): error TS2322: Type 'x' is not assignable.";
    const b = "src/app.ts(12,5): error TS2531: Object is possibly null.";
    ok(typeErrorKey(a) !== typeErrorKey(b));
  });

  await test('an error line names its file', () => {
    eq(typeErrorFile("src/app.ts(12,5): error TS2322: nope."), 'src/app.ts');
    eq(typeErrorFile('not an error line'), null);
  });

  section('installing behind the scenes');

  // Nothing here starts a real install: the suite makes no network calls. The
  // gate below is the whole change - an install only ever starts for a project
  // that has never been installed.
  await test('a project that already has node_modules is left alone', async () => {
    const dir = await make('install-existing');
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    const file = path.join(dir, 'package.json');
    const pkg = JSON.stringify({ dependencies: { express: '^4.0.0' } });
    await fs.writeFile(file, pkg, 'utf8');
    packageJsonWritten(file, pkg);
    eq(installIn(dir), null, 'it must not install without being asked');
  });

  section('background processes');

  await test('stopping servers is safe when none are running', () => {
    eq(typeof stopServers(), 'number');
  });

  section('a worker inside its window');

  const conversation = (n, size = 4000) => [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do it' },
    ...Array.from({ length: n }, (_, i) => [
      { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', args: {} }] },
      { role: 'tool', toolCallId: `c${i}`, name: 'read_file', content: 'x'.repeat(size) },
    ]).flat(),
  ];

  await test('a small conversation is untouched', () => {
    const msgs = conversation(2);
    thinWorker(msgs, 1_000_000);
    eq(msgs[3].content.length, 4000);
  });

  await test('older results are trimmed and the recent ones are not', () => {
    const msgs = conversation(30);
    const before = msgs.length;
    thinWorker(msgs, 1000);
    eq(msgs.length, before, 'no message may be removed');
    ok(msgs[3].content.includes('trimmed'), msgs[3].content);
    eq(msgs[msgs.length - 1].content.length, 4000, 'the newest result stays whole');
  });

  await test('every tool call still has its own answer', () => {
    const msgs = conversation(30);
    thinWorker(msgs, 1000);
    const answered = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
    const asked = msgs.flatMap((m) => m.toolCalls ?? []).map((c) => c.id);
    eq(answered.size, asked.length);
    ok(asked.every((id) => answered.has(id)), 'a call lost its result');
  });

  setRoot(root);
}
