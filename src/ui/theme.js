/**
 * theme.js — colour, boxes, and the string maths that keeps a terminal frame
 * from tearing.
 *
 * Everything visual comes from here so the whole interface can be re-tinted by
 * editing one block. ucode is blue: a single hue, three steps of it, and
 * nothing else decorative. Red, amber and green are reserved — they mean
 * failed, careful, and done, and they never appear for any other reason.
 */

import chalk from 'chalk';

// One hue, three weights. Anything that needs a fourth is asking for emphasis
// it has not earned.
export const blue = chalk.hex('#4d8dff');   // structure: borders, the caret, the wordmark
export const sky = chalk.hex('#8fbcff');    // secondary: labels that still matter
export const deep = chalk.hex('#2f6fe0');   // pressed, quiet, behind
export const dim = chalk.dim;

/**
 * The input box's own edge: the same blue, drawn bold.
 *
 * The input is the one thing on screen you act on, so it is the one box that
 * gets the heavier line. Bold box-drawing renders brighter, and in most
 * terminal fonts visibly thicker, which is enough to separate "where you type"
 * from "what you are reading" without a second colour.
 */
export const edge = chalk.hex('#4d8dff').bold;

/**
 * The colour level to use for a stream, or null to leave chalk's guess alone.
 *
 * chalk decides from the environment, and some environments lie: TERM=dumb
 * from an embedding shell, or a wrapper that strips COLORTERM. The result is a
 * UI with every colour silently gone — a grey box where a blue one was drawn.
 *
 * The full-screen interface already depends on a terminal that understands VT
 * sequences — it switches to the alternate screen and moves the cursor — and
 * any terminal that handles those handles colour. So when that interface is
 * running, the guess is overruled. NO_COLOR is still honoured, because that
 * one is a person's explicit choice rather than an environment's accident.
 */
export function colourLevel(stream, env = process.env, current = chalk.level) {
  if ('NO_COLOR' in env) return null;
  if (!stream?.isTTY) return null;
  if (current >= 2) return null;
  return env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || process.platform === 'win32' ? 3 : 2;
}

export function ensureColour(stream) {
  const level = colourLevel(stream);
  if (level !== null) chalk.level = level;
}

export const theme = {
  blue,
  sky,
  deep,
  dim,
  text: chalk.white,
  error: chalk.red,
  warn: chalk.hex('#e0a030'),
  ok: chalk.hex('#3fb950'),
};

/** Tints for a diff: enough colour to scan, dim enough to read code through. */
export const ADDED = chalk.bgHex('#0e2a1a').hex('#7ee2a8');
export const REMOVED = chalk.bgHex('#331319').hex('#f2939c');

export const BANNER = [
  '██╗   ██╗ ██████╗ ██████╗ ██████╗ ███████╗',
  '██║   ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██║   ██║██║     ██║   ██║██║  ██║█████╗  ',
  '██║   ██║██║     ██║   ██║██║  ██║██╔══╝  ',
  '╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗',
  ' ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

export const BANNER_WIDTH = Math.max(...BANNER.map((r) => r.length));

/** The spinner. Braille dots, because they animate in place without jitter. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

export const BOX = {
  topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯',
  h: '─', v: '│',
};

export const boxTop = (width, paint = blue) =>
  paint(BOX.topLeft + BOX.h.repeat(Math.max(0, width - 2)) + BOX.topRight);

export const boxBottom = (width, paint = blue) =>
  paint(BOX.bottomLeft + BOX.h.repeat(Math.max(0, width - 2)) + BOX.bottomRight);

/** One row inside a box, padded so the right border lands in the same column. */
export const boxRow = (content, width, paint = blue) =>
  paint(BOX.v) + padVis(content, Math.max(0, width - 2)) + paint(BOX.v);

// ---------------------------------------------------------------------------
// Widths, with escape codes discounted
// ---------------------------------------------------------------------------

/** The string with its colour codes stripped — what the terminal actually shows. */
export const bare = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
export const visLen = (s) => bare(s).length;

/** The first `width` visible characters, with escape sequences left intact. */
export function sliceVis(s, width) {
  let out = '';
  let seen = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
    }
    if (seen >= width) break;
    out += s[i];
    seen++;
  }
  return out;
}

/** Pad or hard-cut a possibly-coloured string to an exact visible width. */
export function padVis(s, width) {
  const len = visLen(s);
  if (len === width) return s;
  if (len < width) return s + ' '.repeat(width - len);
  return `${sliceVis(s, width)}\x1b[0m`;
}

