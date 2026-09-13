// Repeated steps fold into one line; the answer keeps the room.
import chalk from 'chalk';
import { groupKind, groupLabel, bare } from '../../src/ui/theme.js';
import { Screen } from '../../src/ui/screen.js';

export default async function ({ test, section, ok, eq }) {
  section('folding repeated steps');

  await test('one step keeps its own words', () => {
    eq(groupLabel('Running npm test', 1), 'Running npm test');
  });

  await test('several become a count, in the past tense', () => {
    eq(groupLabel('Running npm test', 3), 'Ran 3 commands');
    eq(groupLabel('Reading a.ts', 2), 'Read 2 files');
    eq(groupLabel('Editing a.ts', 4), 'Edited 4 files');
  });

  await test('a kind nobody anticipated still folds, just less prettily', () => {
    eq(groupLabel('Frobnicating things', 3), 'Frobnicating things (+2 more)');
  });

  await test('what counts as the same kind is the opening word', () => {
    eq(groupKind('Running npm test'), 'Running');
    eq(groupKind('  Reading a.ts'), 'Reading');
    eq(groupKind(''), '');
  });

  section('the transcript while it works');

  const screen = () => {
    const level = chalk.level;
    chalk.level = 0;
    const out = { write() {}, columns: 80, rows: 24, isTTY: true, on() {}, off() {} };
    const s = new Screen({ output: out, cwd: process.cwd() });
    s.render = () => {};
    s.restore = () => { chalk.level = level; };
    return s;
  };

  await test('three commands leave one line, not six', () => {
    const s = screen();
    for (const c of ['npm test', 'npm run build', 'node x.js']) { s.toolCall(`Running ${c}`); s.toolResult('ok'); }
    eq(s.lines.filter((l) => l.trim()).length, 1, s.lines.join(' | '));
    ok(bare(s.lines[0]).includes('Ran 3 commands'), s.lines[0]);
    s.restore();
  });

  await test('a single step shows what it was, and nothing underneath it', () => {
    const s = screen();
    s.toolCall('Running npm test');
    s.toolResult('ok');
    ok(bare(s.lines[0]).includes('Running npm test'), s.lines[0]);
    eq(s.lines.filter((l) => l.trim()).length, 1, 'the result does not get a line of its own');
    s.restore();
  });

  await test('the model speaking does not start a second line for the same work', () => {
    // It used to. Five "Creating Tide from the HTML starter" lines down one
    // page is what that looked like.
    const s = screen();
    s.turnStart();
    s.toolCall('Reading a.ts'); s.toolResult('ok');
    s.assistant('Now the tests.');
    s.toolCall('Reading b.ts'); s.toolResult('ok');
    eq(s.lines.filter((l) => /Read/i.test(bare(l))).length, 1, s.lines.map(bare).filter(Boolean).join(' | '));
    s.restore();
  });

  await test('a different kind of step does not join the run', () => {
    const s = screen();
    s.toolCall('Running npm test'); s.toolResult('ok');
    s.toolCall('Reading a.ts'); s.toolResult('ok');
    ok(!s.lines.some((l) => /Ran 2/.test(bare(l))), 'a read is not a command');
    s.restore();
  });

  await liveSuite({ test, section, ok, eq });
  await thinkingSuite({ test, section, ok, eq });

  await test('a failure goes to the model, not onto the screen', () => {
    const s = screen();
    s.toolCall('Running a'); s.toolResult('ok');
    s.toolCall('Running b'); s.toolFailed('it broke');
    ok(!s.lines.some((l) => bare(l).includes('it broke')),
      'machinery going wrong reads as the tool being broken; the model fixes it instead');
    s.toolCall('Running c');
    // The count carries on: one line per kind of work for the whole turn is
    // the point, and a failure in the middle does not start a second one.
    ok(s.lines.some((l) => /Ran 3 commands/.test(bare(l))), s.lines.map(bare).join(' | '));
    eq(s.lines.filter((l) => /command/.test(bare(l))).length, 1, 'still one line');
    s.restore();
  });
}

