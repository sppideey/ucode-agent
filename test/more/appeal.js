// The parts of the interface that exist to make it worth opening: the light
// that crosses the wordmark at launch, the things to try on an empty screen,
// the mode pill, and one glyph per kind of work.
import chalk from 'chalk';
import { Screen } from '../../src/ui/screen.js';
import {
  bare, narrationMark, modeChip, bannerPaint, BANNER, withoutRestatement, echoesPrompt,
} from '../../src/ui/theme.js';
import { bannerSweep, SWEEP_MS } from '../../src/ui/activity.js';
import { gitBranch, parseHead } from '../../src/core/git.js';

/** A screen with a terminal's shape and none of its side effects. */
function fake(cols = 110, rows = 30) {
  let buf = '';
  const output = {
    columns: cols, rows, isTTY: true,
    write: (s) => { buf += s; return true; },
    on() {}, off() {},
  };
  const input = { setRawMode() {}, resume() {}, setEncoding() {}, on() {}, pause() {} };
  const screen = new Screen({ cwd: process.cwd(), input, output });
  return { screen, read: () => { const b = buf; buf = ''; return b; } };
}

const escapes = (s) => (String(s).match(/\x1b\[[0-9;]*m/g) ?? []).length;

export default async function ({ test, section, ok, eq }) {
  const level = chalk.level;
  chalk.level = 3;

  section('the launch sweep');

  await test('the light crosses the wordmark and then it is simply drawn', () => {
    const still = bannerSweep(BANNER[0], 0, BANNER.length, SWEEP_MS);
    eq(still, bannerPaint(0, BANNER.length)(BANNER[0]),
      'once it is over the row is exactly the resting gradient');
    ok(escapes(bannerSweep(BANNER[0], 0, BANNER.length, 200)) > escapes(still),
      'mid-flight the row is painted in bands, not one colour');
  });

  await test('the sweep moves, and never touches the letters', () => {
    const early = bannerSweep(BANNER[0], 0, 6, 150);
    const late = bannerSweep(BANNER[0], 0, 6, 400);
    ok(early !== late, 'two frames of an animation are not the same frame');
    eq(bare(early), BANNER[0], 'the wordmark itself is untouched');
    eq(bare(late), BANNER[0]);
  });

  await test('with no shades to fade through it is drawn finished instead', () => {
    const flat = bannerSweep(BANNER[0], 0, 6, 200, { level: 1 });
    eq(bare(flat), BANNER[0]);
    ok(escapes(flat) <= 2, 'a two-colour sweep would read as flicker, so there is none');
  });

  section('the empty screen offers something');

  await test('three things to try sit under the box before anything is said', () => {
    const { screen, read } = fake(110, 30);
    read();
    screen.render();
    const painted = bare(read());
    ok(painted.includes('try'), 'the label');
    ok(painted.includes('build me a landing page'), 'something to build');
    ok(painted.includes('explain what this project does'), 'something to understand');
    ok(painted.includes('add a dark mode toggle'), 'something to change');
  });

  await test('they are gone the moment there is anything to look at', () => {
    const { screen, read } = fake(110, 30);
    screen.add('a first line of output');
    read();
    screen.render();
    ok(!bare(read()).includes('build me a landing page'),
      'a suggestion under a live session would be clutter');
  });

  await test('a terminal too short for them keeps the box instead', () => {
    const { screen, read } = fake(110, 12);
    read();
    screen.render();
    const painted = bare(read());
    ok(!painted.includes('build me a landing page'), 'the suggestions are the part that gives way');
    ok(painted.includes('Ask anything'), 'the box is not');
  });

  section('the mode pill');

  await test('the mode is a filled block, not a glyph and a word', () => {
    const build = modeChip('build');
    // Whatever colour depth chalk settled on when it was built — truecolour,
    // 256, or the sixteen — a pill has to arrive with a background on it.
    ok(/\x1b\[(?:4[0-7]|10[0-7]|48;)/.test(build), 'it is painted, background and all');
    eq(bare(build), ' BUILD ', 'a pill is the word with room either side of it');
    ok(bare(modeChip('plan')).includes('PLAN'));
    ok(modeChip('plan') !== build, 'read-only does not look armed');
  });

  await test('the status row still says which mode is live', () => {
    const { screen } = fake();
    ok(bare(screen.statusRow()).includes('BUILD'));
    screen.mode = 'plan';
    ok(bare(screen.statusRow()).includes('PLAN'));
  });

  section('one glyph per kind of work');

  await test('looking, changing and running each read differently', () => {
    eq(bare(narrationMark('Reading')), '◇');
    eq(bare(narrationMark('Listing')), '◇');
    eq(bare(narrationMark('Writing')), '◆');
    eq(bare(narrationMark('Editing')), '◆');
    eq(bare(narrationMark('Running')), '▸');
  });

  await test('anything unmapped keeps the original dot', () => {
    eq(bare(narrationMark('Thinking')), '●');
    eq(bare(narrationMark()), '●');
  });

  await test('all of them stay faint — the shape carries the kind, not the weight', () => {
    for (const kind of ['Reading', 'Writing', 'Running', 'Thinking']) {
      ok(narrationMark(kind).includes('\x1b[2m'), `${kind} is dimmed like the line it marks`);
    }
  });

  await test('the transcript uses the glyph for the step it is drawing', () => {
    const { screen } = fake();
    screen.toolCall('Reading src/app/page.tsx');
    ok(bare(screen.lines.at(-1)).startsWith('◇'), bare(screen.lines.at(-1)));
    screen.toolCall('Running npm test');
    ok(bare(screen.lines.at(-1)).startsWith('▸'), bare(screen.lines.at(-1)));
  });

  section('the answer does not say the question back');

  const PROMPT = 'build me a next.js habit tracker with a clean dashboard';

  await test('an opening that reads the request back is dropped', () => {
    eq(withoutRestatement('You asked me to add a dark mode toggle.\nDone — it is in settings.', ''),
      'Done — it is in settings.');
    eq(withoutRestatement("Sure! I'll build the dashboard.\nIt is at /dashboard.", ''),
      'It is at /dashboard.');
    eq(withoutRestatement('Task: ship the landing page\nShipped.', ''), 'Shipped.');
  });

  await test('so is the request said back in the asker’s own words', () => {
    ok(echoesPrompt('A Next.js habit tracker with a clean dashboard, coming right up.', PROMPT));
    eq(withoutRestatement(`${PROMPT}. Here we go.\nIt is running on port 3000.`, PROMPT),
      'It is running on port 3000.');
  });

  await test('a real answer that happens to share nouns is left alone', () => {
    ok(!echoesPrompt('The dashboard is at /dashboard — run npm run dev.', PROMPT),
      'sharing a word with the request is not repeating it');
    const answer = 'The dashboard is at /dashboard.\nStreaks persist to localStorage.';
    eq(withoutRestatement(answer, PROMPT), answer);
  });

  await test('a short prompt can never trigger it', () => {
    ok(!echoesPrompt('hey there', 'hey'), 'three words of overlap prove nothing');
    ok(!echoesPrompt('Fixed it.', 'fix it'));
    eq(withoutRestatement('Hey! How can I help you today?', 'hey'),
      'Hey! How can I help you today?');
  });

  await test('a reply that is only a restatement is still the reply', () => {
    eq(withoutRestatement('You asked me to add a toggle.', ''), 'You asked me to add a toggle.',
      'an empty answer on screen reads as a crash');
  });

  await test('the screen checks each reply against the message above it', () => {
    const { screen } = fake();
    screen.userMessage(PROMPT);
    screen.assistant(`${PROMPT} — here it is.\n\nRunning on port 3000.`);
    const said = screen.lines.map(bare).join('\n');
    ok(said.includes('Running on port 3000'), 'the answer survives');
    eq(said.split('habit tracker').length - 1, 1, 'and the request appears once, as your own message');
  });

  section('the header says where you are');

  await test('a branch is read off the disk, not shelled out for', () => {
    eq(parseHead('ref: refs/heads/main'), 'main');
    eq(parseHead('ref: refs/heads/feature/some-work'), 'feature/some-work');
    eq(parseHead('a3f9c1e8b7d6a5f4e3c2b1a0f9e8d7c6b5a49382'), 'a3f9c1e', 'a detached head is its commit');
    eq(parseHead(''), '');
    eq(parseHead('nonsense'), '');
  });

  await test('a folder that is not a repository is not an error', () => {
    eq(gitBranch(process.env.TEMP || process.env.TMPDIR || '/'), gitBranch(process.env.TEMP || process.env.TMPDIR || '/'),
      'whatever it answers, it answers the same way twice and never throws');
    eq(typeof gitBranch('/definitely/not/a/place'), 'string');
  });

  await test('every row of the facts column carries something', () => {
    const { screen } = fake(120, 30);
    screen.header({ cwd: process.cwd(), model: 'a model', used: 0, limit: 100 });
    const rows = screen.headerLines().map(bare);
    const text = rows.join('\n');
    ok(text.includes('dir'), 'where you are');
    ok(text.includes('version'), 'which build this is');
    ok(text.includes('keys'), 'how to get out of trouble');
    ok(!text.includes('%'), 'how full the window is belongs on the status row, once');
  });

  await test('the header is framed in the same light as the wordmark inside it', () => {
    const { screen } = fake(120, 30);
    screen.header({ cwd: process.cwd(), model: 'a model', used: 0, limit: 100 });
    const lines = screen.headerLines();
    const colour = (s) => (/38;2;[\d;]+/.exec(s) ?? [''])[0];
    ok(colour(lines[0]) !== colour(lines.at(-1)),
      'the top rule is lit and the bottom one has settled');
  });

  chalk.level = level;
}
