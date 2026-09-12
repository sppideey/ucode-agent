// The transcript is a record of what was done, not a copy of what was written.
import chalk from 'chalk';
import { runLine, groupTarget, bare } from '../../src/ui/theme.js';
import { Screen } from '../../src/ui/screen.js';
import { countDiff } from '../../src/core/loop.js';

export default async function ({ test, section, ok, eq }) {
  section('a change, as two numbers');

  await test('added and removed rows are counted', () => {
    eq(countDiff(['+1| a', '+2| b', '-3| c']), { added: 2, removed: 1 });
  });

  await test('the rows a tool elided are counted too, not lost', () => {
    eq(countDiff(['-24| a', '… 218 more removed', '+24| x', '… 508 more added']),
      { added: 509, removed: 219 });
  });

  await test('a file heading is not a change', () => {
    eq(countDiff(['~index.html', '+1| a']), { added: 1, removed: 0 });
  });

  await test('nothing at all is zero, not a crash', () => {
    eq(countDiff([]), { added: 0, removed: 0 });
    eq(countDiff(), { added: 0, removed: 0 });
  });

  section('one line per run');

  const plain = (o) => bare(runLine(o));

  await test('one step keeps its own words', () => {
    eq(plain({ label: 'Reading app.js', count: 1 }), 'Reading app.js');
  });

  await test('the same file edited many times is still one file', () => {
    eq(plain({ label: 'Editing index.html', count: 3, targets: ['index.html', 'index.html', 'index.html'], added: 555, removed: 221 }),
      'Edited index.html +555 -221');
  });

  await test('different files become a count', () => {
    eq(plain({ label: 'Editing b.ts', count: 2, targets: ['a.ts', 'b.ts'] }), 'Edited 2 files');
  });

  await test('a change carries its numbers, and no change carries none', () => {
    ok(plain({ label: 'Writing x', count: 1, added: 5, removed: 2 }).endsWith('+5 -2'));
    eq(plain({ label: 'Writing x', count: 1 }), 'Writing x');
  });

  await test('the target is everything after the opening word', () => {
    eq(groupTarget('Editing src/app/page.tsx'), 'src/app/page.tsx');
    eq(groupTarget('Running npm run build'), 'npm run build');
    eq(groupTarget('Thinking'), '');
  });

  section('what reaches the screen');

  const screen = () => {
    const level = chalk.level;
    chalk.level = 0;
    const s = new Screen({ output: { write() {}, columns: 100, rows: 30, isTTY: true, on() {}, off() {} }, cwd: '.' });
    s.render = () => {};
    s.restore = () => { chalk.level = level; };
    return s;
  };

  await test('nothing is written underneath a bullet', () => {
    const s = screen();
    s.toolCall('Reading app.js');
    s.toolResult('read 120 lines');
    eq(s.lines.filter((l) => l.trim()).length, 1, s.lines.join(' | '));
    s.restore();
  });

  await test('three edits of one file are one line carrying the total', () => {
    const s = screen();
    for (const [a, r] of [[539, 218], [12, 3], [4, 0]]) {
      s.toolCall('Editing index.html'); s.toolResult('ok'); s.diffStat({ added: a, removed: r });
    }
    const shown = s.lines.filter((l) => l.trim());
    eq(shown.length, 1, shown.join(' | '));
    ok(bare(shown[0]).includes('Edited index.html +555 -221'), shown[0]);
    s.restore();
  });

  await test('no line of the file itself ever reaches the transcript', () => {
    const s = screen();
    s.toolCall('Writing index.html');
    s.toolResult('overwrote · 539 lines');
    s.diffStat(countDiff(['-24| --s-1: .25rem;', '+24| --s-1: .25rem;', '… 508 more added']));
    ok(!s.lines.some((l) => l.includes('--s-1')), 'the code stayed out');
    ok(bare(s.lines[0]).includes('+509 -1'), s.lines[0]);
    s.restore();
  });

  section('pasting');

  await test('a pasted block arrives whole, not a line at a time', () => {
    const s = screen();
    s.onData('\x1b[200~one\ntwo\nthree\x1b[201~');
    eq(s.buffer, 'one\ntwo\nthree');
    s.restore();
  });

  await test('a paste split across two reads is rejoined', () => {
    const s = screen();
    s.onData('\x1b[200~first half ');
    s.onData('second half\x1b[201~');
    eq(s.buffer, 'first half second half');
    s.restore();
  });

  await test('windows line endings come out as plain newlines', () => {
    const s = screen();
    s.onData('\x1b[200~a\r\nb\x1b[201~');
    eq(s.buffer, 'a\nb');
    s.restore();
  });

  await inputSuite({ test, section, ok, eq });
}

export async function inputSuite({ test, section, ok, eq }) {
  const chalk = (await import('chalk')).default;
  const { Screen } = await import('../../src/ui/screen.js');

  section('multi-line input');

  const NL = String.fromCharCode(10);
  const screen = (buffer = '') => {
    chalk.level = 0;
    const s = new Screen({ output: { write() {}, columns: 80, rows: 24, isTTY: true, on() {}, off() {} }, cwd: '.' });
    s.render = () => {};
    s.buffer = buffer;
    s.cursor = buffer.length;
    return s;
  };

  await test('a line break becomes a row, and never reaches the frame', () => {
    const s = screen(`one${NL}two${NL}three`);
    const { rows } = s.inputLines(60);
    eq(rows.length, 3);
    ok(!rows.some((r) => r.includes(NL)), 'a raw newline in a row walks out of the box');
    ok(rows[0].endsWith('one'), rows[0]);
    eq(rows[2], 'three');
  });

  await test('a long line still wraps, and a wrapped line keeps its own rows', () => {
    const s = screen(`${'a'.repeat(50)}${NL}short`);
    const { rows } = s.inputLines(20);
    ok(rows.length >= 4, `${rows.length} rows`);
    eq(rows[rows.length - 1], 'short', 'the second line did not get swept into the first');
    ok(rows.every((r) => r.length <= 20), 'nothing is wider than the box');
  });

  await test('the caret lands on the row the cursor is actually in', () => {
    const s = screen(`one${NL}two${NL}three`);
    s.cursor = 0;
    eq(s.caretAt(60).row, 0, 'the start is on the first row');
    s.cursor = 4; // just after the first newline
    eq(s.caretAt(60).row, 1, 'and the second line is on the second row');
    s.cursor = s.buffer.length;
    eq(s.caretAt(60).row, 2, 'the end is on the last row');
  });

  await test('the caret column is measured from the start of its own row', () => {
    const s = screen(`one${NL}twelve`);
    s.cursor = 4 + 3; // three characters into "twelve"
    const { row, col } = s.caretAt(60);
    eq(row, 1);
    eq(col, 3, 'not counted from the top of the whole text');
  });

  await test('an empty input is one row, not none', () => {
    const s = screen('');
    eq(s.inputLines(60).rows.length, 1);
    eq(s.caretAt(60).row, 0);
  });

  await test('a pasted block sizes the box to hold it', () => {
    const s = screen('');
    s.onData(`\x1b[200~a${NL}b${NL}c${NL}d\x1b[201~`);
    eq(s.inputLines(60).rows.length, 4, 'four pasted lines, four rows');
  });
}
