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

/**
 * The wordmark, lit from the top.
 *
 * Six identical rows of one blue read as ASCII art that happened to be lying
 * there. The same six stepped from sky down to deep read as a mark someone
 * drew: the crown catches the light, and the two shadow rows settle back into
 * the page. chalk downshifts the hex to whatever the terminal actually has, so
 * on a 16-colour terminal this is flat blue again rather than nothing.
 */
const GRADIENT_TOP = [0x8f, 0xbc, 0xff];      // sky, at the crown
const GRADIENT_BOTTOM = [0x2f, 0x6f, 0xe0];   // deep, in the shadow

export function bannerRGB(row, rows = BANNER.length) {
  const t = rows > 1 ? Math.min(1, Math.max(0, row / (rows - 1))) : 0;
  return GRADIENT_TOP.map((from, i) => Math.round(from + (GRADIENT_BOTTOM[i] - from) * t));
}

export function bannerPaint(row, rows = BANNER.length) {
  const hex = bannerRGB(row, rows).map((v) => v.toString(16).padStart(2, '0')).join('');
  return chalk.hex(`#${hex}`);
}

/**
 * The rail beside something you said.
 *
 * A box around every user message draws two full-width rules per turn, and a
 * long session becomes a ladder. A half-block in the left column is the same
 * landmark — findable at a glance, scrollable to — for a fortieth of the ink.
 */
export const RAIL = '▌';

/**
 * Which mode is live, as a filled pill.
 *
 * A glyph and a word is a label; a block of colour with the word knocked out
 * of it is a control, and the mode is the one thing on the status row you can
 * actually change. Build is the solid blue — it may edit and run. Plan is the
 * same shape muted, because a read-only mode should not look armed.
 *
 * Small enough not to be the background painting that was taken out of here
 * once: it is the width of the word, the way a diff's tint is the width of the
 * line it marks.
 */
export const BUILD_CHIP = chalk.bgHex('#4d8dff').hex('#0b1220').bold;
export const PLAN_CHIP = chalk.bgHex('#24344f').hex('#8fbcff').bold;

export const modeChip = (mode) =>
  mode === 'plan' ? PLAN_CHIP(' PLAN ') : BUILD_CHIP(' BUILD ');

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

/**
 * How many columns one character occupies.
 *
 * Not every character is one cell wide, and counting them as though they were
 * is how a box tears: the right border of a row holding CJK or an emoji lands
 * one or two columns early, and every frame after it looks broken. It cost us
 * a crooked credit line in the header for months — and any app whose name the
 * model writes in Japanese would have done the same to the transcript.
 *
 * Three widths. Combining marks and the variation selectors hang off the
 * character before them and take no room of their own. The wide ranges — CJK,
 * Hangul, kana, fullwidth forms, and the emoji planes — are drawn two cells
 * wide by every terminal worth supporting. Everything else is one.
 *
 * Ranges rather than a dependency: this is the whole of what a terminal needs,
 * and a table of every Unicode width would be a megabyte to get the last
 * fraction of a percent right.
 */
/**
 * The emoji among the older symbol blocks — ✅ ❌ ⚡ ⭐ ⌛ and friends. They sit
 * between box-drawing characters that are one cell, so they are listed one by
 * one rather than as a range. Counted as one cell, a model's "✅ Done" line
 * ran a column past the edge, wrapped, and scrolled the whole frame.
 */
const WIDE_SYMBOLS = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe,
  0x2614, 0x2615, 0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f,
  0x2650, 0x2651, 0x2652, 0x2653, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd,
  0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa,
  0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755,
  0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
]);

export function charWidth(code) {
  // Zero: combining marks, joiners, variation selectors.
  if ((code >= 0x0300 && code <= 0x036f)
    || (code >= 0x200b && code <= 0x200f)
    || (code >= 0xfe00 && code <= 0xfe0f)
    || (code >= 0xe0100 && code <= 0xe01ef)
    || code === 0x200d) return 0;

  // Two: the wide and fullwidth blocks, and the emoji planes.
  if ((code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f000 && code <= 0x1f02f)
    || code === 0x1f0cf
    || (code >= 0x1f18e && code <= 0x1f2ff)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f680 && code <= 0x1f6ff)
    || (code >= 0x1f7e0 && code <= 0x1f7eb)
    || (code >= 0x1f900 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd)
    || WIDE_SYMBOLS.has(code)) return 2;

  return 1;
}

/** The columns a string takes up once its colour codes are discounted. */
export function visLen(s) {
  const text = bare(s);
  let cells = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    // A variation selector turns the character before it into an emoji, and
    // an emoji is two cells wide however narrow its text form was.
    if (text.codePointAt(i) === 0xfe0f) { cells += 2; i += 1; continue; }
    cells += charWidth(cp);
  }
  return cells;
}

