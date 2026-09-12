// Asking the project's own TypeScript what something is.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectRootFor, offsetOf, typeOf, clearServices } from '../../src/tools/types.js';

export default async function ({ test, section, ok, eq, sandbox }) {
  section('finding the symbol to ask about');

  await test('a name is found where it is used as a name', () => {
    const src = 'const total = 1;\nconst other = total + 2;\n';
    eq(offsetOf(src, 'total'), src.indexOf('total'));
  });

  await test('a longer word containing the name is not the name', () => {
    const src = 'const subtotal = 1;\nconst total = 2;\n';
    eq(offsetOf(src, 'total'), src.indexOf('const total') + 'const '.length);
  });

  await test('a name that is not there is reported as not there', () => {
    eq(offsetOf('const a = 1;', 'missing'), -1);
  });

  await test('asking about a line picks the occurrence nearest it', () => {
    const src = ['const x = 1;', 'const y = 2;', 'use(x);', 'use(x);'].join('\n');
    const late = offsetOf(src, 'x', 4);
    eq(src.slice(late, late + 1), 'x');
    ok(late > src.indexOf('const x'), 'it chose a later occurrence, not the first');
  });

  section('finding the project');

  await test('the nearest folder with a tsconfig above the file is the project', async () => {
    const app = path.join(sandbox, 'tsproj');
    await fs.mkdir(path.join(app, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(app, 'tsconfig.json'), '{}', 'utf8');
    eq(projectRootFor(path.join(app, 'src', 'deep'), sandbox), app);
  });

  await test('a file with no tsconfig above it has no project', () => {
    eq(projectRootFor(path.join(sandbox, 'nowhere'), path.join(sandbox, 'nowhere')), null);
  });

  section('asking the compiler');

  await test('a file outside any TypeScript project says so plainly', async () => {
    await fs.mkdir(path.join(sandbox, 'plain'), { recursive: true });
    await fs.writeFile(path.join(sandbox, 'plain', 'a.js'), 'const a = 1;\n', 'utf8');
    const out = await typeOf({ path: 'plain/a.js', symbol: 'a' });
    ok(/not a typescript project|typescript not installed/.test(out.summary), out.summary);
  });

  await test('a project with no TypeScript installed says that, rather than guessing', async () => {
    const app = path.join(sandbox, 'notsc');
    await fs.mkdir(path.join(app, 'src'), { recursive: true });
    await fs.writeFile(path.join(app, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }', 'utf8');
    await fs.writeFile(path.join(app, 'src', 'a.ts'), 'export const count = 1;\n', 'utf8');
    clearServices();
    const out = await typeOf({ path: 'notsc/src/a.ts', symbol: 'count' });
    eq(out.summary, 'typescript not installed');
    ok(out.content.includes('installed'), out.content);
  });

  section('a real answer from a real compiler');

  // The suite must still run on a bare checkout, so this needs typescript to be
  // installed (it is a devDependency) and says so rather than passing quietly.
  const tsLib = path.join(process.cwd(), 'node_modules', 'typescript');
  const haveTs = await fs.access(tsLib).then(() => true, () => false);

  await test('typescript is installed, so the language service can actually be tested', () => {
    ok(haveTs, 'run npm install: the type_of tests need the typescript devDependency');
  });

  if (haveTs) {
    const app = path.join(sandbox, 'realts');
    await fs.mkdir(path.join(app, 'src'), { recursive: true });
    await fs.mkdir(path.join(app, 'node_modules'), { recursive: true });
    // A junction rather than a copy: the same compiler, none of the megabytes.
    await fs.symlink(tsLib, path.join(app, 'node_modules', 'typescript'), 'junction').catch(() => {});
    await fs.writeFile(path.join(app, 'tsconfig.json'),
      '{ "compilerOptions": { "strict": true, "target": "ES2022", "skipLibCheck": true }, "include": ["src"] }', 'utf8');
    await fs.writeFile(path.join(app, 'src', 'model.ts'), [
      '/** A person who can sign in. */',
      'export type User = { id: string; displayName: string; age: number };',
      '',
      '/** Format a user for display in the header. */',
      'export function greet(user: User, formal: boolean): string {',
      '  return formal ? `Good evening, ${user.displayName}` : `Hi ${user.displayName}`;',
      '}',
      '',
      'const currentUser: User = { id: "1", displayName: "Ada", age: 36 };',
      'export const greeting = greet(currentUser, true);',
      ''].join('\n'), 'utf8');
    clearServices();

    await test('a function comes back with its real signature and its docs', async () => {
      const out = await typeOf({ path: 'realts/src/model.ts', symbol: 'greet' });
      ok(out.content.includes('function greet(user: User, formal: boolean): string'), out.content);
      ok(out.content.includes('Format a user for display'), 'the JSDoc comes too');
      ok(out.content.includes('model.ts:5'), 'and where it is defined');
    });

    await test('a property of a type is answered, not just a top-level name', async () => {
      const out = await typeOf({ path: 'realts/src/model.ts', symbol: 'displayName' });
      ok(out.content.includes('displayName: string'), out.content);
    });

    await test('an inferred type is reported, which is the part nobody can guess', async () => {
      const out = await typeOf({ path: 'realts/src/model.ts', symbol: 'greeting' });
      ok(/greeting: string/.test(out.content), out.content);
    });

    await test('the answer says it is the compiler talking, not a guess', async () => {
      const out = await typeOf({ path: 'realts/src/model.ts', symbol: 'currentUser' });
      ok(out.content.includes('currentUser: User'), out.content);
      ok(out.content.includes('what the build will say'), out.content);
    });
  }

  await test('an empty question is asked for rather than answered', async () => {
    eq((await typeOf({ path: 'plain/a.js', symbol: '  ' })).summary, 'nothing to ask about');
  });

  await test('a name not in the file is said so before the compiler is troubled', async () => {
    const app = path.join(sandbox, 'notsc');
    const out = await typeOf({ path: 'notsc/src/a.ts', symbol: 'nowhere' });
    ok(/not in this file|typescript not installed/.test(out.summary), out.summary);
  });
}
