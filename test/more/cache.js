// The starter package cache: link a known install in rather than wait on npm.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { slotFor, linkTree, restore, populate, cacheRoot } from '../../src/tools/cache.js';

export default async function ({ test, section, ok, eq, tmp }) {
  section('the package cache');

  const home = path.join(tmp, 'cache-home');
  const at = (...p) => path.join(tmp, 'cache-work', ...p);
  const LOCK = '{"name":"starter","lockfileVersion":3}';

  /** A believable node_modules: nested dirs, a .bin, and a build-tool leftover. */
  async function fakeInstall(dir) {
    await fs.mkdir(path.join(dir, 'node_modules', 'react', 'cjs'), { recursive: true });
    await fs.mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    await fs.mkdir(path.join(dir, 'node_modules', '.cache', 'webpack'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'react', 'index.js'), 'module.exports = 1;');
    await fs.writeFile(path.join(dir, 'node_modules', 'react', 'cjs', 'react.js'), 'deep');
    await fs.writeFile(path.join(dir, 'node_modules', '.bin', 'next'), '#!/bin/sh');
    await fs.writeFile(path.join(dir, 'node_modules', '.cache', 'webpack', 'blob'), 'junk');
  }

  const there = (p) => fs.access(p).then(() => true, () => false);

  await test('a slot is stable for one lockfile and different for another', () => {
    eq(slotFor('next-shadcn', LOCK, home), slotFor('next-shadcn', LOCK, home));
    ok(slotFor('next-shadcn', LOCK, home) !== slotFor('next-shadcn', '{"other":1}', home),
      'a changed lockfile must not reuse the old packages');
    ok(slotFor('other-starter', LOCK, home) !== slotFor('next-shadcn', LOCK, home),
      'two starters do not share a slot');
    ok(slotFor('next-shadcn', LOCK, home).startsWith(cacheRoot(home)), 'slots live under the cache root');
  });

  await test('linking a tree gives the same file on disk under a new name, not a second copy', async () => {
    const src = at('link-src');
    await fakeInstall(src);
    const dst = at('link-dst', 'node_modules');
    const files = await linkTree(path.join(src, 'node_modules'), dst);
    ok(files >= 4, `linked ${files} files`);
    ok(await there(path.join(dst, 'react', 'cjs', 'react.js')), 'nested files come across');
    const a = await fs.stat(path.join(src, 'node_modules', 'react', 'index.js'));
    const b = await fs.stat(path.join(dst, 'react', 'index.js'));
    // Same inode where the filesystem supports links; a copy is the fallback.
    ok(a.ino === b.ino || b.size === a.size, 'linked, or copied when links are unavailable');
  });

  await test('build leftovers are left out of the cache, but only at the top level', async () => {
    const app = at('skip-app');
    await fakeInstall(app);
    // A package legitimately named .cache deeper in the tree must survive.
    await fs.mkdir(path.join(app, 'node_modules', 'react', '.cache'), { recursive: true });
    await fs.writeFile(path.join(app, 'node_modules', 'react', '.cache', 'keep'), 'mine');

    ok(await populate(app, 'skip-starter', LOCK, { home }), 'the cache was filled');
    const slot = slotFor('skip-starter', LOCK, home);
    ok(!(await there(path.join(slot, 'node_modules', '.cache'))), 'the webpack leftover is not cached');
    ok(await there(path.join(slot, 'node_modules', '.bin', 'next')), '.bin is kept, it is needed to run');
    ok(await there(path.join(slot, 'node_modules', 'react', '.cache', 'keep')),
      'a package of that name deeper down is not skipped');
  });

  await test('with nothing cached yet, a restore does nothing and says so', async () => {
    const app = at('cold-app');
    await fs.mkdir(app, { recursive: true });
    eq(await restore(app, 'cold-starter', LOCK, { home }), 0);
    ok(!(await there(path.join(app, 'node_modules'))), 'no half-made node_modules left behind');
  });

  await test('a starter installed once is linked into the next app', async () => {
    const first = at('first-app');
    await fakeInstall(first);
    ok(await populate(first, 'round-trip', LOCK, { home }), 'the first install fills the cache');

    const second = at('second-app');
    await fs.mkdir(second, { recursive: true });
    const linked = await restore(second, 'round-trip', LOCK, { home });
    ok(linked > 0, `expected files to be linked, got ${linked}`);
    eq(await fs.readFile(path.join(second, 'node_modules', 'react', 'index.js'), 'utf8'), 'module.exports = 1;');
    ok(await there(path.join(second, 'node_modules', 'react', 'cjs', 'react.js')), 'the whole tree arrives');
  });

  await test('the app\'s own rewritten lockfile never moves the slot', async () => {
    // npm rewrites package-lock.json as it installs. The cache is keyed on the
    // starter's lockfile, so a stored install is still found afterwards.
    const app = at('rewrite-app');
    await fakeInstall(app);
    await fs.writeFile(path.join(app, 'package-lock.json'), '{"rewritten-by":"npm"}');
    ok(await populate(app, 'rewrite-starter', LOCK, { home }), 'filled');

    const next = at('rewrite-next');
    await fs.mkdir(next, { recursive: true });
    await fs.writeFile(path.join(next, 'package-lock.json'), '{"totally":"different"}');
    ok(await restore(next, 'rewrite-starter', LOCK, { home }) > 0, 'still a hit');
  });

  await test('a half-written cache is ignored rather than half-installed', async () => {
    const slot = slotFor('torn-starter', LOCK, home);
    await fs.mkdir(path.join(slot, 'node_modules', 'react'), { recursive: true });
    await fs.writeFile(path.join(slot, 'node_modules', 'react', 'index.js'), 'partial');
    // No marker file: the copy never finished.
    const app = at('torn-app');
    await fs.mkdir(app, { recursive: true });
    eq(await restore(app, 'torn-starter', LOCK, { home }), 0, 'an unmarked slot is not trusted');
  });

  await test('an app that already has packages is left alone', async () => {
    const app = at('has-app');
    await fakeInstall(app);
    ok(await populate(app, 'has-starter', LOCK, { home }), 'filled');
    eq(await restore(app, 'has-starter', LOCK, { home }), 0, 'never overwrite a real install');
  });

  await test('without a lockfile the cache stands aside and npm does the work', async () => {
    const app = at('nolock-app');
    await fakeInstall(app);
    eq(await restore(app, 'x', null, { home }), 0);
    eq(await populate(app, 'x', null, { home }), false);
  });

  await test('the second app does not re-fill the cache', async () => {
    const app = at('again-app');
    await fakeInstall(app);
    ok(await populate(app, 'again-starter', LOCK, { home }), 'the first fills it');
    eq(await populate(app, 'again-starter', LOCK, { home }), false, 'the second leaves it as it is');
  });
}
