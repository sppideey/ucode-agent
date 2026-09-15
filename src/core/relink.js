/**
 * relink.js — taking an app's own folder back out of its own links.
 *
 * create_app wants paths relative to the project root — "tide/index.html" —
 * because that is where every file tool works from. The model then carries the
 * same prefix into the markup and writes `<link href="tide/styles.css">` inside
 * tide/index.html, where it resolves to tide/tide/styles.css and 404s. The page
 * comes up as bare markup: no stylesheet, no script, dead buttons. It is the
 * commonest way a finished build looks like nothing was built.
 *
 * It lived inside create_app first, which covered only the files that call was
 * handed. An app written across a scaffold and two edits put the prefix back on
 * the next write and nothing was watching, so it runs over every changed page
 * now, on every turn, wherever the page came from.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeTracked } from '../tools/shared.js';

/** Relative href/src only — absolute paths, URLs, data: and anchors are left alone. */
const ASSET_REF = /\b(href|src)=("|')(?!https?:|\/\/|\/|data:|#|mailto:|tel:)([^"']+)\2/g;

/**
 * Strip a page's own folder from its relative links.
 *
 * `files` are paths relative to `root`. A page at "tide/index.html" has "tide/"
 * taken off its links, because inside that folder the prefix is always wrong.
 * A page sitting directly in the root has no folder to strip and is skipped.
 *
 * Returns the pages it changed, for reporting. Never throws: a file that cannot
 * be read is a file that is left exactly as it is.
 */
export async function unprefixOwnFolder(root, files) {
  const fixed = [];

  for (const rel of files) {
    if (!/\.html?$/i.test(rel)) continue;

    const abs = path.resolve(root, rel);
    const folder = path.basename(path.dirname(abs));
    if (!folder || path.dirname(abs) === path.resolve(root)) continue;

    const text = await fs.readFile(abs, 'utf8').catch(() => null);
    if (text === null) continue;

    const prefix = `${folder}/`;
    let hits = 0;
    const next = text.replace(ASSET_REF, (all, attr, quote, value) => {
      if (!value.startsWith(prefix)) return all;
      hits++;
      return `${attr}=${quote}${value.slice(prefix.length)}${quote}`;
    });

    if (!hits) continue;
    try {
      await writeTracked(abs, next);
      fixed.push(`${rel} (${hits})`);
    } catch { /* unwritable: leave it, and say nothing that is not true */ }
  }

  return fixed;
}
