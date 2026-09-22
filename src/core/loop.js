/**
 * loop.js — the agent itself.
 *
 * One turn, end to end: take a line, fold the conversation if it has grown too
 * big, ask the model, and if it asked for tools, run them and ask again. Repeat
 * until it answers with prose instead of a tool call.
 *
 * Two histories are kept, deliberately:
 *   session.messages  the complete record, written to disk after every step
 *   working           what is actually sent, which may have its older turns
 *                     folded into a summary once the window gets tight
 */

import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { appendFileSync, existsSync } from 'node:fs';
import { readFile, readdir, access, mkdir } from 'node:fs/promises';
import { testRunnerFor, relatedCommand, summariseFailures } from './tests.js';
import { LogWatch } from './livelog.js';
import { checkHtml } from './htmlcheck.js';
import { checkCss } from './csscheck.js';
import { runningServers } from '../tools/shell.js';
import { unprefixOwnFolder } from './relink.js';
import { beginTurn, undoTurn, changedCount } from './undo.js';
import { spawn } from 'node:child_process';

import {
  ask, model, setModel, modelName, modelList, contextLimit, rateLimits,
  estimateConversation, MODELS, DEFAULT_MODEL, PROVIDER, fallbackFor,
} from './provider.js';
import {
  tools, runTool, describe, setRoot, setConfirm, setRequest,
  PARALLEL_SAFE, WRITES, FILE_WRITES,
} from '../tools/index.js';
import { projectMap, loadMemory, hasCode, remember, MEMORY_FILE } from './context.js';
import { autoUpdate } from './updater.js';
import { closeBrowser, forgetReviews } from '../tools/browser.js';
import {
  newSession, save, load, list, remove, removeAll, titleFrom,
} from './history.js';
import { fold, usage, tooBig, SUMMARY_PROMPT, summaryRequest, forSummary } from './window.js';
import { loadSkills, catalogue, findSkill, skillMessage, autoLoadFor } from './skills.js';
import { Screen } from '../ui/screen.js';
import { Plain } from '../ui/plain.js';
import { theme, blue, sky, dim, formatTokens, relativeTime, shortenPath, clip,
  asNarrationLine } from '../ui/theme.js';
import { Failure, ToolFailure, Declined } from './failure.js';
import { StuckWatch, eventFor, describeHit } from './stuck.js';
import { serversReadySince } from '../tools/shell.js';
import { formatDuration } from '../ui/activity.js';
import { runDoctor } from './doctor.js';
import { JS_LOGIC } from './jslogic.js';
import { deploy } from '../tools/deploy.js';
import { normaliseFiles } from '../tools/scaffold.js';

/**
 * Tool calls allowed in one turn.
 *
 * Scaffolding an app is dozens of writes before anything can even be run, so a
 * small ceiling stops a real job halfway through — which from the outside is
 * indistinguishable from the agent giving up for no reason. The runaway-loop
 * protection this exists for still works at 250; a loop burns through that
 * just as visibly, only later.
 */
const MAX_STEPS = Number(process.env.UCODE_MAX_STEPS) || 250;
const MAX_ARG_RETRIES = 2;

/**
 * How many times a reply cut off at the output limit is asked to carry on.
 * Three covers any answer a terminal should be printing; past that the model
 * is rambling and stopping is the kinder outcome.
 */
const MAX_CONTINUATIONS = 3;

/** Read-only tools whose result line adds nothing — the user saw the output. */
/**
 * How many rows a diff adds and removes.
 *
 * The rows come through as "+12| text" and "-12| text", with a "~" heading
 * for each file in a multi-file write and an undecorated note counting what
 * was elided. Only the signs are counted.
 */
export function countDiff(rows = []) {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    const line = String(row ?? '');
    if (line.startsWith('~')) continue;
    // "… 218 more removed" / "… 508 more added" stand for rows not shown.
    const more = /^\s*[….]+\s*(\d+)\s+more\s+(added|removed)/.exec(line);
    if (more) {
      if (more[2] === 'added') added += Number(more[1]);
      else removed += Number(more[1]);
      continue;
    }
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

const QUIET = new Set(['read_file', 'read_files', 'list_dir', 'glob', 'grep', 'web_search', 'update_plan']);

/** Tools that draw their own line, so they get no "● Doing X" line of their own. */
const SILENT = new Set(['update_plan']);

/** How many rounds of "the type check found errors, fix them" one turn may take. */
const MAX_FIX_ROUNDS = 3;

/** Files worth checking after they change. */
/** A file with a page in it — something a browser can be pointed at. */
const PAGE = /\.(?:html?|tsx|jsx)$/i;

const CHECKABLE = /\.(?:[cm]?[jt]sx?|py|html?)$/i;

/** Where TypeScript keeps what it learned, so the next check is a quick one. */
export const TSBUILDINFO = 'node_modules/.cache/ucode/types.tsbuildinfo';

/** TypeScript before 4.0 rejects --incremental together with --noEmit. */
const NO_INCREMENTAL = /TS5074|TS6304|'--incremental'/;

/**
 * The type check to run. Incremental by default: the first check pays the
 * full cost and writes a build info file, and every one after it reads that
 * and reports in about a second.
 */
export function typeCheckCommand(incremental = true) {
  const base = 'npx --no-install tsc --noEmit --pretty false';
  return incremental ? `${base} --incremental --tsBuildInfoFile ${TSBUILDINFO}` : base;
}

/**
 * Failures that are the provider's and not the model's: busy, slow, down, or
 * unreachable. None of them should end a build — the turn moves to another
 * model and carries on from exactly where it was.
 */
const TRANSIENT = new Set(['rate_limit', 'timeout', 'server', 'network', 'no_content']);
/** Will another model, or a little patience, get past this? Not the daily cap: it covers them all. */
const passing = (err) => TRANSIENT.has(err.kind) && !err.detail?.daily;
const MAX_FAILOVERS = 8;
const COOLDOWN = 5 * 60_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * UCODE_TRACE=1 writes one JSON line per model call and per tool to
 * ~/.ucode/trace.jsonl (or to the path UCODE_TRACE names): how long it took,
 * tokens in and out, what was called. It is how "it feels slow" becomes a
 * number with a cause attached.
 */
const TRACE_FILE = process.env.UCODE_TRACE
  ? (process.env.UCODE_TRACE === '1' ? path.join(os.homedir(), '.ucode', 'trace.jsonl') : process.env.UCODE_TRACE)
  : null;

/** Tool results worth re-sending in full only while they are recent. */
const THIN_RESULTS = new Set([
  'read_file', 'read_files', 'grep', 'glob', 'list_dir', 'run_command', 'run_commands',
  'look_at_app', 'web_search', 'edit_file', 'multi_edit', 'edit_files',
  // create_app hands back the starter's files in full so they are never read.
  // That is worth a round trip once and nothing at all after the next few
  // steps, by which point they are on disk like any other file.
  'create_app',
]);

/** Replace long strings in old tool arguments with a note of their size. */
function thinArgs(value) {
  if (typeof value === 'string') {
    return value.length > 400
      ? `[${value.length} characters, already applied — read the file if you need its current text]`
      : value;
  }
  if (Array.isArray(value)) return value.map(thinArgs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, thinArgs(v)]));
  }
  return value;
}

/**
 * The conversation as sent, with bulky history thinned.
 *
 * Every file the model writes travels inside its own tool call, so a
 * thirty-file app is re-sent in full on every later step — tens of thousands
 * of tokens the provider has to read before it can answer, growing with
 * each file. Beyond the last few steps that text is replaced by a note of its
 * size; the files are on disk, and the model re-reads one when it needs it.
 * Call ids and results stay paired, and the saved session keeps everything.
 */

/**
 * The identity of a type error, without its line number.
 *
 * tsc prints "src/a.ts(12,5): error TS2322: ...". The line moves every time
 * anything above it is edited, so where an error sits cannot be part of what
 * makes it the same error as before; the file, the code and the message can.
 */
export function typeErrorKey(line) {
  const m = /^(.*?)[(](\d+),(\d+)[)]:\s*(error TS\d+:.*)$/.exec(String(line).trim());
  return m ? `${m[1]}|${m[4]}` : String(line).trim();
}

/** The file an error line is about, or null. */
export function typeErrorFile(line) {
  const m = /^(.*?)[(]\d+,\d+[)]:/.exec(String(line).trim());
  return m ? m[1].trim() : null;
}

/**
 * Shrink a worker's conversation in place, oldest tool results first.
 *
 * Nothing is removed, so every tool call keeps its answer and the transcript
 * stays valid - a long result is replaced by a note of its size. The last few
 * steps are left whole, which is the part a worker is actually working from.
 */
export function thinWorker(messages, budget, keep = 12) {
  if (estimateConversation(messages) <= budget) return messages;
  const from = Math.max(2, messages.length - keep);
  for (let i = 0; i < from; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || (m.content?.length ?? 0) < 400 || m.thinned) continue;
    m.content = `[${m.content.length} characters, trimmed to stay inside the window - read the file again if you still need it]`;
    m.thinned = true;
  }
  return messages;
}

/** Tools whose result is the contents of one named thing, so re-reads repeat. */
const RE_READ = new Set(['read_file', 'read_files', 'list_dir', 'grep', 'glob']);

/** The thing a call was about, when two calls for it return the same text. */
function subjectOf(call) {
  if (!RE_READ.has(call?.name)) return null;
  const a = call.args ?? {};
  const what = a.path ?? (Array.isArray(a.paths) ? a.paths.join('|') : null) ?? a.pattern;
  if (typeof what !== 'string' || !what) return null;
  // grep and glob also depend on what was asked, not only where.
  const extra = call.name === 'grep' || call.name === 'glob' ? `|${a.pattern ?? ''}|${a.glob ?? ''}` : '';
  return `${call.name}:${what}${extra}`;
}

/**
 * Send each file once.
 *
 * Reading a file four times over a long task puts four copies of it in the
 * conversation, and the first three are worth nothing: the model reads the
 * newest and the older ones only cost tokens and invite it to answer from a
 * stale copy. Every superseded copy becomes a line saying where the current
 * one is. The newest is always kept whole, so nothing the model needs is
 * taken away, and the saved session still holds the lot.
 */
export function dedupe(messages) {
  const subject = new Map(); // toolCallId -> subject
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    for (const c of m.toolCalls) {
      const s = subjectOf(c);
      if (s) subject.set(c.id, s);
    }
  }
  if (!subject.size) return messages;

  const newest = new Map(); // subject -> index of the last result for it
  messages.forEach((m, i) => {
    if (m.role !== 'tool') return;
    const s = subject.get(m.toolCallId);
    if (s) newest.set(s, i);
  });

  return messages.map((m, i) => {
    if (m.role !== 'tool') return m;
    const s = subject.get(m.toolCallId);
    if (!s || newest.get(s) === i) return m;
    // Short results are not worth a note in place of themselves.
    if ((m.content?.length ?? 0) < 400) return m;
    const what = s.slice(s.indexOf(':') + 1).split('|')[0];
    return {
      ...m,
      content:
        `[${m.content.length} characters. This was read again later, and the current ` +
        `contents of ${what} are further down this conversation — use those, not this.]`,
    };
  });
}

export function lean(messages, keep = 3) {
  let seen = 0;
  let cut = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].toolCalls?.length && ++seen === keep) { cut = i; break; }
  }
  if (cut <= 0) return messages;
  return messages.map((m, i) => {
    if (i >= cut) return m;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return { ...m, toolCalls: m.toolCalls.map((c) => ({ ...c, args: thinArgs(c.args) })) };
    }
    if (m.role === 'tool' && THIN_RESULTS.has(m.name) && (m.content?.length ?? 0) > 1500) {
      return {
        ...m,
        content: `${m.content.slice(0, 300)}
… [${m.content.length} characters from an earlier step, trimmed ` +
          'to keep the conversation fast — run the tool again if you need this now]',
      };
    }
    return m;
  });
}

/** One spelling per file for the read counts: "./a/b.js", "a\b.js" and "a/b.js" are one file. */
const fileKey = (p) => { const k = path.normalize(String(p)).split(path.sep).join('/'); return process.platform === 'win32' || process.platform === 'darwin' ? k.toLowerCase() : k; };

/** Tools that write whole files, whose sizes are remembered for the turn. */
const WHOLE_WRITES = new Set(['write_file', 'batch_write', 'create_app']);

/** Names a closing message can point at as files, for checkClaims. */
const FILE_EXT = /\.(?:[cm]?[jt]sx?|json|html?|css|s[ac]ss|less|md|mdx|txt|py|go|rs|java|rb|php|vue|svelte|ya?ml|toml|xml|svg|png|jpe?g|gif|webp|ico|sh|ps1|sql|env|lock|csv)$/i;

function trace(event) {
  if (!TRACE_FILE) return;
  try { appendFileSync(TRACE_FILE, `${JSON.stringify({ at: Date.now(), ...event })}
`); } catch { /* never fatal */ }
}

/** What /stats reports, counted as the session goes. */
function newStats() {
  return {
    started: Date.now(), workMs: 0, turns: 0, steps: 0, tokensIn: 0, tokensOut: 0,
    tools: {}, failed: 0, written: 0, edited: 0, commands: 0, builds: 0, stuck: 0,
  };
}

const BUILD_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bnext\s+build\b|\bvite\s+build\b/;

function countTool(stats, call, out, err) {
  stats.tools[call.name] = (stats.tools[call.name] ?? 0) + 1;
  if (err) { stats.failed++; return; }
  const a = call.args ?? {};
  if (call.name === 'write_file') stats.written++;
  if (call.name === 'batch_write') stats.written += a.files?.length ?? 0;
  if (call.name === 'edit_file' || call.name === 'multi_edit') stats.edited++;
  if (call.name === 'edit_files') stats.edited += new Set((a.edits ?? []).map((e) => e.path)).size || 1;
  if (call.name === 'run_command') {
    stats.commands++;
    if (BUILD_COMMAND.test(a.command ?? '')) stats.builds++;
  }
  if (call.name === 'run_commands') stats.commands += a.commands?.length ?? 0;
}

/** The /stats box. */
export function statsLines(st, messages) {
  const n = (v) => Number(v).toLocaleString();
  const top = Object.entries(st.tools).sort((x, y) => y[1] - x[1]).slice(0, 6)
    .map(([k, v]) => `${k} ${v}`).join(' · ') || 'none yet';
  const plural = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
  const rows = [
    ['Session', `${formatDuration(Date.now() - st.started)} open · ${formatDuration(st.workMs)} working · ${plural(st.turns, 'request')}`],
    ['Model', `${n(st.steps)} steps · ${formatTokens(st.tokensIn)} in · ${formatTokens(st.tokensOut)} out`],
    ['Tools', top],
    ['Files', `${st.written} written · ${st.edited} edited`],
    ['Commands', `${st.commands} run · ${plural(st.builds, 'build')}${st.failed ? ` · ${plural(st.failed, 'tool call')} failed` : ''}`],
    ['Context', `${messages} messages${st.stuck ? ` · ${plural(st.stuck, 'loop')} caught` : ''}`],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return ['', `  ${blue('Stats')}`, ...rows.map(([k, v]) => `  ${dim(k.padEnd(w))}  ${v}`), ''];
}

/** Parallel workers at once, and how many steps each may take. */
const MAX_WORKERS = 3;
const WORKER_STEPS = Number(process.env.UCODE_WORKER_STEPS) || 60;

/** Workers build; they do not plan, delegate further, or load skills themselves. */
// create_app too: a worker builds a part of the app the lead already made.
const WORKER_EXCLUDED = new Set(['delegate', 'update_plan', 'load_skill', 'create_app']);

const planTool = {
  name: 'update_plan',
  description:
    'Keep a short checklist the user can see, for work with three or more steps. ' +
    'Send the whole list every time: at most 6 items, a few words each, with done: true ' +
    'on the finished ones. Update it as items finish. Skip it for small tasks.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'The whole plan, in order. At most 6.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'A few words: "Build the upload box".' },
            done: { type: 'boolean', description: 'True once it is finished.' },
          },
          required: ['text'],
        },
      },
    },
    required: ['items'],
  },
};

