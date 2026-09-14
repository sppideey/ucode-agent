// The joins between the parts, which break quietly.
//
// A tool offered to the model with no handler behind it, a command that
// tab-completes and then does nothing, a skill that can never load itself:
// none of these throw at startup. They fail the first time a user reaches for
// them, which is the worst possible moment to find out.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (p) => readFileSync(p, 'utf8');

/** Keys of an object literal, including `foo,` shorthand and `'quoted':`. */
function keysOf(source, startMarker) {
  const from = source.indexOf(startMarker);
  if (from < 0) return [];
  const body = source.slice(from + startMarker.length);

  const keys = [];
  let depth = 1;
  for (const line of body.split('\n')) {
    depth += (line.match(/[{[]/g) ?? []).length - (line.match(/[}\]]/g) ?? []).length;
    if (depth <= 0) break;
    const named = /^\s{2}(?:'([a-z_]+)'|([a-z_]+))\s*[:,]/.exec(line);
    if (named) keys.push(named[1] ?? named[2]);
  }
  return keys;
}

export default async function ({ test, section, ok, eq }) {
  section('nothing is offered that is not wired up');

  await test('every tool the model is offered has a handler behind it', () => {
    const index = read('src/tools/index.js');
    const declared = [...index.matchAll(/^\s*name: '([a-z_]+)',$/gm)].map((m) => m[1]);
    const handlers = new Set(keysOf(index, 'const run = {'));

    ok(declared.length >= 20, `only ${declared.length} tools declared`);
    const orphans = declared.filter((t) => !handlers.has(t));
    eq(orphans, [], `offered to the model with nothing behind them: ${orphans.join(', ')}`);
  });

  await test('every handler is a tool the model was actually offered', () => {
    const index = read('src/tools/index.js');
    const declared = new Set([...index.matchAll(/^\s*name: '([a-z_]+)',$/gm)].map((m) => m[1]));
    const unreachable = keysOf(index, 'const run = {').filter((h) => !declared.has(h));
    eq(unreachable, [], `implemented but never offered: ${unreachable.join(', ')}`);
  });

  await test('every command that tab-completes actually runs', () => {
    const listed = [...(/export const COMMANDS = \[([\s\S]*?)\];/.exec(read('src/ui/screen.js'))?.[1] ?? '')
      .matchAll(/'(\/[a-z]+)'/g)].map((m) => m[1]);
    const dispatched = new Set([...read('src/core/loop.js').matchAll(/case '(\/[a-z]+)':/g)].map((m) => m[1]));

    ok(listed.length >= 15, `only ${listed.length} commands listed`);
    const dead = listed.filter((c) => !dispatched.has(c));
    eq(dead, [], `offered by tab-completion and never dispatched: ${dead.join(', ')}`);
  });

  section('every skill can reach the work it is for');

  await test('each skill parses, and can load itself', async () => {
    const { loadSkills } = await import('../../src/core/skills.js');
    const skills = await loadSkills(process.cwd());

    ok(skills.length >= 8, `only ${skills.length} skills found`);
    for (const s of skills) {
      ok(s.triggers?.length, `${s.name} has no auto triggers, so it never loads itself`);
      ok(s.body?.trim(), `${s.name} has an empty body`);
      ok(s.description?.trim(), `${s.name} has no description`);
      // A digest exists to be cheaper than the skill. One that is not is a
      // second copy of the same thing, sent on every step of every build.
      if (s.digest) ok(s.digest.length < s.body.length, `${s.name}'s digest is not shorter than the skill`);
    }
  });

  await test('the requests that matter pull the skills that cover them', async () => {
    const { loadSkills, autoLoadFor } = await import('../../src/core/skills.js');
    const skills = await loadSkills(process.cwd());

    for (const [prompt, want] of [
      ['build me a todo app', ['ui-ux', 'build-app']],
      ['build me a next.js dashboard with an api route', ['ui-ux', 'build-app']],
      ['make a landing page for a coffee shop', ['ui-ux']],
      ['there is a bug in the filter row', ['debug']],
      ['write tests for the store', ['write-tests']],
    ]) {
      const got = autoLoadFor(skills, prompt).map((s) => s.name);
      for (const w of want) ok(got.includes(w), `"${prompt}" loaded [${got}] — no ${w}`);
    }
  });

  section('the starters are whole');

  await test('each starter ships the guide and the files its page asks for', () => {
    for (const t of ['plain-html', 'next-shadcn']) {
      ok(read(path.join('templates', t, 'TEMPLATE.md')).trim(), `${t} has no guide`);
    }

    const dir = path.join('templates', 'plain-html');
    const html = read(path.join(dir, 'index.html'));
    for (const m of html.matchAll(/\b(?:href|src)="(?!https?:|\/\/|data:|#)([^"]+)"/g)) {
      // A starter that links to a file it does not ship is a 404 in every app
      // ever made from it.
      ok(readFileSync(path.join(dir, m[1]), 'utf8'), `plain-html links to ${m[1]}, which it does not ship`);
    }
  });

  await test('the starter page never links through its own folder', () => {
    // The bug relink.js exists to correct, guarded at the source too.
    const html = read(path.join('templates', 'plain-html', 'index.html'));
    for (const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      ok(!/^(?:APP_FOLDER|__FOLDER__)\//.test(m[1]), `the starter itself carries a folder prefix: ${m[1]}`);
    }
  });
}
