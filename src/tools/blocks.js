/**
 * blocks.js — pieces of an app that are already right.
 *
 * A model writing a table from scratch writes a passable one: no empty state,
 * no sort, numbers left-aligned, and nothing that works on a phone. It is not
 * that it cannot do better, it is that doing better costs steps and attention
 * that belong to the thing being built.
 *
 * These are the parts every app needs, written once and carefully: a shell, a
 * page header, an empty state, a table, a row of stats. They are copied into
 * the app as ordinary source files for the model to edit, not imported from a
 * library it cannot change.
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

export const BLOCK_NAMES = Object.keys(CATALOGUE);

const listing = () =>
  BLOCK_NAMES.map((name) => `  ${name} — ${CATALOGUE[name].what}`).join('\n');

/**
 * Copy a block into an app, or list what there is. The file lands in
 * src/components/blocks/ and is the app's to edit from then on.
 */
export async function addBlock({ name, folder = '.' }) {
  const wanted = String(name ?? '').trim();

  if (!wanted) {
    return result(
      `Blocks you can add, with add_block({ name, folder }):\n\n${listing()}\n\n` +
      'Each one is copied into the app as a source file you can then edit.',
      `${BLOCK_NAMES.length} blocks`
    );
  }

  if (!CATALOGUE[wanted]) {
    throw new ToolFailure({
      kind: 'no_such_block',
      attempted: `adding the "${wanted}" block`,
      failed: `There is no block called "${wanted}".`,
      fix: `Pick one of: ${BLOCK_NAMES.join(', ')}. Call add_block with no name to see what each is for.`,
    });
  }

  const target = resolveIn(folder || '.', 'add_block', 'folder');
  await guard(target, `add the ${wanted} block to ${target.abs}`);

  const source = await fs.readFile(path.join(BLOCKS, `${wanted}.tsx`), 'utf8').catch(() => null);
  if (source === null) {
    throw new ToolFailure({
      kind: 'block_missing',
      attempted: `adding the "${wanted}" block`,
      failed: `The ${wanted} block is listed but its file is not installed.`,
      fix: 'Write the component by hand, or reinstall ucode.',
    });
  }

  const rel = path.join('src', 'components', 'blocks', `${wanted}.tsx`);
  const dest = path.join(target.abs, rel);

  if (await fs.stat(dest).catch(() => null)) {
    return result(
      `${rel} is already in ${target.show}; it has been left as it is so your edits survive.\n` +
      `Import: import { ${CATALOGUE[wanted].exports.split(',')[0].trim()} } from "@/components/blocks/${wanted}";`,
      'already there'
    );
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, source, 'utf8');

  const first = CATALOGUE[wanted].exports.split(',')[0].trim();
  return result(
    `Added ${rel} to ${target.show}.\n\n` +
    `import { ${CATALOGUE[wanted].exports} } from "@/components/blocks/${wanted}";\n\n` +
    `${CATALOGUE[wanted].use}\n\n` +
    `It is an ordinary file now — edit it to suit the app rather than working around it. ` +
    `It uses the shadcn components already in the starter, so nothing needs installing.`,
    `${first} added`
  );
}
