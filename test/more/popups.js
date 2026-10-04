// Popups over the input box: the command list on "/", questions, panels and pickers.
import chalk from 'chalk';
import { Screen } from '../../src/ui/screen.js';
import { bare, visLen } from '../../src/ui/theme.js';
import { Agent } from '../../src/core/loop.js';

const ESC = '\x1b';

function fake(cols = 100, rows = 30) {
  const output = { columns: cols, rows, isTTY: true, write() {}, on() {}, off() {} };
  const input = { setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, on() {} };
  const screen = new Screen({ cwd: 'C:/projects/app', input, output });
  screen.cols = cols;
  screen.rows = rows;
  return screen;
}

const type = (screen, text) => { for (const ch of text) screen.onKey(ch); };
const shown = (screen, room = 20) => screen.popupLines(screen.width(), room).map(bare);

export default async function ({ test, section, ok, eq }) {
  section('popups');

  await test('"/" opens the command list, and it narrows as you type', () => {
    const screen = fake();
    screen.listCommands = () => [
      { name: '/stats', what: 'time, steps and tokens' },
      { name: '/skills', what: 'what ucode knows' },
      { name: '/help', what: 'this list' },
    ];
    type(screen, '/');
    eq(screen.paletteItems().length, 3, 'all of them on a bare slash');
    type(screen, 'st');
    eq(screen.paletteItems().map((c) => c.name), ['/stats']);
    ok(shown(screen).some((r) => r.includes('/stats') && r.includes('time, steps and tokens')), 'the name and what it does');
    type(screen, ' ');
    eq(screen.paletteItems(), [], 'gone once arguments start');
  });

  await test('enter runs the highlighted command, tab completes it, esc closes the list', async () => {
    const screen = fake();
    screen.listCommands = () => [{ name: '/help', what: '' }, { name: '/stats', what: '' }];
    type(screen, '/');
    screen.onKey(`${ESC}[B`);
    screen.onKey('\t');
    eq(screen.buffer, '/stats', 'tab puts the highlighted name in the box');
    screen.buffer = '';
    screen.cursor = 0;
    type(screen, '/h');
    const sent = screen.nextLine();
    screen.onKey('\r');
    eq(await sent, '/help', 'enter sends the highlighted command');
    type(screen, '/s');
    screen.onKey(ESC);
    eq(screen.buffer, '', 'esc clears it');
  });

  await test('a key on its own answers nothing; y, n or a and enter does', async () => {
    const screen = fake();
    const asked = screen.confirm({ action: 'run npm test', detail: 'npm test', risk: 'command', always: 'npm test' });
    type(screen, 'a');
    ok(screen.asking, 'the "a" of "and then" is not "always"');
    eq(screen.buffer, 'a', 'it is in the box, not lost');
    ok(shown(screen).some((r) => r.includes('Always allow npm test')));
    screen.onKey('\r');
    eq(await asked, 'always');
    eq(screen.buffer, '', 'the answer does not stay in the box');
    const again = screen.confirm({ action: 'run it', risk: 'command' });
    type(screen, 'yes');
    screen.onKey('\r');
    eq(await again, true, 'the word works as well as the letter');
  });

  await test('enter on a fresh question is no; arrows move to yes; esc is no', async () => {
    const screen = fake();
    let asked = screen.confirm({ action: 'delete it', risk: 'write' });
    screen.onKey('\r');
    eq(await asked, false, 'no is where it starts');
    asked = screen.confirm({ action: 'delete it', risk: 'write' });
    screen.onKey(`${ESC}[A`);
    screen.onKey('\r');
    eq(await asked, true);
    asked = screen.confirm({ action: 'delete it', risk: 'write' });
    screen.onKey(ESC);
    eq(await asked, false);
  });

  await test('a sentence typed under a question is sent as a message, and the question stays', async () => {
    const screen = fake();
    const asked = screen.confirm({ action: 'run it', risk: 'command', always: 'it' });
    const sent = screen.nextLine();
    type(screen, 'and yes, add a footer');
    ok(shown(screen).some((r) => r.includes('enter sends what you typed')), 'it says what enter will do');
    screen.onKey('\r');
    eq(await sent, 'and yes, add a footer', 'sent as a message');
    ok(screen.asking, 'still waiting for an answer');
    type(screen, 'n');
    screen.onKey('\r');
    eq(await asked, false);
  });

  await test('a wheel notch under a question scrolls, and never moves the answer', async () => {
    const screen = fake();
    const asked = screen.confirm({ action: 'run it', risk: 'command' });
    screen.onData(`${ESC}[A${ESC}[A${ESC}[A`);
    eq(screen.asking.index, 1, 'still on No');
    screen.onKey('\r');
    eq(await asked, false);
  });

  await test('a long command to approve wraps in the popup instead of being cut', () => {
    const screen = fake(60, 30);
    screen.confirm({ action: 'run it', detail: `echo ${'#'.repeat(150)}`, risk: 'command' });
    const rows = shown(screen);
    eq(rows.join('').split('#').length - 1, 150, 'every character of it is on screen');
    ok(rows.every((r) => r.length === screen.width()), 'inside the frame');
  });

  await test('codes hidden in a command cannot change what the question shows', () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const screen = fake();
      screen.confirm({ action: 'run echo hi \x1b[8m&& rm -rf ~\x1b[0m', detail: 'in .\r\x1b[2Kin the project', risk: 'command' });
      const raw = screen.popupLines(screen.width(), 20).join('');
      ok(!raw.includes('\x1b[8m') && !raw.includes('\x1b[2K') && !raw.includes('\r'), 'no hiding, no clearing, no carriage return');
      ok(shown(screen).some((r) => r.includes('echo hi && rm -rf ~')), 'the whole command shows');
    } finally {
      chalk.level = level;
    }
  });

  await test('a command taller than the popup scrolls, and the answers stay in view', async () => {
    const screen = fake(80, 24);
    screen.add('said'); // into the conversation layout, where the popup gets the viewport's rows
    const room = screen.viewportHeight();
    const lines = Array.from({ length: 60 }, (_, i) => `step ${i + 1}`).join('\n');
    const asked = screen.confirm({ action: 'run a long script', detail: lines, risk: 'command' });
    let rows = shown(screen, room);
    ok(rows[1].includes('run a long script'), 'it starts at the top');
    ok(rows.some((r) => r.includes('n  No')), 'the answers show');
    ok(rows.at(-2).includes('pgup pgdn'), 'says it scrolls');
    for (let i = 0; i < 20; i++) screen.onKey(`${ESC}[6~`);
    rows = shown(screen, room);
    ok(rows.some((r) => r.includes('step 60')), 'the end can be reached');
    ok(rows.some((r) => r.includes('n  No')), 'with the answers still there');
    screen.onKey(ESC);
    eq(await asked, false);
  });

  await test('a panel drops cursor and screen codes from what it shows', () => {
    const screen = fake();
    screen.panel('MCP servers', ['  broken: \x1b[2J\x1b]0;owned\x07server died']);
    eq(screen.panelOpen.lines, ['  broken: server died']);
    screen.onKey(ESC);
  });

  await test('a panel shows over the input box, scrolls, and esc closes it', async () => {
    const screen = fake(80, 30);
    const open = screen.panel('Stats', ['', ...Array.from({ length: 40 }, (_, i) => `  line ${i + 1}`), '']);
    let rows = shown(screen, 12);
    ok(rows[1].includes('Stats'), 'its title');
    ok(rows.some((r) => r.includes('line 1 ')), 'blank lines at the ends are dropped');
    for (let i = 0; i < 3; i++) screen.onKey(`${ESC}[B`);
    rows = shown(screen, 12);
    ok(rows.some((r) => r.includes('line 4 ')) && !rows.some((r) => r.includes('line 1 ')), 'down scrolls');
    ok(rows.at(-2).includes('/40'), 'says how far through');
    screen.onKey(ESC);
    await open;
    ok(!screen.panelOpen, 'closed');
  });

  await test('a coloured row too wide for the popup is cut by what shows, never inside a colour code', () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const screen = fake(40, 30);
      // 22 letters is the length that put the old cut inside the closing code.
      screen.listCommands = () => [
        { name: '/one', what: 'short' },
        { name: '/two', what: 'twenty-two chars here.' },
        { name: '/six', what: 'a description long enough to run well past the right edge of this popup' },
      ];
      type(screen, '/');
      for (const row of screen.popupLines(screen.width(), 20)) {
        ok(row.split(ESC).slice(1).every((part) => /^\[[0-9;]*m/.test(part)), `whole colour codes: ${JSON.stringify(row)}`);
        eq(visLen(row), screen.width());
      }
    } finally {
      chalk.level = level;
    }
  });

  await test('a picker has its title on top, and a row about to be deleted says so', () => {
    const screen = fake();
    screen.pick(['one', 'two'], { title: 'Resume a conversation', deletable: true });
    ok(shown(screen)[1].includes('Resume a conversation'));
    screen.onKey('d');
    ok(shown(screen).some((r) => r.includes('✗ one')), 'marked, though it is also the highlighted row');
    screen.onKey(ESC);
  });

  await test('information goes to a panel when there is one, and to plain lines when not', async () => {
    let panelled = null;
    await Agent.prototype.show.call({ ui: { panel: async (title, lines) => { panelled = [title, lines]; } } }, 'Skills', ['  a']);
    eq(panelled, ['Skills', ['  a']]);
    const out = [];
    await Agent.prototype.show.call({ ui: { blank() {}, write: (l) => out.push(bare(l)) } }, 'Skills', ['  a']);
    eq(out, ['  Skills', '  a'], 'with its title, where there is no screen');
  });
}
