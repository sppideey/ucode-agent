// Renaming a name everywhere it is that name — and nowhere it is not.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { renameIn, renameSymbol } from '../../src/tools/rename.js';

export default async function ({ test, section, ok, eq, throws, sandbox }) {
  section('renaming by shape, not by text');

  const rn = (src, from = 'id', to = 'key') => renameIn(src, from, to).text;

  await test('a whole name is renamed and a longer word containing it is not', () => {
    eq(rn('const id = 1; const width = id; const idle = 2;'),
       'const key = 1; const width = key; const idle = 2;');
    eq(rn('user.id = other.idx;'), 'user.key = other.idx;');
    eq(rn('const paid = id;'), 'const paid = key;', 'a name ending in the old one is untouched');
  });

  await test('a name inside a string is left alone', () => {
    eq(rn('const id = "id"; log("the id is", id);'), 'const key = "id"; log("the id is", key);');
    eq(rn("const id = 'id';"), "const key = 'id';");
  });

  await test('a name inside a comment is left alone', () => {
    eq(rn('// the id goes here\nconst id = 1;'), '// the id goes here\nconst key = 1;');
    eq(rn('/* id: a number */ const id = 1;'), '/* id: a number */ const key = 1;');
    eq(rn('# python says id\nid = 1'), '# python says id\nkey = 1');
  });

  await test('a template literal renames the code in it but not the words around it', () => {
    eq(rn('const s = `the id is ${id}`;'), 'const s = `the id is ${key}`;');
  });

  await test('a nested template is still followed back out again', () => {
    eq(rn('const s = `a ${ `b ${id}` } c`; const t = id;'),
       'const s = `a ${ `b ${key}` } c`; const t = key;');
  });

  await test('an escaped quote does not end the string early', () => {
    eq(rn('const a = "he said \\"id\\""; const id = 1;'),
       'const a = "he said \\"id\\""; const key = 1;');
  });

  await test('a division sign is not the start of a comment', () => {
    eq(rn('const half = id / 2; const also = id;'), 'const half = key / 2; const also = key;');
  });

  await test('the lines that changed are reported, once each', () => {
    const { lines } = renameIn('const id = 1;\nconst b = 2;\nuse(id, id);\n', 'id', 'key');
    eq(lines, [1, 3]);
  });

  await test('a jsx prop is a name like any other', () => {
    eq(renameIn('<Card id={id} label="id" />', 'id', 'key').text, '<Card key={key} label="id" />');
  });

  section('renaming across the project');

  const write = async (rel, text) => {
    const abs = path.join(sandbox, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, 'utf8');
  };
  const read = (rel) => fs.readFile(path.join(sandbox, rel), 'utf8');

  await write('rn/src/a.ts', 'export const userId = 1;\n// userId is a number\nexport const label = "userId";\n');
  await write('rn/src/b.ts', 'import { userId } from "./a";\nconsole.log(userId, userIdentity);\n');
  await write('rn/README.md', 'The userId field is documented here.\n');

  await test('every file that uses the name is changed, and the docs are not code', async () => {
    const out = await renameSymbol({ name: 'userId', to: 'accountId', path: 'rn' });
    ok(out.content.includes('src/a.ts'), out.content);
    ok(out.content.includes('src/b.ts'), out.content);
    eq(await read('rn/README.md'), 'The userId field is documented here.\n', 'markdown is not source');
  });

  await test('the rename landed where it should and nowhere else', async () => {
    const a = await read('rn/src/a.ts');
    ok(a.includes('export const accountId = 1;'), a);
    ok(a.includes('// userId is a number'), 'the comment is untouched');
    ok(a.includes('"userId"'), 'the string is untouched');
    const b = await read('rn/src/b.ts');
    ok(b.includes('console.log(accountId, userIdentity)'), b);
  });

  await test('a name that is not there is said plainly, not silently', async () => {
    const out = await renameSymbol({ name: 'nothingHere', to: 'somethingElse', path: 'rn' });
    eq(out.summary, 'no occurrences');
  });

  await test('renaming a single file touches only that file', async () => {
    await write('rn/src/one.ts', 'const only = 1;\n');
    await write('rn/src/two.ts', 'const only = 2;\n');
    await renameSymbol({ name: 'only', to: 'single', path: 'rn/src/one.ts' });
    ok((await read('rn/src/one.ts')).includes('single'));
    ok((await read('rn/src/two.ts')).includes('only'), 'the other file was not in scope');
  });

  await test('a name that is not an identifier is refused with a reason', async () => {
    await throws(() => renameSymbol({ name: 'a.b', to: 'c', path: 'rn' }), 'bad_args');
    await throws(() => renameSymbol({ name: '2fast', to: 'c', path: 'rn' }), 'bad_args');
    await throws(() => renameSymbol({ name: 'a', to: '', path: 'rn' }), 'bad_args');
  });

  await test('renaming something to itself is refused rather than rewriting every file', async () => {
    await throws(() => renameSymbol({ name: 'same', to: 'same', path: 'rn' }), 'bad_args');
  });
}
