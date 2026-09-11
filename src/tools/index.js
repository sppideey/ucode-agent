/**
 * index.js — the tool registry: schemas, argument checking, dispatch, and the
 * line the user reads while each one runs.
 */

import { ToolFailure } from '../core/failure.js';
import { readFile, readFiles, writeFile, batchWrite, editFile, multiEdit, editFiles } from './files.js';
import { listDir, glob, grep } from './search.js';
import { runCommand, runCommands } from './shell.js';
import { webSearch } from './web.js';
import { clip, READ_LINES } from './shared.js';

export { setRoot, setConfirm, getRoot } from './shared.js';

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

export const tools = [
  {
    name: 'read_file',
    description:
      'Read a text file. Comes back as numbered lines — the numbers are for you to ' +
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
      'change existing code.',
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
  run_command: runCommand,
  run_commands: runCommands,
  web_search: webSearch,
};

/** Tools that change the project or execute code. */
export const MUTATING = new Set([
  'write_file', 'batch_write', 'edit_file', 'multi_edit', 'edit_files', 'run_command', 'run_commands',
]);

/** Tools with no side effects, so several may run at the same time. */
export const PARALLEL_SAFE = new Set(['read_file', 'read_files', 'list_dir', 'glob', 'grep', 'web_search']);

/** Tools withheld in plan mode. Withholding beats asking a model not to. */
export const WRITES = new Set([
  'write_file', 'batch_write', 'edit_file', 'multi_edit', 'edit_files', 'run_command', 'run_commands',
  'delegate',
]);

/** Tools that change files on disk, which parallel workers take turns at. */
export const FILE_WRITES = new Set(['write_file', 'batch_write', 'edit_file', 'multi_edit', 'edit_files']);

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

    const actual = Array.isArray(value) ? 'array' : typeof value;
    const wanted = spec.type === 'integer' ? 'number' : spec.type;
    // A number sent as a string is close enough — the tool coerces it anyway.
    if (wanted === 'number' && actual === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) continue;
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
      return `Reading ${clip(args.path)}${args.offset > 1 ? ` from line ${args.offset}` : ''}`;
    case 'read_files': {
      const names = (args.paths ?? []).map((p) => String(p));
      const joined = names.join(', ');
      return names.length && joined.length <= 60 ? `Reading ${joined}` : `Reading ${names.length} files`;
    }
    case 'write_file':
      return `Writing ${clip(args.path)}`;
    case 'batch_write': {
      const n = args.files?.length ?? 0;
      const first = args.files?.[0]?.path;
      return n === 1 && first ? `Writing ${clip(first)}` : `Writing ${n} files`;
    }
    case 'edit_file':
      return `Editing ${clip(args.path)}`;
    case 'multi_edit':
      return `Editing ${clip(args.path)}, ${args.edits?.length ?? 0} changes`;
    case 'edit_files': {
      const n = args.files?.length ?? 0;
      const first = args.files?.[0]?.path;
      return n === 1 && first ? `Editing ${clip(first)}` : `Editing ${n} files`;
    }
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
    case 'grep':
      return `Searching for ${clip(args.pattern, 40)}${args.glob ? ` in ${clip(args.glob, 20)}` : ''}`;
    case 'run_command':
      return `Running ${clip(args.command, 70)}${args.background ? ' in the background' : ''}`;
    case 'run_commands':
      return `Running ${args.commands?.length ?? 0} commands together`;
    case 'web_search':
      return `Searching the web for ${clip(args.query, 60)}`;
    case 'load_skill':
      return `Loading the ${clip(args.name, 40)} skill`;
    default:
      return `${name} ${clip(JSON.stringify(args), 60)}`;
  }
}
