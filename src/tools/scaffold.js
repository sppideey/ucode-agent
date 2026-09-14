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
import { batchWrite } from './files.js';
import { packageJsonWritten, installIn } from './shell.js';
import { restore, populate } from './cache.js';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

/** npm silently drops these two names from published packages, so they ship renamed. */
const RENAME = { _gitignore: '.gitignore', '_package-lock.json': 'package-lock.json' };

/** Files the placeholders are filled into. Everything else is copied byte for byte. */
const TEXT = /\.(?:json|md|mjs|css|html|jsx?|tsx?)$/i;

export const TEMPLATE_NAMES = ['next-shadcn', 'plain-html'];

/**
 * Which of a starter's files come back inside the result, in full.
 *
 * Reading a file ucode just copied is a whole round trip spent learning what
 * it already had on disk, and a round trip is ten to forty seconds. The
 * three-file starter is small enough to hand over outright; the Next.js one
 * is a hundred files and its guide has to do that job instead.
 */
const SHOW_BACK = { 'plain-html': ['index.html', 'styles.css', 'app.js'] };

/**
 * The files argument, however it was written.
 *
 * A list of `{ path, content }` is what the schema asks for, and it is what
 * arrives most of the time. The rest of the time it is a JSON string, or a
 * `{ "todo/app.js": "..." }` map, or the same list with the keys named
 * something adjacent. Each of those, refused, is a round trip spent being
 * told what could have been read — so they are all read.
 */
function normaliseFiles(files) {
  let value = files;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!value || typeof value !== 'object') return [];

  const entries = Array.isArray(value)
    ? value
    : Object.entries(value).map(([path, content]) => ({ path, content }));

  return entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const path = entry.path ?? entry.file ?? entry.filename ?? entry.name;
    const content = entry.content ?? entry.contents ?? entry.text ?? entry.body ?? entry.source;
    return { ...entry, path, content };
  });
}

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
 * Give the new app its look: one of the hand-picked presets in the starter's
 * presets/ folder — a full light and dark palette and a font — written into
 * globals.css and layout.tsx. Apps stop looking like the same default blue.
 * Returns the preset used, or null when the starter has none.
 */
/**
 * The file in each starter that carries the design, not just some of the rules.
 *
 * next-shadcn has globals.css, which applyDesign re-tints. plain-html has one
 * stylesheet and it is the whole design system: the palette, a spacing scale,
 * radii, motion timings, focus rings, a reduced-motion rule and a breakpoint.
 */
const TOKEN_FILE = { 'plain-html': 'styles.css' };

/**
 * Put the starter's token block back when the app wrote over it without one.
 *
 * The stylesheet in plain-html is a design, not a placeholder — but `files`
 * lands straight on top of the starter, so a model passing its own styles.css
 * replaces the scale, the palette and the timings with whatever it typed. What
 * comes back is hand-rolled CSS with no system behind it, and an app built on
 * raw pixel values has uneven spacing everywhere for the rest of its life.
 *
 * A replacement that declares its own custom properties is left alone: that is
 * a model doing the job properly, and second-guessing it would be worse. Only
 * a stylesheet with no :root variables at all gets the starter's block put
 * back above it, where every rule underneath can reach it.
 */
