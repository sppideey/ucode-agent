/**
 * index.js — the tool registry: schemas, argument checking, dispatch, and the
 * line the user reads while each one runs.
 */

import { ToolFailure } from '../core/failure.js';
import { readFile, readFiles, writeFile, batchWrite, editFile, multiEdit, editFiles } from './files.js';
import { listDir, glob, grep } from './search.js';
import { findSymbol, outline } from './symbols.js';
import { renameSymbol } from './rename.js';
import { addBlock, BLOCK_NAMES, PLAIN_BLOCK_NAMES, ALL_BLOCK_NAMES } from './blocks.js';
import { typeOf } from './types.js';
import { runCommand, runCommands } from './shell.js';
import { webSearch } from './web.js';
import { createApp, TEMPLATE_NAMES, TEMPLATE_NOTES } from './scaffold.js';
import { deploy } from './deploy.js';
import { clip, READ_LINES } from './shared.js';

export { setRoot, setConfirm, setRequest, getRoot } from './shared.js';

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

/**
 * The browser check is deliberately not in `tools`.
 *
 * It used to run itself whenever a dev server came up, which meant a window
 * opening mid-thought and a page being driven while the user was reading. It
 * is now something asked for: /look runs it, and nothing else does.
 */
export const lookAtAppTool =   {
    name: 'look_at_app',
    description:
      'Open the running app in a real browser at a phone width (375px) and a desktop width ' +
      '(1440px) and report what a person would run into: console errors, failed requests, ' +
      'content that spills off the side of the screen, broken images, unlabeled buttons and ' +
      'fields. The first look at an app also brings a designer-style review of the ' +
      'screenshots; later looks re-run only the fast checks. Use it once the dev server is ' +
      'ready, fix what it reports, then look once more to confirm. Screenshots are saved ' +
      'under .ucode/screenshots.',
    parameters: {
      type: 'object',
      properties: {
        url: str('The local URL the dev server reported, e.g. http://localhost:3000'),
        paths: {
          type: 'array',
          description: 'Pages to open, e.g. ["/", "/settings"]. Defaults to ["/"]. Up to 4.',
          items: { type: 'string' },
        },
      },
      required: ['url'],
    },
  };

/**
 * Deploying is not the model's to decide.
 *
 * Put something online and it is online: a link exists, someone may have it,
 * and undoing that is not the same as undoing a file. It happens when the
 * user says /deploy, and at no other time.
 */
export const deployTool =   {
    name: 'deploy',
    description:
      'Put an app online on Vercel and get its live link - use it when the user asks to deploy, ' +
      'publish, host or share the app. ucode picks a short free project name, copies the app\'s ' +
      '.env keys to Vercel as encrypted variables, refuses code with a secret written into it ' +
      '(move it to .env.local and a server route, then deploy again), and builds on Vercel. ' +
      'Run the local build first so errors show up here. Deploying again updates the same link.',
    parameters: {
      type: 'object',
      properties: {
        folder: str('The app folder, relative to the project root, e.g. "food-iq". Defaults to ".".'),
        name: str('Optional: a project name to use instead of the one ucode would choose.'),
      },
      required: [],
    },
  };

