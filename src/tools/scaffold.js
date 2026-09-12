/**
 * scaffold.js — starting an app from a starter that is known to work.
 *
 * Setting up a Next.js + shadcn project from nothing is four minutes of
 * create-next-app and shadcn CLI runs — measured at 116s and 130s — plus a
 * dozen model round trips to drive them and then theme the result. Every app
 * starts from the same place anyway, so ucode ships that place: a project
 * that has already been built and type-checked, copied in one step, with its
 * install starting in the background while the model writes the first
 * component.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolFailure } from '../core/failure.js';
import { resolveIn, guard, result } from './shared.js';
import { packageJsonWritten, installIn } from './shell.js';
import { restore, populate } from './cache.js';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

/** npm silently drops these two names from published packages, so they ship renamed. */
const RENAME = { _gitignore: '.gitignore', '_package-lock.json': 'package-lock.json' };

/** Files the placeholders are filled into. Everything else is copied byte for byte. */
const TEXT = /\.(?:json|md|mjs|css|html|jsx?|tsx?)$/i;

export const TEMPLATE_NAMES = ['next-shadcn', 'plain-html'];

/** What each starter is for, so the choice is made on purpose. */
export const TEMPLATE_NOTES = {
  'next-shadcn': 'Next.js, TypeScript, Tailwind and shadcn/ui. For anything with routes, data or many components.',
  'plain-html': 'One index.html, one stylesheet, one module. No install, no build, opens straight in a browser.',
};

function slug(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

/** Text that is safe inside a JS string and a JSON string. */
const plain = (s) => String(s ?? '').replace(/["'`\\<>]/g, '').replace(/\s+/g, ' ').trim();

async function copyTree(from, to, fill) {
  await fs.mkdir(to, { recursive: true });
  const copied = [];
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const name = RENAME[entry.name] ?? entry.name;
    const src = path.join(from, entry.name);
    const dest = path.join(to, name);
    if (entry.isDirectory()) {
      copied.push(...(await copyTree(src, dest, fill)).map((f) => `${name}/${f}`));
    } else if (TEXT.test(entry.name) || entry.name in RENAME) {
      let text = await fs.readFile(src, 'utf8');
      for (const [token, value] of Object.entries(fill)) text = text.split(token).join(value);
      await fs.writeFile(dest, text, 'utf8');
      copied.push(name);
    } else {
      await fs.copyFile(src, dest);
      copied.push(name);
    }
  }
  return copied;
}

/**
 * @param {object} o
 * @param {string} o.folder       new, empty folder for the app
 * @param {string} o.name         display name, e.g. "Stride"
 * @param {string} [o.description]
 * @param {string} [o.template]
 * @param {boolean} [o.install]   start the background install (tests turn it off)
 */
/**
 * Give the new app its look: one of the hand-picked presets in the starter's
 * presets/ folder — a full light and dark palette and a font — written into
 * globals.css and layout.tsx. Apps stop looking like the same default blue.
 * Returns the preset used, or null when the starter has none.
 */
export async function applyDesign(appDir, design) {
  const dir = path.join(appDir, 'presets');
  const names = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  if (!names.length) return null;
  const presets = await Promise.all(names.map(async (f) => JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))));
  await fs.rm(dir, { recursive: true, force: true }); // the app needs the result, not the catalogue
  const preset = presets.find((p) => p.name === design) ?? presets.find((p) => p.default) ?? presets[0];

  const cssFile = path.join(appDir, 'src', 'app', 'globals.css');
  let css = await fs.readFile(cssFile, 'utf8').catch(() => null);
  if (css !== null) {
    const retint = (selector, tokens) => {
      const block = new RegExp(`(${selector}\\s*\\{)([\\s\\S]*?)(\\n\\})`);
      css = css.replace(block, (all, open, body, close) => {
        const seen = new Set();
        let next = body.replace(/(\n\s*)--([\w-]+):\s*[^;]+;/g, (line, lead, key) => {
          if (!(key in tokens)) return line;
          seen.add(key);
          return `${lead}--${key}: ${tokens[key]};`;
        });
        for (const [key, value] of Object.entries(tokens)) if (!seen.has(key)) next += `\n  --${key}: ${value};`;
        return open + next + close;
      });
    };
    retint(':root', { radius: preset.radius, ...preset.light });
    retint('\\.dark', preset.dark);
    await fs.writeFile(cssFile, css);
  }

  const sans = preset.fonts?.sans;
  const layoutFile = path.join(appDir, 'src', 'app', 'layout.tsx');
  if (sans && sans !== 'Geist') {
    const id = sans.replace(/\s+/g, '_');
    const layout = await fs.readFile(layoutFile, 'utf8').catch(() => null);
    if (layout !== null) {
      await fs.writeFile(layoutFile, layout
        .replace('import { Geist, Geist_Mono } from "next/font/google";', `import { ${id}, Geist_Mono } from "next/font/google";`)
        .replace('const sans = Geist({', `const sans = ${id}({`));
    }
  }

  const guide = path.join(appDir, 'TEMPLATE.md');
  const text = await fs.readFile(guide, 'utf8').catch(() => null);
  if (text !== null) {
    await fs.writeFile(guide, `${text.trimEnd()}\n\n## Design\n\nThis app uses the **${preset.name}** preset — ` +
      `${preset.summary}. Font: ${sans ?? 'Geist'}. The palette lives in globals.css (light and dark): ` +
      'build with the tokens (bg-primary, text-muted-foreground, border, ...) rather than raw colours, ' +
      'so every screen stays in one look.\n');
  }
  return preset;
}

