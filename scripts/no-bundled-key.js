/**
 * Refuse to publish a build with an API key compiled into it.
 *
 * package.json is also marked private, but npm only enforces that when it
 * reaches the registry, so `npm publish --dry-run` sails straight past it.
 * This runs first, on every publish attempt, and exits non-zero — which makes
 * it the rail that can be tested before it is the rail that matters.
 *
 * A key in a published tarball is readable by everyone who installs the
 * package, is scraped from the registry within minutes, and survives an
 * unpublish in mirrors and caches. There is no version of that which is
 * recoverable, so this does not have an override flag: take the constant out.
 */

import { readFileSync } from 'node:fs';

if (readFileSync('src/core/provider.js', 'utf8').includes('BUNDLED_KEY')) {
  console.error(
    '\n  Refused: an API key is compiled into src/core/provider.js.'
    + '\n  Remove BUNDLED_KEY before publishing or committing — a key in a package'
    + '\n  is read by everyone who installs it, and a key in a commit is there for'
    + '\n  good the moment the branch is pushed.\n'
  );
  process.exit(1);
}
