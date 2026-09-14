/**
 * install-hooks.js — a pre-commit hook that keeps a bundled key out of git.
 *
 * scripts/no-bundled-key.js guards `npm publish`, and it works: it refused a
 * publish while a key was compiled in. But it only guards the registry. In the
 * same session a chain that used `;` where it meant `&&` ran the commit anyway,
 * and the key went into a local commit — caught by hand, a minute later, on a
 * repository that happens never to have been pushed.
 *
 * The registry is not the only way a secret leaves a machine. This closes the
 * other one.
 *
 * Run it with `npm run hooks`. It is deliberately not automatic: writing to
 * someone's .git on install is the sort of thing a package should ask for.
 */

import { writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

const HOOK = `#!/bin/sh
# Installed by scripts/install-hooks.js — refuses a commit carrying an API key.
node scripts/no-bundled-key.js || exit 1
`;

const dir = path.join('.git', 'hooks');
if (!existsSync('.git')) {
  console.error('  Not a git repository — nothing to install into.');
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'pre-commit');
writeFileSync(file, HOOK, 'utf8');
try { chmodSync(file, 0o755); } catch { /* Windows has no execute bit to set */ }

console.log(`  Installed ${file} — a commit with a bundled key will now be refused.`);
