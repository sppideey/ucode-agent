/**
 * stuck.js — noticing when the model is going round in circles.
 *
 * Measured on a real build (a tip calculator, 84 model steps): six edits whose
 * old_string and new_string were identical, the same build failing three times
 * running on the same two type errors, and thirty reads of files whose current
 * text was already in the conversation. Every one of those is a whole round
 * trip, and a small model that has started repeating itself rarely stops on
 * its own — the error it keeps getting says what is wrong, but nothing says
 * "you have tried exactly this before".
 *
 * So each finished tool call becomes an event, and the recent events are
 * checked for four patterns:
 *
 *   repeat     the same call, with the same arguments, failing the same way
 *   identical  edits refused because old_string and new_string are the same
 *   reread     reading a file whose unchanged text is still in view
 *   build      a build failing with the same error text
 *
 * The first time a pattern reaches its threshold, the result that completed it
 * carries a firm, specific note: what was repeated, the error, what to do
 * instead. If the same pattern turns up again after that note, a nudge has not
 * worked, and the caller hands the turn to another model.
 *
 * Everything here is pure: events in, verdicts out. The loop owns the side
 * effects — appending the text and switching the model.
 */

import { createHash } from 'node:crypto';

/** How many recent tool calls the patterns are looked for in. */
export const WINDOW = 20;

/** Occurrences inside the window that make a hit. */
export const THRESHOLDS = { repeat: 3, identical: 2, reread: 1, build: 3 };

const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/** Argument values compared the way a person would: whitespace runs do not make a call different. */
function stable(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}

/** Name and arguments, reduced to one short string. */
export function signature(call) {
  return `${call?.name}:${hash(JSON.stringify(stable(call?.args ?? {})))}`;
}

/** Commands whose job is to build or type-check the project. */
const BUILD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bnext\s+build\b|\bvite\s+build\b|\btsc\b(?![^&|;]*--watch)/i;

export const isBuild = (command) => BUILD.test(String(command ?? ''));

const ERROR_LINE = /\berror\b|Error:|Module not found|Can't resolve|Type error|is not defined|Unterminated/i;
const GENERIC = /^(?:>\s*)?Build error occurred|Failed to (?:type check|compile)|build worker exited|exiting the build|^exit code:|^What to do:|^- |build failed with \d+ errors?|^Import trace|^\d+ errors? found/i;

/**
 * The part of a build's output that names what is wrong, with the noise that
 * changes from run to run — timings, digests — taken out, so two failures on
 * the same errors compare equal.
 */
export function buildErrors(output) {
  const clean = (l) => l
    .replace(/\b\d+(?:\.\d+)?\s?m?s\b/g, '')
    .replace(/digest: '[^']*'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const lines = String(output ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errors = [...new Set(lines.filter((l) => ERROR_LINE.test(l) && !GENERIC.test(l)).map(clean))];
  return (errors.length ? errors.slice(0, 12) : lines.slice(-5).map(clean)).join('\n');
}

/**
 * One finished call as the detector sees it.
 *
 * @param {object} call          { name, args }
 * @param {object} outcome
 * @param {object} [outcome.out]      a tool result ({ content, exitCode? })
 * @param {object} [outcome.err]      a ToolFailure
 * @param {string[]} [outcome.rereads] files this call re-read while their text was still in view
 */
export function eventFor(call, { out, err, rereads = [] } = {}) {
  const args = call?.args ?? {};
  const event = { tool: call?.name, sig: signature(call), failed: false, rereads: [...rereads] };
  event.path = args.path ?? args.files?.[0]?.path ?? null;

  if (err) {
    event.failed = true;
    event.kind = err.kind ?? 'error';
    event.error = String(err.failed ?? err.message ?? err);
    event.identical = event.kind === 'bad_args' && /old_string and new_string are identical/.test(event.error);
    return event;
  }

  if (call?.name === 'run_command' && out && out.exitCode !== undefined && out.exitCode !== 0) {
    const command = String(args.command ?? '');
    event.failed = true;
    event.kind = `exit ${out.exitCode}`;
    event.command = command;
    if (isBuild(command)) {
      event.build = true;
      event.error = buildErrors(out.content);
    } else {
      event.error = buildErrors(out.content).slice(0, 400);
    }
  }
  return event;
}

/**
 * Does the latest event complete a pattern? Returns the hit, or null.
 *
 * Only the newest event can complete one: every earlier event was checked when
 * it arrived, so looking again would report the same hit twice.
 */
