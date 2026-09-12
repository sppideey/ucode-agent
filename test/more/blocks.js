// Ready-made pieces of an app, copied in to be edited.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addBlock, CATALOGUE, BLOCK_NAMES } from '../../src/tools/blocks.js';

const BLOCKS = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'blocks'
);

export default async function ({ test, section, ok, eq, throws, sandbox }) {
  section('the block catalogue');

  await test('every block in the catalogue is actually installed', async () => {
    for (const name of BLOCK_NAMES) {
      const there = await fs.access(path.join(BLOCKS, `${name}.tsx`)).then(() => true, () => false);
      ok(there, `${name}.tsx is listed but missing from templates/blocks`);
    }
  });

  await test('nothing is shipped that the catalogue does not describe', async () => {
    const shipped = (await fs.readdir(BLOCKS)).filter((f) => f.endsWith('.tsx'));
    for (const file of shipped) {
      ok(CATALOGUE[file.replace(/\.tsx$/, '')], `${file} is shipped but undocumented`);
    }
  });

  await test('each block says what it is for and how to use it', () => {
    for (const name of BLOCK_NAMES) {
      const entry = CATALOGUE[name];
      ok(entry.what.length > 20, `${name} needs a real description`);
      ok(entry.exports.trim().length > 0, `${name} must name what it exports`);
      ok(entry.use.includes('<'), `${name} needs an example of it in use`);
    }
  });

  await test('what a block claims to export is what it exports', async () => {
    for (const name of BLOCK_NAMES) {
      const src = await fs.readFile(path.join(BLOCKS, `${name}.tsx`), 'utf8');
      for (const exported of CATALOGUE[name].exports.split(',').map((e) => e.trim())) {
        ok(new RegExp(`export\\s+(?:function|type|const)\\s+${exported}\\b`).test(src),
          `${name}.tsx does not export ${exported}`);
      }
    }
  });

  await test('a block only uses components the starter already ships', async () => {
    const ui = new Set(
      (await fs.readdir(path.join(BLOCKS, '..', 'next-shadcn', 'src', 'components', 'ui')))
        .map((f) => f.replace(/\.tsx$/, ''))
    );
    for (const name of BLOCK_NAMES) {
      const src = await fs.readFile(path.join(BLOCKS, `${name}.tsx`), 'utf8');
      for (const m of src.matchAll(/from "@\/components\/ui\/([\w-]+)"/g)) {
        ok(ui.has(m[1]), `${name}.tsx imports ui/${m[1]}, which the starter does not have`);
      }
    }
  });

  await test('anything with state says it runs on the client', async () => {
    for (const name of BLOCK_NAMES) {
      const src = await fs.readFile(path.join(BLOCKS, `${name}.tsx`), 'utf8');
      if (/\buseState\b|\buseMemo\b|\bonClick=\{\(\)/.test(src) && !/^\s*"use client"/.test(src)) {
        ok(src.startsWith('"use client"'), `${name}.tsx uses hooks but is not a client component`);
      }
    }
  });

  section('adding a block to an app');

  await test('with no name it lists what there is', async () => {
    const out = await addBlock({});
    for (const name of BLOCK_NAMES) ok(out.content.includes(name), `${name} is missing from the list`);
    eq(out.summary, `${BLOCK_NAMES.length} blocks`);
  });

  await test('a block lands in the app with the import line to use it', async () => {
    await fs.mkdir(path.join(sandbox, 'blockapp'), { recursive: true });
    const out = await addBlock({ name: 'data-table', folder: 'blockapp' });
    const written = await fs.readFile(
      path.join(sandbox, 'blockapp', 'src', 'components', 'blocks', 'data-table.tsx'), 'utf8');
    ok(written.includes('export function DataTable'), 'the file arrived whole');
    ok(out.content.includes('@/components/blocks/data-table'), out.content);
    ok(out.content.includes('DataTable'), 'it says what to import');
  });

  await test('adding it twice does not overwrite the edits made in between', async () => {
    const file = path.join(sandbox, 'blockapp', 'src', 'components', 'blocks', 'data-table.tsx');
    await fs.writeFile(file, '// my own version\n', 'utf8');
    const out = await addBlock({ name: 'data-table', folder: 'blockapp' });
    eq(out.summary, 'already there');
    eq(await fs.readFile(file, 'utf8'), '// my own version\n', 'the edit survived');
  });

  await test('a name that is not a block is refused with the list', async () => {
    const err = await throws(() => addBlock({ name: 'carousel', folder: 'blockapp' }), 'no_such_block');
    ok(err.fix.includes('data-table'), err.fix);
  });
}
