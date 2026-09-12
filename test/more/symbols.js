// The symbol index: where a thing is declared, not every line that mentions it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { declarationsIn, routeFor, findSymbol, outline, clearIndex } from '../../src/tools/symbols.js';

export default async function ({ test, section, ok, eq, sandbox }) {
  /** The shared write helper does not make parent folders; these files need them. */
  const write = async (rel, text) => {
    const abs = path.join(sandbox, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, 'utf8');
  };

  section('declarations');

  const names = (rel, text) => declarationsIn(rel, text).map((s) => `${s.kind} ${s.name}`);

  await test('the shapes a declaration actually takes are all read', () => {
    const src = [
      'export function plain() {}',
      'export default async function loader() {}',
      'export class Store {}',
      'const add = (a, b) => a + b;',
      'export const fetchUser = async (id: string) => {};',
      'const legacy = function () {};',
      'export type Money = number;',
      'export interface Props {}',
      'enum Colour { Red }',
    ].join('\n');
    eq(names('src/a.ts', src), [
      'function plain', 'function loader', 'class Store', 'function add',
      'function fetchUser', 'function legacy', 'type Money', 'type Props', 'type Colour',
    ]);
  });

  await test('a capitalised function in a .tsx file is called a component', () => {
    eq(names('src/Button.tsx', 'export function Button() {}'), ['component Button']);
    eq(names('src/util.ts', 'export function Button() {}'), ['function Button'], 'only in a .tsx file');
    eq(names('src/Button.tsx', 'export function useThing() {}'), ['function useThing'], 'lowercase is not one');
  });

  await test('python is read too', () => {
    eq(names('api/main.py', 'class Server:\n    async def handle(self):\n        pass'),
      ['class Server', 'function handle']);
  });

  await test('a use is not a declaration', () => {
    eq(names('src/a.ts', 'const total = add(1, 2);\nconsole.log(plain());'), []);
  });

  await test('one declaration to a line, and generated one-liners are left alone', () => {
    eq(names('src/a.ts', `const x = () => 1; ${'// padding'.repeat(60)}`), []);
  });

  section('routes');

  await test('a page file says which URL it answers on', () => {
    eq(routeFor('src/app/page.tsx'), '/');
    eq(routeFor('src/app/blog/page.tsx'), '/blog');
    eq(routeFor('src/app/blog/[slug]/page.tsx'), '/blog/[slug]');
    eq(routeFor('src/app/api/hello/route.ts'), '/api/hello');
  });

  await test('a route group is a folder for us, not part of the URL', () => {
    eq(routeFor('src/app/(marketing)/pricing/page.tsx'), '/pricing');
  });

  await test('an ordinary file has no route', () => {
    eq(routeFor('src/lib/utils.ts'), null);
    eq(routeFor('src/components/Button.tsx'), null);
  });

  section('looking a symbol up');

  await write('idx/src/lib/money.ts', 'export function calculateTip(bill: number) {\n  return bill * 0.2;\n}\n');
  await write('idx/src/app/checkout/page.tsx', 'export default function CheckoutPage() {\n  return null;\n}\n');
  await write('idx/src/uses.ts', 'import { calculateTip } from "./lib/money";\nconst a = calculateTip(1);\nconst b = calculateTip(2);\n');
  clearIndex();

  await test('a lookup lands on the declaration, not the three lines that use it', async () => {
    const out = await findSymbol({ name: 'calculateTip', path: 'idx' });
    ok(out.content.includes('src/lib/money.ts:1'), out.content);
    ok(!out.content.includes('uses.ts'), 'the uses are not declarations');
    eq(out.summary, '1 declaration');
  });

  await test('a half-remembered name still lands', async () => {
    const out = await findSymbol({ name: 'calculatetip', path: 'idx' });
    ok(out.content.includes('money.ts'), out.content);
    const partial = await findSymbol({ name: 'Tip', path: 'idx' });
    ok(partial.content.includes('calculateTip'), partial.content);
  });

  await test('a page found by name comes with the URL it serves', async () => {
    const out = await findSymbol({ name: 'CheckoutPage', path: 'idx' });
    ok(out.content.includes('[route /checkout]'), out.content);
    ok(out.content.includes('component'), 'a page is a component');
  });

  await test('asking for one kind excludes the others', async () => {
    const out = await findSymbol({ name: 'calculateTip', kind: 'type', path: 'idx' });
    ok(/not declared here/.test(out.summary), out.content);
  });

  await test('a name that is not there says so plainly, and suggests grep', async () => {
    const out = await findSymbol({ name: 'noSuchThing', path: 'idx' });
    ok(out.content.includes('grep'), out.content);
    eq(out.summary, 'not declared here');
  });

  await test('an empty name is asked for rather than searched for', async () => {
    eq((await findSymbol({ name: '  ', path: 'idx' })).summary, 'nothing to look for');
  });

  section('the outline');

  await test('a folder maps to what each file declares', async () => {
    const out = await outline({ path: 'idx' });
    ok(out.content.includes('calculateTip'), out.content);
    ok(out.content.includes('[route /checkout]'), 'routes are on the map');
  });

  await test('a single file lists its declarations in order', async () => {
    await write('idx/src/many.ts', 'export function one() {}\nexport function two() {}\n');
    const out = await outline({ path: 'idx/src/many.ts' });
    ok(out.content.indexOf('one') < out.content.indexOf('two'), out.content);
    eq(out.summary, '2 declarations');
  });

  await test('an edit is picked up without a rescan of everything', async () => {
    await write('idx/src/late.ts', 'export function addedLater() {}\n');
    const out = await findSymbol({ name: 'addedLater', path: 'idx' });
    ok(out.content.includes('late.ts'), out.content);
  });
}
