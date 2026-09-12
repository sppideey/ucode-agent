/**
 * htmlcheck.js — the JavaScript inside an HTML file is still JavaScript.
 *
 * A single-file app keeps everything in one <script>, and nothing was looking
 * at it: the checks run `node --check` on .js files and tsc on TypeScript
 * projects, so an index.html whose script does not parse passed every one of
 * them. The page renders, the CSS is right, and not one button works.
 *
 * The failure that prompted this: a model writing an HTML-escaping map inside
 * an HTML file produced `"'":'''` — three quotes, a syntax error, the whole
 * script dead. Everything looked finished.
 *
 * Parsing is Babel's, which ucode already carries. Only syntax is checked:
 * an undefined variable is a runtime problem and this is not the place for it.
 */

import { parse } from '@babel/parser';

/** Inline scripts worth parsing: not src=, not JSON, not a template. */
const SCRIPTS = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

const runnable = (attrs) => {
  if (/\bsrc\s*=/i.test(attrs)) return false;         // a separate file, checked on its own
  const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
  if (!type) return true;
  return type === 'module' || type === 'text/javascript' || type === 'application/javascript';
};

/**
 * Syntax errors in a file's inline scripts, with lines counted in the HTML
 * rather than in the extracted fragment — a line number that does not match
 * the file is worse than none.
 */
export function checkHtml(text) {
  const html = String(text ?? '');
  const problems = [];

  for (const match of html.matchAll(SCRIPTS)) {
    const [whole, attrs, body] = match;
    if (!runnable(attrs) || !body.trim()) continue;

    const before = html.slice(0, match.index + whole.indexOf(body));
    const offset = before.split('\n').length - 1;

    try {
      parse(body, {
        sourceType: 'module',          // accepts a plain script too
        allowReturnOutsideFunction: true,
        errorRecovery: false,
        plugins: ['topLevelAwait'],
      });
    } catch (err) {
      const line = (err.loc?.line ?? 1) + offset;
      problems.push({ line, message: String(err.message ?? err).replace(/\s*\(\d+:\d+\)$/, '') });
    }
  }

  return problems;
}