const ASSET_REF = /\b(href|src)=("|')(?!https?:|\/\/|\/|data:|#|mailto:|tel:)([^"']+)\2/g;

/**
 * Take the app's own folder back out of its own links.
 *
 * create_app wants paths relative to the project root — "todo/index.html" —
 * because that is where every other file tool works from. The model then
 * carries the same prefix into the markup and writes
 * <link href="todo/styles.css"> inside todo/index.html, where it resolves to
 * todo/todo/styles.css and 404s. The page comes up as bare markup with no
 * stylesheet and no script: no design, no behaviour, nothing in the console
 * but two failed requests.
 *
 * It is the tool's own convention leaking into the file, so the tool takes it
 * back out. Only a leading "<folder>/" on a relative reference, which inside
 * that folder is always wrong — absolute paths, URLs, data: and anchors are
 * left exactly as they are.
 */
async function unprefixOwnFolder(appDir, written) {
  const prefix = `${path.basename(appDir)}/`;
  const fixed = [];

  for (const abs of written) {
    if (!/\.html?$/i.test(abs)) continue;
    const text = await fs.readFile(abs, 'utf8').catch(() => null);
    if (text === null) continue;

    let hits = 0;
    const next = text.replace(ASSET_REF, (all, attr, quote, value) => {
      if (!value.startsWith(prefix)) return all;
      hits++;
      return `${attr}=${quote}${value.slice(prefix.length)}${quote}`;
    });

    if (hits) {
      await fs.writeFile(abs, next, 'utf8');
      fixed.push(`${path.relative(appDir, abs).split(path.sep).join('/')} (${hits})`);
    }
  }
  return fixed;
}

/**
 * Files that legitimately sit at the root of a Next.js project.
 *
 * Everything else a model writes there is app code that has missed src/.
 */
const NEXT_ROOT = /^(?:package(?:-lock)?\.json|next\.config\.[mc]?[jt]s|tsconfig\.json|postcss\.config\.[mc]?js|eslint\.config\.[mc]?js|components\.json|README\.md|TEMPLATE\.md|\.gitignore|next-env\.d\.ts)$/i;

/**
 * Put Next.js files where Next.js looks for them.
 *
 * Routing is folder-based and unforgiving: a page is a route only at
 * src/app/<segment>/page.tsx. A traced build wrote page.tsx at the project
 * root and api/expenses/route.ts beside it — the build passed, every route
 * 404ed, and nothing said why.
 *
 * The guide has the tree in it, and the guide cannot help: it comes back
 * inside the create_app result, and the model chooses these paths in the call
 * that produces that result. It is reading the map after it has parked. So the
 * paths are corrected on the way in, and the result says what moved and why,
 * which is the copy that arrives in time to matter for the next file.
 *
 * Only for next-shadcn, only for files under the app folder, and never for the
 * config files that genuinely belong at the root.
 */
function placeForNext(files, folder) {
  const moved = [];

  const out = files.map((f) => {
    const rel = String(f.path ?? '').split('\\').join('/');
    const prefix = `${folder}/`;
    if (!rel.startsWith(prefix)) return f;

    const inside = rel.slice(prefix.length);
    if (!inside || inside.startsWith('src/') || inside.startsWith('public/')) return f;
    if (NEXT_ROOT.test(inside)) return f;

    // app/... is the right tree written one level too high; everything else
    // that is app code belongs under src/ as it stands.
    const under = inside.startsWith('app/') ? `src/${inside}` : `src/app/${inside}`;
    const isRoute = /(?:^|\/)(?:page|layout|loading|error|not-found)\.[jt]sx?$/.test(inside)
      || /(?:^|\/)route\.[jt]s$/.test(inside);
    const isCode = /^(?:components|lib|hooks|styles|utils)\//.test(inside);

    if (!isRoute && !isCode) return f;
    const to = isCode ? `${prefix}src/${inside}` : `${prefix}${under}`;
    if (to === rel) return f;

    moved.push(`${inside} -> ${to.slice(prefix.length)}`);
    return { ...f, path: to };
  });

  return { files: out, moved };
}

async function keepDesignTokens(appDir, template, written, starterCss) {
  const rel = TOKEN_FILE[template];
  if (!rel || !starterCss) return null;

  const abs = path.join(appDir, rel);
  if (!written.has(abs)) return null;                 // never overwritten

  const now = await fs.readFile(abs, 'utf8').catch(() => null);
  if (now === null || /:root\s*\{[^}]*--/.test(now)) return null;

  const block = /:root\s*\{[\s\S]*?\n\}/.exec(starterCss);
  if (!block) return null;

  await fs.writeFile(abs, `${block[0]}\n\n${now}`, 'utf8');
  return rel;
}

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

/**
 * Start an app, and — when the model passes them — write its files in the
 * same call.
 *
 * @param {object} o
 * @param {string} o.folder        new, empty folder for the app
 * @param {string} o.name          display name, e.g. "Stride"
 * @param {string} [o.description]
 * @param {string} [o.template]    defaults to plain-html: nothing to install
 * @param {string} [o.design]
 * @param {{path: string, content: string}[]} [o.files]  the app itself, paths
 *   relative to the project root, written straight over the starter's
 * @param {boolean} [o.install]    start the background install (tests turn it off)
 */
export async function createApp({ folder, name, description, template = 'plain-html', design, files, install = true }) {
  if (!TEMPLATE_NAMES.includes(template)) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'creating an app',
      failed: `There is no starter called "${template}".`,
      fix: `Use one of: ${TEMPLATE_NAMES.join(', ')}.`,
    });
  }

  // Every shape a model reaches for when handing over a set of files. Reading
  // them all costs nothing; refusing them costs a round trip each, which is
  // the whole reason this argument exists.
  const given = normaliseFiles(files);

  // Checked before anything is copied: a bad entry found halfway through
  // would leave the folder created, and the retry would then be refused for
  // already having files in it.
  const bad = given.findIndex(
    (f) => typeof f?.path !== 'string' || typeof f?.content !== 'string'
  );
  if (bad !== -1) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'creating an app',
      failed: `Entry ${bad + 1} of "files" is missing "path" or "content" — both must be strings.`,
      fix: 'Fix that entry and call create_app again. Nothing has been created yet.',
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
  // A folder with something already in it, and the whole app passed in
  // alongside: that is the second attempt at a build that half happened.
  // Refusing it is how a Next.js build spent two calls being told no and then
  // started over from nothing. The starter is already on disk — take the files
  // and write them into it.
  //
  // With no files it is still a refusal, because then there is nothing to do
  // but copy a starter over work that is already there.
  const adopt = existing.length > 0 && given.length > 0;
  if (existing.length && !adopt) {
    throw new ToolFailure({
      kind: 'not_empty',
      attempted,
      failed: `${target.show} already has ${existing.length} item(s) in it: ${existing.slice(0, 5).join(', ')}.`,
      fix: 'Pick a new folder name, or pass the app in "files" to write it into the folder that is already there.',
    });
  }

  const display = plain(name) || path.basename(target.abs);
  const fill = {
    __APP_NAME__: display,
    __APP_SLUG__: slug(display),
    __APP_DESCRIPTION__: plain(description) || display,
  };

  const copied = adopt ? [] : await copyTree(path.join(TEMPLATES, template), target.abs, fill);
  // Next.js serves static files from public/; a plain page has no such place
  // and an empty folder in a three-file app is clutter.
  if (!adopt && template !== 'plain-html') await fs.mkdir(path.join(target.abs, 'public'), { recursive: true });
  const look = await applyDesign(target.abs, design);

  // Read before the app's own files land on top of it, so the tokens can be
  // put back if the replacement arrives without any.
  const starterCss = TOKEN_FILE[template]
    ? await fs.readFile(path.join(target.abs, TOKEN_FILE[template]), 'utf8').catch(() => null)
    : null;

  // The starter has been installed on this machine before: hard-link that
  // tree in, which is seconds where npm is a minute. Otherwise install as
  // usual, and keep the result so the next app is instant.
  let linked = 0;
  const needsInstall = !adopt && template !== 'plain-html';
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

  // The app's own files, written in this same call. Two round trips become
  // one, and round trips are nearly all of the time a build takes.
  // Next.js only: paths that have missed src/ are corrected before they land.
  const placed = template === 'next-shadcn' ? placeForNext(given, path.basename(target.abs)) : { files: given, moved: [] };
  const mine = placed.files;
  const wrote = mine.length ? await batchWrite({ files: mine }) : null;
  const written = new Set(mine.map((f) => resolveIn(f.path, 'create_app', 'files').abs));
  const keptTokens = await keepDesignTokens(target.abs, template, written, starterCss);
  const relinked = await unprefixOwnFolder(target.abs, written);

  // The starter's own files, in full, so there is never a reason to read them
  // back — and only the ones this call did not already write over. A read is
  // another round trip to learn what ucode already knows.
  const starter = [];
  for (const rel of SHOW_BACK[template] ?? []) {
    const abs = path.join(target.abs, rel);
    if (written.has(abs)) continue;
    const text = await fs.readFile(abs, 'utf8').catch(() => null);
    if (text !== null) starter.push(`=== ${target.show}/${rel} ===\n${text}`);
  }

  const out = result(
    `Created ${target.show} from the ${template} starter — ${copied.length} files, already known to build.\n` +
      (look ? `Design: the ${look.name} preset (${look.summary}), font ${look.fonts?.sans ?? 'Geist'}.\n` : '') +
      (wrote ? `\nYour ${mine.length} file${mine.length === 1 ? '' : 's'}:\n${wrote.content}\n` : '') +
      (placed.moved.length
        ? `\nMoved into place: ${placed.moved.join(', ')}. In Next.js a page is only a route at `
          + 'src/app/<segment>/page.tsx, an API handler only at src/app/api/<name>/route.ts, and '
          + 'components and libraries live under src/. A file written outside src/ builds fine and '
          + 'is never served, which is the hardest kind of wrong to notice. Write the rest there '
          + 'directly.\n'
        : '') +
      (relinked.length
        ? `\nFixed in ${relinked.join(', ')}: links that began with "${path.basename(target.abs)}/". ` +
          'Paths in "files" are relative to the project root, but a link inside a page is ' +
          'relative to that page — so "index.html" beside "styles.css" links to it as ' +
          '"styles.css", never "app/styles.css". Written that way the stylesheet and the ' +
          'script 404 and the page comes up as bare markup.\n'
        : '') +
      (keptTokens
        ? `\nYour ${keptTokens} arrived with no :root block, so the starter's was kept above it — ` +
          'the palette, the spacing scale (--s1 to --s5), the radius and the motion timings. ' +
          'Build the rest of the stylesheet out of those variables: spacing that comes from a ' +
          'scale is the difference between a designed page and an arranged one. Re-tint the ' +
          'values to suit this app; do not go back to raw pixels.\n'
        : '') +
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
          `folder with "python -m http.server 8000" if it fetches anything.\n\n${guide}`) +
      (starter.length
        ? `\n\nThe starter's files, in full — they are below, so do not read them back:\n\n${starter.join('\n\n')}`
        : ''),
    `${copied.length} files${wrote ? ` · ${mine.length} written` : ''}` +
      `${linked ? ' · packages ready' : install && needsInstall ? ' · installing in the background' : ''}`,
    24_000
  );
  if (wrote?.diff?.length) out.diff = wrote.diff;
  return out;
}
