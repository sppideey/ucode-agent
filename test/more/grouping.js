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

  await test('the model speaking ends the run, so the next steps start a new one', () => {
    const s = screen();
    s.toolCall('Reading a.ts'); s.toolResult('ok');
    s.assistant('Now the tests.');
    s.toolCall('Reading b.ts'); s.toolResult('ok');
    const folded = s.lines.filter((l) => /Read \d+ files/.test(bare(l)));
    eq(folded.length, 0, 'they are separate runs, not one of two');
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
    ok(!s.lines.some((l) => /Ran 3/.test(bare(l))), 'and it did not get counted into a run');
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

  await test('the model speaking starts the next piece of work afresh', () => {
    const s = make();
    step(s, 'read_file', { path: 'a' });
    s.assistant('Now the animations.');
    step(s, 'read_file', { path: 'b' });
    eq(s.lines.filter((l) => bare(l).includes('eading files')).length, 2,
      'a new segment gets its own line');
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

  section('the opening line');

  const make = () => {
    chalk.level = 0;
    const s = new Screen({ output: { write() {}, columns: 80, rows: 24, isTTY: true, on() {}, off() {} }, cwd: '.' });
    s.render = () => {};
    return s;
  };
  const bare = (l) => String(l ?? '').replace(/\[[0-9;]*m/g, '').trim();

  await test('nothing is shown until a sentence has finished', () => {
    const s = make();
    s.thinkingDelta('I');
    s.thinkingDelta(' need to buil');
    eq(s.lines.length, 0, 'half a sentence reads as a stutter');
  });

  await test('the first finished sentence goes up as one line', () => {
    const s = make();
    s.thinkingDelta('I need to build a tasks app in one file.');
    eq(s.lines.length, 1);
    eq(bare(s.lines[0]), 'I need to build a tasks app in one file.');
  });

  await test('it is never rewritten, however much more arrives', () => {
    const s = make();
    s.thinkingDelta('First I will write the HTML structure.');
    const line = s.lines[0];
    s.thinkingDelta(' Then the CSS. Then the JavaScript.');
    eq(s.lines.length, 1, 'rewriting it as more arrived was the flicker');
    eq(s.lines[0], line);
  });

  await test('it stays put when the real reply starts', () => {
    const s = make();
    s.thinkingDelta('I will build the app now.');
    s.thinkingEnd();
    eq(s.lines.length, 1, 'what it set out to do is worth keeping');
  });

  await test('a new turn gets its own opening line', () => {
    const s = make();
    s.thinkingDelta('First turn opening sentence.');
    s.thinkingEnd();
    s.thinkingDelta('Second turn opening sentence.');
    eq(s.lines.length, 2);
    eq(bare(s.lines[1]), 'Second turn opening sentence.');
  });

  await test('what the model says is full strength, not backdrop', () => {
    const level = chalk.level;
    chalk.level = 3;
    const s = make();
    chalk.level = 3;
    s.thinkingDelta('I will build Tide as a single HTML file.');
    ok(!s.lines[0].includes('[2m'), 'the model talking is the thing worth reading');
    ok(s.lines[0].includes('[37m'), 'it is painted, not left to the terminal default');
    chalk.level = level;
  });

  await test('the request is never read back to the person who wrote it', () => {
    // Reasoning models open by restating the prompt to themselves. The user
    // wrote it, is looking at it, and does not need it narrated.
    for (const line of [
      'The user wants a tasks app called Tide in a single index.html.',
      'The user wants me to build Tide - a tasks app.',
      'So the user is asking for a dark theme here.',
      'The request asks for localStorage persistence.',
      'I need to understand what they are asking for here.',
    ]) {
      const s = make();
      s.thinkingDelta(line);
      eq(s.lines.length, 0, 'shown: ' + line);
    }
  });

  await test('a sentence about the work still earns its line', () => {
    for (const line of [
      'Now I need to add the missing CSS for the filter row.',
      'I will build Tide as a single HTML file.',
      'The layout is done, now the animations.',
    ]) {
      const s = make();
      s.thinkingDelta(line);
      eq(s.lines.length, 1, 'hidden: ' + line);
    }
  });

  await test('a throwaway opener is not worth a line', () => {
    const s = make();
    s.thinkingDelta('Okay.');
    eq(s.lines.length, 0, 'it tells nobody anything');
  });

  await test('an empty delta never creates a line of nothing', () => {
    const s = make();
    s.thinkingDelta('');
    eq(s.lines.length, 0);
  });
}
