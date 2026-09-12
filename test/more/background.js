// Narration recedes; the answer is what the page is for.
import chalk from 'chalk';
import { narration, narrationMark, bare } from '../../src/ui/theme.js';

export default async function ({ test, section, ok, eq }) {
  section('narration against the answer');

  // The suite is not a terminal, so chalk would emit nothing at all; the
  // question here is what it emits when there IS a terminal to emit to.
  const level = chalk.level;
  chalk.level = 3;

  await test('what the agent is doing is drawn faint', () => {
    const line = narration('Reading screen.js');
    ok(line.includes('\x1b[2m'), 'faint is the only "smaller" a terminal has');
    eq(bare(line), 'Reading screen.js', 'and the words are untouched');
  });

  await test('the bullet is present without being loud', () => {
    const mark = narrationMark();
    ok(mark.includes('\x1b[2m'), 'it is dimmed with the line it belongs to');
    eq(bare(mark), '\u25cf');
  });

  await test('the answer itself is not dimmed, so it wins by contrast', async () => {
    const { theme } = await import('../../src/ui/theme.js');
    ok(!theme.text('an answer').includes('\x1b[2m'), 'the answer stays at full strength');
  });

  await test('nothing paints over the terminal background any more', async () => {
    const t = await import('../../src/ui/theme.js');
    eq(t.BG_ON, undefined, 'the background feature is gone, not merely turned off');
    const fs = await import('node:fs');
    const screen = fs.readFileSync('src/ui/screen.js', 'utf8');
    ok(!screen.includes('BG_ON'), 'and the screen no longer references it');
    ok(!/\x1b\]11;/.test(screen), 'nor sets the window colour');
  });

  chalk.level = level;
}
