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

  await test('a failure is never folded away', () => {
    const s = screen();
    s.toolCall('Running a'); s.toolResult('ok');
    s.toolCall('Running b'); s.toolFailed('it broke');
    ok(s.lines.some((l) => bare(l).includes('it broke')), 'the failure is on screen');
    s.toolCall('Running c');
    ok(!s.lines.some((l) => /Ran 3/.test(bare(l))), 'and it did not get counted into a run');
    s.restore();
  });
}