const delegateTool = {
  name: 'delegate',
  description:
    'Build independent parts in parallel. Up to 3 workers run at once, each with the ' +
    'same tools as you. Use it when the work splits cleanly into parts that touch ' +
    'different files - e.g. the API route, the upload component and the results view. ' +
    'A worker sees only its instructions, so make them complete: the files it owns, ' +
    'what to build, the exact interfaces (props, types, request and response shapes) ' +
    'it must match, and the design rules. Set up shared files (package.json, design ' +
    'tokens, shared types) yourself first. You get back each worker\'s summary and ' +
    'the files it changed; wire the parts together and check the whole afterwards.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'Up to 3 independent pieces of work.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Two or three words: "api route", "upload ui".' },
            instructions: { type: 'string', description: 'Everything the worker needs to do its part completely.' },
          },
          required: ['name', 'instructions'],
        },
      },
    },
    required: ['tasks'],
  },
};

/** The instructions a parallel worker starts with. */
function workerPrompt({ cwd, name, memory, skills, map }) {
  return [
    `You are a ucode worker called "${name}" - one of several building parts of the same project at the same time.`,
    '',
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    '',
    '- Do exactly the task you were given. Touch only the files it names, or new files in',
    '  the area it owns - other workers are editing the rest of the project right now.',
    '- Read before you edit. read_files for several files, batch_write for several new',
    '  files, edit_files for changes across files.',
    '- Nothing has a keyboard: pass non-interactive flags. Do not start dev servers and do',
    '  not install packages unless the task says to - say what you need instead.',
    '- Finish what you build: real content, every state handled, no TODOs.',
    '- When done, reply with two or three sentences: what you built, in which files, and',
    '  anything the lead has to wire up.',
    '- The files you own may not exist yet - create them. Do not go looking for them',
    '  first. The project map below shows what does exist; read only the files whose',
    '  interfaces you must match, then start writing within two or three steps.',
    ...(memory ? ['', '## Project memory', '', memory] : []),
    ...(map ? ['', '## Project map', '', map] : []),
    ...(skills ? ['', '## Instructions in force', '', skills] : []),
  ].join('\n');
}

/** The files a writing tool call touches. */
function pathsOf(call) {
  const a = call.args ?? {};
  // create_app writes the app in the same call it scaffolds it, so those
  // files are changes like any other: they are checked, and they are counted.
  if (call.name === 'batch_write' || call.name === 'edit_files' || call.name === 'create_app') {
    // Read the way the tools read it: the list can arrive as a JSON string or
    // a { path: contents } map, and a string has a .length but no .map.
    return normaliseFiles(a.files).map((f) => f?.path).filter((p) => typeof p === 'string' && p);
  }
  return a.path ? [a.path] : [];
}

/**
 * Is everything that changed part of a page that has nothing to run?
 *
 * The verify nudge exists so an app is not handed over untested. It costs a
 * whole round trip, so it has to be about the thing that was built: a folder
 * with an index.html and no package.json cannot be started or tested, and its
 * files were parsed on the spot as they were written. Running the surrounding
 * repository's `npm test` against it proves nothing and takes half a minute.
 */
async function pagesOnly(paths, root) {
  const folders = new Map();
  for (const rel of paths) {
    const dir = String(rel).replace(/\\/g, '/').split('/')[0];
    if (!dir || dir.includes('.')) return false;    // a file at the root belongs to the project
    if (!folders.has(dir)) {
      folders.set(dir, (await exists(path.join(root, dir, 'index.html'))) &&
                       !(await exists(path.join(root, dir, 'package.json'))));
    }
    if (!folders.get(dir)) return false;
  }
  return folders.size > 0;
}

/**
 * Reads the file paths out of a tool call's arguments while they stream.
 *
 * The arguments of a call that writes an app are tens of kilobytes of JSON
 * arriving over a minute or more. Only the paths are wanted, they appear in
 * the order the files are written, and each one is complete long before the
 * content that follows it — so a plain scan for the next `"path": "..."`
 * says exactly where the model has got to.
 *
 * Scanning resumes from where it left off rather than re-reading the whole
 * string on every delta, which is the difference between a few thousand
 * characters of work and a few million over one call.
 */
const PATH_IN_ARGS = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

export class Writing {
  constructor() {
    this.at = new Map();      // call index -> how far it has been scanned
    this.count = new Map();   // call index -> files named so far
    this.last = null;
  }

  /** The line to show, or null when nothing new has been named. */
  seen(index, name, args) {
    if (!WRITES.has(name)) return null;
    const from = this.at.get(index) ?? 0;
    if (args.length <= from) return null;

    // Overlap by the length of the longest thing a path match can straddle,
    // so a path split across two deltas is not missed.
    const window = args.slice(Math.max(0, from - 512));
    this.at.set(index, args.length);

    let found = null;
    let extra = 0;
    PATH_IN_ARGS.lastIndex = 0;
    for (const match of window.matchAll(PATH_IN_ARGS)) {
      if (match[1] === this.last) continue;
      found = match[1];
      extra++;
    }
    if (!found) return null;

    const total = (this.count.get(index) ?? 0) + extra;
    this.count.set(index, total);
    this.last = found;
    return `writing ${shortenPath(found, 42)}${total > 1 ? ` · ${total} files so far` : ''}`;
  }
}

/** Tools that only mean anything once there is code in the folder. */
const LOOKUP_TOOLS = new Set(['find_symbol', 'outline', 'rename_symbol', 'type_of']);

/** A request that plainly wants the internet keeps web_search in a new project. */
const WANTS_WEB = /\b(?:search|google|web|online|internet|latest|current|news|docs|documentation|api reference|look up|find out about)\b/i;

const exists = (p) => access(p).then(() => true, () => false);

/** Skills reach the model as one extra tool, so bodies load only when wanted. */
const loadSkillTool = {
  name: 'load_skill',
  description:
    'Load the full instructions for one of the skills listed in your system prompt. ' +
    'Call it the moment a task matches one — before planning, before writing anything ' +
    '— then follow what it says.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The skill name, exactly as listed.' } },
    required: ['name'],
  },
};

function systemPrompt({ cwd, skills, mode, check, map, memory }) {
  const list = catalogue(skills);

  return [
    'You are ucode, a coding agent working directly in the user\'s terminal.',
    '',
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    ...(memory ? [
      '',
      '## Project memory',
      '',
      'Standing instructions from the user. They outrank your defaults.',
      '',
      memory,
    ] : []),
    '',
    '## How to work',
    '',
    'AN APP THAT IS AWKWARD TO USE IS NOT FINISHED. Before you call it done, look at',
    'what you built as someone using it for the first time: is the button inside its',
    'field or sitting on top of it, is there room to breathe between things, does the',
    'empty state say anything, can every control be reached from the keyboard, does',
    'it hold together at 360px wide. Controls that overlap or crowd each other are a',
    'bug in the same way a crash is - fix it before you say a word about being done.',
    '',
    'Before building anything, turn the request into a list of what it must do — every',
    'feature named, and the ones any user would expect whether or not they were named',
    '(an empty state, an error state, the keyboard doing the obvious thing, working on',
    'a phone). Keep it as the plan. Build against it, then go through it one item at a',
    'time before you say a word about being finished. Most of what gets missed was',
    'never written down.',
    '',
    'Do not put code in your reply. Not a snippet, not "here is the key part", not a',
    'summary of the file. It is already in the file and the user can open it; pasting',
    'it again buries the one or two sentences that actually matter. Say what it does',
    'and what to try.',
    '',
    'No emojis and no # headings in your reply, ever. Not a tick, not a rocket, not',
    'a "## Summary". The terminal shows them as clutter. Plain sentences only.',
    '',
    'Do not claim it is done while anything is still running or unchecked. "I have',
    'built it" said before the build finishes is worse than saying nothing: the user',
    'believes you, looks, and finds it broken. Finish, check, then say so — and if',
    'something is incomplete, say which part and why.',
    '',
    'BE FAST. Every tool call is a round trip, and round trips are nearly all of the',
    'time a build takes. So: a new app is ONE create_app call with its files passed',
    'in — the starter and the whole app together, not a scaffold and then a write.',
    'Its starter files come back inside that result, so there is nothing to read',
    'afterwards. Everything else goes in ONE batch_write rather than a write_file',
    'per file. Read every file you need in ONE read_files. Never read a',
    'file you just wrote, and never read one back after edit_file — the result',
    'already contains it. Do not re-check work the checks have already reported on.',
    'Fast is not sloppy: it is the same work with the waiting taken out.',
    '',
    'DESIGN IT BEFORE YOU TYPE IT. Fast means fewer round trips. It does not mean a',
    'default theme, and an app that goes out in the palette its starter came with is',
    'not a fast build, it is an undesigned one. There is no design pass after the',
    'create_app call, because there is no after — so the decisions happen before it.',
    '',
    'Three of them, and you hold them for the whole build:',
    '  - A TONE, one word you commit to: clinical, warm, editorial, technical,',
    '    playful, industrial, calm, dense. "Modern and clean" is not a tone.',
    '  - An ACCENT that is not the one the starter shipped with.',
    '  - ONE memorable thing this app has that other apps do not: a colour, a type',
    '    move, a texture, one interaction. Exactly one. It is the difference between',
    '    a design and a theme.',
    'Name the tone and the accent in your opening line, so they are settled before any',
    'file exists: "I will build Tide - a tasks app in one HTML file, calm, warm grey',
    'with a single amber accent." That is not narrating a plan, that is the decision.',
    '',
    'Then the tokens are the first thing in the file, in the same call as everything',
    'else: the type scale, the space scale, neutrals that carry a hue, the accent and',
    'its semantics. Nothing after that uses a raw value. IN next-shadcn THAT MEANS',
    'globals.css IS RE-TINTED IN THAT SAME create_app CALL. Shipping the palette the',
    'starter came with is the commonest way a build looks generated, and it is the',
    'first thing anyone notices. A blocked-out page in the colours this app chose',
    'beats a finished page in the ones it was handed.',
    '',
    'add_block gives you structure, never a look. A block arrives with no opinion',
    'about this app and is yours to tint the moment it lands. Assembling blocks and',
    'shipping them as they came is the quick way to something nobody designed.',
    '',
    'Never repeat the request back. Not as a summary, not as a restatement, not as',
    'a list of what was asked for. They wrote it and it is on the screen above you.',
    'Do not narrate your planning either - which files you will make, what order you',
    'will do them in, what you are about to consider. Say what you are building and',
    'then build it.',
    '',
    'SPEAK AS "I", NEVER "WE". You are doing this, not a committee: "I will build',
    'Tide as a single HTML file", not "we have created the file".',
    '',
    'Say three or four things over a whole build, not one per step:',
    '  - Open with what you are going to make and how, in one line, before anything',
    '    else: "I will build Tide as a single HTML file - markup, one stylesheet, one',
    '    module - with the tasks kept in localStorage."',
    '  - One line when you move between the big pieces of work: "The layout is done,',
    '    now the animations."',
    '  - One line at the end saying what it does and how to try it.',
    'That closing line is ONE OR TWO SENTENCES, and FIVE LINES IS THE HARD CEILING.',
    'Never a checklist, never a feature list, never ticks or bullets walking through',
    'the request item by item, never a list of the files you touched - the user',
    'watched them go past. "Tide is built - open tide/index.html, or serve the folder',
    'and visit it." Anything longer is a status report nobody asked for, and it is',
    'the last thing on screen, so it is what the whole session looks like. ucode cuts',
    'the closing message to five lines before it is drawn, so anything past that is',
    'written for nobody: say the one thing that matters and stop.',
    'That is all. A line before every tool call is not narration, it is noise: the',
    'steps already show on screen, and repeating them in words buries the few',
    'sentences worth reading.',
    '',
    'YOUR FIRST WORDS, BEFORE ANY TOOL CALL, EVERY TIME. Nothing else appears on',
    'screen while you work, so if you say nothing the user watches a blank page.',
    '',
    'Open with one plain sentence naming the thing and the shape of it:',
    '  I will build Tide for you - a tasks app in a single HTML file, dark with a',
    '  teal accent.',
    'Then one line whenever you start a new piece of the work:  Now the filter row.',
    'Then one line at the end saying it is done.',
    '',
    'Plain words only. No methodology, no "component-based approach", no',
    '"structured design", no listing the qualities the work will have. Never',
    '"I need to", never "Let me", never a plan of which files you will touch, never',
    'the request repeated back. Say it the way you would to someone watching over',
    'your shoulder, who can already see the screen.',
    '',
    'Every one of those lines is ONE SENTENCE, because that is all that is drawn:',
    'anything you write beside a tool call is cut to a single status line, so a',
    'paragraph there loses everything after its first sentence. The closing message',
    '- the one with no tool call after it - is the only prose the user reads.',
    '',
    JS_LOGIC,
    '',

    '',
    '',
    'NEVER ASSUME A LIBRARY IS THERE. Not React, not lodash, not a component kit,',
    'however well known it is. Check what this project already uses before you reach',
    'for it: its package.json, the file next to the one you are writing, what the',
    'starter actually shipped. The plain-html starter has no build step and no',
    'packages at all, so JSX, TypeScript and bare module imports are not syntax it',
    'can run — a JSX tag in a plain module is a page that renders nothing and one',
    'unexpected-token error in the console. Write what the project can execute.',
    '',
    'CALL TOOLS TOGETHER WHEN THEY DO NOT DEPEND ON EACH OTHER. Several can go in',
    'one reply and they run at the same time. Six files is one read_files in one',
    'message, never six read_file calls in six — each of those is a round trip you',
    'and the user sit through. Same for independent searches, same for commands',
    'that do not feed each other.',
    '',
    'POINT AT CODE AS file:line. The filter is built in src/app.js:42 — not in the',
    'app file somewhere near the filter. One of those the reader can open; the',
    'other they have to go hunting from.',
    'Before you guess at an API, ask: type_of gives the exact signature from the',
    'TypeScript this project has installed, and find_symbol says where something is declared without',
    'reading five files to find it. Rename with rename_symbol rather than edit_file — a',
    'find-and-replace that matches too much is the most common broken edit.',
    '',
    'CALL add_block BEFORE WRITING A LIST, A FILTER ROW, A STORE, A DIALOG, A TOAST, A',
    'THEME TOGGLE, A TABLE OR AN EMPTY STATE BY HAND. It has all of those, written for',
    'whichever starter this app uses, keyboard and empty states included, and each one',
    'is a hundred lines you do not have to type. Typing is the slowest part of a build:',
    'a page assembled from blocks is finished minutes before the same page typed out.',
    '',
    ...(mode === 'plan' ? [
      'You are in PLAN MODE. Reading, searching and research are available; every tool',
      'that writes a file or runs a command has been withheld. Investigate, then set out',
      'what you would change: which files, which functions, in what order. Never imply',
      'you have made a change you are not able to make.',
      '',
    ] : []),
    ...(check ? [
      `This project checks itself with: ${check}`,
      'After changing code, run that and report what actually happened. "It should work"',
      'is not a result.',
      '',
    ] : []),
    '- Read before you write. Never edit a file you have not read this session.',
    '- Prefer edit_file to write_file. Rewrite a whole file only when creating it, or',
    '  when the change genuinely touches most of it.',
    '- old_string must be copied out of what read_file showed you, character for',
    '  character, without the line-number gutter, and must appear exactly once. Add',
    '  surrounding lines until it does.',
    '- read_file returns up to 600 lines. Read the whole file before editing it rather',
    '  than editing from a fragment; pass offset to continue a long one.',
    '',
    '## Going fast',
    '',
    'Every tool call is a round trip to you, and the round trip — not the disk, not',
    'the shell — is where the time goes. So:',
    '',
    '- Need more than one file? read_files, all of them in one call. Never read files',
    '  one at a time when you already know which ones you want.',
    '- An edit result shows the file as it now stands. Do not read a file again after',
    '  editing it - you already have its current text.',
    '- Put independent calls in the same message — several greps, a glob and a read.',
    '  Read-only calls in one message run at the same time.',
    '- New Next.js app? create_app - one step, never create-next-app or shadcn init. It',
    '  copies a starter that already builds and installs it in the background.',
    '- batch_write to lay out several new files at once - but at most about four per',
    '  call: one slip in a huge call throws the whole call away.',
    '- multi_edit for several changes',
    '  to one file, edit_files for a change that spans several files.',
    '- For work with three or more steps, keep a short plan with update_plan - at most',
    '  six items of a few words - and tick items off as they finish. Skip it for small jobs.',
    '- When a build splits into parts that touch different files (the API route, the',
    '  upload component, the results view), set up the shared files yourself, then hand',
    '  the parts to delegate so they are built in parallel.',
    '- A package.json you write starts installing in the background immediately; keep',
    '  writing files. Running the install yourself afterwards just waits for that one.',
    '- When you finish, ucode type-checks what you changed and hands you the errors, so',
    '  there is no need to run tsc yourself.',
    '- Do not open or drive a browser. Checking the page in one is something the user',
    '  asks for with /look; your job is to leave the app in a state worth looking at.',
    '  When ucode hands back problems it found, fix exactly those and nothing else: a',
    '  fix round is not a chance to restyle or rewrite what already works.',
    '- ANYTHING THAT NEEDS A SERVER IS LEFT RUNNING. If the app has a dev server -',
    '  Next.js, Vite, anything with an npm run dev - start it and leave it up when you',
    '  finish. ucode opens it in the browser for the user as soon as it is ready, so a',
    '  build that ends with the server stopped ends with nothing to look at. A one-page',
    '  app with no server needs none of this: the file is the app. Write all of it in',
    '  (HTML, CSS AND the JavaScript that makes every button work: add, complete, delete,',
    '  filter, save to localStorage. A page whose buttons do nothing is not an app)',
    '  create_app\'s files, then stop: ucode opens the page itself and hands it to the',
    '  user the moment it works. Do not start a server, curl it or re-read it to check.',
    '- Nothing you run has a keyboard. Pass the non-interactive flag to anything that',
    '  would ask a question, or it fails instead of waiting: create-next-app --yes,',
    '  npx shadcn@latest init -d -y, npx shadcn@latest add <names> -y, npm init -y.',
    '- Dev servers start in the background by themselves, and the result tells you the',
    '  URL once the server says it is ready. Do not start one twice, do not sleep while',
    '  waiting for it, and do not curl it before that result comes back.',
    '',
    '## When something fails',
    '',
    '- A failed build names the problem. Fix exactly that, then build again. Never go',
    '  exploring inside node_modules: a missing component or package is one install away.',
    '- A build takes most of a minute. Fix every error it lists in one pass - multi_edit,',
    '  edit_files - before building again, never one error per build.',
    '- Never delete an app folder to start over. Fix it where it is - starting again throws',
    '  away the install and everything already written.',
    '- Run an app\'s commands with cwd set to its folder, and keep paths inside those',
    '  commands relative to that folder.',
    '',
    '## Safety',
    '',
    '- run_command runs without asking. That is trust rather than licence: never run',
    '  anything destructive the user did not ask for.',
    '- Paths are relative to the working directory. Anything outside it needs the user',
    '  to approve it first.',
    '- Verify. After changing code, run the tests or a quick check with run_command.',
    '',
    '## Saying what you are doing',
    '',
    '- Before every tool call, write ONE short line naming the file or command:',
    '  "Reading tui.js", "Fixing the spinner in loop.js", "Running npm test".',
    '- Present tense, under ten words, and no full stop at the end. It is a label on',
    '  work happening right now, not a sentence about work that is finished.',
    '- That line and nothing else in the message. No preamble, no plan, no bullets —',
    '  the user reads it live while the tool runs.',
    '- Say the next one when you take the next step, not all of them up front.',
    '',
    '## Answering',
    '',
    '- Be short. Two or three sentences is usually the entire answer. This is a',
    '  terminal, not a document.',
    '- No preamble, no restating the question, no "I will now...". Just answer.',
    '- Do not narrate what the tool output already showed. The user watched the diff',
    '  and the command output; cover only what is not obvious from them.',
    '- Skip closing summaries of work the user just watched you do — but never end',
    '  a turn silently. If there is genuinely nothing to add, one short line saying',
    '  what changed is the whole answer.',
    '- Markdown. Fenced blocks with a language tag get highlighted.',
    '- Point at code as path:line so the user can jump straight to it.',
    '- Report honestly. If a command failed or you skipped something, say so.',
    '- Length tracks the question: a one-line question gets a one-line answer.',
    '- Brevity is about your prose and never about your work. What you build is',
    '  finished: every control wired, every state handled, no TODO left behind.',
    ...(list ? [
      '',
      '## Skills',
      '',
      'These instruction packs are available. When a task matches one, load it with',
      'load_skill as your first step — before planning, before writing anything — and',
      'then follow it. A skill already in this conversation outranks your own defaults',
      'and is not advisory.',
      '',
      list,
    ] : []),
    '',
    '## Project map',
    '',
    'Every file in the project at the start of this turn, with the names each code file',
    'exports. Go straight to the files you need instead of searching for them.',
    '',
    map || '(not available)',
  ].join('\n');
}

