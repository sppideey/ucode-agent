// A plain app has to work when its index.html is double-clicked (file://),
// where browsers refuse <script type="module">.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeOpenable } from '../../src/core/openable.js';

const BLOCKS = path.resolve('templates/blocks/plain');

async function app(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ucode-open-'));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  return dir;
}

const PAGE = '<!doctype html><html><body><input id="t" placeholder="Add a task"><button id="b">Add</button><ul id="l"></ul>' +
  '<script type="module" src="app.js"></script></body></html>';

export default async function ({ test, section, ok, eq }) {
  section('plain apps open from file://');

  await test('a module script becomes a deferred classic script, wrapped so its names stay private', async () => {
    const dir = await app({ 'index.html': PAGE, 'app.js': 'const top = 1;\nexport function f() {}\n' });
    eq(await makeOpenable(dir), ['app.js']);
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    ok(/<script src="app.js" defer><\/script>/.test(html), html);
    const js = await fs.readFile(path.join(dir, 'app.js'), 'utf8');
    ok(!/\bexport\b/.test(js) && /^\(\(\) => \{/m.test(js) && js.includes("'use strict'"), js);
    new Function(js); // parses as a classic script
    eq(await makeOpenable(dir), []); // and a second pass leaves it alone
  });

  await test('imported files are inlined; a URL import is left as a module', async () => {
    const dir = await app({
      'index.html': PAGE,
      'app.js': "import { createStore } from './blocks/store.js';\nimport def, * as ns from './x.js';\nconsole.log(createStore, def, ns.y);\n",
      'blocks/store.js': await fs.readFile(path.join(BLOCKS, 'store.js'), 'utf8'),
      'x.js': 'export const y = 2;\nexport default function () { return y; }\n',
    });
    eq(await makeOpenable(dir), ['app.js']);
    const js = await fs.readFile(path.join(dir, 'app.js'), 'utf8');
    ok(!/^\s*(import|export)\b/m.test(js), js);
    new Function(js);

    const url = await app({ 'index.html': PAGE, 'app.js': "import confetti from 'https://esm.sh/canvas-confetti';\n" });
    eq(await makeOpenable(url), []);
  });

  await test('data-src is not src, another page can be fixed, a script listed twice is rewritten once', async () => {
    const dir = await app({
      'about.html': '<script data-src="nope.js" type="module" src="a.js"></script><script type="module" src="a.js"></script>',
      'a.js': '// import() later\nconst r = await Promise.resolve(1);\n',
    });
    eq(await makeOpenable(dir, 'about.html'), ['a.js', 'a.js']);
    const js = await fs.readFile(path.join(dir, 'a.js'), 'utf8');
    ok(js.includes('(async () => {') && js.split('=> {').length === 2, js);
    ok(!(await fs.readFile(path.join(dir, 'about.html'), 'utf8')).includes('module'));
  });

  await test('top-level await keeps working', async () => {
    const dir = await app({ 'index.html': PAGE, 'app.js': 'const r = await Promise.resolve(1);\n' });
    await makeOpenable(dir);
    ok((await fs.readFile(path.join(dir, 'app.js'), 'utf8')).includes('(async () => {'));
  });

  await test('opened from disk, a todo app built on the blocks adds a task', async () => {
    let chromium;
    try { ({ chromium } = await import('playwright-core')); } catch { return; }
    const browser = await chromium.launch({ channel: 'msedge', headless: true })
      .catch(() => chromium.launch({ channel: 'chrome', headless: true })).catch(() => null);
    if (!browser) return; // no browser on this machine: the parse checks above still ran
    try {
      const dir = await app({
        'index.html': '<!doctype html><html><body><main id="app"></main><script type="module" src="app.js"></script></body></html>',
        'app.js': "import { ItemList } from './blocks/item-list.js';\nimport { createStore } from './blocks/store.js';\n" +
          "const store = createStore('t', { items: [] });\n" +
          "const list = ItemList({ items: store.state.items, onChange: (items) => store.set({ items }), placeholder: 'Add a task' });\n" +
          "document.querySelector('#app').append(list.el);\n",
        'blocks/item-list.js': await fs.readFile(path.join(BLOCKS, 'item-list.js'), 'utf8'),
        'blocks/store.js': await fs.readFile(path.join(BLOCKS, 'store.js'), 'utf8'),
      });
      await makeOpenable(dir);
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
      await page.getByPlaceholder('Add a task').fill('buy milk');
      await page.getByPlaceholder('Add a task').press('Enter');
      await page.waitForTimeout(300);
      eq(errors, []);
      ok(await page.evaluate(() => document.body.innerText.includes('buy milk')), 'the task never appeared');
    } finally {
      await browser.close();
    }
  });
}