export function detect(events, { window = WINDOW, thresholds = THRESHOLDS } = {}) {
  const recent = events.slice(-window);
  const last = recent[recent.length - 1];
  if (!last) return null;

  if (last.identical) {
    const count = recent.filter((e) => e.identical).length;
    return count >= thresholds.identical
      ? { pattern: 'identical', key: 'identical', count, tool: last.tool, path: last.path, error: last.error }
      : null;
  }

  if (last.build) {
    const count = recent.filter((e) => e.build && e.error === last.error).length;
    return count >= thresholds.build
      ? { pattern: 'build', key: `build:${hash(last.error)}`, count, command: last.command, error: last.error }
      : null;
  }

  if (last.rereads?.length) {
    const count = recent.filter((e) => e.rereads?.length).length;
    return count >= thresholds.reread
      ? { pattern: 'reread', key: 'reread', count, paths: last.rereads }
      : null;
  }

  if (last.failed) {
    const same = (e) => e.failed && !e.identical && !e.build && e.sig === last.sig && e.kind === last.kind && e.error === last.error;
    const count = recent.filter(same).length;
    return count >= thresholds.repeat
      ? {
          pattern: 'repeat', key: `repeat:${last.sig}:${last.kind}:${hash(last.error)}`, count,
          tool: last.tool, kind: last.kind, error: last.error, path: last.path, command: last.command,
        }
      : null;
  }

  return null;
}

/** What each pattern is, as a few words for the user and for the model-switch note. */
export function describeHit(hit) {
  switch (hit.pattern) {
    case 'identical': return 'making edits that change nothing';
    case 'build': return 'rebuilding on the same errors';
    case 'reread': return 're-reading files it already has';
    default: return `repeating a failing ${hit.tool}`;
  }
}

const nth = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** What to do instead, by the kind of failure being repeated. */
function adviceFor(hit) {
  if (hit.tool === 'run_command') {
    return 'Read the output above: it names the problem. Change the cause - the code, the ' +
      'command, or its cwd - before running it again, or take a different route.';
  }
  switch (hit.kind) {
    case 'no_match':
      return `Read ${hit.path ?? 'the file'} once, copy old_string from that result exactly as it ` +
        'stands, without the line-number gutter - or, if the change is large, rewrite the file with write_file.';
    case 'ambiguous':
      return 'Add the lines around it to old_string until it matches one place only.';
    case 'not_found':
      return 'That path does not exist. Find the right one with glob or list_dir first.';
    case 'bad_args':
      return 'Fix exactly the argument the error names before calling it again.';
    default:
      return 'Change what the error points at, or take a different route.';
  }
}

/** The note appended to the result that completed a hit. Empty when the result already says it. */
export function nudge(hit, { switched = false } = {}) {
  const lead = switched
    ? 'ucode has handed this turn to another model, because the last one kept ' +
      `${describeHit(hit)} after being told to stop. `
    : '';

  switch (hit.pattern) {
    case 'identical':
      return `${lead}STOP - that is ${hit.count} edits in a row whose old_string and new_string are ` +
        'identical. An edit like that changes nothing, so it is refused every time. If ' +
        `${hit.path ?? 'the file'} already says what you want, that part is finished: move on to the ` +
        'next thing. If it does not, put the text you actually want in new_string.';
    case 'build':
      return `${lead}STOP - \`${hit.command}\` has now failed ${hit.count} times with the same errors:\n` +
        `${hit.error}\n` +
        'Building again without changing the code those lines point at fails the same way, and each ' +
        'build takes most of a minute. Fix every error listed - in one pass, with edit_files or ' +
        'multi_edit - then build once.';
    case 'reread':
      // The result itself already says the text was not sent again and why;
      // only a model switch has anything to add.
      return switched
        ? `${lead}Work from the file text already in this conversation instead of reading it again.`
        : '';
    default:
      return `${lead}STOP - this is the ${nth(hit.count)} time ${hit.tool} has been called with exactly ` +
        `these arguments, and it failed the same way every time (${hit.kind}: ${oneLine(hit.error)}). ` +
        `Calling it again will fail again. ${adviceFor(hit)}`;
  }
}

const oneLine = (s) => {
  const line = String(s ?? '').split('\n')[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};

/**
 * The detector with memory: which hits have already had their nudge.
 *
 * observe() returns null, a nudge, or a switch. A nudge is remembered for as
 * long as it is inside the window; the same pattern turning up again while it
 * is remembered means the nudge did not work. After a switch the slate is
 * wiped, so the new model gets a nudge of its own before any further switch.
 */
export class StuckWatch {
  constructor({ window = WINDOW, thresholds = THRESHOLDS } = {}) {
    this.window = window;
    this.thresholds = thresholds;
    this.events = [];
    this.seq = 0;
    this.nudged = new Map(); // hit key -> seq of the event that was nudged
  }

  observe(event) {
    this.seq++;
    this.events.push({ ...event, seq: this.seq });
    if (this.events.length > this.window * 2) this.events.splice(0, this.events.length - this.window);

    const hit = detect(this.events, { window: this.window, thresholds: this.thresholds });
    if (!hit) return null;

    const at = this.nudged.get(hit.key);
    if (at !== undefined && this.seq - at < this.window) {
      this.reset();
      return { action: 'switch', hit, text: nudge(hit, { switched: true }) };
    }
    this.nudged.set(hit.key, this.seq);
    return { action: 'nudge', hit, text: nudge(hit) };
  }

  reset() {
    this.events = [];
    this.nudged.clear();
  }
}