export async function liveSuite({ test, section, ok, eq }) {
  const chalk = (await import('chalk')).default;
  const { Screen } = await import('../../src/ui/screen.js');
  const { describe } = await import('../../src/tools/index.js');

  section('one line per kind, and the live one moves');

  const make = () => {
    chalk.level = 3;
    const s = new Screen({ output: { write() {}, columns: 100, rows: 30, isTTY: true, on() {}, off() {} }, cwd: '.' });
    s.render = () => {};
    return s;
  };
  const bare = (l) => String(l).replace(/\x1b\[[0-9;]*m/g, '');
  const step = (s, n, a, d) => { s.toolCall(describe(n, a)); s.toolResult('ok'); if (d) s.diffStat(d); };

  await test('reads and writes interleaved keep one line each, not six', () => {
    const s = make();
    step(s, 'read_files', { paths: ['a'] });
    step(s, 'write_file', { path: 'a' }, { added: 27, removed: 24 });
    step(s, 'read_file', { path: 'b' });
    step(s, 'edit_file', { path: 'a' }, { added: 9, removed: 9 });
    step(s, 'read_file', { path: 'c' });
    const shown = s.lines.filter((l) => l.trim());
    eq(shown.length, 2, shown.map(bare).join(' | '));
    ok(bare(shown[0]).includes('Read files'), shown[0]);
    ok(bare(shown[1]).includes('+36 -33'), 'the writes kept adding up');
  });

  await test('a kind of work keeps one line for the whole turn', () => {
    // Five "Creating Tide from the HTML starter" lines and four "Reading
    // files" down one page, each about a different moment, said the same
    // thing five times and took five rows to do it.
    const s = make();
    s.turnStart();
    step(s, 'read_file', { path: 'a' });
    s.assistant('Now the animations.');
    step(s, 'read_file', { path: 'b' });
    s.assistant('And the empty state.');
    step(s, 'read_file', { path: 'c' });
    eq(s.lines.filter((l) => /ead files/i.test(bare(l))).length, 1,
      s.lines.map(bare).filter(Boolean).join(' | '));
  });

  await test('a new turn starts a clean set of lines', () => {
    const s = make();
    s.turnStart();
    step(s, 'read_file', { path: 'a' });
    s.turnStart();
    step(s, 'read_file', { path: 'b' });
    eq(s.lines.filter((l) => /eading files/.test(bare(l))).length, 2,
      'the next turn is a new page of work');
  });

  await test('a transcript line never animates', () => {
    // Animating one meant repainting the whole frame twelve times a second,
    // which rebuilt the input box under the cursor as the user typed. The
    // status row is the one animated thing, and it repaints a single row.
    const s = make();
    s.toolCall('Reading files');
    const drawn = s.lines[0];
    s.tick = 40;
    s.paintStatus();
    eq(s.lines[0], drawn, 'the transcript is still');
    s.toolResult('ok');
    eq(s.lines[0], drawn, 'and a result does not redraw it either');
  });

  await test('a tick repaints the status row, not the whole frame', () => {
    const s = make();
    s.toolCall('Reading files');
    let frames = 0;
    s.render = () => { frames++; };
    for (let i = 0; i < 12; i++) { s.tick++; s.paintStatus(); }
    eq(frames, 0, 'twelve ticks must not cost twelve full repaints');
  });
}

export async function thinkingSuite({ test, section, ok, eq }) {
  const chalk = (await import('chalk')).default;
  const { Screen } = await import('../../src/ui/screen.js');

  section('reasoning stays off the screen');

  const make = () => {
    chalk.level = 0;
    const s = new Screen({ output: { write() {}, columns: 80, rows: 24, isTTY: true, on() {}, off() {} }, cwd: '.' });
    s.render = () => {};
    return s;
  };

  await test('nothing the model thinks is published', () => {
    // It was surfaced to fill the wait, and what it filled it with was the
    // model talking to itself. What the model *says* is its reply.
    for (const line of [
      'I need to build this app.',
      'The user wants a tasks app called Tide.',
      'Now I need to add the missing CSS for the filter row.',
      'Let me look at the request again.',
      'I will build Tide as a single HTML file.',
    ]) {
      const s = make();
      s.thinkingDelta(line);
      s.thinkingEnd();
      eq(s.lines.length, 0, 'reached the screen: ' + line);
    }
  });

  await test('a finished turn writes nothing at all', () => {
    const s = make();
    s.turnStart();
    s.activity.start = Date.now() - 9000;
    s.turnEnd({ ok: true });
    eq(s.lines.filter((l) => l.trim()).length, 0, 'the reply is the end of the turn');
  });

  await test('a turn that gave up still says so', () => {
    // Silence there is indistinguishable from a crash.
    const s = make();
    s.turnStart();
    s.activity.start = Date.now() - 9000;
    s.turnEnd({ ok: false });
    ok(s.lines.some((l) => /without finishing/.test(l)), s.lines.join(' | '));
  });
}
