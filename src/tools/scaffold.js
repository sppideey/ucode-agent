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
import { packageJsonWritten } from './shell.js';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

/** npm silently drops these two names from published packages, so they ship renamed. */
const RENAME = { _gitignore: '.gitignore', '_package-lock.json': 'package-lock.json' };

/** Files the placeholders are filled into. Everything else is copied byte for byte. */
const TEXT = /\.(?:json|md|mjs|css|tsx?)$/i;

export const TEMPLATE_NAMES = ['next-shadcn'];

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
export async function createApp({ folder, name, description, template = 'next-shadcn', install = true }) {
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
  await fs.mkdir(path.join(target.abs, 'public'), { recursive: true });

  if (install) {
    const pkg = path.join(target.abs, 'package.json');
    packageJsonWritten(pkg, await fs.readFile(pkg, 'utf8'));
  }

  const guide = await fs.readFile(path.join(target.abs, 'TEMPLATE.md'), 'utf8').catch(() => '');

  return result(
    `Created ${target.show} from the ${template} starter — ${files.length} files, already known to build.\n` +
      (install
        ? `Its packages are installing in the background right now. Keep writing: any command you run in ` +
          `${target.show} waits for that install first, so there is no need to run npm install.\n`
        : '') +
      `Run this app's commands with cwd: "${target.show}" (npm run build, npm run dev).\n\n${guide}`,
    `${files.length} files${install ? ' · installing in the background' : ''}`
  );
}