export async function createApp({ folder, name, description, template = 'next-shadcn', design, install = true }) {
  if (!TEMPLATE_NAMES.includes(template)) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'creating an app',
      failed: `There is no starter called "${template}".`,
      fix: `Use one of: ${TEMPLATE_NAMES.join(', ')}.`,
    });
  }

  const target = resolveIn(folder, 'create_app', 'folder');
  const attempted = `creating an app in ${target.show}`;
  if (target.show === '.') {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted,
      failed: 'The app needs its own folder, not the project root.',
      fix: 'Pass a new folder name, e.g. "stride".',
    });
  }
  await guard(target, `create an app in ${target.abs}`);

  let existing = [];
  try {
    existing = await fs.readdir(target.abs);
  } catch {
    existing = [];
  }
  if (existing.length) {
    throw new ToolFailure({
      kind: 'not_empty',
      attempted,
      failed: `${target.show} already has ${existing.length} item(s) in it: ${existing.slice(0, 5).join(', ')}.`,
      fix: 'Pick a new folder name. If this folder is the app from an earlier attempt, work in it instead of creating it again.',
    });
  }

  const display = plain(name) || path.basename(target.abs);
  const fill = {
    __APP_NAME__: display,
    __APP_SLUG__: slug(display),
    __APP_DESCRIPTION__: plain(description) || display,
  };

  const files = await copyTree(path.join(TEMPLATES, template), target.abs, fill);
  // Next.js serves static files from public/; a plain page has no such place
  // and an empty folder in a three-file app is clutter.
  if (template !== 'plain-html') await fs.mkdir(path.join(target.abs, 'public'), { recursive: true });
  const look = await applyDesign(target.abs, design);

  // The starter has been installed on this machine before: hard-link that
  // tree in, which is seconds where npm is a minute. Otherwise install as
  // usual, and keep the result so the next app is instant.
  let linked = 0;
  const needsInstall = template !== 'plain-html';
  if (install && needsInstall) {
    // Keyed on the starter's lockfile, which is the same for every app made
    // from it — the app's own is rewritten by npm as it installs.
    const lockText = await fs
      .readFile(path.join(TEMPLATES, template, '_package-lock.json'), 'utf8')
      .catch(() => null);
    linked = await restore(target.abs, template, lockText);
    if (!linked) {
      const pkg = path.join(target.abs, 'package.json');
      packageJsonWritten(pkg, await fs.readFile(pkg, 'utf8'));
      installIn(target.abs)?.then((done) => {
        if (done?.code === 0) populate(target.abs, template, lockText);
      });
    }
  }

  const guide = await fs.readFile(path.join(target.abs, 'TEMPLATE.md'), 'utf8').catch(() => '');

  return result(
    `Created ${target.show} from the ${template} starter — ${files.length} files, already known to build.\n` +
      (look ? `Design: the ${look.name} preset (${look.summary}), font ${look.fonts?.sans ?? 'Geist'}.\n` : '') +
      (linked
        ? `Its packages are already in place (${linked.toLocaleString()} files, linked from the starter cache) — ` +
          'nothing to install: build and run straight away.\n'
        : install && needsInstall
        ? `Its packages are installing in the background right now. Keep writing: any command you run in ` +
          `${target.show} waits for that install first, so there is no need to run npm install.\n`
        : '') +
      (needsInstall
        ? `Run this app's commands with cwd: "${target.show}" (npm run build, npm run dev).\n\n${guide}`
        : `Nothing to install and nothing to build: open ${target.show}/index.html directly, or serve the ` +
          `folder with "python -m http.server 8000" if it fetches anything.\n\n${guide}`),
    `${files.length} files${linked ? ' · packages ready' : install && needsInstall ? ' · installing in the background' : ''}`
  );
}
