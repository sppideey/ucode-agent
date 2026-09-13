// The plain HTML starter: for when a framework is not what was asked for.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createApp, TEMPLATE_NAMES, TEMPLATE_NOTES } from '../../src/tools/scaffold.js';

export default async function ({ test, section, ok, eq, sandbox }) {
  section('the plain html starter');

  const read = (rel) => fs.readFile(path.join(sandbox, rel), 'utf8');
  const there = (rel) => fs.access(path.join(sandbox, rel)).then(() => true, () => false);

  await test('both starters are offered, and each says what it is for', () => {
    eq(TEMPLATE_NAMES, ['next-shadcn', 'plain-html']);
    for (const name of TEMPLATE_NAMES) ok(TEMPLATE_NOTES[name]?.length > 20, `${name} needs a note`);
  });

  await test('it makes three files and no framework', async () => {
    const out = await createApp({
      folder: 'tide', name: 'Tide', description: 'a tasks app',
      template: 'plain-html', install: false,
    });
    ok(await there('tide/index.html'), 'the page');
    ok(await there('tide/styles.css'), 'the stylesheet');
    ok(await there('tide/app.js'), 'the module');
    ok(!(await there('tide/package.json')), 'nothing to install');
    ok(!(await there('tide/public')), 'no stray folder from the other starter');
    ok(/\d+ files/.test(out.summary), out.summary);
  });

  await test('the name is filled into the html and the js, not left as a placeholder', async () => {
    const html = await read('tide/index.html');
    ok(html.includes('<title>Tide</title>'), html.slice(0, 200));
    ok(html.includes('a tasks app'), 'the description reaches the metadata');
    ok(!html.includes('__APP_'), 'no placeholder survives');
    const js = await read('tide/app.js');
    ok(js.includes('Tide'), 'the module knows the name');
    ok(js.includes("'tide'"), 'and the slug is used for storage');
    ok(!js.includes('__APP_'), 'no placeholder survives in the module');
  });

  await test('it says how to run it, and does not talk about npm', async () => {
    const out = await createApp({
      folder: 'tide2', name: 'Tide', template: 'plain-html', install: true,
    });
    ok(out.content.includes('index.html'), out.content);
    ok(!/npm run build/.test(out.content), 'there is no build to run');
    ok(!/installing in the background/.test(out.summary), out.summary);
  });

  await test('the stylesheet ships tokens and honours reduced motion', async () => {
    const css = await read('tide/styles.css');
    ok(css.includes(':root'), 'tokens at the top');
    ok(css.includes('prefers-reduced-motion'), 'someone who asked for no motion means it');
  });

  await htmlCheckSuite({ test, section, ok, eq });
  await stuckOnSyntaxSuite({ test, section, ok, eq, sandbox });

  await test('a starter that does not exist is still refused', async () => {
    let threw = false;
    try { await createApp({ folder: 'x', name: 'X', template: 'svelte-kit', install: false }); }
    catch (err) { threw = err.kind === 'bad_args'; }
    ok(threw, 'an unknown starter is a clear error');
  });
}

export async function htmlCheckSuite({ test, section, ok, eq }) {
  const { checkHtml } = await import('../../src/core/htmlcheck.js');

  section('the script inside a page');

  await test('a script that does not parse is reported, with the line in the file', () => {
    const html = ['<html>', '<body>', '<div></div>', '<script>', '  const a = 1;', '  const bad = {', '</script>'].join('\n');
    const bad = checkHtml(html);
    eq(bad.length, 1);
    ok(bad[0].line >= 5 && bad[0].line <= 7, 'line ' + bad[0].line + ' should be inside the script');
  });

  await test('the exact failure that shipped a dead app is caught', () => {
    // A model writing an HTML-escape map inside HTML: the entities collapsed
    // into three quotes in a row, and the whole script stopped running.
    const html = '<script>\n  const esc = (s) => s.replace(/&/g, {"\'":\'\'\'}[s]);\n</script>';
    ok(checkHtml(html).length === 1, 'this is the one that got through');
  });

  await test('a page whose script is fine says nothing', () => {
    eq(checkHtml('<script>\n  const a = 1;\n  document.title = a;\n</script>'), []);
  });

  await test('a module is parsed as a module', () => {
    eq(checkHtml('<script type="module">\n  import x from "./x.js";\n  await x();\n</script>'), []);
  });

  await test('a separate file is left to its own check', () => {
    eq(checkHtml('<script src="app.js"></script>'), []);
  });

  await test('JSON and templates are not JavaScript', () => {
    eq(checkHtml('<script type="application/json">{not json</script>'), []);
    eq(checkHtml('<script type="text/template"><div>{{x}}</div></script>'), []);
  });

  await test('several scripts are each checked', () => {
    eq(checkHtml('<script>const a = 1;</script>\n<script>const b = {</script>').length, 1);
  });

  await test('a page with no script at all is fine', () => {
    eq(checkHtml('<html><body>hello</body></html>'), []);
    eq(checkHtml(''), []);
  });
}

export async function stuckOnSyntaxSuite({ test, section, ok, eq, sandbox }) {
  const fsp = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const { writeFile } = await import('../../src/tools/files.js');
  const { forgetBrokenRuns } = await import('../../src/tools/files.js');

  section('a file that will not parse');

  const broken = 'const a = {\n';
  const fine = 'const a = 1;\n';

  await test('the first failure is a nudge, not a lecture', async () => {
    forgetBrokenRuns();
    const out = await writeFile({ path: 'loop/a.js', content: broken });
    ok(out.content.includes('does not parse'), out.content);
    ok(out.content.includes('Fix it now'), out.content);
    ok(!out.content.includes('write the whole file again'), 'too early for that');
  });

  await test('the third in a row says to stop editing and rewrite it', async () => {
    // One run spent fifteen minutes patching a single line before giving up
    // and rewriting the file, which is what it should have done much earlier.
    forgetBrokenRuns();
    let out;
    for (let i = 0; i < 3; i++) out = await writeFile({ path: 'loop/b.js', content: broken });
    ok(out.content.includes('3 attempts in a row'), out.content);
    ok(out.content.includes('write the whole file again'), out.content);
  });

  await test('a file that parses forgets its run, so a later slip is just a slip', async () => {
    forgetBrokenRuns();
    for (let i = 0; i < 3; i++) await writeFile({ path: 'loop/c.js', content: broken });
    const good = await writeFile({ path: 'loop/c.js', content: fine });
    ok(!good.content.includes('does not parse'), 'it parses now');
    const slip = await writeFile({ path: 'loop/c.js', content: broken });
    ok(!slip.content.includes('attempts in a row'), 'the count started over');
  });

  await test('each file keeps its own count', async () => {
    forgetBrokenRuns();
    for (let i = 0; i < 3; i++) await writeFile({ path: 'loop/d.js', content: broken });
    const other = await writeFile({ path: 'loop/e.js', content: broken });
    ok(!other.content.includes('attempts in a row'), 'a different file starts clean');
  });
}