export const tools = [
  {
    name: 'create_app',
    description:
      'Start a new app AND write it, in one call. Pass "files" with the whole app and this ' +
      'is the only call the build needs: the starter lands, your files are written over it, ' +
      'and the result comes back with everything. Two starters. "plain-html" (the default): ' +
      'one index.html, one stylesheet, one ES module — nothing to install, nothing to build, ' +
      'and the stylesheet is a design system already: a palette, a spacing scale, radii, ' +
      'motion timings, focus rings and a breakpoint. Re-tint those tokens to suit the app ' +
      'and compose every rule from them. Replacing it with raw pixel values is what an ' +
      'undesigned page is made of. ' +
      'opens straight in a browser, and its three files come back inside this result so there ' +
      'is never a reason to read them. Use it for anything that is one page: a tasks app, a ' +
      'toy, a game, a visualisation, a calculator, a timer. "next-shadcn": Next.js 16, ' +
      'TypeScript, Tailwind 4 and shadcn with 33 components — only when the app genuinely ' +
      'needs routes, a database or many screens, because it costs an install and a build. ' +
      'This is how every Next.js app begins - never run create-next-app or shadcn init. ' +
      'In "next-shadcn" every path in "files" goes under src/: a page is a route only at ' +
      '<app>/src/app/page.tsx or <app>/src/app/<segment>/page.tsx, an API handler only at ' +
      '<app>/src/app/api/<name>/route.ts, and components at <app>/src/components/<feature>/. ' +
      'A page.tsx written anywhere else is an ordinary file the router never serves.',
    parameters: {
      type: 'object',
      properties: {
        folder: str('A new, empty folder for the app, relative to the project root, e.g. "stride".'),
        name: str('The display name of the app, e.g. "Stride".'),
        description: str('One line about the app, used in the page metadata.'),
        files: {
          type: 'array',
          description:
            'The app itself, written in this same call, straight over the starter\'s files. ' +
            'Pass the whole app here rather than following up with batch_write - it saves a ' +
            'round trip, which is most of the time a build takes. Paths are relative to the ' +
            'project root and so include the app folder, e.g. "stride/index.html".',
          items: {
            type: 'object',
            properties: {
              path: str('Path relative to the project root, e.g. "stride/index.html".'),
              content: str('The complete contents of the file.'),
            },
            required: ['path', 'content'],
          },
        },
        template: {
          type: 'string',
          // The default goes first: a model picking from an enum reaches for
          // the head of the list, and the head of this one used to be the
          // starter that costs an install and a build.
          enum: ['plain-html', 'next-shadcn'],
          description:
            'Which starter. "plain-html" (the default) for one page, a toy, a game, or any ' +
            'app that does not need a server: no install, no build, nothing to wait for. ' +
            '"next-shadcn" only for routes, a database or many screens.',
        },
        design: {
          type: 'string',
          enum: ['ocean', 'grove', 'sunset', 'graphite', 'violet', 'citrus'],
          description:
            'The look: colours and fonts, light and dark. Pick the one that fits the app. ' +
            'ocean - calm blue, for dashboards, finance, productivity (default). ' +
            'grove - fresh green, for health, habits, food, nature. ' +
            'sunset - warm coral with a serif, for travel, recipes, journaling, lifestyle. ' +
            'graphite - monochrome and crisp, for developer tools, docs, portfolios. ' +
            'violet - vivid violet, for AI tools, creative apps, music, learning. ' +
            'citrus - bright lime and bold, for games, sport, kids, social.',
        },
      },
      required: ['folder', 'name'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read one text file - for two or more, use read_files instead. Comes back as numbered lines — the numbers are for you to ' +
      'refer to and must never appear in an edit_file argument. Long files arrive in ' +
      'pages; pass offset to keep going.',
    parameters: {
      type: 'object',
      properties: {
        path: str('File path, relative to the project root.'),
        offset: int('First line to read, 1-based. Defaults to 1.'),
        limit: int(`How many lines. Defaults to ${READ_LINES}.`),
      },
      required: ['path'],
    },
  },
  {
    name: 'read_files',
    description:
      'Read several text files in one call. Use this whenever you need more than one ' +
      'file - it is one round trip instead of one per file, so it is much faster than ' +
      'calling read_file repeatedly. Same numbered-line output as read_file, one block ' +
      'per file. A missing file is reported in its place without failing the others.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'File paths, relative to the project root. Up to 20.',
          items: { type: 'string' },
        },
        limit: int(`Lines per file. Defaults to ${READ_LINES}.`),
      },
      required: ['paths'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create a file, or replace all of its contents. For a change to part of an ' +
      'existing file use edit_file instead — this one throws away everything that was ' +
      'there. Missing parent directories are created.',
    parameters: {
      type: 'object',
      properties: {
        path: str('File path, relative to the project root.'),
        content: str('The complete text of the file.'),
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'batch_write',
    description:
      'Create or replace several files in one call. Use this to lay out a whole ' +
      'project at once instead of calling write_file over and over — it is the ' +
      'difference between one round trip and twenty.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'The files to write.',
          items: {
            type: 'object',
            properties: {
              path: str('File path, relative to the project root.'),
              content: str('The complete text of the file.'),
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace one exact piece of text in a file. old_string must match the file ' +
      'character for character, including indentation, and must occur exactly once — ' +
      'the edit is refused on zero matches and on two. This is the normal way to ' +
      'change existing code. The result shows the file as it now stands, so do not ' +
      'read it again afterwards.',
    parameters: {
      type: 'object',
      properties: {
        path: str('File path, relative to the project root.'),
        old_string: str('The exact text to replace. Must be unique in the file.'),
        new_string: str('What to put there instead.'),
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'multi_edit',
    description:
      'Several exact replacements in one file, applied in order, each seeing the ' +
      'result of the last. Same rules as edit_file for each one. If any of them is ' +
      'ambiguous or missing, none are written at all. Prefer this to calling ' +
      'edit_file repeatedly on the same file.',
    parameters: {
      type: 'object',
      properties: {
        path: str('File path, relative to the project root.'),
        edits: {
          type: 'array',
          description: 'The replacements, in the order they should be applied.',
          items: {
            type: 'object',
            properties: {
              old_string: str('The exact text to replace. Must be unique at that point.'),
              new_string: str('What to put there instead.'),
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'edit_files',
    description:
      'Exact replacements across several files in one call - the fastest way to make ' +
      'a change that touches a route, a component and a type together. Same matching ' +
      'rules as edit_file for every edit. If any edit in any file fails, nothing is ' +
      'written anywhere.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'One entry per file, each listed once.',
          items: {
            type: 'object',
            properties: {
              path: str('File path, relative to the project root.'),
              edits: {
                type: 'array',
                description: 'Replacements for this file, in order.',
                items: {
                  type: 'object',
                  properties: {
                    old_string: str('The exact text to replace.'),
                    new_string: str('What to put there instead.'),
                  },
                  required: ['old_string', 'new_string'],
                },
              },
            },
            required: ['path', 'edits'],
          },
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'list_dir',
    description: 'List what is in one directory, with file sizes.',
    parameters: {
      type: 'object',
      properties: { path: str('Directory path. Defaults to the project root.') },
      required: [],
    },
  },
  {
    name: 'glob',
    description:
      'Find files by name pattern, most recently changed first. Understands **, *, ? ' +
      'and {a,b}. node_modules, .git, dist and similar are skipped unless the pattern ' +
      'names one of them.',
    parameters: {
      type: 'object',
      properties: {
        pattern: str('Glob pattern, e.g. "src/**/*.{ts,tsx}".'),
        path: str('Directory to look under. Defaults to the project root.'),
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      'Search inside files with a regular expression. Returns file:line: text for ' +
      'every match. Pass glob to limit which files get read.',
    parameters: {
      type: 'object',
      properties: {
        pattern: str('A JavaScript regular expression.'),
        path: str('File or directory to search. Defaults to the project root.'),
        glob: str('Optional filename filter, e.g. "**/*.js".'),
        ignore_case: bool('Match case-insensitively. Defaults to false.'),
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_symbol',
    description:
      'Find where a function, component, class or type is declared. Use this instead of ' +
      'grep when you want the definition: grep returns every line that mentions a name, ' +
      'nearly all of which are uses. Returns file:line, what kind of thing it is, and the ' +
      'declaring line. Falls back to near matches when the exact name is not found.',
    parameters: {
      type: 'object',
      properties: {
        name: str('The name to look for, e.g. "calculateTip" or "Button".'),
        kind: str('Optional filter: function, component, class or type.'),
        path: str('Directory to look under. Defaults to the project root.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'outline',
    description:
      'The shape of the code without reading all of it: what each file declares, and the ' +
      'URL any Next.js page answers on. Pass a file for its declarations in order, or a ' +
      'folder for a map of it. Good for getting your bearings in an unfamiliar project.',
    parameters: {
      type: 'object',
      properties: {
        path: str('File or directory. Defaults to the project root.'),
      },
    },
  },
  {
    name: 'rename_symbol',
    description:
      'Rename a function, component, variable, prop or type everywhere it appears as ' +
      'that name. Understands where code ends and strings and comments begin, so it will ' +
      'not rewrite a word inside a message, and matches whole names only — renaming "id" ' +
      'leaves "width" and "idle" alone. Prefer this over edit_file for a rename: a ' +
      'find-and-replace that matched too much is the most common broken edit.',
    parameters: {
      type: 'object',
      properties: {
        name: str('The name as it is now, e.g. "userId".'),
        to: str('What it should become, e.g. "accountId".'),
        path: str('File or directory to rename within. Defaults to the project root.'),
      },
      required: ['name', 'to'],
    },
  },
  {
    name: 'add_block',
    description:
      'Add a ready-made, polished piece of an app, copied in as an ordinary source file ' +
      'you can then edit. Which set you get is decided by the app itself, so you never ' +
      'pick wrong. For a plain page: ' + PLAIN_BLOCK_NAMES.join(', ') + ' — plain ES ' +
      'modules that import nothing and style themselves from the CSS variables already ' +
      'in styles.css. For a React app: ' + BLOCK_NAMES.join(', ') + ' — built on the ' +
      'shadcn components already in the starter. ALWAYS reach for these before writing a ' +
      'list, a filter row, a store, a dialog or a table by hand: they already handle the ' +
      'keyboard, the empty state, small screens and the cases that get skipped, and every ' +
      'one you use is a hundred lines you do not have to type. Call it with no name to ' +
      'see what each is for.',
    parameters: {
      type: 'object',
      properties: {
        name: str(`Which block, e.g. "${ALL_BLOCK_NAMES[0]}". Omit to list the ones this app can use.`),
        folder: str('The app folder to add it to. Defaults to the project root.'),
      },
    },
  },
  {
    name: 'type_of',
    description:
      'Ask the TypeScript this project has installed what something actually is: the exact ' +
      'type or signature of a function, prop, variable or import, the docs written on it, ' +
      'and where it is defined. Use this instead of guessing at an API or reading the ' +
      'source of a package — the answer comes from the same compiler and tsconfig the ' +
      'build uses, so it is what the build will say. Costs milliseconds.',
    parameters: {
      type: 'object',
      properties: {
        path: str('The file the name appears in, e.g. "src/app/page.tsx".'),
        symbol: str('The name to ask about, e.g. "useRouter" or "user".'),
        line: int('Optional: which line it is on, when the name appears more than once.'),
      },
      required: ['path', 'symbol'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command and get back its output and exit code. It runs without ' +
      'asking, so never run something destructive the user did not ask for. There is ' +
      'no keyboard: pass the non-interactive flag to anything that would ask a question. ' +
      'Dev servers (npm run dev, vite, next dev, uvicorn...) are started in the ' +
      'background automatically and the result comes back as soon as the server says ' +
      'it is ready, with the URL it is listening on - do not start one twice.',
    parameters: {
      type: 'object',
      properties: {
        command: str('The whole command line.'),
        cwd: str('Directory to run it in. Defaults to the project root.'),
        timeout_ms: int('Kill it after this many milliseconds. Default 120000.'),
        background: bool('Start it detached and return its PID. For servers.'),
      },
      required: ['command'],
    },
  },
  {
    name: 'run_commands',
    description:
      'Run several shell commands at once, up to max_parallel at a time. Good for ' +
      'independent work — install, lint and test together rather than one after ' +
      'another. Each entry takes the same fields as run_command.',
    parameters: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          description: 'The commands to run.',
          items: {
            type: 'object',
            properties: {
              command: str('The whole command line.'),
              cwd: str('Directory to run it in. Defaults to the project root.'),
              timeout_ms: int('Kill it after this many milliseconds. Default 120000.'),
              background: bool('Start it detached and return its PID.'),
            },
            required: ['command'],
          },
        },
        max_parallel: {
          type: 'integer',
          description: 'How many may run at once. Default 3.',
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['commands'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web and get back titles, links and summaries. For anything the ' +
      'project files and your own knowledge cannot settle: current versions, recent ' +
      'releases, an unfamiliar error, documentation for an API you do not know. Cite ' +
      'the URLs you actually used.',
    parameters: {
      type: 'object',
      properties: {
        query: str('What to look up.'),
        max_results: int('How many results, 1-10. Defaults to 5.'),
      },
      required: ['query'],
    },
  },
];

const run = {
  read_file: readFile,
  read_files: readFiles,
  write_file: writeFile,
  batch_write: batchWrite,
  edit_file: editFile,
  multi_edit: multiEdit,
  edit_files: editFiles,
  list_dir: listDir,
  glob,
  grep,
  find_symbol: findSymbol,
  outline,
  rename_symbol: renameSymbol,
  add_block: addBlock,
  type_of: typeOf,
  run_command: runCommand,
  run_commands: runCommands,
  web_search: webSearch,
  /**
   * Loaded when it is used, not when ucode starts.
   *
   * browser.js pulls in playwright-core, which costs a second of start-up on
   * its own. Nothing reaches for the browser until someone types /look, so
   * nobody should wait for it before the first prompt.
   */
  look_at_app: async (args, opts) => (await import('./browser.js')).lookAtApp(args, opts),
  create_app: createApp,
  deploy,
};

/** Tools that change the project or execute code. */
export const MUTATING = new Set([
  'write_file', 'batch_write', 'edit_file', 'multi_edit', 'edit_files', 'rename_symbol', 'add_block',
  'run_command', 'run_commands', 'create_app', 'deploy',
]);

/** Tools with no side effects, so several may run at the same time. */
export const PARALLEL_SAFE = new Set(['read_file', 'read_files', 'list_dir', 'glob', 'grep', 'web_search', 'find_symbol', 'outline', 'type_of']);

/** Tools withheld in plan mode. Withholding beats asking a model not to. */
export const WRITES = new Set([
  'write_file', 'batch_write', 'edit_file', 'multi_edit', 'edit_files', 'rename_symbol', 'add_block',
  'run_command', 'run_commands', 'delegate', 'create_app', 'deploy',
]);

/** Tools that change files on disk, which parallel workers take turns at. */
export const FILE_WRITES = new Set(['write_file', 'batch_write', 'edit_file', 'multi_edit', 'edit_files', 'rename_symbol', 'create_app']);

// ---------------------------------------------------------------------------
// Argument checking
// ---------------------------------------------------------------------------

/**
 * Check the model's arguments against the schema before anything runs.
 *
 * Catching it here means the model gets a precise sentence about what it got
 * wrong and can correct itself, instead of a TypeError thrown from somewhere
 * inside fs that means nothing to anybody.
 */
/**
 * Arguments whose tool reads more shapes than the schema advertises.
 *
 * Kept here rather than in the schema so the wire format stays exactly what
 * the model is asked for — the leniency is ucode's, not part of the contract.
 */
const LENIENT = new Set(['create_app.files']);

function check(name, args) {
  const schema = tools.find((t) => t.name === name).parameters;
  const problems = [];

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['the arguments must be a JSON object'];
  }

  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) problems.push(`"${key}" is required and missing`);
  }

  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties[key];
    if (!spec) {
      problems.push(`"${key}" is not an argument of ${name} (it takes: ${Object.keys(schema.properties).join(', ')})`);
      continue;
    }
    if (value === undefined || value === null) continue;

    let actual = Array.isArray(value) ? 'array' : typeof value;
    const wanted = spec.type === 'integer' ? 'number' : spec.type;
    // A number sent as a string is close enough — the tool coerces it anyway.
    if (wanted === 'number' && actual === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) continue;

    // An array or object sent as a JSON string is the single most common way
    // a model gets a nested argument wrong, and it is one every model makes
    // sometimes. Rejecting it costs a whole round trip to be told something
    // that could simply be read: parse it and carry on.
    if ((wanted === 'array' || wanted === 'object') && actual === 'string') {
      try {
        const parsed = JSON.parse(value);
        const kind = Array.isArray(parsed) ? 'array' : typeof parsed;
        if (kind === wanted || LENIENT.has(`${name}.${key}`)) { args[key] = parsed; actual = kind; }
      } catch { /* not JSON either — the message below is the right answer */ }
    }

    // A list of files written as a { path: contents } map. The tool reads it
    // either way, so refusing it here would be a round trip spent on nothing.
    if (wanted === 'array' && actual === 'object' && LENIENT.has(`${name}.${key}`)) continue;

    if (actual !== wanted) problems.push(`"${key}" should be ${spec.type} but was ${actual}`);
  }

  return problems;
}

export async function runTool(name, args = {}, opts = {}) {
  const impl = run[name];
  if (!impl) {
    throw new ToolFailure({
      kind: 'no_such_tool',
      attempted: `calling ${name}`,
      failed: `There is no tool called "${name}".`,
      fix: `The tools you have are: ${tools.map((t) => t.name).join(', ')}.`,
    });
  }

  const problems = check(name, args);
  if (problems.length) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: `calling ${name}`,
      failed: `The arguments were wrong: ${problems.join('; ')}.`,
      fix: `Call ${name} again with them corrected. Its schema is: ${JSON.stringify(
        tools.find((t) => t.name === name).parameters
      )}`,
      detail: { problems },
    });
  }

  return impl(args, opts);
}

/**
 * The line shown while a call runs: "Listing src", "Running npm test".
 *
 * Present tense, no trailing full stop — it is a label on something happening
 * now, not a sentence about something that happened. It is built from the call
 * itself rather than from what the model said it would do, so it is always an
 * account of the real work.
 */
export function describe(name, args = {}) {
  switch (name) {
    case 'read_file':
    case 'read_files':
      // Which file is in the diff and in the result; the transcript only has to
      // say what kind of work is going on, so a run of them folds into one line.
      return 'Reading files';
    case 'write_file':
      return 'Writing app';
    case 'batch_write':
      return 'Writing app';
    case 'edit_file':
      return 'Writing app';
    case 'multi_edit':
      return 'Writing app';
    case 'edit_files':
      return 'Writing app';
    case 'update_plan':
      return 'Updating the plan';
    case 'delegate':
      return `Starting ${args.tasks?.length ?? 0} workers in parallel`;
    case 'list_dir':
      return !args.path || args.path === '.'
        ? 'Listing the project root'
        : `Listing ${clip(args.path)}`;
    case 'glob':
      return `Finding ${clip(args.pattern)}`;
    case 'type_of':
      return `Asking what ${clip(args.symbol, 30)} is`;
    case 'add_block':
      return args.name ? `Adding the ${clip(args.name, 30)} block` : 'Listing the ready-made blocks';
    case 'rename_symbol':
      return `Renaming ${clip(args.name, 30)} to ${clip(args.to, 30)}`;
    case 'find_symbol':
      return `Looking up ${clip(args.name, 40)}`;
    case 'outline':
      return !args.path || args.path === '.'
        ? 'Mapping the project'
        : `Mapping ${clip(args.path)}`;
    case 'grep':
      return `Searching for ${clip(args.pattern, 40)}${args.glob ? ` in ${clip(args.glob, 20)}` : ''}`;
    case 'run_command':
      return `Running ${clip(args.command, 70)}${args.background ? ' in the background' : ''}`;
    case 'run_commands':
      return `Running ${args.commands?.length ?? 0} commands together`;
    case 'deploy':
      return `Deploying ${clip(args.folder || '.', 30)} to Vercel`;
    case 'create_app':
      // Say which starter it actually is. Hardcoding one of them meant a plain
      // HTML app announced itself as Next.js, which is a line that is simply
      // untrue on screen while the opposite happens on disk.
      return `Creating ${clip(args.name || args.folder, 30)} from the ` +
        `${args.template === 'next-shadcn' ? 'Next.js' : 'HTML'} starter` +
        `${args.files?.length ? ` with ${args.files.length} file${args.files.length === 1 ? '' : 's'}` : ''}`;
    case 'look_at_app':
      return `Looking at ${clip(args.url, 40)} on a phone and a desktop`;
    case 'web_search':
      return `Searching the web for ${clip(args.query, 60)}`;
    case 'load_skill':
      return `Loading the ${clip(args.name, 40)} skill`;
    default:
      return `${name} ${clip(JSON.stringify(args), 60)}`;
  }
}