/** The first `width` visible characters, with escape sequences left intact. */
export function sliceVis(s, width) {
  let out = '';
  let seen = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
    }
    // A wide character that would straddle the edge is left off entirely:
    // half of one is a replacement glyph in most terminals and a torn border
    // in the rest.
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const selector = s.codePointAt(i + ch.length) === 0xfe0f;
    const w = selector ? 2 : charWidth(cp);
    if (seen + w > width) break;
    out += selector ? ch + String.fromCodePoint(0xfe0f) : ch;
    i += (selector ? ch.length + 1 : ch.length) - 1;
    seen += w;
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
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    line += ch;
    i += ch.length - 1;
    seen += charWidth(cp);
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

/** The longest a narration line may be before it is clipped. */
const NARRATION_MAX = 120;

/**
 * Any reply that came alongside a tool call, cut down to one status line.
 *
 * Mid-build the model narrates: a paragraph on what it is about to do, then a
 * tool call that does it. Printed in full that paragraph is the loudest thing
 * on screen and it is about work that has not happened yet — the file being
 * written scrolls past underneath it. Only the closing message is an answer;
 * everything before it is commentary, and commentary belongs on one dim line.
 *
 * The first sentence is kept because that is the one saying what is happening
 * now. Code blocks, headings and bullets are dropped outright: none of them
 * survive being squeezed into a single line, and half a fence is worse than
 * no fence.
 */
export function asNarrationLine(text) {
  const flat = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  const first = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  return asLabel((first?.[1] ?? flat).slice(0, NARRATION_MAX));
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
/**
 * How far along, as a bar rather than as arithmetic.
 *
 * "2/4" is a sum the reader has to do; a bar is the answer to it, read at a
 * glance. Ten cells whatever the plan's length, so the row does not change
 * width as steps are added and the eye keeps one edge to measure against.
 *
 * Heavy and light box-drawing, not block shading: those two are already the
 * frame of every box on screen, so they are the two glyphs this app can be
 * certain the terminal has and draws one cell wide.
 */
export const BAR_CELLS = 10;

export function progressBar(done, total, cells = BAR_CELLS) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const fill = Math.round(ratio * cells);
  return blue('━'.repeat(fill)) + dim('─'.repeat(Math.max(0, cells - fill)));
}

