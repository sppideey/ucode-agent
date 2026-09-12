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
export function planLine(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, 6);
  if (!list.length) return '';
  const done = list.filter((i) => i?.done).length;
  const current = list.findIndex((i) => !i?.done);
  const parts = list.map((item, i) => {
    const text = clip(String(item?.text ?? '').trim(), 30);
    if (item?.done) return `${theme.ok('✓')} ${dim(text)}`;
    if (i === current) return `${blue('▸')} ${chalk.white(text)}`;
    return dim(`○ ${text}`);
  });
  return `  ${sky(`plan ${done}/${list.length}`)}  ${parts.join(dim('  ·  '))}`;
}

/**
 * The background ucode paints behind itself.
 *
 * A terminal's own background is whatever the person set it to years ago:
 * white, solarized, a photograph. The interface was drawn for a dark one, and
 * on a light terminal the dim greys it relies on turn to near-invisible smoke.
 * So ucode paints its own ground for as long as it is running, and the
 * alternate screen gives it back untouched on exit.
 *
 * Two things are needed, not one. Painting each row covers the rows ucode
 * draws; it cannot reach the margin a terminal keeps below the last line or
 * beside the last column, which stays the old colour and shows as a border of
 * the wrong shade. So the terminal is also told, once, what its own background
 * is — and told to put it back on the way out.
 */
export const BACKGROUND = process.env.UCODE_BG || '#000000';

const rgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [19, 19, 22];
};

/** Turn the background on. Everything painted after this sits on it. */
export const BG_ON = (() => {
  if (process.env.NO_COLOR || process.env.UCODE_BG === 'off') return '';
  const [r, g, b] = rgb(BACKGROUND);
  return `\x1b[48;2;${r};${g};${b}m`;
})();

/**
 * Tell the terminal what its own background is.
 *
 * Painting each row covers the rows ucode draws, and nothing else. It cannot
 * reach the margin a terminal keeps below the last line or beside the last
 * column, which stays the old colour and reads as a border in the wrong
 * shade. OSC 11 sets the window's background itself, which does reach those
 * edges. A terminal that does not know the sequence ignores it in silence,
 * and the per-row painting still covers everything ucode draws.
 */
export const BG_WINDOW = BG_ON ? `\x1b]11;${BACKGROUND}\x07` : '';

/** Put the terminal's own background back, exactly as it was. */
export const BG_WINDOW_OFF = BG_ON ? '\x1b]111\x07' : '';

/** Hand the terminal its own colours back. */
export const BG_OFF = BG_ON ? '\x1b[0m' : '';

/**
 * Keep the background on across a line that resets it.
 *
 * chalk closes a foreground with 39 and a background with 49, and 49 means
 * "the terminal's default" — which is exactly the colour being painted over.
 * A diff line, which sets its own background, would therefore punch a hole
 * through to the terminal's ground for the rest of the line. Re-asserting the
 * background after every reset closes those holes.
 */
export function onBackground(text) {
  if (!BG_ON) return text;
  return BG_ON + String(text).replace(/\x1b\[(?:0|49)m/g, (m) => m + BG_ON);
}
