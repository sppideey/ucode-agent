// ucode paints its own ground, whatever colour the terminal is set to.
import { BG_ON, BG_OFF, BACKGROUND, onBackground } from '../../src/ui/theme.js';

export default async function ({ test, section, ok, eq }) {
  section('the background');

  await test('it is a real 24-bit colour, and near-black rather than black', () => {
    const m = /^\x1b\[48;2;(\d+);(\d+);(\d+)m$/.exec(BG_ON);
    ok(m, JSON.stringify(BG_ON));
    const [r, g, b] = m.slice(1).map(Number);
    ok(r + g + b > 0, 'a true black is a hole in a lit room');
    ok(r < 60 && g < 60 && b < 60, `${BACKGROUND} is not dark`);
  });

  await test('leaving hands the terminal its own colours back', () => {
    eq(BG_OFF, '\x1b[0m');
  });

  await test('a reset inside a line does not punch a hole through to the terminal', () => {
    // chalk closes a background with 49, which means "the terminal default" —
    // exactly the colour being painted over.
    const painted = onBackground(`before\x1b[49mafter`);
    ok(painted.startsWith(BG_ON), 'the line opens on the background');
    ok(painted.endsWith(`\x1b[49m${BG_ON}after`), painted);
  });

  await test('a full reset is closed over too', () => {
    ok(onBackground('a\x1b[0mb').includes(`\x1b[0m${BG_ON}`), 'a hard reset re-asserts it');
  });

  await test('a line with no resets is simply painted', () => {
    eq(onBackground('plain'), `${BG_ON}plain`);
  });

  await loginSuite({ test, section, ok, eq });
}

export async function loginSuite({ test, section, ok, eq }) {
  const { looksLikeKey, withKey } = await import('../../src/core/login.js');

  section('saving the key once per machine');

  await test('a real key is accepted and an obvious typo is not', () => {
    ok(looksLikeKey('sk-or-v1-' + 'a'.repeat(40)));
    ok(!looksLikeKey('or-v1-missing-the-prefix'));
    ok(!looksLikeKey('sk-short'));
    ok(!looksLikeKey(''));
    ok(!looksLikeKey(undefined));
  });

  await test('the key is added without disturbing what else is in the file', () => {
    const before = 'VERCEL_TOKEN=abc\nTAVILY_API_KEY=def\n';
    const after = withKey(before, 'sk-or-v1-xyz');
    ok(after.includes('VERCEL_TOKEN=abc'), after);
    ok(after.includes('TAVILY_API_KEY=def'), 'the other keys survive');
    ok(after.includes('OPENROUTER_API_KEY=sk-or-v1-xyz'), after);
  });

  await test('setting it again replaces it in place rather than adding a second one', () => {
    const after = withKey('OPENROUTER_API_KEY=old\nOTHER=1\n', 'sk-or-v1-new');
    eq(after.match(/OPENROUTER_API_KEY=/g).length, 1, 'exactly one key line');
    ok(after.includes('OPENROUTER_API_KEY=sk-or-v1-new'), after);
    ok(!after.includes('=old'), 'the old one is gone');
    ok(after.includes('OTHER=1'), 'the rest is untouched');
  });

  await test('an exported line counts as the same key, not a different one', () => {
    const after = withKey('export OPENROUTER_API_KEY=old\n', 'sk-or-v1-new');
    eq(after.match(/OPENROUTER_API_KEY=/g).length, 1, after);
  });

  await test('an empty file just gets the key', () => {
    ok(withKey('', 'sk-or-v1-a').includes('OPENROUTER_API_KEY=sk-or-v1-a'));
  });
}