export class Agent {
  constructor({ cwd, debug = false, ui = null }) {
    this.cwd = cwd;
    this.debug = debug;
    // A full-screen layout only makes sense on a real terminal. Piped input,
    // CI and `echo ... | ucode` get the line-based interface instead.
    this.full = ui ? ui instanceof Screen : Boolean(process.stdout.isTTY && process.stdin.isTTY);
    this.ui = ui ?? (this.full ? new Screen({ cwd }) : new Plain({ cwd }));
    this.stats = newStats();
    this.skills = [];
    this.session = newSession(cwd, model());
    this.working = [];
    this.loaded = new Set();
    this.short = new Set();   // loaded as a digest, so load_skill can still fetch the whole thing
    this.abort = null;
    this.busy = false;
    this.check = null;
  }

  // -- history -------------------------------------------------------------

  push(message) {
    this.session.messages.push(message);
    this.working.push(message);
  }

  /**
   * Answer every tool call a stopped turn never got to.
   *
   * An assistant message ends by asking for tools, and each of those asks
   * needs an answer. Abandon them and the conversation is left mid-sentence,
   * so the next time the model reads it the only sensible thing to do is
   * carry on where it left off — which is exactly what the user pressed stop
   * to prevent. Saying "this did not happen" for each one ends the sentence,
   * and a line from the user ends the task.
   */
  closeInterrupted() {
    const answered = new Set(this.working.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
    const missing = [];
    for (const m of this.working) {
      if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
      for (const call of m.toolCalls) {
        if (!answered.has(call.id)) missing.push(call);
      }
    }
    for (const call of missing) {
      this.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: 'The user stopped the turn before this ran. It did not happen, and it must not be retried.',
      });
    }
    if (missing.length) {
      this.push({
        role: 'user',
        content: 'I stopped that. Drop it and wait for what I ask next — do not pick it back up.',
      });
    }
    return missing.length;
  }

  /**
   * Write the session out - without the turn waiting for it.
   *
   * The whole file is rewritten every time, and this is called after every
   * model reply and every round of tools. On a long build that was the same
   * growing file serialized hundreds of times, on the critical path, so the
   * loop sat waiting on the disk for work it had already finished.
   *
   * Now a save that is already running absorbs the next request rather than
   * queueing behind it: the writer loops until nothing is dirty, and what it
   * writes is always the newest state, because the snapshot is taken inside
   * save(). Callers may still await this - it settles at once - and everywhere
   * durability actually matters (the end of a turn, shutdown, a signal) awaits
   * settled() as well.
   */
  persist() {
    this.session.model = model();
    this.dirty = true;
    if (!this.saving) {
      this.saving = (async () => {
        try {
          while (this.dirty) {
            this.dirty = false;
            await save(this.session);
          }
        } catch (err) {
          // Losing the save must not lose the turn.
          this.ui.error(err, { debug: this.debug });
        } finally {
          this.saving = null;
        }
      })();
    }
    return Promise.resolve();
  }

  /** Wait for whatever is being written to reach the disk. */
  async settled() {
    while (this.saving) await this.saving;
  }

  // -- startup -------------------------------------------------------------

  /**
   * Everything a turn needs, minus the terminal.
   *
   * Split out of start() so another front end could prepare an agent and drive
   * turn() itself.
   */
  async bootstrap() {
    setRoot(this.cwd);
    // Parallel workers can ask at the same moment; the questions queue up and
    // are put to the user one at a time, never on top of each other.
    let asking = Promise.resolve();
    setConfirm((request) => {
      const next = asking.then(() => this.ui.confirm(request));
      asking = next.catch(() => {});
      return next;
    });
    this.skills = await loadSkills({ cwd: this.cwd });
    await this.detectCheck();
  }

  async start() {
    await this.bootstrap();

    if (this.full) {
      await this.ui.start();
      this.ui.onInterrupt = () => {
        if (this.busy && this.abort) {
          this.abort.abort();
          this.ui.stopSpinner();
          this.ui.stopTimer?.();
          this.ui.note('interrupted');
        }
      };
      this.ui.onModeChange = () => this.showHeader({ clear: false });
    }

    for (const problem of this.skills.problems ?? []) {
      this.ui.write(theme.warn(`  skill not loaded: ${problem}`));
    }

    this.showHeader();
    this.installSignals();

    // Checked in the background; nothing here waits on it.
    autoUpdate({
      onUpdated: (version) => {
        this.ui.setFacts?.({ update: version });
        if (!this.ui.welcoming?.()) this.ui.note(`updated to v${version} — it takes over the next time you start ucode`);
      },
    });
    await this.repl();
  }

  showHeader({ clear = true } = {}) {
    if (clear && this.full) this.ui.clearScreen();
    const stats = usage(this.working, contextLimit());
    this.ui.header({
      cwd: this.cwd,
      model: modelName(),
      used: stats.used,
      limit: stats.limit,
      title: this.session.title === 'Untitled' ? 'new session' : this.session.title,
    });
  }

  installSignals() {
    const flush = async () => {
      await save(this.session).catch(() => {});
      process.exit(0);
    };
    process.on('SIGTERM', flush);

    // The full-screen UI reads keys itself, so it owns ctrl+c and esc.
    if (this.full) return;

    this.ui.rl.on('SIGINT', () => {
      if (this.busy && this.abort) {
        this.abort.abort();
        this.ui.stopSpinner();
        this.ui.write(dim('  interrupted'));
        return;
      }
      this.ui.write(dim('  (ctrl+d or /exit to quit)'));
      this.ui.rl.prompt();
    });
  }

  /**
   * How this project verifies itself, worked out once at startup. Null when
   * there is genuinely nothing to run — verification is only insisted on where
   * there is something to insist on.
   */
  async detectCheck() {
    const has = (f) => readFile(path.join(this.cwd, f)).then(() => true, () => false);

    if (await has('package.json')) {
      try {
        const pkg = JSON.parse(await readFile(path.join(this.cwd, 'package.json'), 'utf8'));
        if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
          this.check = 'npm test';
          return;
        }
      } catch { /* an unreadable package.json is not worth failing over */ }
    }
    if (await has('Cargo.toml')) { this.check = 'cargo test'; return; }
    if (await has('go.mod')) { this.check = 'go test ./...'; return; }
    if (await has('pyproject.toml') || await has('pytest.ini')) { this.check = 'pytest'; return; }
    if (await has('Makefile')) { this.check = 'make test'; return; }
    this.check = null;
  }

  // -- REPL ----------------------------------------------------------------

  async repl() {
    let sawInput = false;

    for (;;) {
      const line = await this.ui.ask();
      if (line === null) {
        // End of input before anything was typed. On Windows this is almost
        // always npm's PowerShell shim, which runs the CLI as `$input | node`.
        // The pipe makes stdin a non-TTY, readline hits EOF at once, and the
        // banner flashes up and vanishes — which looks like a crash rather
        // than like a program that was never given a keyboard. So say which.
        if (!sawInput && !process.stdin.isTTY) this.explainNoKeyboard();
        break;
      }

      const input = line.trim();
      if (input) sawInput = true;
      if (!input) continue;

      if (input.startsWith('/')) {
        if (await this.command(input) === 'exit') break;
        continue;
      }

      try {
        await this.turn(input);
      } catch (err) {
        this.ui.error(err, { debug: this.debug });
      }
    }

    await this.shutdown();
  }

  explainNoKeyboard() {
    this.ui.blank();
    this.ui.write(theme.warn('  ucode could not reach the keyboard, so it stopped.'));
    this.ui.blank();
    this.ui.write('  That happens when input is piped rather than typed. On Windows it is');
    this.ui.write("  usually npm's PowerShell wrapper, which pipes stdin.");
    this.ui.blank();
    this.ui.write(`  ${blue('Any of these work:')}`);
    this.ui.write(`    ${sky('ucode.cmd')}          the cmd shim, which keeps the keyboard`);
    this.ui.write(`    ${sky('npx ucode-agent')}    runs it directly`);
    this.ui.write('    or start it from Command Prompt or Windows Terminal');
    this.ui.blank();
  }

  async shutdown() {
    await closeBrowser().catch(() => {});
    this.ui.stopSpinner();
    if (this.session.messages.length) {
      await this.persist();
      await this.settled();
      this.ui.write(dim(`\n  saved · ${this.session.title}`));
    }
    this.ui.close();
  }

  // -- one turn ------------------------------------------------------------

  /**
   * Pull image paths out of the message and load them, so "what is wrong in
   * screenshot.png" works without a separate command for it.
   */
  async attachImages(input) {
    const mentioned = input.match(/[^\s"']+\.(?:png|jpe?g|gif|webp)\b/gi) ?? [];
    const images = [];

    for (const name of mentioned) {
      const file = path.resolve(this.cwd, name);
      try {
        const buf = await readFile(file);
        if (buf.length > 4 * 1024 * 1024) {
          this.ui.note(`${name} is ${(buf.length / 1024 / 1024).toFixed(1)}MB — too big to send, skipped`);
          continue;
        }
        const ext = path.extname(file).toLowerCase().slice(1);
        images.push(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`);
        this.ui.note(`attached ${name}`);
      } catch {
        // Just a filename mentioned in passing, not a file on disk.
      }
    }

    return images;
  }

  /**
   * Skills that this request should arrive with, already loaded.
   *
   * The load_skill tool asks the model to notice that a task needs a skill,
   * and a model in a hurry to be helpful does not always notice. For work
   * where the skill *is* the quality bar — anything with a user interface in
   * it — that is not a discovery to make after the app has been built. So the
   * request is matched against each skill's trigger words and the body goes in
   * before the model takes its first step.
   */
  autoLoad(input) {
    for (const skill of autoLoadFor(this.skills, input)) {
      if (this.loaded.has(skill.name)) continue;
      // The short form where the skill has one. Everything loaded here is
      // re-read by the provider on every step of the build, so the depth is
      // left behind load_skill and the rules come now.
      const message = skillMessage(skill, { automatic: true, short: true });
      this.loaded.add(skill.name);
      if (message.short) this.short.add(skill.name);
      // Nothing on screen: which rules the model was handed is bookkeeping,
      // and the only text a build should leave is the answer at the end.
      this.push(message);
    }
  }

  async turn(input) {
    // From here every file this turn writes keeps a copy of how it was, so
    // /undo can put the whole turn back.
    beginTurn();
    this.lookedThisTurn = false;
    this.lookAgain = null;
    this.handOverPending = false;
    this.appName = null;
    this.appTemplate = null;
    this.reads = new Map();
    this.declines = 0;
    this.apps = [];
    this.wrote = new Map();
    forgetReviews(); // a new request: its apps get a fresh design review
    setRequest(input); // create_app checks this before choosing a starter
    const images = await this.attachImages(input);
    // The skill goes in ahead of the request, so the request is the last
    // thing the model reads. After it, a page of house rules was what the
    // model answered: asked for a dark mode toggle on its second turn, a live
    // run re-read two files and repeated its first turn's summary instead.
    this.autoLoad(input);
    this.push(images.length
      ? { role: 'user', content: input, images }
      : { role: 'user', content: input });

    if (!this.session.title || this.session.title === 'Untitled') {
      this.session.title = titleFrom(input);
    }
    // What the model is told about the project, fresh for this turn.
    [this.map, this.memory] = await Promise.all([
      projectMap(this.cwd).catch(() => ''),
      loadMemory(this.cwd).catch(() => ''),
    ]);
    // Nothing to look up in an empty folder, so those tools do not go out with
    // the request. Decided per turn: the moment there is code, they are back.
    this.fresh = !hasCode(this.map);
    this.wantsWeb = WANTS_WEB.test(input);
    await this.persist();

    // A busy model was swapped for a fallback earlier; after a few minutes the
    // one the user chose gets another go.
    this.preferred ??= model();
    if (model() !== this.preferred && Date.now() > (this.cooldownUntil ?? 0)) {
      setModel(this.preferred);
      if (this.full) this.showHeader({ clear: false });
    }

    this.busy = true;
    this.abort = new AbortController();
    this.endedSilently = false;

    const turnStarted = Date.now();
    let finished = false;
    this.ui.turnStart?.();
    try {
      for (;;) {
        try {
          await this.run();
          break;
        } catch (err) {
          // The daily free cap mid-build: wait for the reset and carry on,
          // rather than leaving a half-built app for the user to restart.
          if (err?.detail?.daily && !this.abort.signal.aborted && (await this.waitForReset(err))) continue;
          throw err;
        }
      }
      finished = true;
    } catch (err) {
      if (err?.kind === 'aborted' || this.abort.signal.aborted) this.ui.write(dim('  turn cancelled'));
      else throw err;
    } finally {
      trace({ kind: 'turn', ms: Date.now() - turnStarted });
      this.stats.workMs += Date.now() - turnStarted;
      this.stats.turns++;
      if (!finished) this.closeInterrupted();
      const ok = finished && !this.endedSilently;
      this.busy = false;
      this.abort = null;
      this.ui.stopSpinner();
      this.ui.stopTimer?.();
      this.activity = null;
      await this.persist();
      await this.settled();
      if (this.full) this.showHeader({ clear: false });
      if (finished) this.openWhenReady(turnStarted);
      // Last, so "Done" is the last thing that happens rather than the last
      // thing said before several more things happen.
      this.ui.turnEnd?.({ ok });
    }
  }

  /**
   * The tools the model may see, given the mode and what is in the folder.
   *
   * A new project has nothing to look up: no symbol to find, nothing to
   * rename, no types to ask about, and — unless the request says otherwise —
   * nothing to search the web for. Their schemas are eight hundred tokens the
   * provider re-reads on every step of the build, and they are also five more
   * wrong turns available to a model deciding what to do next.
   */
  toolsNow() {
    const all = [...tools, loadSkillTool, planTool, delegateTool];
    const live = this.fresh
      ? all.filter((t) => !LOOKUP_TOOLS.has(t.name) && !(t.name === 'web_search' && !this.wantsWeb))
      : all;
    if (this.ui.mode !== 'plan') return live;
    return live.filter((t) => !WRITES.has(t.name));
  }

  /** Model, tools, model, until it answers with prose. */
  async run() {
    const available = this.toolsNow();
    this.offering = new Set(available.map((t) => t.name));
    let argRetries = 0;
    let continuations = 0;
    let askedToVerify = false;
    let squeezed = false;
    let askedToSpeak = false;
    let fixRounds = 0;
    this.failovers = 0;
    this.tried = new Set([model()]);

    this.stuck = new StuckWatch();
    this.touched = new Set();
    this.sinceCheck = new Set();
    this.logWatch = new LogWatch();
    this.ranSomething = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      await this.maybeFold();
      this.ui.startSpinner(step === 0 ? 'thinking' : 'working');

      let reply;
      let streaming = false;
      this.early = new Map();

      try {
        const opts = {
          signal: this.abort.signal,
          onWait: (text) => this.ui.updateSpinner(text),
        };
        // Only a real terminal has somewhere to stream into.
        if (this.full) {
          opts.onThinking = (delta) => this.ui.thinkingDelta(delta);
          opts.onText = (delta) => {
            if (!streaming) {
              streaming = true;
              this.ui.thinkingEnd();
              this.ui.streamBegin();
            }
            this.ui.streamDelta(delta);
          };
          // Read-only calls start the moment they are fully written, while the
          // rest of the reply is still arriving. Nothing that writes or runs is
          // started early: a reply that fails halfway must leave no side effects.
          opts.onToolCall = (call) => {
            if (PARALLEL_SAFE.has(call.name) && !call.parseError && !this.early.has(call.id)) {
              this.early.set(call.id, this.execute(call));
            }
          };
          // A whole app is one tool call whose arguments take a minute or two
          // to arrive, and nothing can be started until they have. What can
          // happen is saying where it has got to: the files are named in the
          // order they are written, so the spinner names the one being
          // written now instead of sitting on "working" for ninety seconds.
          const writing = new Writing();
          opts.onToolArgs = ({ index, name, args }) => {
            const at = writing.seen(index, name, args);
            if (at) this.ui.updateSpinner(at);
          };
        }

        var asked = Date.now();
        reply = await ask(
          [
            {
              role: 'system',
              content: systemPrompt({
                cwd: this.cwd,
                skills: this.skills,
                mode: this.ui.mode,
                check: this.check,
                map: this.map,
                memory: this.memory,
              }),
            },
            ...dedupe(lean(this.working)),
          ],
          available,
          opts
        );
      } catch (err) {
        this.ui.thinkingEnd();
        if (streaming) this.ui.streamEnd();

        // The model invented a tool and the provider rejected the request
        // outright. Tell it what it did and let it try again.
        if (err.kind === 'bad_tool_call' && argRetries < MAX_ARG_RETRIES) {
          argRetries++;
          this.ui.stopSpinner();
          this.ui.toolFailed(
            `${err.detail?.attemptedName ?? 'invalid tool call'} — retrying (${argRetries}/${MAX_ARG_RETRIES})`
          );
          this.push({
            role: 'user',
            content:
              `Your last tool call was rejected. ${err.failed} The only tools that exist ` +
              `are: ${available.map((t) => t.name).join(', ')}. Try again with one of them.`,
          });
          continue;
        }

        // An oversized conversation is a recoverable thing, not a dead end.
        //
        // The provider rejects the request, ucode prints the error and the
        // half-built app stops there; typing "continue" sends the same
        // oversized conversation again and fails the same way. Folding it and
        // trying once is what the user would be told to do, so it happens
        // without asking.
        if ((err.kind === 'too_large' || err.kind === 'bad_request') && !squeezed && !this.abort.signal.aborted) {
          squeezed = true;
          const before = this.working.length;
          await this.maybeFold({ force: true });
          if (this.working.length < before) {
            this.ui.note('the conversation had grown too large — folded it and carried on');
            continue;
          }
        }

        // Busy, slow or down: move to the next model and carry on, rather
        // than ending a half-built app with an error.
        if (passing(err) && !this.abort.signal.aborted && (await this.failover(err))) continue;
        throw err;
      }

      // A reply that is nothing but tool calls never starts a text stream, so
      // the thinking timer has to be closed out here as well.
      this.ui.thinkingEnd();
      this.ui.stopSpinner();
      this.record(reply.usage);
      this.ui.step?.();
      this.stats.steps++;
      this.stats.tokensIn += reply.usage.promptTokens ?? 0;
      this.stats.tokensOut += reply.usage.outputTokens ?? 0;
      trace({
        kind: 'model', who: 'lead', model: model(), ms: Date.now() - asked,
        in: reply.usage.promptTokens, out: reply.usage.outputTokens,
        calls: reply.toolCalls.map((c) => c.name),
      });

      // Streamed text is already on screen; turn it into rendered markdown.
      // Text that turns out to be narration ahead of a tool call folds into a
      // status line instead — that is where the live commentary comes from.
      const narrating = reply.toolCalls.length > 0;
      // No tool calls left and something was actually done: this is the closing
      // message, the last thing on screen, and it gets cut to eight lines.
      const closing = !narrating && (this.touched.size > 0 || this.ranSomething);
      if (streaming) this.ui.streamEnd({ asNarration: narrating, closing });
      // Anything said beside a tool call is narration, however long it ran on:
      // it is cut to a status line instead of being printed as an answer. Only
      // the closing message — the one with no tool call after it — is prose.
      else if (reply.text && narrating) this.ui.narrate(asNarrationLine(reply.text));
      else if (reply.text) this.ui.assistant(reply.text, { closing });
      if (closing && reply.text) this.checkClaims(reply.text);

      if (reply.toolCalls.length === 0) {
        // The answer stopped at the provider's output cap rather than at the
        // end of a thought, so it is cut mid-word. Ask for the rest instead of
        // handing over half an answer with no sign there was more.
        if (reply.finishReason === 'length' && reply.text && continuations < MAX_CONTINUATIONS) {
          continuations++;
          this.push({ role: 'assistant', content: reply.text });
          this.push({
            role: 'user',
            content:
              'Your reply stopped at the output limit, mid-sentence. Carry on from exactly ' +
              'where it broke off. Do not repeat any of it, do not start again, and do not ' +
              'introduce it — just continue.',
          });
          this.ui.note('hit the output limit — asking for the rest');
          continue;
        }

        // Type-check what changed and hand back the errors, a few rounds at most.
        // A turn that ends on a broken build is the most common way an app
        // gets handed over as done when it is not.
        if (fixRounds < MAX_FIX_ROUNDS) {
          const problems = await this.autoCheck();
          if (problems) {
            fixRounds++;
            if (reply.text) this.push({ role: 'assistant', content: reply.text });
            this.push({
              role: 'user',
              content:
                `ucode checked the files you changed and found errors (round ${fixRounds} of ` +
                `${MAX_FIX_ROUNDS}). Fix all of them with the smallest edits that do it, then ` +
                'finish. Change nothing else - no restyling, no rewrites of code that works.' +
                `\n\n${problems}`,
            });
            continue;
          }
        }

        // It changed code and never ran anything. Send it back once — but
        // only if this project's check would actually exercise what changed.
        // A page and a stylesheet in a repo that happens to have `npm test`
        // was costing a whole round trip to run someone else's unit tests
        // against a file they have never heard of, when the page's own script
        // was parsed locally a moment ago.
        if (this.touched.size && !this.ranSomething && this.check && !askedToVerify &&
            !(await pagesOnly(this.touched, this.cwd))) {
          askedToVerify = true;
          if (reply.text) this.push({ role: 'assistant', content: reply.text });
          this.push({
            role: 'user',
            content:
              `You changed ${[...this.touched].join(', ')} and did not check it. Run ` +
              `\`${this.check}\` with run_command now, then say what actually happened — ` +
              'if it failed, show the output rather than claiming it worked. If that is ' +
              'the wrong way to check this project, run the right one and say which.',
          });
          this.ui.note('verifying the change');
          continue;
        }

        /**
         * It did the work and then said nothing at all.
         *
         * Reasoning models do this, and the instruction to skip closing
         * summaries makes it more likely. Silence is fine as a style; it is
         * not fine as an answer, because the user cannot tell it apart from a
         * crash — and if they asked what happened, they asked. One nudge,
         * once per turn, and only when there was actually work to report.
         */
        if (!reply.text?.trim() && this.touched.size + (this.ranSomething ? 1 : 0) > 0 && !askedToSpeak) {
          askedToSpeak = true;
          this.push({
            role: 'user',
            content:
              'You stopped without saying anything. If the thing I asked for is not ' +
              'built yet, carry on and build it. If it is, tell me in one or two ' +
              'sentences what it does and how to try it. No preamble, no diffs.',
          });
          continue;
        }

        // An assistant message with no content and no tool calls is not a turn,
        // it is a hole. Providers reject the whole conversation as malformed
        // once one is in it — which showed up as HTTP 400 on every request
        // after the model went quiet, with the conversation at 0% full and
        // "usually an oversized conversation" printed underneath it.
        if (reply.text?.trim()) this.push({ role: 'assistant', content: reply.text });
        if (!reply.text?.trim()) {
          // Silence after being asked to speak is not a finished turn. Saying
          // "Done" here is the worst thing available: the user believes it,
          // looks, and finds the thing they asked for was never built.
          this.ui.note('the model stopped without saying anything — the work may be unfinished');
          this.endedSilently = true;
        }
        return;
      }

      this.push({ role: 'assistant', content: reply.text || '', toolCalls: reply.toolCalls });
      await this.persist();

      const badArgs = await this.runCalls(reply.toolCalls);
      if (this.abort.signal.aborted) return;

      // The app is written: see whether it works, and if it does, that is the
      // answer. Waiting for the model to decide it is finished was most of the
      // time a build took (see handOver).
      const handed = badArgs ? null : await this.handOver(reply.toolCalls);
      if (handed?.done) return;
      if (handed?.problems && fixRounds < MAX_FIX_ROUNDS) {
        fixRounds++;
        this.push({
          role: 'user',
          content:
            `ucode opened the app and found errors (round ${fixRounds} of ${MAX_FIX_ROUNDS}). Fix all ` +
            'of them with the smallest edits that do it. Change nothing else. As soon as it works, ' +
            `ucode hands it to the user.\n\n${handed.problems}`,
        });
        await this.persist();
        continue;
      }

      // Malformed arguments go back to the model, but only so many times.
      if (badArgs) {
        argRetries++;
        if (argRetries > MAX_ARG_RETRIES) {
          throw new Failure({
            kind: 'bad_tool_args',
            attempted: 'running the tools the model asked for',
            failed:
              `${modelName()} produced invalid tool arguments ${argRetries} times running ` +
              'and could not correct itself.',
            fix:
              'Say what you want more concretely, or /model to another one — North Mini ' +
              'Code and Nemotron 3.5 Lightning are both steadier with tool arguments.',
          });
        }
      } else {
        argRetries = 0;
      }

      await this.persist();
    }

    throw new Failure({
      kind: 'step_limit',
      attempted: 'finishing your request',
      failed: `The model was still calling tools after ${MAX_STEPS} steps.`,
      fix:
        'Nothing is lost — everything so far is on disk. Say "carry on where you left ' +
        'off" to continue. If it was repeating one step, it is looping: break the task ' +
        'up, or /new to reset.',
    });
  }

  /**
   * Run one round of tool calls.
   *
   * Consecutive read-only calls go out together — four files read at once
   * rather than four round trips — while anything that writes or executes runs
   * on its own, in order. Returns whether any call had unusable arguments.
   */
  async runCalls(calls) {
    const groups = [];
    let batch = [];

    for (const call of calls) {
      if (PARALLEL_SAFE.has(call.name)) {
        batch.push(call);
      } else {
        if (batch.length) { groups.push(batch); batch = []; }
        groups.push([call]);
      }
    }
    if (batch.length) groups.push(batch);

    let badArgs = false;

    for (const group of groups) {
      if (this.abort.signal.aborted) return badArgs;

      const noted = (call) => {
        if (FILE_WRITES.has(call.name)) {
          for (const p of pathsOf(call)) { this.touched.add(p); this.sinceCheck.add(p); this.forgetReads(p); }
        }
        if (call.name === 'run_command' || call.name === 'run_commands') this.ranSomething = true;
      };

      if (group.length > 1) {
        for (const call of group) {
          this.ui.toolCall(describe(call.name, call.args));
          noted(call);
        }
        this.ui.startSpinner(`${group.length} lookups at once`);

        const settled = await Promise.all(
          group.map((call) => (this.early.get(call.id) ?? this.execute(call)).then((r) => ({ call, ...r })))
        );

        this.ui.stopSpinner();
        for (const { call, out, err } of settled) {
          if (err) badArgs = this.reportFailure(call, err) || badArgs;
          else this.reportResult(call, out);
        }
        continue;
      }

      for (const call of group) {
        if (this.abort.signal.aborted) return badArgs;

        const label = describe(call.name, call.args);
        if (!SILENT.has(call.name)) this.ui.toolCall(label);
        this.ui.startSpinner(label);
        noted(call);

        const { out, err } = await (this.early.get(call.id) ?? this.execute(call));
        this.ui.stopSpinner();
        if (err) badArgs = this.reportFailure(call, err) || badArgs;
        else this.reportResult(call, out);
      }
    }

    return badArgs;
  }

  /**
   * Check a finished call against the stuck patterns (see stuck.js) and return
   * the note to add to its result. A nudge that did not work hands the turn to
   * another model.
   */
  stuckNote(call, outcome) {
    if (!this.stuck) return '';
    const verdict = this.stuck.observe(eventFor(call, outcome));
    if (!verdict) return '';
    this.stats.stuck++;
    if (verdict.action === 'switch') {
      const next = fallbackFor(model(), this.tried ?? new Set([model()]));
      if (next) {
        this.tried?.add(next);
        this.ui.note(`${modelName(model())} kept ${describeHit(verdict.hit)} — handing over to ${modelName(next)}`);
        setModel(next);
        this.cooldownUntil = Date.now() + COOLDOWN;
        if (this.full) this.showHeader({ clear: false });
      }
    }
    return verdict.text ? `\n\n${verdict.text}` : '';
  }

  /**
   * The daily free cap was hit mid-turn: keep the session, count down to the
   * reset, and carry on by itself. Esc stops the wait like any other turn.
   */
  async waitForReset(err) {
    const resetAt = err.detail?.resetAt;
    if (!Number.isFinite(resetAt)) return false;
    const at = resetAt + 30_000;
    const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.ui.stopSpinner();
    this.ui.note(`Daily limit reached — ucode carries on by itself at ${clock}. Esc to stop`);
    await this.persist();
    let lastNote = Date.now();
    while (Date.now() < at) {
      if (this.abort?.signal.aborted) return false;
      const left = formatDuration(at - Date.now());
      if (this.full) this.ui.startSpinner(`daily limit · carrying on at ${clock} (in ${left})`);
      else if (Date.now() - lastNote > 30 * 60_000) { this.ui.note(`still waiting for the daily limit — ${left} to go`); lastNote = Date.now(); }
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, at - Date.now()))));
    }
    this.ui.stopSpinner();
    this.ui.note('Daily limit has reset — carrying on');
    return true;
  }

  /** A dev server came up during this turn: open it in the browser, once. */
  /**
   * Open the running app in a browser as soon as a dev server is up.
   *
   * This was turned off once, on the grounds that a window seizing the screen
   * mid-thought is startling and worse during a demo. It only fires at the end
   * of a finished turn, though, not mid-thought — and the thing the user asked
   * for is a running app, not a URL they then have to go and click. Being
   * handed a link to the thing you asked to be built is the last step of the
   * job left undone.
   *
   * UCODE_OPEN=0 turns it off for anyone who wants the link and nothing else.
   */
  openWhenReady(since) {
    if (!this.full || process.env.UCODE_OPEN === '0') return;
    const server = serversReadySince(since).at(-1);
    if (!server || (this.opened ??= new Set()).has(server.url)) return;
    this.opened.add(server.url);
    const [cmd, args] = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', server.url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [server.url]];
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
      this.ui.note(`Opened ${server.url} in your browser`);
    } catch { /* no browser to open — the link is in the answer */ }
  }

  cmdStats() {
    for (const line of statsLines(this.stats, this.working?.length ?? 0)) this.ui.write(line);
  }

  async cmdDoctor() {
    this.ui.startSpinner('checking your setup');
    try {
      const lines = await runDoctor();
      this.ui.stopSpinner();
      for (const line of lines) this.ui.write(line);
    } finally {
      this.ui.stopSpinner();
    }
  }

  /** /deploy [folder] — the same tool the model calls, run directly. */
  async cmdDeploy(arg) {
    const folder = (arg ?? '').trim() || '.';
    this.ui.toolCall(`Deploying ${folder}`);
    this.ui.startSpinner('getting ready to deploy');
    try {
      const out = await deploy({ folder }, { onOutput: (lines) => this.ui.updateSpinner(lines.at(-1)) });
      this.ui.stopSpinner();
      this.ui.toolResult(out.summary);
      this.ui.write(out.content.split('\n').map((l) => `  ${l}`).join('\n'));
    } catch (err) {
      this.ui.stopSpinner();
      if (err instanceof ToolFailure) this.ui.error(err);
      else throw err;
    }
  }

  reportResult(call, out) {
    // A build or type check that just passed already verified everything
    // changed so far; the automatic check at the end would only repeat it.
    if (call.name === 'run_command' && out.exitCode === 0 &&
        /(?:next build|npm run build|pnpm (?:run )?build|tsc)/.test(call.args?.command ?? '')) {
      // The pages stay. A build proves the project compiles, which is not the
      // same claim as the page working — and clearing everything here meant a
      // Next.js app, where a passing `npm run build` is part of every turn,
      // never reached the look at all. That is the one check that opens the
      // thing and presses its buttons, skipped on the whole framework.
      const pages = [...(this.sinceCheck ?? [])].filter((f) => PAGE.test(f));
      this.sinceCheck?.clear();
      for (const p of pages) this.sinceCheck?.add(p);
    }
    if (!QUIET.has(call.name)) this.ui.toolResult(out.summary);
    // The change as its two numbers, not as a copy of the file. The diff rows
    // are still built by the tool — the model reads them in the result — they
    // simply do not go on screen.
    if (out.diff?.length) this.ui.diffStat?.(countDiff(out.diff));
    // A look is the most thorough thing ucode runs — two widths, screenshots,
    // a designer's review, and now the app actually driven — and it was the
    // quietest line on screen, saying only that it had happened. Its verdict
    // goes on the same line, the way a change carries its two numbers.
    // Which app folders this turn actually made, so a second one can be
    // refused before it is built and any leftovers can be counted at the end.
    if (WHOLE_WRITES.has(call.name)) for (const f of this.writesOf(call)) this.wrote?.set(f.abs, f.size);
    if (call.name === 'create_app' && call.args?.folder) {
      const made = path.resolve(this.cwd, String(call.args.folder));
      if (!(this.apps ??= []).includes(made)) this.apps.push(made);
      if (call.args.name) this.appName = String(call.args.name);
      this.appTemplate = String(call.args.template || 'plain-html');
    }

    if (call.name === 'look_at_app') {
      const found = /^(\d+) problem/.exec(out.summary ?? '');
      this.ui.runStat?.(found ? `${found[1]} to fix` : 'clean');
    }
    this.push({ role: 'tool', toolCallId: call.id, name: call.name, content: out.content + this.stuckNote(call, { out }) });
  }

  /**
   * Files the closing message points at, checked rather than taken on trust.
   *
   * A build told the user it had removed two folders it had not removed. The
   * same habit sends someone to open a file that was never written. Saying a
   * thing is done when it is not is the one failure that costs the reader
   * their time rather than the writer's, and it is cheap to check: a path the
   * reply names in backticks either exists or it does not.
   *
   * Only paths with a file extension, only inside the project, and only a note
   * on screen — the turn is over by now, so this is for the person reading it,
   * not another round with the model.
   */
  checkClaims(text) {
    // A known file extension, or a folder in front of it: `item.price` in a
    // reply is code, and reporting it missing from disk was a false alarm.
    const named = [...String(text).matchAll(/`([\w./-]+\.[a-z]{1,5})`/gi)]
      .map((m) => m[1])
      .filter((f) => f.includes('/') || FILE_EXT.test(f));
    const root = path.resolve(this.cwd);

    const missing = [...new Set(named)].filter((f) => {
      const abs = path.resolve(root, f);
      return abs.startsWith(root) && !existsSync(abs);
    });

    if (missing.length) {
      const is = missing.length === 1 ? 'is' : 'are';
      this.ui.note(`mentions ${missing.join(', ')} — ${is} not on disk`);
    }
  }

  /** Show a tool failure, hand it to the model, and say if it was bad arguments. */
  reportFailure(call, err) {
    if (!(err instanceof ToolFailure)) throw err;

    // Bad arguments are the model talking to itself. "old_string and new_string
    // are identical" is a correction it will make on the next step, and it means
    // nothing to whoever is watching except that something went wrong. It goes
    // to the model, which can act on it, and not to the screen. A refusal the
    // user made, and anything that actually failed, still shows.
    if (err instanceof Declined) this.ui.toolFailed('declined');
    else if (err.kind !== 'bad_args') this.ui.toolFailed(`${err.kind}: ${err.failed}`);

    // Declines that keep coming are not decisions, they are a wall.
    //
    // A traced build ran 250 steps and 32 minutes before dying on the step
    // limit because every command it tried was declined — a piped session
    // cannot answer "go ahead? [y/N]", so the answer is always no. The model
    // read each refusal as being about that command, picked a different one,
    // and was refused again. Nothing ever told it the refusals were the room
    // rather than the request.
    //
    // Two are a person saying no to two things. The third is the wall, and it
    // is worth naming, because the way out is to finish without commands
    // rather than to keep hunting for one that is allowed.
    this.declines = err instanceof Declined ? (this.declines ?? 0) + 1 : 0;
    this.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: err.forModel()
        + (err instanceof Declined ? '' : this.stuckNote(call, { err }))
        + (this.declines >= 3
          ? '\n\nThat is the third command declined in a row. They are not being refused one by one — '
            + 'nothing can be run in this session at all, and the next one will be declined too. '
            + 'Stop trying to run things: finish the work with the files you have, and say plainly '
            + 'in your reply which steps someone will need to run themselves.'
          : ''),
    });
    return err.kind === 'bad_args';
  }

  /** The files a whole-file write names, resolved the way the tool will resolve them. */
  writesOf(call) {
    const a = call.args ?? {};
    const list = call.name === 'write_file' ? [{ path: a.path, content: a.content }] : normaliseFiles(a.files);
    return list
      .filter((f) => typeof f?.path === 'string' && typeof f?.content === 'string')
      .map((f) => ({ abs: path.resolve(this.cwd, f.path), size: f.content.length, path: f.path }));
  }

  async dispatch(call, offered = this.offering) {
    // The model emitted arguments that were not valid JSON. Hand the parser's
    // own complaint straight back so it can correct itself next step.
    if (call.parseError) {
      throw new ToolFailure({
        kind: 'bad_args',
        attempted: `calling ${call.name}`,
        failed: `The arguments were not valid JSON: ${call.parseError}`,
        fix: `Call ${call.name} again with the arguments as one well-formed JSON object.`,
      });
    }

    // A tool that was not offered does not run, whatever the model calls it.
    // The list it is sent is the list that exists: plan mode withholds every
    // tool that writes, and a new project is not sent the ones that look code
    // up — and a model naming one from memory was, until this check, executing
    // it. A withheld tool has to be refused, not just left out of the menu.
    // A worker is checked against its own, narrower list, not the lead's.
    if (!offered?.has(call.name)) {
      throw new ToolFailure({
        kind: 'no_such_tool',
        attempted: `calling ${call.name}`,
        failed: `${call.name} is not available${this.ui.mode === 'plan' ? ' in plan mode' : ' in this project'}.`,
        fix: `Use one of the tools you were given: ${[...offered ?? []].join(', ')}.`,
      });
    }

    // Reading the same unchanged file over and over.
    //
    // A traced build of a one-page app spent 53 of its 80 tool calls on
    // read_file, most of them the same handful of files again and again — six
    // seconds and a few thousand tokens each, for text that was already in the
    // conversation. The prompt has asked it not to since 1.27; asking is not
    // working, so the third read of a file nothing has written to since says
    // so instead of sending the file a third time.
    //
    // Two reads are left alone: the first is the work, and the second is
    // usually a fair re-check after an edit. Only the third is a loop. And it
    // is keyed on the file being untouched since — the moment anything writes
    // to it, the count starts again and a real re-read goes through.
    //
    // Counted per page, not per file: paging through a long file with offset
    // is new text every time, and a live run was refused four pages in a row
    // of a 900-line file it had only ever seen the start of.
    //
    // A write starts the count again (forgetReads). It used to be skipped only
    // while the file sat in sinceCheck, which the checks empty every fix round:
    // after round one, every read of a file the model had just edited was
    // refused as "unchanged", and a live build spent sixty steps being told so.
    if (call.name === 'read_file' && call.args?.path) {
      const file = String(call.args.path);
      const key = `${fileKey(file)}#${Number(call.args.offset) || 1}:${Number(call.args.limit) || 0}`;
      const seen = (this.reads ??= new Map()).get(key) ?? 0;
      if (seen >= 2) {
        this.reads.set(key, seen + 1);
        return {
          content: `You have already read that part of ${file} ${seen} times this turn and nothing has written ` +
          'to it since, so it is unchanged and already above. Use what is there. If you need a part ' +
          'you have lost, say which and read the files you still need together in one read_files.',
          summary: 'unchanged since you last read it',
        };
      }
      this.reads.set(key, seen + 1);
    }

    // A file written this turn, about to be replaced by a sliver of itself.
    // A model that "verifies" by writing again can put a few bytes over a
    // finished app, and the app is gone. Checking a file is a read.
    if (WHOLE_WRITES.has(call.name) && this.wrote?.size) {
      for (const f of this.writesOf(call)) {
        const had = this.wrote.get(f.abs);
        if (had >= 2000 && f.size < had / 4) {
          throw new ToolFailure({
            kind: 'would_shrink',
            attempted: `writing ${f.path}`,
            failed: `You wrote ${f.path} earlier this turn (${had} characters), and this would replace it with ${f.size}.`,
            fix: 'Nothing was written. To check a file, read it with read_files; do not write it again. '
              + 'To change part of it, use edit_file.',
          });
        }
      }
    }

    // Starting a second app instead of fixing the first.
    //
    // A traced build hit a problem in todo/, abandoned it and made todo-fixed/
    // — three create_app calls, two folders, one broken, the app typed twice.
    // Starting over is never the cheap way out of a problem in a file, and it
    // leaves the user to work out which folder is the real one.
    if (call.name === 'create_app' && call.args?.folder && (this.apps ?? []).length) {
      const wanted = path.resolve(this.cwd, String(call.args.folder));
      const already = this.apps.filter((f) => f !== wanted);
      if (already.length && !this.apps.includes(wanted)) {
        const show = already.map((f) => path.basename(f)).join(', ');
        throw new ToolFailure({
          kind: 'already_building',
          attempted: `creating ${call.args.folder}`,
          failed: `You already made ${show} this turn, and it is still there.`,
          fix:
            `Fix ${show} instead of starting again — whatever is wrong with it is a smaller `
            + 'job than writing the whole app a second time, and a half-finished folder left '
            + `beside the real one is worse than either. If ${show} genuinely cannot be saved, `
            + 'delete it first, then create this one.',
        });
      }
    }

    if (call.name === 'load_skill') return this.loadSkill(call.args?.name);
    if (call.name === 'update_plan') return this.updatePlan(call.args?.items);
    if (call.name === 'delegate') return this.delegate(call.args?.tasks);

    // Output reaches the screen as the command produces it, so a slow build is
    // something you watch rather than something you sit out in silence.
    return runTool(call.name, call.args ?? {}, {
      onOutput: (lines) => this.ui.progress(lines),
    });
  }

  /**
   * Switch to the next model after a provider failure. Returns false once
   * there is nothing sensible left to try. When every model is busy at once,
   * it waits a minute and goes round again rather than giving up.
   */
  async failover(err) {
    if (++this.failovers > MAX_FAILOVERS) return false;
    const from = model();
    let next = fallbackFor(from, this.tried);

    const why = err.kind === 'rate_limit' ? 'busy' : err.kind === 'timeout' ? 'too slow to answer' : 'not answering';

    if (!next) {
      // With fallback off this is the ordinary path, so the wait names the one
      // model being waited on. A rate limit needs the full minute to clear; a
      // timeout has already cost minutes of silence, and waiting longer before
      // asking again buys nothing.
      const alone = process.env.UCODE_FALLBACK !== '1';
      const who = alone ? modelName(from) : 'every model';
      const until = Date.now() + (err.kind === 'rate_limit' || !alone ? 60_000 : 5_000);
      this.ui.startSpinner(`${who} is ${why}`);
      while (Date.now() < until && !this.abort?.signal.aborted) {
        this.ui.updateSpinner(`${who} is ${why} — trying again in ${Math.ceil((until - Date.now()) / 1000)}s`);
        await wait(1000);
      }
      this.ui.stopSpinner();
      if (this.abort?.signal.aborted) return false;
      this.tried = new Set();
      next = this.preferred && this.preferred !== from ? this.preferred : fallbackFor(from, this.tried) ?? from;
    }

    this.tried.add(next);
    setModel(next);
    this.cooldownUntil = Date.now() + COOLDOWN;
    this.ui.note(next === from
      ? `${modelName(from)} was ${why} — asking it again`
      : `${modelName(from)} is ${why} — carrying on with ${modelName(next)}`);
    if (this.full) this.showHeader({ clear: false });
    return true;
  }

  /** Run a call and settle to { out } or { err } — never throws. */
  execute(call, offered = this.offering) {
    const started = Date.now();
    return this.dispatch(call, offered).then(
      (out) => { trace({ kind: 'tool', name: call.name, ms: Date.now() - started }); countTool(this.stats, call, out); return { out }; },
      (err) => { trace({ kind: 'tool', name: call.name, ms: Date.now() - started, err: err?.kind }); countTool(this.stats, call, null, err); return { err }; }
    );
  }

  updatePlan(items) {
    const list = (Array.isArray(items) ? items : [])
      .filter((i) => i && String(i.text ?? '').trim())
      .slice(0, 6);
    this.ui.plan(list);
    const done = list.filter((i) => i.done).length;
    return { content: `Plan updated: ${done} of ${list.length} done.`, summary: `${done}/${list.length}` };
  }

  /** A file was written: every page of it read so far is news again. */
  forgetReads(file) {
    const prefix = `${fileKey(file)}#`;
    for (const key of this.reads?.keys() ?? []) if (key.startsWith(prefix)) this.reads.delete(key);
  }

  /** File writes from parallel workers take turns, so two never interleave. */
  fileLock(fn) {
    const run = (this.lockChain ?? Promise.resolve()).then(fn, fn);
    this.lockChain = run.catch(() => {});
    return run;
  }

  /**
   * Several workers at once, each its own small agent loop with its own
   * conversation, sharing the tools, the project, and whatever skills are
   * already in force. Their lines in the transcript carry their name.
   */
  async delegate(tasks) {
    const list = (Array.isArray(tasks) ? tasks : [])
      .filter((t) => t && String(t.instructions ?? '').trim())
      .slice(0, MAX_WORKERS);
    if (!list.length) {
      throw new ToolFailure({
        kind: 'bad_args',
        attempted: 'starting workers',
        failed: 'No tasks with instructions were given.',
        fix: 'Pass tasks as [{ name, instructions }, ...], up to 3.',
      });
    }

    const results = await Promise.all(list.map((task, i) => this.runWorker(task, i).catch((err) => ({
      name: task.name || `worker ${i + 1}`,
      summary: `Failed: ${err?.failed ?? err?.message ?? err}`,
      touched: [],
    }))));

    for (const r of results) for (const f of r.touched) { this.touched.add(f); this.sinceCheck.add(f); this.forgetReads(f); }

    // A worker that wrote nothing has not done its part, whatever it said.
    // The lead builds those itself rather than leaving holes in the app.
    const empty = results.filter((r) => !r.touched.length).map((r) => r.name);

    return {
      content: results
        .map((r) => `## ${r.name}\n${r.summary}\nFiles changed: ${r.touched.join(', ') || 'none'}`)
        .join('\n\n') +
        (empty.length
          ? `\n\n${empty.join(', ')} wrote no files. Build ${empty.length === 1 ? 'that part' : 'those parts'} ` +
            'yourself now, directly - do not delegate them again.'
          : ''),
      summary: results.map((r) => `${r.name} · ${r.touched.length} file${r.touched.length === 1 ? '' : 's'}`).join('  '),
    };
  }

  async runWorker(task, index) {
    const name = clip(String(task.name || `worker ${index + 1}`).trim(), 16);
    const touched = new Set();
    // A worker gets what the lead has, digest included: its prompt is re-read
    // on every step it takes, the same as the lead's.
    const skills = this.skills
      .filter((s) => this.loaded.has(s.name))
      .map((s) => `--- ${s.name} ---\n${this.short.has(s.name) && s.digest ? s.digest : s.body}`)
      .join('\n\n');
    const messages = [
      { role: 'system', content: workerPrompt({ cwd: this.cwd, name, memory: this.memory, skills, map: this.map }) },
      { role: 'user', content: String(task.instructions) },
    ];
    const available = this.toolsNow().filter((t) => !WORKER_EXCLUDED.has(t.name));
    const offered = new Set(available.map((t) => t.name));
    const wanted = process.env.UCODE_WORKER_MODEL;
    let workerModel = wanted && MODELS[wanted] ? wanted : model();
    const tried = new Set([workerModel]);
    let failovers = 0;

    // Start a moment apart. Three requests in the same instant is exactly what
    // trips a free endpoint's rate limit, and the stagger costs a second or two.
    if (index) await wait(index * 1500);

    for (let step = 0; step < WORKER_STEPS; step++) {
      if (this.abort?.signal.aborted) break;

      let reply;
      const asked = Date.now();
      // A worker never folded its own conversation, so sixty steps of reading
      // files ended in a window error and a worker that reported "Failed:"
      // having done most of its job. No summary call is needed here: the old
      // tool results are what is large, the files are on disk, and reading one
      // again costs far less than carrying the whole history.
      thinWorker(messages, contextLimit(workerModel) * 0.6);
      try {
        reply = await ask(messages, available, { signal: this.abort?.signal, model: workerModel });
      } catch (err) {
        // Same rule as the lead: a busy model is swapped, not a reason to stop.
        if (passing(err) && failovers < 6 && !this.abort?.signal.aborted) {
          failovers++;
          let next = fallbackFor(workerModel, tried);
          if (!next) { tried.clear(); await wait(20_000); next = fallbackFor(workerModel, tried) ?? workerModel; }
          tried.add(next);
          this.ui.note(`${name}: ${modelName(workerModel)} is busy — switching to ${modelName(next)}`);
          workerModel = next;
          step--;
          continue;
        }
        throw err;
      }
      this.record(reply.usage);
      trace({
        kind: 'model', who: name, model: workerModel, ms: Date.now() - asked,
        in: reply.usage.promptTokens, out: reply.usage.outputTokens,
        calls: reply.toolCalls.map((c) => c.name),
      });

      if (!reply.toolCalls.length) {
        this.ui.toolResult(`${name} finished`);
        return { name, summary: reply.text?.trim() || 'Finished without a summary.', touched: [...touched] };
      }

      messages.push({ role: 'assistant', content: reply.text || '', toolCalls: reply.toolCalls });
      for (const call of reply.toolCalls) {
        this.ui.toolCall(`${name} › ${describe(call.name, call.args)}`);
        if (FILE_WRITES.has(call.name)) for (const p of pathsOf(call)) touched.add(p);
        // Writes and commands both take turns.
        //
        // Only file writes were serialized, so three workers could run three
        // installs in one folder, or race for the same port, at the same
        // moment - the two things the shell code goes furthest out of its way
        // to prevent everywhere else.
        const exclusive =
          FILE_WRITES.has(call.name) || call.name === 'run_command' || call.name === 'run_commands';
        const { out, err } = exclusive
          ? await this.fileLock(() => this.execute(call, offered))
          : await this.execute(call, offered);
        if (err) {
          if (!(err instanceof ToolFailure)) throw err;
          this.ui.toolFailed(`${name}: ${err.kind}: ${err.failed}`);
        }
        messages.push({
          role: 'tool', toolCallId: call.id, name: call.name,
          content: err ? err.forModel() : out.content,
        });
      }
    }

    return { name, summary: `Stopped after ${WORKER_STEPS} steps without finishing.`, touched: [...touched] };
  }

  /**
   * Check the code files changed since the last check, and return the
   * errors as text for the model — or null when everything is clean.
   *
   * The check is incremental: TypeScript writes what it learned to a build
   * info file, so the second check onwards reads that instead of retyping
   * every dependency — seconds rather than the best part of a minute. The
   * file sits in node_modules/.cache, which is already ignored by git and is
   * deliberately left out of the starter package cache.
   *
   * TypeScript projects get one `tsc --noEmit` per project that owns a
   * changed file (an app scaffolded into a subfolder is its own project).
   * Plain JavaScript gets a syntax check, Python a compile check. Nothing
   * runs that is not already installed.
   */
  async autoCheck() {
    const changed = [...this.sinceCheck].filter((f) => CHECKABLE.test(f));
    this.sinceCheck.clear();
    if (!changed.length) return null;

    const root = path.resolve(this.cwd);

    // A page that links to its own folder, whoever wrote it. create_app fixes
    // the files it is handed, but an app written across several calls — a
    // scaffold, then two edits — reintroduces the prefix on the next write,
    // and nothing was watching after the first one. The page then loads no
    // stylesheet and no script, which is the difference between an app and a
    // wall of unstyled markup, so it is corrected wherever it turns up.
    const relinked = await unprefixOwnFolder(root, changed);
    if (relinked.length) {
      this.ui.toolCall(`Fixing self-referencing links in ${relinked.join(', ')}`);
    }
    const tsRoots = new Set();
    const singles = [];
    const problems = [];

    for (const rel of changed) {
      const abs = path.resolve(root, rel);
      if (!(await exists(abs))) continue;
      if (/\.py$/i.test(rel)) { singles.push({ abs, rel, command: `python -m py_compile "${abs}"` }); continue; }
      // A single-file app keeps all its logic in an inline <script>, which no
      // other check here ever looks at.
      if (/\.html?$/i.test(rel)) {
        const text = await readFile(abs, 'utf8').catch(() => null);
        const bad = text === null ? [] : checkHtml(text);
        if (bad.length) {
          problems.push(`${rel} — the script in this page does not parse, so none of it runs:\n` +
            bad.map((b) => `  line ${b.line}: ${b.message}`).join('\n'));
        }
        continue;
      }
      let dir = path.dirname(abs);
      let owner = null;
      while (dir.startsWith(root)) {
        if (await exists(path.join(dir, 'tsconfig.json'))) { owner = dir; break; }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
      if (owner && (await exists(path.join(owner, 'node_modules', 'typescript')))) tsRoots.add(owner);
      else if (/\.[cm]?js$/i.test(rel)) singles.push({ abs, rel, command: `node --check "${abs}"` });
    }

    // CSS is checked a folder at a time, not a file at a time: a token
    // declared in styles.css and reached for from an inline <style> is
    // defined, and either file read on its own would call it undefined.
    // Definitions are gathered from everything beside the changed files;
    // problems are reported only in the files this turn actually wrote, so a
    // build is never interrupted by something it did not touch.
    const rels = (abs) => path.relative(root, abs).split(path.sep).join('/');
    const group = (found) => {
      const by = new Map();
      for (const b of found) {
        if (!by.has(b.rel)) by.set(b.rel, []);
        by.get(b.rel).push(b);
      }
      return by;
    };
    const cssDirs = new Set();
    for (const rel of changed) {
      if (/\.(?:css|html?)$/i.test(rel)) cssDirs.add(path.dirname(path.resolve(root, rel)));
    }
    if (cssDirs.size) {
      const sources = [];
      const seen = new Set();
      const take = async (abs) => {
        if (seen.has(abs)) return;
        seen.add(abs);
        const text = await readFile(abs, 'utf8').catch(() => null);
        if (text !== null) sources.push({ rel: rels(abs), text });
      };
      for (const dir of cssDirs) {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.isFile() && /\.(?:css|html?|[cm]?js)$/i.test(entry.name)) {
            await take(path.join(dir, entry.name));
          }
        }
      }
      const mine = new Set(changed.map((rel) => rels(path.resolve(root, rel))));
      for (const rel of changed) await take(path.resolve(root, rel));

      const undefinedVars = checkCss(sources).filter((b) => mine.has(b.rel));
      for (const [rel, found] of group(undefinedVars)) {
        problems.push(
          `${rel} — ${found.length === 1 ? 'a custom property is' : `${found.length} custom properties are`} ` +
          'used and never defined. CSS does not warn about this: the browser throws away the whole ' +
          'declaration, so the value is silently missing and the page still renders.\n' +
          found.map((b) => `  line ${b.line}: var(${b.name})`).join('\n')
        );
      }
    }

    const check = async (label, command, cwd) => {
      // The spinner only, never a transcript line. This pass runs after the
      // model has finished speaking, so a step logged here is the last thing
      // left on screen — the session ends on "Checking tasker/app.js" instead
      // of on the answer, and it reads as though something was still going
      // when it stopped. A check that passes has nothing to say, and one that
      // fails goes back to the model, which says it in words.
      this.ui.startSpinner(label);
      const { out, err } = await this.execute({
        id: 'check', name: 'run_command',
        args: { command, cwd: path.relative(root, cwd) || '.', timeout_ms: 180_000 },
      });
      this.ui.stopSpinner();
      return err ? { exitCode: -1, content: String(err.failed ?? err.message) } : out;
    };

    for (const dir of tsRoots) {
      const show = path.relative(root, dir) || '.';
      await mkdir(path.join(dir, path.dirname(TSBUILDINFO)), { recursive: true }).catch(() => {});
      let out = await check(`Checking types in ${show}`, typeCheckCommand(true), dir);
      // Older TypeScript refuses --incremental alongside --noEmit. Say so once
      // by simply checking again the slow way, rather than failing the edit.
      if (out.exitCode !== 0 && NO_INCREMENTAL.test(out.content)) {
        out = await check(`Checking types in ${show}`, typeCheckCommand(false), dir);
      }
      if (out.exitCode === 0) { this.ui.toolResult('types check out'); continue; }
      const errors = out.content.split('\n').filter((l) => /error TS\d+/.test(l));

      /**
       * Only the errors this turn is answerable for.
       *
       * tsc reports the whole project, and a real project usually has errors
       * in it already that have nothing to do with the file just edited.
       * Handing those back reads as "you broke this, fix it": the model spends
       * its three fix rounds on somebody else's type errors, in files it has
       * never opened, and the thing the user asked for never gets finished.
       *
       * So the first check of a project in this session records what was
       * already wrong outside the files this turn touched, and after that only
       * errors that are not on that list are reported. Anything genuinely
       * introduced - in a changed file, or anywhere a change knocked on to -
       * is new, and still goes straight back.
       */
      const mine = new Set(changed.map((rel) => path.resolve(root, rel)));
      const isMine = (line) => {
        const file = typeErrorFile(line);
        return file ? mine.has(path.resolve(dir, file)) : false;
      };
      let base = (this.tsBaseline ??= new Map()).get(dir);
      let fresh;
      if (!base) {
        base = new Set(errors.filter((l) => !isMine(l)).map(typeErrorKey));
        this.tsBaseline.set(dir, base);
        fresh = errors.filter(isMine);
      } else {
        fresh = errors.filter((l) => !base.has(typeErrorKey(l)));
      }

      if (!fresh.length) {
        this.ui.toolResult(errors.length ? `no new type errors (${errors.length} already there)` : 'types check out');
        continue;
      }
      this.ui.toolFailed(`${fresh.length} type error${fresh.length === 1 ? '' : 's'}`);
      problems.push(`In ${show} (tsc --noEmit):\n${fresh.slice(0, 40).join('\n')}`);
    }

    for (const f of singles) {
      const out = await check(`Checking ${f.rel}`, f.command, root);
      if (out.exitCode === 0) { this.ui.toolResult('ok'); continue; }
      this.ui.toolFailed('does not compile');
      problems.push(`${f.rel}:\n${out.content.split('\n').slice(0, 20).join('\n')}`);
    }

    // Only once it compiles: a failing test on code that does not build tells
    // the model nothing it does not already know from the errors above.
    if (!problems.length) {
      const failed = await this.runRelatedTests(root, changed);
      if (failed) problems.push(failed);
    }

    const live = await this.liveErrors();
    if (live) problems.push(live);

    // Two app folders, one of them abandoned.
    //
    // A build hit a problem in todo/, started todo-fixed/, then said in its
    // reply that it had removed the duplicate — and had not. Both were still
    // on disk for the user to sort out, and the claim that they were not is
    // the failure this whole checking pass exists to catch: saying a thing is
    // done when it is not. So it is checked rather than believed.
    const apps = this.apps ?? [];
    if (apps.length > 1) {
      const names = apps.map((f) => path.basename(f));
      problems.push(
        `There are ${apps.length} app folders here now: ${names.join(', ')}. Only one of them is `
        + 'the app. Delete the ones you are not shipping — actually delete them, do not just say '
        + 'you have — and make sure the one you keep is the one that works.',
      );
    }

    // Then look at it, in the same pass that type-checks — not when the model
    // remembers to. A check that runs only when it is asked for reports
    // nothing on exactly the builds that needed it, and this is the only one
    // that opens the page, presses its buttons and finds out whether any of it
    // actually works.
    // Whatever else is wrong. It used to wait until everything else was clean,
    // which meant the one check that opens the page and presses its buttons
    // was skipped on exactly the builds going badly — and a type error and a
    // dead button are two separate things to fix, so finding them in one pass
    // costs a round trip less than finding them in two. The visual review
    // inside the look still stands itself down on a page that is broken;
    // reviewing the typography of an error overlay helps nobody.
    const seen = await this.lookOnceThisTurn(root, changed);
    if (seen) problems.push(seen);

    return problems.length ? problems.join('\n\n') : null;
  }

  /**
   * Open what was just built and report what is wrong with it, once a turn.
   *
   * Points at a dev server when one is running; otherwise serves the folder
   * holding the page that changed, which is the only way the default
   * three-file starter gets looked at at all — it has no server to point at.
   * Only for a turn that touched something with a page in it: there is nothing
   * to open after a change to a utility module.
   *
   * Never throws. A browser that will not start is a reason to skip the look,
   * never a reason to fail the turn that built the app.
   */
  /**
   * Hand a plain-page app over the moment it works.
   *
   * Traced: a tip calculator was on disk and complete 60 seconds in, and the
   * turn ran to 270 — re-reading the files it had just written, starting
   * servers to look at a page that needs none, rewriting it to "verify". The
   * user waited three and a half minutes for an app that was already there.
   *
   * So right after a step that writes the app — create_app with its files, a
   * batch of files, or any write while earlier problems are being fixed —
   * ucode opens the page itself. No console errors, no failed requests, and
   * it responds when used: the turn ends there with where to find it. If it
   * is broken, the problems go straight back, and the next write checks again.
   * Plain pages only: a framework app is checked when the model says it is
   * done, since its build and server take their own time.
   *
   * Returns { done: true }, { problems }, or null when there was nothing to check.
   */
  async handOver(calls) {
    if (this.ui.mode === 'plan' || !this.apps?.length) return null;
    const app = this.apps.at(-1);
    // Plain by the starter it came from, not by what is in the folder: a model
    // that adds a package.json to a one-page app still made a one-page app, and
    // judging by the file sent a stopwatch on a 22-step, six-minute detour.
    if (this.appTemplate !== 'plain-html' || !(await exists(path.join(app, 'index.html')))) return null;

    const inApp = (p) => {
      const rel = path.relative(app, path.resolve(this.cwd, String(p)));
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    const writes = calls.filter((c) => FILE_WRITES.has(c.name) && pathsOf(c).some(inApp));
    const whole = writes.some((c) => (c.name === 'create_app' || c.name === 'batch_write') && pathsOf(c).length > 0);
    if (!writes.length || (!whole && !this.handOverPending)) return null;

    const show = path.relative(this.cwd, app).split(path.sep).join('/') || '.';
    let out;
    try {
      const { lookAtApp, withStaticServer } = await import('../tools/browser.js');
      this.ui.startSpinner(`opening ${show} to check it works`);
      out = await withStaticServer(app, (url) => lookAtApp({ url, review: false }));
    } catch {
      return null; // no browser: the check at the end of the turn still runs
    } finally {
      this.ui.stopSpinner();
    }

    const content = String(out?.content ?? '');
    if (/Console errors|Failed requests|NOTHING HAPPENS|does not parse/i.test(content)) {
      this.handOverPending = true;
      this.ui.runStat?.('needs a fix');
      return { problems: `I opened the app and looked at it:\n\n${content}` };
    }

    this.handOverPending = false;
    // "Tip Calculator is done", with the page as a link the terminal can open.
    const made = calls.find((c) => c.name === 'create_app' && c.args?.name)?.args.name ?? this.appName;
    const name = String(made ?? path.basename(app)).trim();
    this.appName = name;
    const link = pathToFileURL(path.join(app, 'index.html')).href;
    const text = `${name} is done. Open it here: ${link}\n\n(or open \`${show}/index.html\` in your browser)`;
    this.push({ role: 'assistant', content: text });
    this.ui.assistant(text, { closing: true });
    await this.persist();
    return { done: true };
  }

  async lookOnceThisTurn(root, changed) {
    // A look that found problems is taken again after the fix round, even if
    // the fix only touched the page's script. Looking once a turn let a live
    // build report "Failed to load module script" on its first look, fail to
    // fix it, and finish as done with a page whose script never ran — nothing
    // opened the page again. The fix rounds bound how often this repeats.
    const again = this.lookAgain;
    if (this.lookedThisTurn && !again) return null;

    let pages = [...changed].filter((f) => PAGE.test(f));
    // A plain page's script changed and its index.html did not — the usual
    // shape of a build on the HTML starter, whose page comes from the starter
    // while the model writes app.js. The page is still the thing to open: a
    // live build whose "Add" button threw on every click finished as done
    // because nothing with .html in its name had changed, so nobody looked.
    if (!pages.length) {
      for (const f of changed) {
        const page = path.join(path.dirname(f), 'index.html');
        if (/\.m?js$/i.test(f) && (await exists(path.resolve(root, page)))) { pages = [page]; break; }
      }
    }
    if (!pages.length && again) pages = [again];
    if (!pages.length) return null;
    this.lookedThisTurn = true;
    this.lookAgain = null;

    try {
      const { lookAtApp, withStaticServer } = await import('../tools/browser.js');
      const look = async (url) => {
        this.ui.toolCall(`Looking at ${url} on a phone and a desktop`);
        // No designer's review here. It cost up to a minute, and its advice
        // went back as "errors, fix all of them" with no look afterwards to
        // check the restyle — builds came out worse than they went in. /look
        // still brings it, when the user asks.
        const out = await lookAtApp({ url, review: false });
        const found = /^(\d+) problem/.exec(out.summary ?? '');
        this.ui.runStat?.(found ? `${found[1]} to fix` : 'clean');
        if (found) this.lookAgain = pages.find((f) => /\.html?$/i.test(f)) ?? pages[0];
        return found ? `I opened the app and looked at it:\n\n${out.content}` : null;
      };

      const server = runningServers().at(-1);
      if (server?.url) return await look(server.url);

      const html = pages.find((f) => /\.html?$/i.test(f));
      if (!html) return null;
      return await withStaticServer(path.dirname(path.resolve(root, html)), look);
    } catch (err) {
      // Say so, quietly, rather than skipping in silence. A browser that will
      // not start is a reason to carry on without the look — but a check that
      // stops running and never mentions it is worse than one that was never
      // written, because everything downstream still believes it ran.
      this.ui.note(`could not open the app to check it: ${String(err?.failed ?? err?.message ?? err).split('\n')[0]}`);
      return null;
    }
  }

  /**
   * Anything the running app has complained about since the last look. A dev
   * server knows about a broken import the moment it happens; without this
   * nobody reads that until a build, or until the user says the page is blank.
   */
  async liveErrors() {
    try {
      const found = await this.logWatch.since(runningServers());
      if (found) this.ui.toolFailed('the running app reported an error');
      return found;
    } catch {
      return null; // reading a log must never be what breaks a turn
    }
  }

  /**
   * Run the tests that reach the files just changed, and return their
   * failures as text — or null when they pass, or when this project has no
   * runner that can be asked which tests matter.
   */
  async runRelatedTests(root, changed) {
    const runner = await testRunnerFor(root);
    if (!runner) return null;

    const existing = [];
    for (const rel of changed) if (await exists(path.resolve(root, rel))) existing.push(rel);
    const command = relatedCommand(runner, existing);
    if (!command) return null;

    const label = `Running the ${runner} tests that cover this`;
    this.ui.toolCall(label);
    this.ui.startSpinner(label);
    const { out, err } = await this.execute({
      id: 'tests', name: 'run_command',
      args: { command, cwd: '.', timeout_ms: 180_000 },
    });
    this.ui.stopSpinner();

    if (err) { this.ui.toolResult('tests skipped'); return null; }
    if (out.exitCode === 0) { this.ui.toolResult('tests pass'); return null; }

    // A runner that is not installed is not a failing test; npx says so.
    if (/could not determine executable|not found|Cannot find module/i.test(out.content)) {
      this.ui.toolResult('no test runner installed');
      return null;
    }

    this.ui.toolFailed('tests fail');
    return `The tests covering your change fail (${runner}):\n${summariseFailures(runner, out.content)}`;
  }

  loadSkill(name) {
    const skill = findSkill(this.skills, name);
    if (!skill) {
      // The available names go in `failed` rather than only in `fix`: the
      // transcript shows the failure line, and a bare "no such skill" leaves
      // the user guessing at what this session actually has.
      const available = this.skills.map((s) => s.name).join(', ') || '(none)';
      throw new ToolFailure({
        kind: 'no_such_skill',
        attempted: `loading the "${name}" skill`,
        failed: `There is no skill called "${name}". This session has: ${available}.`,
        fix: 'Use one of those names, or carry on without one.',
      });
    }

    // Loaded in full already: nothing to do. Loaded as a digest: this is the
    // model asking for the depth, which is exactly what the digest points at.
    if (this.loaded.has(skill.name) && !this.short.has(skill.name)) {
      return { content: `The "${skill.name}" skill is already loaded above. Follow it.`, summary: 'already loaded' };
    }

    this.loaded.add(skill.name);
    this.short.delete(skill.name);
    this.push(skillMessage(skill));
    return {
      content: `Loaded "${skill.name}". Its instructions are in your context now — follow them.`,
      summary: `${skill.name} · ${skill.body.split('\n').length} lines`,
    };
  }

  record(u) {
    const total = this.session.usage;
    total.promptTokens += u.promptTokens || 0;
    total.outputTokens += u.outputTokens || 0;
    total.totalTokens += u.totalTokens || 0;
    total.turns += 1;
  }

  /**
   * Fold older turns into a summary when the window gets tight.
   *
   * `force` is for when the provider has already said the conversation is too
   * large: its word beats our estimate of the same thing, and the estimate is
   * what let it get here.
   */
  async maybeFold({ force = false } = {}) {
    const limit = contextLimit();
    if (!force && !tooBig(this.working, limit)) return;

    this.ui.startSpinner('context is filling up — summarizing earlier turns');
    try {
      const result = await fold(this.working, {
        limit,
        force,
        summarize: async (older, previous) => {
          const reply = await ask(
            [
              { role: 'system', content: SUMMARY_PROMPT },
              { role: 'user', content: summaryRequest(forSummary(older), previous) },
            ],
            [],
            // Always the quick model, whatever the user picked for the work
            // itself. This is a mechanical restatement in the middle of a
            // build the user is waiting on; a reasoning model would think
            // about it for half a minute and produce the same paragraph.
            { signal: this.abort?.signal, temperature: 0, model: DEFAULT_MODEL },
          );
          return reply.text;
        },
      });

      this.ui.stopSpinner();
      if (result.folded) {
        this.working = result.messages;
        this.ui.note(
          `folded ${result.droppedCount} earlier messages into a summary ` +
          '(the full history is still saved in this session)'
        );
      }
    } catch (err) {
      // If summarizing fails, carry on with the full history and let the API
      // complain — better than silently throwing away the conversation.
      this.ui.stopSpinner();
      this.ui.note(`could not summarize older turns (${err.kind ?? 'error'}); carrying on uncompacted`);
    }
  }

  // -- slash commands ------------------------------------------------------

  async command(input) {
    const [name, ...rest] = input.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (name) {
      case '/help':
        return this.cmdHelp();

      // One thing, one command, however you happen to spell it.
      case '/model':
      case '/models':
        return this.cmdModel(arg);

      case '/session':
      case '/sessions':
      case '/resume':
        return this.cmdSessions(arg);

      case '/new':      return this.cmdNew();
      case '/remember': return this.cmdRemember(arg);
      case '/skills':   return this.cmdSkills();
      case '/clear':    this.showHeader(); return;
      case '/search':   return this.cmdSearch(arg);
      case '/copy':     return this.cmdCopy();
      case '/stats':    return this.cmdStats();
      case '/undo':     return this.cmdUndo();
      case '/doctor':   return this.cmdDoctor();
      case '/look':     return this.cmdLook(arg);
      case '/deploy':   return this.cmdDeploy(arg);
      case '/exit':
      case '/quit':     return 'exit';

      default:
        this.ui.write(theme.warn(`  no such command: ${name}`));
        this.ui.note('/help lists them.');
    }
  }

  /**
   * Look at the running app, because the user asked to.
   *
   * This used to happen on its own, which meant a browser being driven while
   * someone was reading, and a window taking the screen mid-thought. It is
   * the same check as before; the difference is who starts it.
   */
  async cmdLook(url) {
    const { lookAtApp } = await import('../tools/browser.js');
    const server = runningServers().at(-1);
    const at = (url ?? '').trim() || server?.url;
    if (!at) {
      this.ui.write(theme.warn('  nothing is running to look at.'));
      this.ui.note('start the app first, or pass a URL: /look http://localhost:3000');
      return;
    }
    this.ui.toolCall(`Looking at ${at}`);
    try {
      const out = await lookAtApp({ url: at });
      this.ui.write(out.content);
      // The model gets it too, so the next thing it says is about what is
      // actually on the page rather than what it believes it built.
      this.push({ role: 'user', content: `I looked at ${at}. This is what is there:

${out.content}` });
    } catch (err) {
      this.ui.write(theme.error(`  ${err.failed ?? err.message}`));
    }
  }

  /**
   * Put every file the last turn wrote back the way it was.
   *
   * The one thing an agent that edits your files on its own has to have. It
   * covers the last turn only — the state you want back is almost always the
   * one that just happened — and it says how many files it touched rather than
   * listing them, the way everything else here reports work.
   */
  async cmdUndo() {
    const count = changedCount();
    if (!count) {
      this.ui.note('nothing to undo — the last turn changed no files.');
      return;
    }

    const { restored, removed, failed } = await undoTurn();
    const parts = [];
    if (restored.length) parts.push(`${restored.length} file${restored.length === 1 ? '' : 's'} put back`);
    if (removed.length) parts.push(`${removed.length} removed`);
    this.ui.write(`  ${theme.ok('✓')} ${parts.join(', ') || 'nothing to do'}`);
    for (const f of failed) this.ui.write(theme.error(`  could not undo ${f}`));
  }

  cmdHelp() {
    const rows = [
      ['/help', 'this list'],
      ['/undo', 'put back every file the last turn changed'],
      ['/stats', 'time, steps and tokens this session'],
      ['/doctor', 'check that everything ucode needs is working'],
      ['/look [url]', 'open the running app and report what is on the page'],
      ['/deploy [folder]', 'put the app online and get its link'],
      ['/model', 'show the models and switch between them'],
      ['/resume', 'pick up an earlier conversation'],
      ['/new', 'save this one and start fresh'],
      ['/remember <note>', `add a standing note to ${MEMORY_FILE}`],
      ['/skills', 'what ucode knows how to do'],
      ['/search <query>', 'look something up on the web'],
      ['/copy', 'copy the last reply to the clipboard'],
      ['/clear', 'clear the screen, keep the conversation'],
      ['/exit', 'save and quit'],
    ];

    this.ui.blank();
    for (const [command, what] of rows) {
      this.ui.write(`  ${blue(command.padEnd(18))} ${dim(what)}`);
    }
    this.ui.blank();
    this.ui.write(dim('  /models, /session and /sessions do the same as /model and /resume.'));
    this.ui.write(dim('  ctrl+b swaps plan and build · esc stops a running turn · ctrl+d quits'));
    this.ui.blank();
  }

  /** The six models, and this session's spend. */
  async cmdModel(arg) {
    if (arg) {
      try {
        setModel(arg);
        this.preferred = model();
      } catch (err) {
        this.ui.error(err, { debug: this.debug });
        return;
      }
      this.session.model = model();
      this.ui.note(`now using ${modelName()}`);
      this.showHeader({ clear: false });
      return;
    }

    const all = modelList();
    const width = Math.max(...all.map((m) => m.name.length));

    if (this.ui.pick) {
      const items = all.map((m) => ({
        label:
          `${m.active ? blue('●') : dim('○')} ${m.star ? blue('★') : ' '} ` +
          `${m.name.padEnd(width)}  ${dim(`${formatTokens(m.context)} · ${m.note}`)}`,
      }));

      const chosen = await this.ui.pick(items, {
        active: Math.max(0, all.findIndex((m) => m.active)),
        hint: '↑↓ move · enter to switch · esc to cancel',
      });
      if (chosen === null) return;

      setModel(all[chosen].id);
      this.preferred = model();
      this.session.model = model();
      this.ui.note(`now using ${modelName()}`);
      this.showHeader({ clear: false });
      return;
    }

    this.ui.blank();
    for (const m of all) {
      this.ui.write(
        `  ${m.active ? blue('●') : dim('○')} ${m.star ? blue('★') : ' '} ` +
        `${(m.active ? blue : dim)(m.name.padEnd(width))}  ${dim(`${formatTokens(m.context)} · ${m.note}`)}`
      );
      this.ui.write(`      ${dim(m.id)}`);
    }

    const u = this.session.usage;
    const live = rateLimits();
    this.ui.blank();
    this.ui.write(
      `  ${dim('this session')}  ${u.turns} turns · ${formatTokens(u.totalTokens)} tokens ` +
      `(${formatTokens(u.promptTokens)} in, ${formatTokens(u.outputTokens)} out)`
    );
    if (live?.requestsRemaining != null && live?.requestsLimit) {
      this.ui.write(`  ${dim('requests')}      ${live.requestsRemaining} of ${live.requestsLimit} left`);
    }
    this.ui.blank();
    this.ui.write(dim('  /model <id> switches without the picker.'));
    this.ui.blank();
  }

  /**
   * One row per saved conversation.
   *
   * A list of titles and timestamps is not enough to recognise your own work
   * by — half of them start "Fix the". So each row carries what it was about
   * and how far it got, and the ones from this folder are marked, because that
   * is nearly always the one being looked for.
   */
  describeSession(s, width, i) {
    const room = Math.max(24, Math.min(46, width - 34));
    const mark = s.mine ? blue('●') : dim('○');
    const when = relativeTime(s.updatedAt).padEnd(9);
    const turns = `${s.turns} turn${s.turns === 1 ? '' : 's'}`.padEnd(9);
    const where = s.mine ? 'here' : shortenPath(s.cwd, 26);

    return {
      // Numbered in the picker, so /session delete 3 has something to point at.
      label: `${i === undefined ? '' : `${dim(String(i + 1).padStart(2))} `}${mark} ${clip(s.title, room).padEnd(room)}  ${dim(when)}${dim(turns)}${dim(where)}`,
      sub: s.preview ? dim(`     ${clip(s.preview, width - 10)}`) : '',
    };
  }

  async cmdSessions(arg) {
    if (arg === '--clear' || arg === 'clear') {
      const yes = await this.ui.confirm({
        action: 'delete every saved conversation',
        detail: 'This cannot be undone.',
        risk: 'write',
      });
      if (!yes) {
        this.ui.note('cancelled');
        return;
      }
      await removeAll();
      this.ui.note('all sessions deleted');
      return;
    }

    // /session delete 3   or   /session delete 2,5,7
    const del = /^(?:delete|del|rm|remove)\b\s*(.*)$/i.exec(arg ?? '');
    if (del) return this.deleteSessions(del[1]);

    const sessions = await list({ cwd: this.cwd });
    if (!sessions.length) {
      this.ui.note('no saved conversations yet');
      return;
    }

    for (const bad of sessions.unreadable ?? []) {
      this.ui.write(theme.warn(`  could not read session file: ${bad}`));
    }

    const shown = sessions.slice(0, 25);
    const width = this.ui.width ? this.ui.width() : 80;
    let index;

    if (arg) {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > shown.length) {
        this.ui.write(theme.warn(`  "${arg}" is not one of 1-${shown.length}`));
        return;
      }
      index = n - 1;
    } else if (this.ui.pick) {
      // The picker stays open while you delete, so clearing out several old
      // conversations is d d, d d, d d — then Enter on the one you want.
      let active = 0;
      for (;;) {
        const here = shown.filter((s) => s.mine).length;
        const picked = await this.ui.pick(
          shown.map((s, i) => this.describeSession(s, width, i)),
          {
            active,
            deletable: true,
            hint:
              `↑↓ move · enter to continue · d twice to delete · esc to cancel` +
              (here ? ` — ${here} from this folder` : ''),
          }
        );
        if (picked === null) return;
        if (typeof picked === 'object' && picked.delete !== undefined) {
          const doomed = shown[picked.delete];
          active = picked.delete;
          if (doomed.id === this.session.id) {
            this.ui.flash?.('that is the conversation you are in — /new first, then delete it');
            continue;
          }
          await remove(doomed.id);
          shown.splice(picked.delete, 1);
          this.ui.flash?.(`deleted · ${clip(doomed.title, 50)}`);
          if (!shown.length) {
            this.ui.note('no saved conversations left');
            return;
          }
          active = Math.min(active, shown.length - 1);
          continue;
        }
        index = picked;
        break;
      }
    } else {
      this.ui.blank();
      this.ui.note('/session delete <number> removes one, or several: /session delete 2,5');
      index = await this.ui.choose(
        'continue which?',
        shown.map((s, i) => this.describeSession(s, width, i).label)
      );
      if (index === null) return;
    }

    if (this.session.messages.length) await this.persist();
    if (await this.resume(shown[index].id)) {
      this.showHeader();
      this.replayTail();
    }
  }

  /** /session delete 3, or 2,5,7 — numbers as the session list shows them. */
  async deleteSessions(spec) {
    const sessions = (await list({ cwd: this.cwd })).slice(0, 25);
    const numbers = [...new Set(String(spec).split(/[\s,]+/).filter(Boolean).map(Number))];
    const bad = numbers.filter((n) => !Number.isInteger(n) || n < 1 || n > sessions.length);
    if (!numbers.length || bad.length) {
      this.ui.write(theme.warn(`  usage: /session delete <number>[,<number>…] — numbers from 1 to ${sessions.length}`));
      return;
    }
    for (const n of numbers) {
      const s = sessions[n - 1];
      if (s.id === this.session.id) {
        this.ui.note(`skipped ${n} — that is the conversation you are in`);
        continue;
      }
      await remove(s.id);
      this.ui.note(`deleted ${n} · ${s.title}`);
    }
  }

  async resume(id) {
    try {
      const loaded = await load(id);
      this.session = loaded;
      this.working = [...loaded.messages];
      this.loaded = new Set(loaded.messages.filter((m) => m.skill).map((m) => m.skill));
      this.short = new Set(loaded.messages.filter((m) => m.skill && m.short).map((m) => m.skill));
      if (loaded.model && MODELS[loaded.model]) setModel(loaded.model);
      return true;
    } catch (err) {
      this.ui.error(err, { debug: this.debug });
      this.ui.note('Starting a fresh one instead.');
      return false;
    }
  }

  /** The whole conversation back on screen, so a resumed session reads like it never closed. */
  replayTail() {
    for (const m of this.session.messages) {
      if (m.role === 'user' && m.content?.trim()) {
        if (this.ui.userMessage) this.ui.userMessage(m.content, { silent: true });
        else this.ui.write(`${blue('›')} ${dim(String(m.content).split('\n')[0])}`);
      } else if (m.role === 'assistant' && m.content?.trim() && !m.toolCalls?.length) {
        this.ui.assistant(m.content, { replay: true, silent: true });
      }
    }
    if (this.ui.scroll !== undefined) this.ui.scroll = 0;
    this.ui.render?.();
    if (this.session.messages.length) this.ui.write(dim('  ── picking up here ──\n'));
  }

  /** Add a line to this project's UCODE.md, read at the start of every turn. */
  async cmdRemember(note) {
    if (!note) {
      this.ui.note(`usage: /remember <something ucode should always know here> — saved to ${MEMORY_FILE}`);
      return;
    }
    try {
      const file = await remember(this.cwd, note);
      this.ui.note(`remembered · ${path.relative(this.cwd, file) || MEMORY_FILE}`);
    } catch (err) {
      this.ui.error(new Failure({
        kind: 'memory_unwritable',
        attempted: `saving to ${MEMORY_FILE}`,
        failed: err.message,
        fix: 'Check that this folder is writable.',
      }), { debug: this.debug });
    }
  }

  async cmdNew() {
    if (this.session.messages.length) {
      await this.persist();
      this.ui.note(`saved · ${this.session.title}`);
    }
    this.session = newSession(this.cwd, model());
    this.working = [];
    this.loaded = new Set();
    this.short = new Set();   // loaded as a digest, so load_skill can still fetch the whole thing
    this.showHeader();
  }

  async cmdSkills() {
    // Re-read from disk. Skills load once at startup, so one written during
    // this session would otherwise stay invisible — and load_skill would fail
    // on a name the user can see in the folder.
    this.skills = await loadSkills({ cwd: this.cwd });
    for (const problem of this.skills.problems ?? []) {
      this.ui.write(theme.warn(`  skill not loaded: ${problem}`));
    }

    if (!this.skills.length) {
      this.ui.note('no skills found — add a folder with a SKILL.md under .ucode/skills');
      return;
    }

    this.ui.blank();
    for (const s of this.skills) {
      const live = this.loaded.has(s.name);
      const how = live && this.short.has(s.name) ? dim('  · short form') : '';
      const auto = s.triggers.length ? dim('  · loads itself') : '';
      this.ui.write(`  ${live ? blue('●') : dim('○')} ${blue(s.name)}${how}${auto}`);
      this.ui.write(`    ${dim(s.description)}`);
    }
    this.ui.blank();
    this.ui.write(dim('  ● already loaded here · ucode pulls one in when the task matches'));
    this.ui.blank();
  }

  async cmdSearch(query) {
    if (!query) {
      this.ui.note('usage: /search <what you want to look up>');
      return;
    }
    await this.turn(
      `Search the web for: ${query}\n\nUse web_search, then summarise what you found and cite the URLs.`
    );
  }

  /** Copy the last reply. Every platform ships a clipboard pipe. */
  async cmdCopy() {
    const last = [...this.session.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.content?.trim());

    if (!last) {
      this.ui.note('nothing to copy yet');
      return;
    }

    const tool = process.platform === 'win32' ? 'clip'
      : process.platform === 'darwin' ? 'pbcopy'
      : 'xclip -selection clipboard';

    try {
      await new Promise((resolve, reject) => {
        const child = spawn(tool, { shell: true, windowsHide: true });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.stdin.end(last.content);
      });
      const lines = last.content.split('\n').length;
      this.ui.note(`copied ${lines} line${lines === 1 ? '' : 's'}`);
    } catch (err) {
      this.ui.error(new Failure({
        kind: 'clipboard_failed',
        attempted: 'copying the last reply',
        failed: `${tool} could not run: ${err.message}`,
        fix: process.platform === 'linux'
          ? 'Install xclip (apt install xclip), or select the text with the mouse.'
          : 'Select the text with the mouse instead.',
      }), { debug: this.debug });
    }
  }
}

export { DEFAULT_MODEL, PROVIDER };