export function clip(text, max) {
  const s = String(text ?? '');
  if (max <= 1) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Word-wrap text that may already be coloured.
 *
 * Escape sequences have no width, and whichever styles are open at a break get
 * reopened on the next line — otherwise a wrapped sentence loses its colour
 * halfway through.
 */
export function wrapAnsi(text, width) {
  if (width < 4) return [text];

  const lines = [];
  let line = '';
  let seen = 0;
  let open = '';
  let lastSpace = -1;
  let lastSpaceSeen = 0;

  const flush = (upto = null) => {
    if (upto === null) {
      lines.push(line);
      line = open;
      seen = 0;
    } else {
      lines.push(line.slice(0, upto));
      const carry = line.slice(upto).replace(/^ +/, '');
      line = open + carry;
      seen = visLen(carry);
    }
    lastSpace = -1;
  };

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
      if (m) {
        line += m[0];
        open = m[0] === '\x1b[0m' ? '' : open + m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (text[i] === ' ') { lastSpace = line.length; lastSpaceSeen = seen; }
    line += text[i];
    seen++;
    if (seen >= width) {
      // Break at a word boundary unless that would leave a stub behind.
      if (lastSpace > 0 && lastSpaceSeen > width * 0.4) flush(lastSpace);
      else flush();
    }
  }

  if (visLen(line)) lines.push(line);
  return lines.length ? lines : [''];
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

export function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function today() {
  return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Shorten a path for display: home becomes ~, a long middle collapses. */
export function shortenPath(p, max = 40) {
  let out = String(p);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home && out.startsWith(home)) out = `~${out.slice(home.length)}`;
  if (out.length <= max) return out;

  const parts = out.split(/[\\/]/);
  if (parts.length <= 3) return `…${out.slice(-(max - 1))}`;
  const sep = out.includes('\\') ? '\\' : '/';
  return `${parts[0]}${sep}…${sep}${parts.slice(-2).join(sep)}`;
}

export function relativeTime(iso) {
  if (!iso) return 'unknown';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';

  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toISOString().slice(0, 10);
}

/**
 * Trim a trailing full stop off a live status line.
 *
 * "Listing src" is a label on work in progress. "Listing src." is a sentence,
 * and a sentence that ends while the thing it describes is still happening
 * reads as finished when it is not. Models add the full stop by habit; this
 * takes it back off.
 *
 * Only after a word, though. A dot that follows a space is the whole point of
 * the line — "Listing ." names the current directory — and trimming that turns
 * a label into a fragment.
 */
export function asLabel(text) {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    // A trailing stop, from a model's sentence or a tool's own output
    // ("Building…", "Completing…"), is noise on a one-line label. A dot that
    // is the argument itself — "Listing ." — is not, so a word has to come
    // before it.
    .replace(/(?<=[\w)\]"'`])[.。…]+$/, '');
}

/**
 * The model's checklist, as one short line — done ticked, the current item
 * marked, the rest dim — so progress is visible without taking over the screen.
 */
/**
 * The plan, as a block rather than a sentence.
 *
 * Six steps joined with separators made one line far wider than any terminal,
 * so it wrapped — and a wrapped checklist has its ticks in the middle of the
 * text, which is unreadable. Down the page each step keeps its own row, its
 * mark stays in the left column, and the eye can find the one in progress
 * without reading any of the others.
 *
 * Returns the rows; the caller pushes them.
 */
export function planRows(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, 8);
  if (!list.length) return [];
  const done = list.filter((i) => i?.done).length;
  const current = list.findIndex((i) => !i?.done);

  const rows = [`  ${sky(`plan ${done}/${list.length}`)}`];
  list.forEach((item, i) => {
    const text = clip(String(item?.text ?? '').trim(), 64);
    if (item?.done) rows.push(`    ${theme.ok('✓')} ${dim(text)}`);
    else if (i === current) rows.push(`    ${blue('▸')} ${chalk.white(text)}`);
    else rows.push(`    ${dim('○')} ${dim(text)}`);
  });
  return rows;
}

/** Kept for the plain interface, which has one line to work with. */
export function planLine(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, 6);
  if (!list.length) return '';
  const done = list.filter((i) => i?.done).length;
  const current = list.findIndex((i) => !i?.done);
  const now = current === -1 ? 'done' : clip(String(list[current]?.text ?? '').trim(), 40);
  return `  ${sky(`plan ${done}/${list.length}`)}  ${chalk.white(now)}`;
}

/**
 * Narration: what the agent is doing, as opposed to what it has to say.
 *
 * These lines are scaffolding — "Reading screen.js", "Checking types". They
 * are worth seeing and not worth reading, and at full strength they compete
 * with the answer, which is the thing the user is actually here for. A
 * terminal has no smaller size to set, so the only axis available is weight:
 * faint, and a step down in colour. The answer stays at full strength and
 * wins the page by contrast rather than by shouting.
 */
export const narration = (text) => chalk.dim(text);

/** The bullet beside a narration line: present, not loud. */
export const narrationMark = () => chalk.dim(deep('●'));

/**
 * How a run of the same kind of step reads once it is over.
 *
 * While it happens, "Running npm test" is the useful thing to show. Once
 * three of them have happened, three near-identical lines are just noise
 * between the reader and the answer, so they fold into one: "Ran 3 commands".
 * The present tense belongs to the thing happening now; the past tense to the
 * summary of what did.
 */
const GROUPS = {
  Running: ['Ran', 'command', 'commands'],
  Reading: ['Read', 'file', 'files'],
  Searching: ['Searched', 'time', 'times'],
  Finding: ['Found', 'pattern', 'patterns'],
  Listing: ['Listed', 'directory', 'directories'],
  Writing: ['Wrote', 'file', 'files'],
  Editing: ['Edited', 'file', 'files'],
  Checking: ['Checked', 'thing', 'things'],
  Looking: ['Looked up', 'name', 'names'],
  Asking: ['Asked about', 'name', 'names'],
  Mapping: ['Mapped', 'folder', 'folders'],
  Adding: ['Added', 'block', 'blocks'],
  Renaming: ['Renamed', 'name', 'names'],
};

/** The first word of a label, which is what decides whether two steps match. */
export const groupKind = (label) => String(label ?? '').trim().split(/\s+/)[0] ?? '';

/** One line standing in for `count` steps that all began with the same word. */
export function groupLabel(label, count) {
  if (count <= 1) return String(label ?? '');
  const g = GROUPS[groupKind(label)];
  if (!g) return `${label} (+${count - 1} more)`;
  const [past, one, many] = g;
  return `${past} ${count} ${count === 1 ? one : many}`;
}

/** The part of a label after its opening word: the file or command it is about. */
export const groupTarget = (label) => String(label ?? '').trim().split(/\s+/).slice(1).join(' ');

/**
 * One narration line, standing for everything that happened under it.
 *
 * The transcript is a record of what was done, not a copy of what was
 * written. A 539-line file printed into it buries the answer and tells the
 * reader nothing they could not get from the file itself, so a change is its
 * two numbers. Several steps on one file stay one line naming that file;
 * several files become a count.
 */
export function runLine({ label, count = 1, targets = [], added = 0, removed = 0 }) {
  const counts = added || removed
    ? ` ${chalk.hex('#3fb950')(`+${added}`)} ${chalk.hex('#f2939c')(`-${removed}`)}`
    : '';
  if (count <= 1) return `${label}${counts}`;

  const g = GROUPS[groupKind(label)];
  const unique = [...new Set(targets.filter(Boolean))];
  if (g && unique.length === 1) return `${g[0]} ${unique[0]}${counts}`;
  if (!g) return `${label} (+${count - 1} more)${counts}`;
  return `${g[0]} ${count} ${count === 1 ? g[1] : g[2]}${counts}`;
}

/**
 * The reply, with any pasted code taken out of it.
 *
 * The model is asked not to paste code into its answer, and mostly does not.
 * When it does, a fenced block of forty lines pushes the two sentences worth
 * reading off the screen — and the code is already in the file it just wrote.
 * A fence becomes a note of what it was, and the prose stays.
 *
 * A short block is left alone: three lines showing a command to run, or the
 * one line that changed, is the kind of thing worth having in the answer.
 */
/**
 * A sentence that exists only to introduce what comes next.
 *
 * "Here's the complete app:" followed by forty lines of code, with the code
 * taken out, is a colon pointing at nothing — which reads as the reply having
 * been cut off mid-thought. The lead-in goes with what it was leading to.
 */
const LEAD_IN = /(?:^|\n)[^\n]{0,80}:[ \t]*\n+$/;

export function withoutCodeBlocks(text, keepLines = 4) {
  const FENCE = /```([A-Za-z0-9+-]*)\n([\s\S]*?)```/g;
  return String(text ?? '').replace(FENCE, (all, lang, body) => {
    const lines = body.replace(/\n+$/, '').split('\n');
    if (lines.length <= keepLines) return all;
    const what = lang ? `${lang} ` : '';
    return `_[${lines.length} lines of ${what}code — it is in the file, not worth repeating here]_`;
  });
}

/**
 * The reply as it should be read: no pasted code, and no sentence left
 * pointing at code that is no longer there.
 */
/**
 * The reply as it should be read.
 *
 * A long pasted block goes, and so does the sentence that introduced it — a
 * colon pointing at nothing reads as the reply having been cut off. A short
 * block stays: three lines showing a command to run belong in an answer.
 */
export function tidyReply(text, keepLines = 4) {
  const MARK = "\u0000CUT\u0000";
  const FENCE = new RegExp("```([A-Za-z0-9+-]*)\\n([\\s\\S]*?)```", "g");

  const marked = String(text ?? "").replace(FENCE, (all, lang, body) => {
    const rows = body.replace(new RegExp("\\n+$"), "").split("\n");
    return rows.length <= keepLines ? all : MARK;
  });

  const leadIn = new RegExp("(?:^|\\n)[^\\n]{0,80}:[ \t]*\\n+" + MARK, "g");
  return marked
    .replace(leadIn, "\n")
    .split(MARK).join("")
    .replace(new RegExp("\\n{3,}", "g"), "\n\n")
    .trim();
}

/**
 * The closing message, cut to what a terminal can take.
 *
 * A model that finishes a build by walking back through the request — every
 * feature ticked off, every file listed — leaves that as the last thing on
 * screen, and the whole session then reads like a status report. Eight lines
 * is the whole of it: what it is, and how to try it.
 *
 * What goes: an opening that reads the request back, and the middle of a list
 * too long to be worth reading. What stays: the first lines, the line that
 * admits something is unfinished, and the line naming a file or a command —
 * the two the user actually acts on, and both of them live at the end.
 */
export const ANSWER_LINES = 8;
const ANSWER_ROOM = 600;   // eight wrapped lines of prose, for a reply with no line breaks in it

const RESTATED = /^(?:you (?:asked|wanted|requested|said)\b|the (?:request|task|ask)\b|as (?:you )?requested\b|here(?:'s| is) what (?:you asked|i)\b|to (?:summarise|summarize|recap)\b|(?:request|task|summary|recap|overview)\s*:)/i;
const CAVEAT = /\b(?:however|failed|couldn't|could not|cannot|can't|didn't|did not|isn't|is not|doesn't|does not|not (?:yet|wired|working|done|implemented)|missing|unfinished|except)\b/i;
const ACTIONABLE = /\b(?:open|run|serve|visit|try|start|npm|npx|node|pnpm|yarn)\b|https?:\/\/|\.(?:html?|css|jsx?|tsx?|md|json|py|rs|go)\b/i;
const BULLET = /^\s*(?:[-*•>]|\d+[.)]|[✓✔✅☑])\s+/;

export function trimAnswer(text, max = ANSWER_LINES) {
  const all = String(text ?? '').replace(/\r/g, '').split('\n');

  let start = 0;
  while (start < all.length && (!all[start].trim() || RESTATED.test(all[start].trim()))) start++;
  const rows = all.slice(start);

  const body = rows.map((row, i) => ({ row, i })).filter((r) => r.row.trim());
  if (!body.length) return '';

  let kept;
  if (body.length <= max) {
    kept = body.map((r) => r.i);
  } else {
    // Searched from the end: the caveat and the how-to-try-it line are the
    // last things written, and they are the two worth pulling out of the part
    // being dropped.
    const tail = body.slice(Math.max(1, max - 2));
    const pick = (re) => [...tail].reverse().find((r) => re.test(r.row))?.i;
    const rescued = [...new Set([pick(CAVEAT), pick(ACTIONABLE)])].filter((i) => i !== undefined);
    const head = body.slice(0, max - rescued.length).map((r) => r.i);
    kept = [...new Set([...head, ...rescued])].sort((a, b) => a - b);
  }

  const out = [];
  let previous = -1;
  for (const i of kept) {
    if (previous >= 0 && i > previous + 1) out.push('');   // a gap in the middle is a paragraph break
    // A line lifted out of a list is no longer in one.
    out.push(previous >= 0 && i > previous + 1 ? rows[i].replace(BULLET, '') : rows[i]);
    previous = i;
  }

  return withinRoom(out.join('\n').replace(/\n{3,}/g, '\n\n').trim());
}

/**
 * One long paragraph is one line and fills the screen anyway. Whole sentences
 * only: a reply cut mid-clause reads as a crash rather than as an ending.
 */
function withinRoom(text, room = ANSWER_ROOM) {
  if (text.length <= room) return text;

  const parts = text.split(/(?<=[.!?])(\s+)/);
  let out = '';
  let sentences = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const next = out + parts[i] + (parts[i + 1] ?? '');
    if (sentences >= 2 && next.trimEnd().length > room) break;
    out = next;
    sentences++;
  }
  return (out.trim() || text.slice(0, room)).trim();
}
