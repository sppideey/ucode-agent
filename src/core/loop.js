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
import { appendFileSync } from 'node:fs';
import { readFile, access, mkdir } from 'node:fs/promises';
import { testRunnerFor, relatedCommand, summariseFailures } from './tests.js';
import { LogWatch } from './livelog.js';
import { checkHtml } from './htmlcheck.js';
import { runningServers } from '../tools/shell.js';
import { spawn } from 'node:child_process';

import {
  ask, model, setModel, modelName, modelList, contextLimit, rateLimits,
  MODELS, DEFAULT_MODEL, PROVIDER, fallbackFor,
} from './provider.js';
import {
  tools, runTool, describe, setRoot, setConfirm, PARALLEL_SAFE, WRITES, FILE_WRITES,
} from '../tools/index.js';
import { projectMap, loadMemory, remember, MEMORY_FILE } from './context.js';
import { autoUpdate } from './updater.js';
import { closeBrowser, forgetReviews } from '../tools/browser.js';
import {
  newSession, save, load, list, remove, removeAll, titleFrom,
} from './history.js';
import { fold, usage, tooBig, SUMMARY_PROMPT, forSummary } from './window.js';
import { loadSkills, catalogue, findSkill, skillMessage, autoLoadFor } from './skills.js';
import { Screen, isLabel } from '../ui/screen.js';
import { Plain } from '../ui/plain.js';
import { theme, blue, sky, dim, formatTokens, relativeTime, shortenPath, clip } from '../ui/theme.js';
import { Failure, ToolFailure, Declined } from './failure.js';
import { StuckWatch, eventFor, describeHit } from './stuck.js';
import { serversReadySince } from '../tools/shell.js';
import { formatDuration } from '../ui/activity.js';
import { runDoctor } from './doctor.js';
import { deploy } from '../tools/deploy.js';

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
const WORKER_EXCLUDED = new Set(['delegate', 'update_plan', 'load_skill']);

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
  if (call.name === 'batch_write' || call.name === 'edit_files') return (a.files ?? []).map((f) => f?.path).filter(Boolean);
  return a.path ? [a.path] : [];
}

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
    'Do not claim it is done while anything is still running or unchecked. "I have',
    'built it" said before the build finishes is worse than saying nothing: the user',
    'believes you, looks, and finds it broken. Finish, check, then say so — and if',
    'something is incomplete, say which part and why.',
    '',
    'BE FAST. Every tool call is a round trip, and round trips are nearly all of the',
    'time a build takes. So: write a whole app in ONE batch_write rather than a',
    'write_file per file. Read every file you need in ONE read_files. Never read a',
    'file you just wrote, and never read one back after edit_file — the result',
    'already contains it. Do not re-check work the checks have already reported on.',
    'Fast is not sloppy: it is the same work with the waiting taken out.',
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
    'That closing line is ONE OR TWO SENTENCES. Never a checklist, never a feature',
    'list, never ticks or bullets walking through the request item by item. "Tide is',
    'built - open tide/index.html, or serve the folder and visit it." Anything longer',
    'is a status report nobody asked for, and it is the last thing on screen, so it',
    'is what the whole session looks like.',
    'That is all. A line before every tool call is not narration, it is noise: the',
    'steps already show on screen, and repeating them in words buries the few',
    'sentences worth reading.',
    '',
    'FIRST, EVERY TIME: write one short line saying what you are about to do, then',
    'make the tool calls. Never open a turn with a tool call and no words. Examples:',
    '"Right, the HTML structure first." / "Now the state and the render loop." /',
    '"That is the layout done - onto the animations." / "Let me see what is there."',
    'One sentence, your own voice, before the actions - not after them, not instead',
    'of them, and not a restatement of what was asked. The user is watching this',
    'scroll past; without those lines it is a list of file operations and they cannot',
    'tell what you are building. This matters as much as the code.',
    '',

    '',
    'Before you guess at an API, ask: type_of gives the exact signature from the',
    'TypeScript this project has installed, and find_symbol says where something is declared without',
    'reading five files to find it. Rename with rename_symbol rather than edit_file — a',
    'find-and-replace that matches too much is the most common broken edit. Reach for',
    'add_block before writing a table, an empty state or a dashboard by hand.',
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
    '  reports - errors, layout that overflows a phone, the review points worth fixing -',
    '  in one pass, then look once more. A clean second look means it is done: report',
    '  back instead of polishing in circles. Never call an interface finished unlooked at.',
    '  name, handles keys and returns the live link. Build locally first.',
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
  constructor({ cwd, debug = false }) {
    this.cwd = cwd;
    this.debug = debug;
    // A full-screen layout only makes sense on a real terminal. Piped input,
    // CI and `echo ... | ucode` get the line-based interface instead.
    this.full = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    this.ui = this.full ? new Screen({ cwd }) : new Plain({ cwd });
    this.stats = newStats();
    this.skills = [];
    this.session = newSession(cwd, model());
    this.working = [];
    this.loaded = new Set();
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

  async persist() {
    try {
      this.session.model = model();
      await save(this.session);
    } catch (err) {
      // Losing the save must not lose the turn.
      this.ui.error(err, { debug: this.debug });
    }
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
      this.loaded.add(skill.name);
      this.push(skillMessage(skill, { automatic: true }));
      this.ui.note(`${skill.name} skill loaded for this`);
    }
  }

  async turn(input) {
    forgetReviews(); // a new request: its apps get a fresh design review
    const images = await this.attachImages(input);
    this.push(images.length
      ? { role: 'user', content: input, images }
      : { role: 'user', content: input });

    if (!this.session.title || this.session.title === 'Untitled') {
      this.session.title = titleFrom(input);
    }

    this.autoLoad(input);
    // What the model is told about the project, fresh for this turn.
    [this.map, this.memory] = await Promise.all([
      projectMap(this.cwd).catch(() => ''),
      loadMemory(this.cwd).catch(() => ''),
    ]);
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
      if (this.full) this.showHeader({ clear: false });
      if (finished) this.openWhenReady(turnStarted);
      // Last, so "Done" is the last thing that happens rather than the last
      // thing said before several more things happen.
      this.ui.turnEnd?.({ ok });
    }
  }

  /** The tools the model may see, given the mode. */
  toolsNow() {
    const all = [...tools, loadSkillTool, planTool, delegateTool];
    if (this.ui.mode !== 'plan') return all;
    return all.filter((t) => !WRITES.has(t.name));
  }

  /** Model, tools, model, until it answers with prose. */
  async run() {
    const available = this.toolsNow();
    let argRetries = 0;
    let continuations = 0;
    let askedToVerify = false;
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
      if (streaming) this.ui.streamEnd({ asNarration: narrating });
      else if (reply.text && narrating && isLabel(reply.text)) this.ui.narrate(reply.text);
      else if (reply.text) this.ui.assistant(reply.text);

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
                `${MAX_FIX_ROUNDS}). Fix all of them, then finish.\n\n${problems}`,
            });
            continue;
          }
        }

        // It changed code and never ran anything. Send it back once.
        if (this.touched.size && !this.ranSomething && this.check && !askedToVerify) {
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

        this.push({ role: 'assistant', content: reply.text });
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
          for (const p of pathsOf(call)) { this.touched.add(p); this.sinceCheck.add(p); }
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
   * Open the running app in a browser — only when asked.
   *
   * This used to happen on its own whenever a dev server came up. Something
   * seizing the screen mid-thought is startling at the best of times, and
   * during a demo it is worse. UCODE_OPEN=1 brings the old behaviour back for
   * anyone who liked it; otherwise the URL is on screen to click.
   */
  openWhenReady(since) {
    if (!this.full || process.env.UCODE_OPEN !== '1') return;
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
        /(?:next build|npm run build|pnpm (?:run )?build|tsc)/.test(call.args?.command ?? '')) {
      this.sinceCheck?.clear();
    }
    if (!QUIET.has(call.name)) this.ui.toolResult(out.summary);
    // The change as its two numbers, not as a copy of the file. The diff rows
    // are still built by the tool — the model reads them in the result — they
    // simply do not go on screen.
    if (out.diff?.length) this.ui.diffStat?.(countDiff(out.diff));
    this.push({ role: 'tool', toolCallId: call.id, name: call.name, content: out.content + this.stuckNote(call, { out }) });
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
    this.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: err.forModel() + (err instanceof Declined ? '' : this.stuckNote(call, { err })),
    });
    return err.kind === 'bad_args';
  }

  async dispatch(call) {
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

    if (!next) {
      const until = Date.now() + 60_000;
      this.ui.startSpinner('every model is busy');
      while (Date.now() < until && !this.abort?.signal.aborted) {
        this.ui.updateSpinner(`every model is busy — trying again in ${Math.ceil((until - Date.now()) / 1000)}s`);
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
    const why = err.kind === 'rate_limit' ? 'busy' : err.kind === 'timeout' ? 'too slow to answer' : 'not answering';
    this.ui.note(`${modelName(from)} is ${why} — carrying on with ${modelName(next)}`);
    if (this.full) this.showHeader({ clear: false });
    return true;
  }

  /** Run a call and settle to { out } or { err } — never throws. */
  execute(call) {
    const started = Date.now();
    return this.dispatch(call).then(
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

    for (const r of results) for (const f of r.touched) { this.touched.add(f); this.sinceCheck.add(f); }

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
    const skills = this.skills
      .filter((s) => this.loaded.has(s.name))
      .map((s) => `--- ${s.name} ---\n${s.body}`)
      .join('\n\n');
    const messages = [
      { role: 'system', content: workerPrompt({ cwd: this.cwd, name, memory: this.memory, skills, map: this.map }) },
      { role: 'user', content: String(task.instructions) },
    ];
    const available = this.toolsNow().filter((t) => !WORKER_EXCLUDED.has(t.name));
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
        const { out, err } = FILE_WRITES.has(call.name)
          ? await this.fileLock(() => this.execute(call))
          : await this.execute(call);
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

    const check = async (label, command, cwd) => {
      this.ui.toolCall(label);
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
      this.ui.toolFailed(`${errors.length || 'some'} type error${errors.length === 1 ? '' : 's'}`);
      problems.push(`In ${show} (tsc --noEmit):\n${(errors.length ? errors : out.content.split('\n')).slice(0, 40).join('\n')}`);
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

    return problems.length ? problems.join('\n\n') : null;
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

    if (this.loaded.has(skill.name)) {
      return { content: `The "${skill.name}" skill is already loaded above. Follow it.`, summary: 'already loaded' };
    }

    this.loaded.add(skill.name);
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

  /** Fold older turns into a summary when the window gets tight. */
  async maybeFold() {
    const limit = contextLimit();
    if (!tooBig(this.working, limit)) return;

    this.ui.startSpinner('context is filling up — summarizing earlier turns');
    try {
      const result = await fold(this.working, {
        limit,
        summarize: async (older) => {
          const reply = await ask(
            [
              { role: 'system', content: SUMMARY_PROMPT },
              { role: 'user', content: forSummary(older) },
            ],
            [],
            { signal: this.abort?.signal, temperature: 0 }
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

  cmdHelp() {
    const rows = [
      ['/help', 'this list'],
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

  /** The five models, and this session's spend. */
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
      if (loaded.model && MODELS[loaded.model]) setModel(loaded.model);
      return true;
    } catch (err) {
      this.ui.error(err, { debug: this.debug });
      this.ui.note('Starting a fresh one instead.');
      return false;
    }
  }

  /** The last few exchanges, so a resumed conversation has visible context. */
  replayTail(count = 4) {
    const tail = this.session.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-count);

    for (const m of tail) {
      if (m.role !== 'user') this.ui.assistant(m.content);
      else if (this.ui.userMessage) this.ui.userMessage(m.content);
      else this.ui.write(`${blue('›')} ${dim(m.content.split('\n')[0])}`);
    }
    if (tail.length) this.ui.write(dim('  ── picking up here ──\n'));
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
      const auto = s.triggers.length ? dim('  · loads itself') : '';
      this.ui.write(`  ${live ? blue('●') : dim('○')} ${blue(s.name)}${auto}`);
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
