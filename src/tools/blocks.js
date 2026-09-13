/**
 * blocks.js — pieces of an app that are already right.
 *
 * A model writing a table from scratch writes a passable one: no empty state,
 * no sort, numbers left-aligned, and nothing that works on a phone. It is not
 * that it cannot do better, it is that doing better costs steps and attention
 * that belong to the thing being built.
 *
 * It also costs time in the plainest sense. Typing is the slowest part of a
 * build — a few thousand tokens at forty a second — so a list, a filter row
 * and a store that arrive written are a minute the user does not wait.
 *
 * Two sets, because the two starters have nothing in common: React and shadcn
 * components for next-shadcn, and plain ES modules with no imports at all for
 * plain-html. Which one you get is decided by the app the block is going into,
 * not by an argument the model has to remember.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolFailure } from '../core/failure.js';
import { resolveIn, guard, result } from './shared.js';

const BLOCKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'blocks');

/** What each block is for, and what it needs to be handed. */
export const CATALOGUE = {
  'app-shell': {
    what: 'The frame every page sits in: sidebar on desktop, the same nav behind a button on a phone.',
    exports: 'AppShell',
    use: '<AppShell title="Stride" nav={[{ href: "/", label: "Home" }]} current="/">…</AppShell>',
  },
  'page-header': {
    what: 'The top of a page: title, a line about it, and the actions available here.',
    exports: 'PageHeader',
    use: '<PageHeader title="Invoices" description="Everything you have billed." actions={<Button>New</Button>} />',
  },
  'empty-state': {
    what: 'What a list looks like before anything is in it, with the one action that fills it.',
    exports: 'EmptyState',
    use: '<EmptyState title="No invoices yet" description="They will appear here." actionLabel="New invoice" />',
  },
  'data-table': {
    what: 'A table you can search and sort, with an empty state and numbers aligned right.',
    exports: 'DataTable, Column',
    use: '<DataTable rows={rows} columns={[{ key: "name", header: "Name" }, { key: "total", header: "Total", numeric: true }]} />',
  },
  'stat-cards': {
    what: 'The row of numbers at the top of a dashboard, each with what it is measured against.',
    exports: 'StatCards, Stat',
    use: '<StatCards stats={[{ label: "Revenue", value: "£12,400", change: 8 }]} />',
  },
};

/**
 * The same idea for a page with no build step: plain ES modules that import
 * nothing, style themselves from the starter's CSS variables, and are ordinary
 * files the moment they land.
 */
export const PLAIN_CATALOGUE = {
  'item-list': {
    what: 'A list of things you can add, tick off, rename and remove — a to-do list, a shopping list, saved items. Keyboard throughout, empty state, a count.',
    exports: 'ItemList',
    use: `const list = ItemList({
  items: store.state.items,
  onChange: (items) => store.set({ items }),
  placeholder: 'Add a task',
});
document.querySelector('#app').append(list.el);`,
  },
  'filter-bar': {
    what: 'A row of filters — All / Active / Done — as real buttons in a labelled group, one tab stop, arrow keys between them.',
    exports: 'FilterBar',
    use: `const filters = FilterBar({
  options: [{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }],
  value: 'all',
  onChange: (value) => { state.filter = value; render(); },
});`,
  },
  store: {
    what: 'State in one place, saved to localStorage, and the same in every open tab. Survives private mode, a full quota and a value written by an older version.',
    exports: 'createStore',
    use: `const store = createStore('tide', { items: [], filter: 'all' });
store.subscribe(render);
store.update((s) => ({ items: [...s.items, task] }));`,
  },
  modal: {
    what: 'A dialog that behaves like one: Escape closes it, focus is trapped inside and returns to the opener. Built on the browser\'s own <dialog>.',
    exports: 'Modal',
    use: `const confirm = Modal({ title: 'Delete this?', danger: true, onConfirm: remove });
document.body.append(confirm.el);
button.addEventListener('click', () => confirm.open());`,
  },
  toast: {
    what: 'A short message that appears, is read out by a screen reader, and goes away. Stacks, caps itself, pauses under the pointer.',
    exports: 'toast',
    use: `toast('Saved');
toast.error('Could not reach the server');
toast('Deleted', { action: { label: 'Undo', onClick: undo } });`,
  },
  'theme-toggle': {
    what: 'Light and dark: follows the operating system until the user chooses, remembers the choice, and applies it before the first paint so nothing flashes.',
    exports: 'ThemeToggle, applyTheme, currentTheme',
    use: `applyTheme();                    // the first line of app.js
header.append(ThemeToggle().el);`,
  },
};

