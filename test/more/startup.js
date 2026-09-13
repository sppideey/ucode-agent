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

  await hygieneSuite({ test, section, ok });

  await test('the version is readable without loading anything heavy', async () => {
    const t = Date.now();
    const { VERSION } = await import('../../src/core/version.js');
    ok(VERSION, 'there is a version');
    ok(Date.now() - t < 500, `version.js took ${Date.now() - t}ms`);
  });
}

export async function hygieneSuite({ test, section, ok }) {
  const fsp = await import('node:fs/promises');
  const pathMod = await import('node:path');

  section('no control characters in the source');

  await test('a regex escape is never a raw control character', async () => {
    // `\b` written into a file as a literal backspace looks identical on
    // screen and matches nothing. Two of them sat in loop.js disabling build
    // detection, and one broke the filter that keeps the model's internal
    // monologue off the transcript. They are invisible; only a scan finds them.
    const bad = [];
    const walk = async (dir) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = pathMod.join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        if (!/\.(?:js|json|css|html|md)$/.test(e.name)) continue;
        const text = await fsp.readFile(full, 'utf8');
        for (const m of text.matchAll(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F]/g)) {
          bad.push(`${full}: code ${m[0].charCodeAt(0)} at offset ${m.index}`);
        }
      }
    };
    for (const dir of ['src', 'test', 'templates']) await walk(dir);
    ok(bad.length === 0, 'control characters found:\n  ' + bad.slice(0, 8).join('\n  '));
  });

  await test('build detection actually matches a build command', async () => {
    const src = await fsp.readFile('src/core/loop.js', 'utf8');
    const m = src.match(/\/(\(\?:next build[^/]*)\//);
    ok(m, 'the build-detection regex is still there');
    const re = new RegExp(m[1]);
    ok(re.test('npm run build'), 'npm run build must be recognised');
    ok(re.test('next build') && re.test('tsc'), 'and the others');
    ok(!re.test('npm run dev'), 'but not everything');
  });
}
