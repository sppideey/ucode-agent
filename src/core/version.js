/**
 * version.js — the version, read from package.json rather than typed twice.
 *
 * package.json always ships in an npm package, so this is right wherever ucode
 * is installed, and it can never drift from what `npm publish` released.
 */

import { readFileSync } from 'node:fs';

export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '';
  }
})();
