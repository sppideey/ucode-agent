// Starting up is not the time to load everything ucode might eventually need.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default async function ({ test, section, ok, eq }) {
  section('what loading ucode costs');

  const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

  await test('the command itself does not pull in the agent or the provider', async () => {
    // Between them they bring the OpenAI SDK and every tool: two and a half
    // seconds before `--version` could print six characters.
    const src = await read('ucode.js');
    const top = src.slice(0, src.indexOf('function parseArgs'));
    ok(!/^import .*core\/loop\.js/m.test(top), 'loop.js must be loaded when a session starts, not before');
    ok(!/^import .*core\/provider\.js/m.test(top), 'provider.js likewise');
  });

  await test('the browser is loaded only when someone asks to look', async () => {
    // playwright-core is a second of start-up on its own, and nothing touches
    // a browser until /look.
    const src = await read('src/tools/index.js');
    ok(!/^import .*browser\.js/m.test(src), 'browser.js must be imported where it is used');
    ok(/import\(['"]\.\/browser\.js['"]\)/.test(src), 'and it must still be reachable');
  });

  await test('nothing in the tool registry reaches for playwright at load time', async () => {
    // A comment about it is fine; a top-level import is the thing that costs.
    const src = await read('src/tools/index.js');
    const statics = [...src.matchAll(/^import .*?from ['"](.+?)['"]/gm)].map((m) => m[1]);
    ok(!statics.some((m) => /playwright|browser\.js/.test(m)),
      'loaded eagerly: ' + statics.filter((m) => /playwright|browser/.test(m)).join(', '));
  });

  await test('the version is readable without loading anything heavy', async () => {
    const t = Date.now();
    const { VERSION } = await import('../../src/core/version.js');
    ok(VERSION, 'there is a version');
    ok(Date.now() - t < 500, `version.js took ${Date.now() - t}ms`);
  });
}
