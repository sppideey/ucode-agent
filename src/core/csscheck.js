/**
 * csscheck.js — a custom property that was never defined.
 *
 * `padding: var(--space-md)` where nothing ever declared `--space-md` does not
 * warn, does not fall back and does not appear in the console. The browser
 * throws the whole declaration away at parse time, so the padding is simply
 * not there — and the page still renders, still looks deliberate, and is
 * wrong in a way that reads as a design choice rather than a bug.
 *
 * It came out of a build here: a stylesheet that declared --space-xs, --space,
 * --space-sm, --space-lg and --space-xl, then used --space-md four times.
 * Nothing in the checks looked at CSS, so nothing said a word.
 *
 * The check is one whole app at a time rather than one file at a time,
 * because the definition and the use are routinely in different files: a
 * single-page app keeps its tokens in styles.css and reaches for them from an
 * inline <style>, and reporting that as undefined would be worse than not
 * looking. Whatever is passed in is the world; a name defined anywhere in it
 * counts as defined everywhere.
 */

/** Definitions: `--name:` at the start of a declaration. */
const DEFINED = /(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g;
/** Uses: `var(--name)` — and whether a fallback follows the name. */
const USED = /var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g;
/** A name handed to CSS from script is defined, just not in a stylesheet. */
const FROM_JS = /setProperty\(\s*['"`](--[A-Za-z0-9_-]+)/g;
/** Inline styles in a page are part of that page's CSS. */
const STYLE_TAGS = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** Comments hold examples and dead rules; neither defines anything. */
const uncommented = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** The CSS in a source file: a stylesheet whole, a page's <style> blocks only. */
function cssOf(rel, text) {
  if (!/\.html?$/i.test(rel)) return uncommented(text);
  // Everything outside a <style> is blanked rather than dropped, so a line
  // number in the result is still a line number in the file.
  let out = text.replace(/[^\n]/g, ' ');
  for (const m of text.matchAll(STYLE_TAGS)) {
    const at = m.index + m[0].indexOf(m[1]);
    out = out.slice(0, at) + uncommented(m[1]) + out.slice(at + m[1].length);
  }
  return out;
}

/**
 * Every `var(--x)` in `sources` with no `--x` defined anywhere in them and no
 * fallback of its own.
 *
 * @param {{rel: string, text: string}[]} sources every file of one app that
 *   holds CSS — stylesheets, pages with inline <style>, and any script that
 *   sets a property, which defines names without declaring them.
 * @returns {{rel: string, line: number, name: string}[]}
 */
export function checkCss(sources = []) {
  const files = sources.map(({ rel, text }) => ({ rel, css: cssOf(rel, String(text ?? '')) }));

  const defined = new Set();
  for (const { css } of files) for (const m of css.matchAll(DEFINED)) defined.add(m[1]);
  for (const { text } of sources) for (const m of String(text ?? '').matchAll(FROM_JS)) defined.add(m[1]);

  const problems = [];
  const seen = new Set();
  for (const { rel, css } of files) {
    for (const m of css.matchAll(USED)) {
      const [, name, next] = m;
      if (next === ',') continue;            // it carries its own fallback
      if (defined.has(name)) continue;
      const key = `${rel}:${name}`;
      if (seen.has(key)) continue;           // once per name per file, not once per use
      seen.add(key);
      problems.push({ rel, name, line: css.slice(0, m.index).split('\n').length });
    }
  }
  return problems;
}
