// A custom property that was never defined: valid CSS, silently dropped.
import { checkCss } from '../../src/core/csscheck.js';

export default async function ({ test, section, ok, eq }) {
  section('a var() with nothing behind it');

  const names = (...files) =>
    checkCss(files.map((text, i) => ({ rel: i ? `f${i}.css` : 'a.css', text }))).map((b) => b.name);

  await test('a name that is used and never declared is reported', () => {
    eq(names('a { padding: var(--space-md) }'), ['--space-md']);
  });

  await test('a name that is declared anywhere in the app is not', () => {
    eq(names(':root { --space-md: 1rem } a { padding: var(--space-md) }'), []);
  });

  // The order files are written in is not the order CSS resolves them in.
  await test('declared after it is used still counts as declared', () => {
    eq(names('a { color: var(--c) } :root { --c: red }'), []);
  });

  await test('declared in another file counts too', () => {
    eq(names('a { color: var(--brand) }', ':root { --brand: red }'), []);
  });

  await test('a var() with its own fallback is fine', () => {
    eq(names('a { padding: var(--nope, 1rem) }'), []);
  });

  await test('declared inside a media query or a theme block counts', () => {
    eq(names('@media (min-width: 40rem) { :root { --c: red } } a { color: var(--c) }'), []);
    eq(names('[data-theme="dark"] { --c: red } a { color: var(--c) }'), []);
  });

  await test('a declaration that is commented out is not a declaration', () => {
    eq(names('/* :root { --c: red } */ a { color: var(--c) }'), ['--c']);
  });

  await test('but a var() inside a comment is not a use', () => {
    eq(names('/* a { color: var(--gone) } */ :root { --c: red }'), []);
  });

  await test('a name set from script is defined, not missing', () => {
    const out = checkCss([
      { rel: 'a.css', text: 'a { color: var(--c) }' },
      { rel: 'app.js', text: "el.style.setProperty('--c', 'red')" },
    ]);
    eq(out, []);
  });

  section('where the missing name is');

  await test('a page reports the line inside its own <style>, not in the fragment', () => {
    const page = '<p>hi</p>\n<style>\na { color: var(--x) }\n</style>';
    eq(checkCss([{ rel: 'i.html', text: page }]), [{ rel: 'i.html', name: '--x', line: 3 }]);
  });

  await test('a comment above it does not shift the line', () => {
    const css = '/* one\ntwo\nthree */\na { color: var(--x) }';
    eq(checkCss([{ rel: 'a.css', text: css }])[0].line, 4);
  });

  await test('a page that only links a stylesheet contributes no CSS of its own', () => {
    eq(names('<link rel="stylesheet" href="s.css">'), []);
  });

  await test('the same missing name twice in one file is reported once', () => {
    eq(names('a { color: var(--x) } b { color: var(--x) }'), ['--x']);
  });

  await test('nothing at all is no problems, not a crash', () => {
    eq(checkCss(), []);
    eq(checkCss([]), []);
    eq(checkCss([{ rel: 'a.css', text: null }]), []);
  });
}