export const BLOCK_NAMES = Object.keys(CATALOGUE);
export const PLAIN_BLOCK_NAMES = Object.keys(PLAIN_CATALOGUE);
export const ALL_BLOCK_NAMES = [...new Set([...PLAIN_BLOCK_NAMES, ...BLOCK_NAMES])];

const exists = (p) => fs.stat(p).then(() => true, () => false);

/**
 * Which set this app takes.
 *
 * A page with an index.html and nothing to install is the plain starter; a
 * folder with a package.json is React. Asked rather than argued about, so
 * the model cannot pick the wrong one.
 */
async function kindOf(dir) {
  if (await exists(path.join(dir, 'package.json'))) return 'react';
  if (await exists(path.join(dir, 'index.html'))) return 'plain';
  return 'react';
}

const listing = (catalogue) =>
  Object.keys(catalogue).map((name) => `  ${name} — ${catalogue[name].what}`).join('\n');

/**
 * Copy a block into an app, or list what there is. React blocks land in
 * src/components/blocks/, plain ones in blocks/, and either way the file is
 * the app's to edit from then on.
 */
export async function addBlock({ name, folder = '.' }) {
  const wanted = String(name ?? '').trim();
  const target = resolveIn(folder || '.', 'add_block', 'folder');
  const kind = await kindOf(target.abs);
  const catalogue = kind === 'plain' ? PLAIN_CATALOGUE : CATALOGUE;
  const names = Object.keys(catalogue);

  if (!wanted) {
    return result(
      `Blocks for ${target.show} (${kind === 'plain' ? 'a page with no build step' : 'React and shadcn'}), ` +
      `with add_block({ name, folder }):\n\n${listing(catalogue)}\n\n` +
      'Each one is copied in as a source file you can then edit.',
      `${names.length} blocks`
    );
  }

  if (!catalogue[wanted]) {
    const other = kind === 'plain' ? CATALOGUE : PLAIN_CATALOGUE;
    throw new ToolFailure({
      kind: 'no_such_block',
      attempted: `adding the "${wanted}" block`,
      failed: other[wanted]
        ? `"${wanted}" is a ${kind === 'plain' ? 'React' : 'plain-page'} block, and ${target.show} is ${kind === 'plain' ? 'a plain page' : 'a React app'}.`
        : `There is no block called "${wanted}".`,
      fix: `For ${target.show}, pick one of: ${names.join(', ')}. Call add_block with no name to see what each is for.`,
    });
  }

  await guard(target, `add the ${wanted} block to ${target.abs}`);

  const from = kind === 'plain'
    ? path.join(BLOCKS, 'plain', `${wanted}.js`)
    : path.join(BLOCKS, `${wanted}.tsx`);
  const source = await fs.readFile(from, 'utf8').catch(() => null);
  if (source === null) {
    throw new ToolFailure({
      kind: 'block_missing',
      attempted: `adding the "${wanted}" block`,
      failed: `The ${wanted} block is listed but its file is not installed.`,
      fix: 'Write it by hand, or reinstall ucode.',
    });
  }

  const rel = kind === 'plain'
    ? path.join('blocks', `${wanted}.js`)
    : path.join('src', 'components', 'blocks', `${wanted}.tsx`);
  const dest = path.join(target.abs, rel);
  const importLine = kind === 'plain'
    ? `import { ${catalogue[wanted].exports} } from './blocks/${wanted}.js';`
    : `import { ${catalogue[wanted].exports} } from "@/components/blocks/${wanted}";`;

  if (await exists(dest)) {
    return result(
      `${rel} is already in ${target.show}; it has been left as it is so your edits survive.\n${importLine}`,
      'already there'
    );
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, source, 'utf8');

  const first = catalogue[wanted].exports.split(',')[0].trim();
  return result(
    `Added ${rel} to ${target.show}.\n\n${importLine}\n\n${catalogue[wanted].use}\n\n` +
    'It is an ordinary file now — edit it to suit the app rather than working around it. ' +
    (kind === 'plain'
      ? 'It imports nothing and styles itself from the CSS variables already in styles.css, so it works as it is.'
      : 'It uses the shadcn components already in the starter, so nothing needs installing.'),
    `${first} added`
  );
}