export function planRows(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, 8);
  if (!list.length) return [];
  const done = list.filter((i) => i?.done).length;
  const current = list.findIndex((i) => !i?.done);

  // One left edge for the whole transcript: markers in column zero, every
  // piece of content at column two. The plan used to sit at two and four, so
  // three different margins ran down the page and the eye had no line to
  // follow.
  const rows = [`${progressBar(done, list.length)}  ${sky(`${done}/${list.length}`)}`];
  list.forEach((item, i) => {
    const text = clip(String(item?.text ?? '').trim(), 64);
    if (item?.done) rows.push(`  ${theme.ok('✓')} ${dim(text)}`);
    else if (i === current) rows.push(`  ${blue('▸')} ${chalk.white(text)}`);
    else rows.push(`  ${dim('○')} ${dim(text)}`);
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

/**
 * The bullet beside a narration line: present, not loud.
 *
 * Three shapes rather than one dot repeated. Every step drawn identically made
 * a long transcript a column of the same mark forty times over, which reads as
 * output rather than as work — and the shape is free, where a fourth colour
 * would not be. A diamond is hollow when the agent is only looking at
 * something and filled when it changes it, and a run of a command points
 * forward. Anything unmapped keeps the original dot.
 *
 * All of them stay dim: the glyph carries the kind, the weight still says this
 * is scaffolding and the answer below is the thing to read.
 */
const MARKS = {
  Reading: ['◇', deep], Listing: ['◇', deep], Looking: ['◇', deep],
  Asking: ['◇', deep], Mapping: ['◇', deep], Searching: ['◇', deep],
  Finding: ['◇', deep],
  Writing: ['◆', blue], Editing: ['◆', blue], Adding: ['◆', blue],
  Renaming: ['◆', blue],
  Running: ['▸', sky], Checking: ['▸', sky],
};

export const narrationMark = (kind) => {
  const [glyph, paint] = MARKS[kind] ?? ['●', deep];
  return chalk.dim(paint(glyph));
};

/**
 * The file or command a step is about, lit so the line can be scanned.
 *
 * "Which file did it touch" is the one question a reader puts to a transcript
 * of tool calls, and dimming the whole line made the answer as faint as the
 * verb in front of it. The verb stays faint — there are only a dozen of them
 * and they repeat — and the part that differs every time carries the colour.
 */
const paintStep = (label) => {
  const text = String(label ?? '');
  const space = text.indexOf(' ');
  if (space < 0) return narration(text);

  const target = text.slice(space + 1);
  // "Read 2 files" is a tally, not a path. Lighting it up would point the eye
  // at a number that says nothing about where the work happened.
  if (/^\d/.test(target)) return narration(text);

  return `${narration(text.slice(0, space))} ${blue(target)}`;
};

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
 *
 * The line comes back painted, so the label handed in has to be through
 * asLabel() already: run that over this and its regexes would be reading
 * escape sequences instead of the last word.
 */
export function runLine({ label, count = 1, targets = [], added = 0, removed = 0, stat = '' }) {
  // What came of the step, in the same place a change puts its two numbers:
  // on the line that named the step, never underneath it. A look that found
  // three things to fix is the one fact worth carrying out of a look, and
  // without it the most thorough check ucode runs is the quietest thing on
  // screen — it opens the app at two widths, screenshots both and has them
  // reviewed, and said nothing about any of it.
  const counts = added || removed
    ? ` ${chalk.hex('#3fb950')(`+${added}`)} ${chalk.hex('#f2939c')(`-${removed}`)}`
    : (stat ? `  ${sky(stat)}` : '');
  if (count <= 1) return `${paintStep(label)}${counts}`;

  const g = GROUPS[groupKind(label)];
  const unique = [...new Set(targets.filter(Boolean))];
  if (g && unique.length === 1) return `${paintStep(`${g[0]} ${unique[0]}`)}${counts}`;
  if (!g) return `${paintStep(`${label} (+${count - 1} more)`)}${counts}`;
  return `${paintStep(`${g[0]} ${count} ${count === 1 ? g[1] : g[2]}`)}${counts}`;
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
export function tidyReply(text, keepLines = 4, prompt = '') {
  const MARK = "\u0000CUT\u0000";
  const FENCE = new RegExp("```([A-Za-z0-9+-]*)\\n([\\s\\S]*?)```", "g");

  const marked = String(text ?? "").replace(FENCE, (all, lang, body) => {
    const rows = body.replace(new RegExp("\\n+$"), "").split("\n");
    return rows.length <= keepLines ? all : MARK;
  });

  const leadIn = new RegExp("(?:^|\\n)[^\\n]{0,80}:[ \t]*\\n+" + MARK, "g");
  const body = marked
    .replace(leadIn, "\n")
    .split(MARK).join("")
    .replace(new RegExp("\\n{3,}", "g"), "\n\n")
    .trim();
  return withoutRestatement(body, prompt);
}

/**
 * The words of a line worth comparing: lowercase, no punctuation, and nothing
 * short enough to turn up in any sentence at all.
 */
const significant = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]+/g, ' ')
  .split(/\s+/)
  .filter((w) => w.length >= 3);

/**
 * Is this line the request handed back?
 *
 * A list of phrases catches the openings a model reaches for out of habit, but
 * the commonest way of repeating a request is simply saying it again in the
 * asker's own words — "A Next.js habit tracker with a clean dashboard, coming
 * right up" — and no list will ever match that. So the line is compared with
 * what was actually typed.
 *
 * Three guards keep it off real answers. A prompt of four significant words or
 * fewer is never matched, because at that length an overlap means nothing. A
 * line much longer than the prompt is saying more than the prompt did, so it
 * is content. And the bar is four fifths of the prompt's words rather than a
 * majority: an answer naturally shares nouns with the request that prompted
 * it, and only something repeating nearly all of it is a repetition.
 */
export function echoesPrompt(line, prompt) {
  const want = [...new Set(significant(prompt))];
  if (want.length < 4) return false;

  const text = String(line ?? '');
  if (text.length > String(prompt ?? '').length * 2.5) return false;

  const have = new Set(significant(text));
  return want.filter((w) => have.has(w)).length / want.length >= 0.8;
}

/**
 * The reply with any opening that reads the request back taken off the front.
 *
 * This ran only on the closing message before, and it belongs on every one. A
 * model that answers "You asked me to add a dark mode toggle — done" has spent
 * its first line telling someone something they typed themselves, and the line
 * directly above it on screen is already their own message, in their own
 * words, against a rail. Two copies of the request and one of the answer is
 * the wrong ratio.
 *
 * It never returns nothing. A reply that is only a restatement is still the
 * whole of the reply, and an empty answer on screen reads as a crash.
 */
export function withoutRestatement(text, prompt = '') {
  const rows = String(text ?? '').replace(/\r/g, '').split('\n');

  let start = 0;
  while (start < rows.length) {
    const line = rows[start].trim();
    if (!line) { start++; continue; }
    if (!RESTATED.test(line) && !echoesPrompt(line, prompt)) break;
    start++;
  }

  return rows.slice(start).join('\n').trim() || String(text ?? '').trim();
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
/**
 * The closing message is read once, at the end, by someone who watched the
 * whole build happen. What was made, where to see it, what is in it — that is
 * three lines and a spare. Eight was room to re-narrate the build, and that is
 * exactly what it filled with: the request read back, every feature ticked
 * off, every file listed, none of it news to the person who just watched it
 * scroll past.
 */
export const ANSWER_LINES = 5;
const ANSWER_ROOM = 600;   // eight wrapped lines of prose, for a reply with no line breaks in it

export const RESTATED = /^(?:(?:sure|ok|okay|got it|understood|alright|right)\b[\s,!.—-]*)?(?:you(?:'ve| have)? (?:asked|want|wanted|requested|said|would like|need)\b|the (?:request|task|ask)\b|as (?:you )?requested\b|here(?:'s| is) what (?:you asked|i)\b|i(?:'ll| will|'m going to| am going to) (?:build|create|make|add|write|implement)\b|let(?:'s| us) (?:build|create|make|add|write|implement)\b|to (?:summarise|summarize|recap)\b|(?:request|task|summary|recap|overview)\s*:)/i;
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
