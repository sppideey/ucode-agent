// SPDX-License-Identifier: AGPL-3.0-only - ucode, made and tested by om dixit. Additional terms: see NOTICE.
/**
 * genericcheck.js — the generated look, caught in code.
 *
 * The rules against it were already written down, in the system prompt and
 * the ui-ux skill: not the starter's palette, not Inter at every size, not a
 * purple-to-blue gradient, not emoji standing in for icons. Flash-Lite reads
 * them and ships the starter's teal anyway. A rule the model can skip is a
 * suggestion; a check that hands the problem back is a rule.
 *
 * Everything here is a few regular expressions over files already on disk —
 * milliseconds, no model call. Only a hit costs anything: one fix round.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** The starter's own accent, which means nobody chose one. */
const STARTER = {
  'plain-html': { files: ['styles.css'], token: /--accent\s*:\s*#2dd4bf\b/i },
  'next-shadcn': { files: ['src/app/globals.css'], token: /--primary\s*:\s*oklch\(\s*0\.53\s+0\.2\s+264\s*\)/i },
};

/** Files that carry a Next.js app's look. */
const LOOK_FILES = {
  'next-shadcn': ['src/app/globals.css', 'src/app/layout.tsx', 'src/app/page.tsx'],
};

const NAMED = {
  purple: 300, violet: 300, indigo: 275, blueviolet: 271, mediumpurple: 260, rebeccapurple: 270,
  darkviolet: 282, slateblue: 248, mediumslateblue: 249, darkslateblue: 248, magenta: 300, fuchsia: 300,
  blue: 240, royalblue: 225, mediumblue: 240, dodgerblue: 210, cornflowerblue: 219,
};

/** Hue in degrees of one colour, or null for a grey or something unreadable. */
export function hueOf(colour) {
  const c = String(colour).trim().toLowerCase();
  if (NAMED[c] !== undefined) return NAMED[c];

  let r; let g; let b;
  const hex = /^#([0-9a-f]{3,8})$/.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((x) => x + x).join('');
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (rgb) [r, g, b] = rgb.slice(1, 4).map((v) => Number(v) / 255);
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%/.exec(c);
  if (hsl) return Number(hsl[2]) < 25 ? null : Number(hsl[1]) % 360;
  const lch = /^oklch\(\s*[\d.]+%?\s+([\d.]+)\s+([\d.]+)/.exec(c);
  // oklch puts blue near 264 and purple near 300-310; shift to the same wheel as hsl.
  if (lch) return Number(lch[1]) < 0.06 ? null : (Number(lch[2]) - 25 + 360) % 360;
  if (r === undefined) return null;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const light = (max + min) / 2;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * light - 1));
  if (sat < 0.25) return null;
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return Math.round((hue * 60 + 360) % 360);
}

/** Every gradient's argument list, brackets balanced. */
function gradients(css) {
  const found = [];
  const re = /(?:linear|radial|conic)-gradient\(/gi;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth; i++) {
      if (css[i] === '(') depth++;
      else if (css[i] === ')') depth--;
    }
    found.push(css.slice(re.lastIndex, i - 1));
  }
  return found;
}

const COLOUR = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch)\([^)]*\)|\b[a-z]+\b/gi;

/** The purple-to-blue gradient: every coloured stop blue-to-purple, at least one of them purple. */
export function purpleGradient(css) {
  return gradients(css).some((args) => {
    const hues = (args.match(COLOUR) ?? []).map(hueOf).filter((h) => h !== null);
    return hues.length >= 2 && hues.every((h) => h >= 200 && h <= 330) && hues.some((h) => h >= 250);
  });
}

/**
 * The files that make up the page. For a plain page that is index.html and
 * whatever it actually links: a starter stylesheet left behind, unlinked,
 * says nothing about how the app looks.
 */
async function lookFiles(dir, template) {
  if (template !== 'plain-html') return LOOK_FILES[template] ?? [];
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8').catch(() => '');
  const linked = [...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)\s*=\s*["']([^"'?#]+)/gi)]
    .map((m) => m[1])
    .filter((f) => !/^(?:[a-z]+:)?\/\//i.test(f) && /\.(?:css|m?js)$/i.test(f));
  return ['index.html', ...new Set(linked)];
}

/** Problems with the look of the app in `dir`, as lines for the model. Never throws. */
export async function genericLook(dir, template = 'plain-html') {
  const files = await lookFiles(dir, template);
  const texts = await Promise.all(files.map((f) => fs.readFile(path.join(dir, f), 'utf8').catch(() => '')));
  const all = texts.join('\n');
  if (!all.trim()) return [];

  const problems = [];
  const starter = STARTER[template];
  if (starter) {
    const own = starter.files.filter((f) => files.includes(f) || template !== 'plain-html');
    const texts2 = await Promise.all(own.map((f) => fs.readFile(path.join(dir, f), 'utf8').catch(() => '')));
    if (texts2.some((t) => starter.token.test(t))) {
      problems.push('The accent is still the starter\'s own colour, so the app looks like every other one built from it. Pick an accent for this app and set it in the tokens.');
    }
  }
  if (/font-family\s*:\s*["']?Inter["']?\s*[,;}]|--font-[\w-]+\s*:\s*["']?Inter["']?\s*[,;]|family=Inter(?![+\w])|import\s*\{[^}]*\bInter\b[^}]*\}\s*from\s*["']next\/font\/google/i.test(all)) {
    problems.push('The type is Inter, the default of generated apps. Choose a typeface with a character that fits this app.');
  }
  if (purpleGradient(all)) {
    problems.push('There is a purple-to-blue gradient, the most recognisable mark of a generated design. Use the app\'s own accent, flat or with a quiet tint.');
  }
  if (/(?:-webkit-)?background-clip\s*:\s*text/i.test(all)) {
    problems.push('There is gradient text (background-clip: text). Set headings in a solid colour and let the type carry them.');
  }
  const emoji = all.match(/<(?:button|h[1-6])\b[^>]*>\s*\p{Extended_Pictographic}/gu) ?? [];
  if (emoji.length >= 3) {
    problems.push(`Emoji stand in for icons in ${emoji.length} buttons or headings. Use small inline SVG icons or plain words.`);
  }
  return problems;
}

/** The fix-round text for a list of look problems. */
export function genericMessage(problems) {
  return 'ucode checked the design for the generated look and found:\n' +
    problems.map((p) => `- ${p}`).join('\n') +
    '\nFix these in the design tokens and styles only - a new accent, a new typeface. Do not ' +
    'restructure the app or change what it does.';
}
