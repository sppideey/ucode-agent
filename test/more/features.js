// 1.6 features: stuck detector, the live status, deploy helpers, design presets, /stats.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StuckWatch, eventFor } from '../../src/core/stuck.js';
import { formatDuration, fitActivity, doneLine } from '../../src/ui/activity.js';
import { slugify, nameCandidates, scanSecrets, readEnv } from '../../src/tools/deploy.js';
import { createApp } from '../../src/tools/scaffold.js';
import { statsLines } from '../../src/core/loop.js';
import { bare } from '../../src/ui/theme.js';

export default async function ({ test, section, ok, eq, sandbox }) {
  section('stuck');

  await test('the same failing edit three times gets a nudge, then a model switch', () => {
    const w = new StuckWatch();
    const call = { name: 'edit_file', args: { path: 'a.ts', old_string: 'x', new_string: 'y' } };
    const err = { kind: 'no_match', failed: 'old_string does not appear' };
    eq(w.observe(eventFor(call, { err })), null);
    eq(w.observe(eventFor(call, { err })), null);
    const third = w.observe(eventFor(call, { err }));
    eq(third.action, 'nudge');
    ok(/STOP/.test(third.text));
    eq(w.observe(eventFor(call, { err })).action, 'switch', 'the nudge did not work, so another model takes over');
  });

  await test('a build failing on the same errors three times is caught', () => {
    const w = new StuckWatch();
    const call = { name: 'run_command', args: { command: 'npm run build' } };
    const out = { exitCode: 1, content: "src/a.ts(1,1): error TS2322: Type 'x' is not assignable" };
    w.observe(eventFor(call, { out }));
    w.observe(eventFor(call, { out }));
    eq(w.observe(eventFor(call, { out }))?.hit.pattern, 'build');
  });

  section('live status');

  await test('durations read the way a person says them', () => {
    eq(formatDuration(400), '0.4s');
    eq(formatDuration(14_000), '14s');
    eq(formatDuration(124_000), '2m 04s');
  });

  await test('the activity fits the room, keeping the timer longest', () => {
    const full = bare(fitActivity({ glyph: '*', label: 'Writing 4 files', meta: [{ text: 'step 3' }, { text: '1m 02s', keep: true }], hint: 'esc to stop' }, 80));
    ok(full.includes('Writing 4 files') && full.includes('step 3') && full.includes('1m 02s') && full.includes('esc'));
    const tight = bare(fitActivity({ glyph: '*', label: 'Writing 4 files', meta: [{ text: 'step 3' }, { text: '1m 02s', keep: true }] }, 12));
    ok(tight.includes('1m 02s') && tight.length <= 12, tight);
    // The step count went: it says nothing about whether the thing asked for
    // exists, and /stats has it for anyone who wants it.
    ok(bare(doneLine(372_000, 25)).includes('Done in 6m 12s'), 'the time is what is worth saying');
    ok(!bare(doneLine(372_000, 25)).includes('25 steps'), 'the count is bookkeeping');
    ok(bare(doneLine(372_000, 25, { ok: false })).includes('without finishing'),
      'a turn that gave up must never read as done');
  });

  section('deploy');

  await test('project names are short, clean and have fallbacks', () => {
    eq(slugify('Food IQ'), 'food-iq');
    eq(slugify('@acme/My   Super Long Application Name'), 'my-super-long');
    const c = nameCandidates('Food IQ');
    eq(c.slice(0, 2), ['food-iq', 'food-iq-app']);
    ok(c.includes('foodiq'));
  });

  await test('a key written into the code is found; .env files are left alone', async () => {
    const dir = path.join(sandbox, 'leaky');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'page.tsx'), `const key = "sk-or-v1-${'a'.repeat(40)}";\n`);
    await fs.writeFile(path.join(dir, '.env.local'), `OPENROUTER_API_KEY="sk-or-v1-${'b'.repeat(40)}"\nexport PLAIN=1\n`);
    const found = await scanSecrets(dir);
    eq(found.map((f) => `${f.file}:${f.line}`), ['src/page.tsx:1']);
    const env = await readEnv(dir);
    eq(Object.keys(env), ['OPENROUTER_API_KEY', 'PLAIN']);
    ok(!env.OPENROUTER_API_KEY.startsWith('"'));
  });

  section('design');

  await test('create_app applies the chosen preset and leaves no catalogue behind', async () => {
    await createApp({ folder: 'citrusy', name: 'Citrusy', design: 'citrus', template: 'next-shadcn', install: false });
    const dir = path.join(sandbox, 'citrusy');
    const layout = await fs.readFile(path.join(dir, 'src/app/layout.tsx'), 'utf8');
    ok(layout.includes('Figtree('), 'font swapped');
    const guide = await fs.readFile(path.join(dir, 'TEMPLATE.md'), 'utf8');
    ok(guide.includes('**citrus** preset'));
    ok(!(await fs.stat(path.join(dir, 'presets')).catch(() => null)), 'presets/ removed');
  });

  section('stats');

  await test('/stats reads cleanly', () => {
    const lines = statsLines({
      started: Date.now() - 65_000, workMs: 60_000, turns: 1, steps: 12, tokensIn: 120_000, tokensOut: 9_000,
      tools: { write_file: 3, run_command: 2 }, failed: 0, written: 5, edited: 2, commands: 2, builds: 1, stuck: 0,
    }, 20).map(bare).join('\n');
    ok(/12 steps/.test(lines) && /5 written/.test(lines) && /1 build\b/.test(lines), lines);
  });
}
